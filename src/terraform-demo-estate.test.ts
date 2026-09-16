import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverTerraformRoots, hasTerraformRoots } from "./terraform-member.ts";

// #416: the bundled Terraform estate. The fixture under src/__fixtures__ has
// the right five shapes with the bodies trimmed to whatever decides a probe —
// correct and dull. This is the same five shapes with bodies worth drawing, and
// what is asserted here is that giving it real content did not change what
// discovery makes of it.
const ESTATE = join(import.meta.dirname, "..", "example-terraform-estate");

describe("example-terraform-estate (#416)", () => {
  const scan = discoverTerraformRoots(ESTATE);

  it("is a Terraform member", () => {
    expect(hasTerraformRoots(ESTATE)).toBe(true);
  });

  it("draws more than one root", () => {
    // Two applied separately, neither a module of the other — which is what
    // makes the cross-root read below a read rather than a reference.
    expect(scan.roots.map((r) => r.name).sort()).toEqual(["platform", "prod"]);
  });

  it("classifies the two look-alike versions.tf correctly", () => {
    // The case that defeated #384's first probe: the shared module's
    // versions.tf is byte-for-byte a root's, so "declares a terraform block"
    // cannot be the whole test. The `modules/` exclusion is what separates them.
    const a = readFileSync(join(ESTATE, "envs/prod/versions.tf"));
    const b = readFileSync(join(ESTATE, "modules/service/versions.tf"));
    expect(a.equals(b)).toBe(true);

    expect(scan.roots.map((r) => r.name)).not.toContain("service");
    const skipped = scan.skipped.map((s) => s.dir);
    expect(skipped.some((d) => d.includes("modules/service"))).toBe(true);
  });

  it("reports the backend fragment as skipped rather than drawing an empty box", () => {
    const backends = scan.skipped.find((s) => s.dir.includes("backends"));
    expect(backends).toBeDefined();
    expect(backends!.why).toMatch(/nothing to draw|no resource/i);
  });

  it("says nothing at all about a directory with no .tf in it", () => {
    // envs/dev holds a README and no Terraform, so there is nothing to report:
    // neither drawn nor listed as skipped. Silence is the right answer.
    expect(scan.roots.some((r) => r.dir.includes("envs/dev"))).toBe(false);
    expect(scan.skipped.some((s) => s.dir.includes("envs/dev"))).toBe(false);
  });
});
