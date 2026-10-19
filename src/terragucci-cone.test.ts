import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTerragucci, pullRequestPlan, terragucciValidator, type Report } from "./terragucci-reports.ts";
import { coneView, plannedInstances, readCone } from "./terragucci-cone.ts";
import type { TerragucciSource } from "./terragucci-source.ts";

// Report minor 34: three pull request plans of service-b over one base where
// network, service-a and service-b applied on choudoufu. One is a cone (2 of
// 6 blocks), one fell back to a full plan, and one ran another binary and
// carries no cone field at all.
const FIX = join(import.meta.dirname, "__fixtures__", "terragucci-cone");
const ROOTS = ["network", "service-a", "service-b"];

/** The fixture bucket, with `index.json` the given variant's. */
function bucket(variant: "cone" | "fallback" | "plain", reads: string[] = []): TerragucciSource {
  return {
    kind: "dir",
    location: FIX,
    async read(key: string) {
      reads.push(key);
      const file = key === "index.json" ? `index-${variant}.json` : key;
      try {
        return readFileSync(join(FIX, file), "utf8");
      } catch {
        return undefined;
      }
    },
  } as TerragucciSource;
}
const doc = (run: string): Report => JSON.parse(readFileSync(join(FIX, "runs", run, "report.json"), "utf8")) as Report;
const read = (variant: "cone" | "fallback" | "plain", reads?: string[]) => readTerragucci(bucket(variant, reads), { roots: ROOTS, validator: terragucciValidator([]) });

describe("a cone plan from terragucci's report (minor 34)", () => {
  it("names the cone's size, the instances its plan.json planned, the roots it did not plan, and the one live backend", async () => {
    const reads: string[] = [];
    const r = await read("cone", reads);
    expect(r.pull_request!.cone).toEqual({
      roots: [
        {
          root: "service-b",
          kind: "cone",
          base: "origin/main",
          blocks: 2,
          of: 6,
          targets: 2,
          planned: [
            { address: "aws_iam_role_policy.service_b", changed: true },
            { address: "aws_iam_role.service_b", changed: false },
          ],
        },
        { root: "network", kind: "not-planned" },
        { root: "service-a", kind: "not-planned" },
      ],
      backend: { estates: 3 },
    });
    // Each root's binary, by the newest report that names it: a read between two choudoufu roots is of the estate's outputs.
    expect(r.binaries).toEqual({ network: "choudoufu", "service-a": "choudoufu", "service-b": "choudoufu" });
    // The plan.json is read from beside the report, once.
    expect(reads.filter((k) => k.endsWith(".plan.json"))).toEqual(["runs/pr-cone/service-b.plan.json"]);
  });

  it("says why choudoufu's guard planned the whole estate, and reads no plan.json for it", async () => {
    const reads: string[] = [];
    const r = await read("fallback", reads);
    expect(r.pull_request!.cone!.roots[0]).toEqual({ root: "service-b", kind: "full", base: "origin/main", fallback: { kind: "provider-changed", reason: "a provider block changed" } });
    expect(r.pull_request!.cone!.roots.slice(1).map((x) => x.kind)).toEqual(["not-planned", "not-planned"]);
    expect(reads.some((k) => k.endsWith(".plan.json"))).toBe(false);
  });

  it("changes nothing for a plan with no cone field: the pull request stage is the one it always was", async () => {
    const reads: string[] = [];
    const r = await read("plain", reads);
    expect(r.pull_request).toEqual(pullRequestPlan(doc("pr-plain"), "runs/pr-plain/report.html"));
    expect(r.pull_request).not.toHaveProperty("cone");
    expect(reads.some((k) => k.endsWith(".plan.json"))).toBe(false);
  });
});

describe("coneView", () => {
  it("is undefined when no root carries a cone", () => {
    expect(coneView({ roots: [{ path: "a" }, { path: "b", binary: { name: "tofu" } }] }, { roots: ["a", "b", "c"] })).toBeUndefined();
  });

  it("names a root planned beside the cone with no cone of its own as planned", () => {
    const v = coneView({ roots: [{ path: "a", cone: { base: "origin/main", blocks: 1, of: 9 } }, { path: "b" }] }, { roots: ["a", "b"] });
    expect(v!.roots.map((r) => [r.root, r.kind])).toEqual([
      ["a", "cone"],
      ["b", "planned"],
    ]);
  });

  it("claims one live backend only when every root ran choudoufu and none has a state file recorded", () => {
    const d = { roots: [{ path: "a", binary: { name: "choudoufu" }, cone: { base: "x", blocks: 1, of: 3 } }] };
    expect(coneView(d, { roots: ["a", "b"], facts: { b: { binary: "choudoufu" } } })!.backend).toEqual({ estates: 2 });
    expect(coneView(d, { roots: ["a", "b"], facts: { b: { binary: "choudoufu", state: true } } })!.backend).toBeUndefined();
    expect(coneView(d, { roots: ["a", "b"], facts: { b: { binary: "tofu" } } })!.backend).toBeUndefined();
    expect(coneView(d, { roots: ["a", "b"] })!.backend).toBeUndefined();
  });

  it("reads a cone without its counts, and refuses what is not one", () => {
    expect(readCone({ base: "origin/main", targets: 3 })).toEqual({ base: "origin/main", targets: 3 });
    expect(readCone({ blocks: 2 })).toBeUndefined();
    expect(readCone(null)).toBeUndefined();
  });

  it("takes a plan.json's managed instances, not its data sources", () => {
    expect(plannedInstances({ resource_changes: [{ address: "a.b", mode: "managed", change: { actions: ["no-op"] } }, { address: "data.c.d", mode: "data", change: { actions: ["read"] } }] })).toEqual([{ address: "a.b", changed: false }]);
    expect(plannedInstances({})).toEqual([]);
  });
});
