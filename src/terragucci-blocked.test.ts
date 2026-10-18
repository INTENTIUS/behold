import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTerragucci, waveBlocked, waveOutcomes, waveRootNames, type Validator } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";

// behold#741 (terragucci#1161): a tf-apply wave's report carries the roots an
// upstream that did not apply held, `waves[].blocked: [{ root, blocked_by }]`
// (report minor 41), and behold reads them from the newest apply's waves.
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const PROJECT = "forgejo.local/demo/fan-out";
const MERGE = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";

type Row = { root?: string; path?: string; outcome?: string; error?: string };
function bucket(waves: { wave: number; roots: (string | Row)[]; state: string; blocked?: { root: string; blocked_by: string }[]; outcomes?: Row[]; finished: string; commit?: string }[]): string {
  const d = mkdtempSync(join(tmpdir(), "behold-tg-blocked-"));
  made.push(d);
  const rows = waves.map((w, i) => {
    const path = `${PROJECT}/run-${i}`;
    mkdirSync(join(d, path), { recursive: true });
    const report = {
      schema: "terragucci.report/v1",
      minor: w.blocked ? 41 : 40,
      run: { project: PROJECT, commit: w.commit ?? MERGE, stage: "tf-apply", wave: w.wave, finished: w.finished },
      roots: waveRootNames({ roots: w.roots }).map((path) => ({ path, status: "planned", changes: [] })),
      waves: [{ number: w.wave, roots: w.roots, set_digest: null, approval: "not-required", state: w.state, ...(w.blocked ? { blocked: w.blocked } : {}), ...(w.outcomes ? { outcomes: w.outcomes } : {}) }],
    };
    writeFileSync(join(d, path, "report.json"), JSON.stringify(report));
    return { project: PROJECT, commit: w.commit ?? MERGE, stage: "tf-apply", wave: w.wave, finished: w.finished, path };
  });
  writeFileSync(join(d, "index.json"), JSON.stringify({ schema: "terragucci.report-index/v1", reports: rows }));
  return d;
}
/** behold's own structural check, whatever terragucci package is installed beside it. */
const structural = (): Validator => ({ validation: { by: "structural" }, check: (_name, doc) => (doc && typeof doc === "object" ? undefined : "not an object") });

describe("a wave report's blocked roots (behold#741)", () => {
  it("reads each row as { root, by }, and skips a malformed one", () => {
    expect(waveBlocked({ blocked: [{ root: "app-01", blocked_by: "cluster-a" }, { root: "", blocked_by: "x" }, { root: "app-02" } as never] })).toEqual([{ root: "app-01", by: "cluster-a" }]);
    expect(waveBlocked({})).toEqual([]);
    expect(waveBlocked(undefined)).toEqual([]);
  });

  it("folds the newest apply's waves' blocked roots, each wave by its newest report", async () => {
    const d = bucket([
      { wave: 1, roots: ["network"], state: "applied", finished: "2026-10-18T10:00:01.000Z" },
      { wave: 2, roots: ["cluster-a", "cluster-b"], state: "failed", finished: "2026-10-18T10:00:05.000Z" },
      { wave: 3, roots: ["app-04"], state: "applied", blocked: [{ root: "app-01", blocked_by: "cluster-a" }, { root: "app-02", blocked_by: "cluster-a" }], finished: "2026-10-18T10:00:09.000Z" },
      // A wave of the run before: not the newest apply's.
      { wave: 3, roots: [], state: "blocked", blocked: [{ root: "app-09", blocked_by: "network" }], finished: "2026-10-17T10:00:09.000Z", commit: "0ld0ld0ld0ld" },
    ]);
    const r = await readTerragucci(terragucciSource(d), { validator: structural() });
    expect(r.blocked).toEqual({ commit: MERGE, roots: { "app-01": { wave: 3, by: "cluster-a" }, "app-02": { wave: 3, by: "cluster-a" } } });
  });

  it("is absent for reports without the field, as they were read before", async () => {
    const d = bucket([
      { wave: 1, roots: ["network"], state: "applied", finished: "2026-10-18T10:00:01.000Z" },
      { wave: 2, roots: ["cluster-a"], state: "failed", finished: "2026-10-18T10:00:05.000Z" },
    ]);
    const r = await readTerragucci(terragucciSource(d), { validator: structural() });
    expect("blocked" in r).toBe(false);
  });

  it("is absent for reports without the field: no outcomes", async () => {
    const d = bucket([{ wave: 2, roots: ["cluster-a"], state: "failed", finished: "2026-10-18T10:00:05.000Z" }]);
    const r = await readTerragucci(terragucciSource(d), { validator: structural() });
    expect("outcomes" in r).toBe(false);
  });
});

// behold#741: each root's own apply outcome, in either shape asked of terragucci#1164 until its field is named.
describe("a wave report's per-root outcomes (behold#741)", () => {
  it("reads waves[].roots[].outcome, the roots still read by name", () => {
    const w = { roots: [{ root: "cluster-a", outcome: "failed", error: "subnet is full" }, { root: "cluster-b", outcome: "applied" }, "network"] };
    expect(waveOutcomes(w)).toEqual([{ root: "cluster-a", outcome: "failed", error: "subnet is full" }, { root: "cluster-b", outcome: "applied" }]);
    expect(waveRootNames(w)).toEqual(["cluster-a", "cluster-b", "network"]);
  });

  it("reads waves[].outcomes: [{ root, outcome, error }], and skips any other outcome", () => {
    const w = { roots: ["cluster-a", "cluster-b"], outcomes: [{ root: "cluster-a", outcome: "failed", error: "subnet is full" }, { root: "cluster-b", outcome: "unchanged", error: "ignored" }, { root: "x", outcome: "exploded" }] };
    expect(waveOutcomes(w)).toEqual([{ root: "cluster-a", outcome: "failed", error: "subnet is full" }, { root: "cluster-b", outcome: "unchanged" }]);
    expect(waveOutcomes({ roots: ["a"] })).toEqual([]);
  });

  it("folds the newest apply's outcomes from either shape", async () => {
    const d = bucket([
      { wave: 1, roots: [{ root: "network", outcome: "applied" }], state: "applied", finished: "2026-10-18T10:00:01.000Z" },
      { wave: 2, roots: ["cluster-a", "cluster-b"], outcomes: [{ root: "cluster-a", outcome: "failed", error: "subnet is full" }, { root: "cluster-b", outcome: "applied" }], state: "failed", finished: "2026-10-18T10:00:05.000Z" },
    ]);
    const r = await readTerragucci(terragucciSource(d), { validator: structural() });
    expect(r.outcomes).toEqual({ commit: MERGE, roots: { network: { wave: 1, outcome: "applied" }, "cluster-a": { wave: 2, outcome: "failed", error: "subnet is full" }, "cluster-b": { wave: 2, outcome: "applied" } } });
  });
});
