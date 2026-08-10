import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { armOverride, parsePlanOutput, LIVE_CONTAINER, LIVE_PORT, LIVE_TARGETS } from "./carve-live.ts";

const LEGACY_TF = join(import.meta.dirname, "..", "example-carve", "legacy-tf");

describe("the Floci --live tier (#254)", () => {
  it("arms the committed override template completely — no endpoint left on the shared :4566", () => {
    const template = readFileSync(join(LEGACY_TF, "floci-override.tf.disabled"), "utf8");
    const before = (template.match(/localhost:4566/g) ?? []).length;
    expect(before).toBeGreaterThan(0);
    const armed = armOverride(template, LIVE_PORT);
    expect(armed).not.toContain("localhost:4566");
    expect((armed.match(new RegExp(`localhost:${LIVE_PORT}`, "g")) ?? []).length).toBe(before);
    // The provider block itself is untouched — only endpoints move.
    expect(armed).toContain('provider "aws"');
    expect(armed).toContain("s3_use_path_style");
  });

  it("targets addresses the demo estate actually declares", () => {
    const tf = readdirSync(LEGACY_TF)
      .filter((f) => f.endsWith(".tf"))
      .map((f) => readFileSync(join(LEGACY_TF, f), "utf8"))
      .join("\n");
    for (const target of LIVE_TARGETS) {
      const [type, name] = target.split(".");
      expect(tf, `${target} must exist in legacy-tf`).toContain(`resource "${type}" "${name}"`);
    }
  });

  it("keeps scratch discipline — never the shared names, never the shared port", () => {
    expect(LIVE_CONTAINER).not.toMatch(/^(floci|chant-floci)$/);
    expect(LIVE_PORT).not.toBe(4566);
  });

  it("reads terraform's verdict line and the no-destroy claim", () => {
    const noop = parsePlanOutput("No changes. Your infrastructure matches the configuration.\n", 0);
    expect(noop.changes).toBe(false);
    expect(noop.noDestroy).toBe(true);
    expect(noop.planLine).toContain("No changes.");

    const clean = parsePlanOutput("…\nPlan: 0 to add, 0 to change, 0 to destroy.\n", 2);
    expect(clean.changes).toBe(true);
    expect(clean.noDestroy).toBe(true);
    expect(clean.planLine).toBe("Plan: 0 to add, 0 to change, 0 to destroy.");

    const destroy = parsePlanOutput("Plan: 0 to add, 0 to change, 1 to destroy.\n", 2);
    expect(destroy.noDestroy).toBe(false);

    const silent = parsePlanOutput("", 1);
    expect(silent.planLine).toContain("exited 1");
  });
});
