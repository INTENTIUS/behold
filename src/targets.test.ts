import { describe, it, expect } from "vitest";
import { resolveSubstrateTargets, targetEnvOverrides, SUBSTRATE_TARGET_VARS } from "./targets.ts";

describe("resolveSubstrateTargets (#99)", () => {
  it("resolves each declared substrate to its own endpoint", () => {
    const targets = resolveSubstrateTargets(["aws", "azure"], {
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AZURE_ENDPOINT_URL: "http://localhost:4577",
    });
    expect(targets).toEqual([
      { name: "aws", label: "Floci", endpoint: "http://localhost:4566", envVar: "AWS_ENDPOINT_URL" },
      { name: "azure", label: "floci-az", endpoint: "http://localhost:4577", envVar: "AZURE_ENDPOINT_URL" },
    ]);
  });

  // #125. chant#1209 moved GCP observation onto the applier's direct-REST
  // transport, which reads GCP_ENDPOINT_URL — until that landed, listing gcp
  // here would have been behold claiming a routing chant could not perform.
  it("resolves a gcp project to floci-gcp", () => {
    const targets = resolveSubstrateTargets(["gcp"], { GCP_ENDPOINT_URL: "http://localhost:4588" });
    expect(targets).toEqual([
      { name: "gcp", label: "floci-gcp", endpoint: "http://localhost:4588", envVar: "GCP_ENDPOINT_URL" },
    ]);
  });

  // The shape chant#1211's E·gcp asserts: the GKE cluster and the workload on
  // it, each substrate pointed at its own emulator.
  it("resolves a mixed aws+gcp estate to both endpoints", () => {
    const targets = resolveSubstrateTargets(["aws", "gcp"], {
      AWS_ENDPOINT_URL: "http://localhost:4566",
      GCP_ENDPOINT_URL: "http://localhost:4588",
    });
    expect(targets.map((t) => [t.name, t.endpoint])).toEqual([
      ["aws", "http://localhost:4566"],
      ["gcp", "http://localhost:4588"],
    ]);
  });

  it("ignores a substrate the project does not declare", () => {
    // The variable being set in the shell says nothing about this project.
    const targets = resolveSubstrateTargets(["azure"], {
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AZURE_ENDPOINT_URL: "http://localhost:4577",
    });
    expect(targets.map((t) => t.name)).toEqual(["azure"]);
  });

  it("omits a declared substrate with no endpoint rather than reporting an empty one", () => {
    // Unset means real cloud — a target behold does not name and cannot redirect.
    expect(resolveSubstrateTargets(["aws", "azure"], { AWS_ENDPOINT_URL: "http://localhost:4566" })).toHaveLength(1);
  });

  it("returns nothing for a project whose substrates resolve from chant.config", () => {
    // k8s and temporal bind from config, not an ambient variable — there is
    // nothing for behold to override and nothing to show.
    expect(resolveSubstrateTargets(["k8s", "temporal"], { AWS_ENDPOINT_URL: "x" })).toEqual([]);
  });

  // Replaces "does not claim a gcp target before chant can honour one", whose
  // premise expired when chant#1209 landed (#125). The rule it was guarding is
  // the real invariant and still holds: an entry here must name a variable
  // chant's read path actually honours. gcp now does — `GCP_ENDPOINT_URL`, in
  // the lexicon's `describe-resources.ts` and `deep-observe.ts`.
  it("names gcp's endpoint variable, now that chant honours one", () => {
    expect(SUBSTRATE_TARGET_VARS.find((v) => v.lexicon === "gcp")?.envVar).toBe("GCP_ENDPOINT_URL");
  });

  // The substrate strip surfaces floci-gcp on :4588 (`detectSubstrates`), so a
  // missing entry here left behold offering an emulator it could not aim at.
  it("covers every substrate the strip can bring up", () => {
    for (const lexicon of ["aws", "azure", "gcp"]) {
      expect(SUBSTRATE_TARGET_VARS.some((v) => v.lexicon === lexicon)).toBe(true);
    }
  });
});

describe("targetEnvOverrides (#99)", () => {
  const targets = resolveSubstrateTargets(["aws", "azure"], {
    AWS_ENDPOINT_URL: "http://localhost:4566",
    AZURE_ENDPOINT_URL: "http://localhost:4577",
  });

  it("points each substrate at its own endpoint", () => {
    expect(targetEnvOverrides(targets)).toEqual({
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AZURE_ENDPOINT_URL: "http://localhost:4577",
    });
  });

  it("an explicit choice still overrides every substrate — pre-#99 `?target=` behaviour", () => {
    expect(targetEnvOverrides(targets, "http://elsewhere:9999")).toEqual({
      AWS_ENDPOINT_URL: "http://elsewhere:9999",
      AZURE_ENDPOINT_URL: "http://elsewhere:9999",
    });
  });

  it("a single-substrate project is unchanged by any of this", () => {
    const awsOnly = resolveSubstrateTargets(["aws"], { AWS_ENDPOINT_URL: "http://localhost:4566" });
    expect(targetEnvOverrides(awsOnly)).toEqual({ AWS_ENDPOINT_URL: "http://localhost:4566" });
  });
});

describe("envOverridesFor with substrate targets (#99)", () => {
  it("points each substrate at its own endpoint through a chant shell-out", async () => {
    const { envOverridesFor } = await import("./chant.ts");
    const substrateTargets = resolveSubstrateTargets(["aws", "azure"], {
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AZURE_ENDPOINT_URL: "http://localhost:4577",
    });
    expect(envOverridesFor({ substrateTargets })).toEqual({
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AZURE_ENDPOINT_URL: "http://localhost:4577",
    });
  });

  it("a chosen target still overrides every substrate", async () => {
    const { envOverridesFor } = await import("./chant.ts");
    const substrateTargets = resolveSubstrateTargets(["aws", "azure"], {
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AZURE_ENDPOINT_URL: "http://localhost:4577",
    });
    expect(envOverridesFor({ substrateTargets, target: "http://elsewhere:9999" })).toEqual({
      AWS_ENDPOINT_URL: "http://elsewhere:9999",
      AZURE_ENDPOINT_URL: "http://elsewhere:9999",
    });
  });

  it("a caller that resolved no substrates keeps the pre-#99 single variable", async () => {
    const { envOverridesFor } = await import("./chant.ts");
    expect(envOverridesFor({ target: "http://localhost:4566" })).toEqual({
      AWS_ENDPOINT_URL: "http://localhost:4566",
    });
  });
});
