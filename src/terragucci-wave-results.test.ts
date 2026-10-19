import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readTerragucci, waveResult, type Validator } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";

// behold#751: a terragucci wave's result, as its own report says it. The
// fixture is a real fan-out-choudoufu cycle's tf-apply reports, trimmed to the
// run, the roots and the waves: the change's merge (2a615596, run 6745), where
// cluster-a failed in wave 2 and wave 3 applied cluster-b's six apps and
// blocked cluster-a's six, and the fix's merge (5cfbdb79, run 6748). Forgejo
// ended the change's wave 3 job as a failure (terragucci#1161); its report
// says `state: "applied"`.
const FIXTURE = join(import.meta.dirname, "__fixtures__", "terragucci-wave-results");
const CHANGE = "2a615596a4f0ed954bdcaa83f77e575eaf2cb5ab";
const FIX = "5cfbdb79c7a45d4b4d80e4c8e2a200afcc9c225e";
const APPS_A = ["app-01", "app-02", "app-03", "app-04", "app-05", "app-06"];
const APPS_B = ["app-07", "app-08", "app-09", "app-10", "app-11", "app-12"];
const structural = (): Validator => ({ validation: { by: "structural" }, check: (_name, doc) => (doc && typeof doc === "object" ? undefined : "not an object") });

describe("a wave's result from its report (behold#751)", () => {
  it("reads the change's waves: wave 2 failed, wave 3 applied six and blocked six by cluster-a", async () => {
    const r = await readTerragucci(terragucciSource(FIXTURE), { validator: structural() });
    expect(Object.keys(r.results ?? {}).sort()).toEqual([CHANGE, FIX].sort());
    const [w1, w2, w3] = r.results![CHANGE]!;
    expect(w1).toMatchObject({ wave: 1, state: "applied", applied: ["network"], failed: [], blocked: [] });
    expect(w2).toMatchObject({ wave: 2, state: "failed", applied: ["cluster-b"], blocked: [] });
    expect(w2!.failed).toEqual([{ root: "cluster-a", error: expect.stringContaining("QueueAlreadyExists") }]);
    expect(w3).toMatchObject({ wave: 3, state: "applied", applied: APPS_B, unchanged: [], failed: [], finished: "2026-10-19T01:58:52.464Z" });
    expect(w3!.blocked).toEqual(APPS_A.map((root) => ({ root, by: "cluster-a" })));
  });

  it("reads the fix's waves as applied, with nothing blocked", async () => {
    const r = await readTerragucci(terragucciSource(FIXTURE), { validator: structural() });
    expect(r.results![FIX]!.map((w) => [w.wave, w.state, w.applied.length, w.unchanged.length, w.blocked.length])).toEqual([
      [1, "applied", 0, 1, 0],
      [2, "applied", 1, 1, 0],
      [3, "applied", 6, 6, 0],
    ]);
  });

  it("is none for a wave without a state (before report minor 21), and the roots stand in for outcomes", () => {
    expect(waveResult({ number: 2, roots: ["a"], set_digest: null, approval: "not-required" }, "2026-10-19T00:00:00Z")).toBeUndefined();
    expect(waveResult(undefined, "2026-10-19T00:00:00Z")).toBeUndefined();
    const older = waveResult({ number: 3, roots: ["app-07", "app-01"], set_digest: null, approval: "not-required", state: "applied", blocked: [{ root: "app-01", blocked_by: "cluster-a" }] }, "t");
    expect(older).toMatchObject({ applied: ["app-07"], blocked: [{ root: "app-01", by: "cluster-a" }] });
  });
});
