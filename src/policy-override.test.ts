import { describe, expect, it } from "vitest";
import { overrideCommand, policyOverride } from "./policy-override.ts";

const pending = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, kind: "pending", op: "policy-override", gate: "envs/prod/vpc", timestamp: "2026-10-08T11:00:00.000Z", expiresAt: "2026-10-15T11:00:00.000Z", planDigest: "sha256:aaaa", plan: "sha256:1111", rules: ["no-public-subnets", "b-rule"], ...over });
const gate = { gate: "envs/prod/vpc", planDigest: "sha256:aaaa", env: null, signed: false, recordedAt: "2026-10-08T11:00:00.000Z", approved: false };

describe("policyOverride (#519)", () => {
  it("reads the rules and plan of the denial status judged, and gives chant's command bound to the digest", () => {
    const o = policyOverride(gate, { ledger: pending() + "\n", applied: "", source: "chant/lifecycle:_gates/policy-override.jsonl" }, null);
    expect(o.rules).toEqual(["b-rule", "no-public-subnets"]);
    expect(o.plan).toBe("sha256:1111");
    expect(o.state).toBe("waiting");
    expect(o.command).toBe('chant approve policy-override envs/prod/vpc --rule b-rule --rule no-public-subnets --reason "<why>" --plan sha256:aaaa');
  });

  it("gives the product's command when the product is known", () => {
    expect(overrideCommand({ subject: "envs/prod/vpc", rules: ["r"], digest: "sha256:aaaa", env: null, signed: true, product: "terragucci" })).toBe('npx terragucci override envs/prod/vpc --rule r --reason "<why>" --sign');
    expect(overrideCommand({ subject: "migrate-prod/revert-7", rules: ["r"], digest: null, env: "prod", signed: false, product: "sql-yodeler" })).toBe('npx yodel override prod --rule r --reason "<why>" --revert 7');
  });

  it("reads an override a run applied under as spent", () => {
    const applied = JSON.stringify({ version: 1, kind: "applied", op: "policy-override", gate: "envs/prod/vpc", planDigest: "sha256:aaaa", approvedAt: "2026-10-08T11:05:00.000Z", approvedBy: "dana", timestamp: "2026-10-08T11:10:00.000Z" });
    const o = policyOverride({ ...gate, approved: true }, { ledger: pending(), applied, source: null }, null);
    expect(o.state).toBe("spent");
    expect(o.spentAt).toBe("2026-10-08T11:10:00.000Z");
  });

  it("leaves the rules unnamed when the ledger can't be read", () => {
    const o = policyOverride(gate, { ledger: "", applied: "", source: null }, null);
    expect(o.rules).toEqual([]);
    expect(o.command).toContain("--rule <id>");
  });
});
