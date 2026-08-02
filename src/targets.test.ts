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

  it("does not claim a gcp target before chant can honour one", () => {
    // chant#1209 has not landed; listing gcp here would be behold claiming a
    // routing it cannot perform.
    expect(SUBSTRATE_TARGET_VARS.some((v) => v.lexicon === "gcp")).toBe(false);
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
