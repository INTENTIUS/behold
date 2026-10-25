import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SIDE_STORE, applyParts, detailsModel, jobTone, keepSide, runTrace, sideState, sideStored } from "./kiosk-side.js";

// The three-root estate of behold#937 (src/__fixtures__/terragucci-demo-ask), built as web/kiosk-light.test.js builds it.
const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "terragucci-demo-ask");
const read = (f) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const report = read("report-pull-request.json");
function answerOf(r) {
  const roots = r.roots.map((x) => ({ member: "demo", name: x.path, path: x.path }));
  const cards = {};
  for (const root of r.roots) {
    for (const c of root.changes) {
      cards[`demo/${root.path}/${c.address}`] = [{ verdict: "plan", action: c.action, addresses: [c.address], values: (c.attributes || []).map((a) => ({ ...a, address: c.address })) }];
    }
  }
  const reads = r.roots.flatMap((x) => (x.reads || []).map((rd) => ({ ...rd, root: x.path })));
  return { roots, cards, unmatched: { roots: [], changes: [] }, pull_request: { roots: r.roots.map((x) => x.path), reads, blast: r.blast, waves: r.waves } };
}
const answer = answerOf(report);
const progressOf = (run) => ({ states: run.waves.map((w) => ({ number: w.number, state: w.state, roots: w.roots, composed: w.composed })), reads: run.roots.map((x) => ({ root: x.root, wave: x.wave, reads: x.reads, stateKey: x.state && x.state.key })) });

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};
const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };

describe("the side pane's place", () => {
  it("shows in ask mode on anything wider than a phone, open until the viewer folds it", () => {
    expect(sideState({ ask: true, phone: false, open: true })).toBe("open");
    expect(sideState({ ask: true, phone: false, open: false })).toBe("folded");
    expect(sideState({ ask: true, phone: true, open: true })).toBe("none");
    expect(sideState({ ask: false, phone: false, open: true })).toBe("none");
  });

  it("remembers a fold in localStorage, and a storage that throws neither breaks nor folds it", () => {
    const store = memory();
    expect(sideStored(store)).toBe(true);
    keepSide(store, false);
    expect(store.m.get(SIDE_STORE)).toBe("closed");
    expect(sideStored(store)).toBe(false);
    keepSide(store, true);
    expect(sideStored(store)).toBe(true);
    expect(() => keepSide(throwing, false)).not.toThrow();
    expect(sideStored(throwing)).toBe(true);
    expect(sideStored(null)).toBe(true);
  });
});

describe("the act's run as a trace", () => {
  const t = (s) => `2026-10-25T04:2${s}Z`;
  const runs = [
    { id: 9, cycle: 471, trigger: "merge", event: "push", created_at: "2026-10-25T04:24:14Z", jobs: [{ id: 2, name: "plan", status: "skipped" }, { id: 3, name: "apply", status: "success", started_at: "2026-10-25T04:24:14.000Z", ended_at: "2026-10-25T04:24:28.000Z" }] },
    { id: 8, cycle: 471, trigger: "plan", event: "pull_request", created_at: "2026-10-25T04:23:24Z", jobs: [{ id: 1, name: "plan", status: "success", started_at: "2026-10-25T04:23:25.000Z", ended_at: "2026-10-25T04:23:35.000Z" }, { id: 4, name: "apply", status: "skipped" }] },
    { id: 7, cycle: 470, trigger: "merge", created_at: t("0:00"), jobs: [{ id: 5, name: "apply", status: "success", started_at: t("0:00"), ended_at: t("0:10") }] },
  ];

  it("lists this act's plan, its approval and its apply, in order, with their times", () => {
    const tr = runTrace(runs, { cycle: 471, step: "applied" }, { now: Date.parse("2026-10-25T04:25:00Z") });
    expect(tr.rows.map((r) => [r.label, r.tone, r.ms])).toEqual([
      ["plan", "done", 10_000],
      ["approval", "done", 39_000],
      ["apply", "done", 14_000],
    ]);
    expect(tr.from).toBe(Date.parse("2026-10-25T04:23:25Z"));
    expect(tr.to).toBe(Date.parse("2026-10-25T04:24:28Z"));
  });

  it("times a running job and a waiting approval up to now", () => {
    const now = Date.parse("2026-10-25T04:24:00Z");
    const tr = runTrace([runs[1]], { cycle: 471, step: "planned" }, { now });
    expect(tr.rows.map((r) => [r.label, r.tone, r.ms])).toEqual([["plan", "done", 10_000], ["approval", "waiting", 25_000]]);
    expect(tr.to).toBe(now);
    const running = [{ ...runs[1], jobs: [{ id: 1, name: "plan", status: "running", started_at: "2026-10-25T04:23:25.000Z", ended_at: null }] }];
    const r2 = runTrace(running, { cycle: 471, step: "pull-request" }, { now });
    expect(r2.rows).toHaveLength(1);
    expect(r2.rows[0]).toMatchObject({ label: "plan", tone: "running", ms: 35_000, end: null });
  });

  it("is empty before the act has a run, and without a step", () => {
    expect(runTrace(runs, { cycle: 472, step: "pull-request" }).rows).toEqual([]);
    expect(runTrace(runs, null).rows).toEqual([]);
  });

  it("puts each estate's part under the apply, from the run view", () => {
    const progress = progressOf(read("run-applied.json"));
    const parts = applyParts(answer, progress);
    expect(parts.map((p) => p.label)).toEqual(["network", "app", "edge"]);
    expect(parts.every((p) => p.tone === "done" && p.words === "applied")).toBe(true);
    const tr = runTrace(runs, { cycle: 471, step: "applied" }, { answer, progress });
    expect(tr.rows.filter((r) => r.depth === 1).map((r) => r.label)).toEqual(["network", "app", "edge"]);
  });

  it("names a job's tone", () => {
    expect(["success", "running", "failure", "waiting", "skipped"].map(jobTone)).toEqual(["done", "running", "failed", "waiting", "skipped"]);
  });
});

describe("the card about the current line", () => {
  it("names what the line lights: the resource, its estate, and its lines", () => {
    const d = detailsModel(answer, null, { light: ["network/terraform_data.subnet"] });
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ name: "subnet", type: "terraform_data", action: "create", estate: "network" });
    expect(d.items[0].lines[0]).toMatchObject({ state: "unknown" });
    expect(d.estates).toEqual([{ name: "network", words: "state network.tfstate", written: false }]);
  });

  it("follows the paths downstream, at most three items, and says how many more", () => {
    const d = detailsModel(answer, null, { light: ["network/terraform_data.subnet"], paths: true });
    expect(d.items).toHaveLength(3);
    expect(d.more).toBe(3);
    expect(d.estates.map((e) => e.name).sort()).toEqual(["app", "edge", "network"]);
  });

  it("says which estate's record was written once the run view has it", () => {
    const progress = progressOf(read("run-applied.json"));
    const d = detailsModel({ ...answer, binaries: { network: "choudoufu", app: "choudoufu", edge: "choudoufu" } }, progress, { light: ["network/terraform_data.subnet"] });
    expect(d.estates[0]).toMatchObject({ name: "network", written: true });
    expect(d.estates[0].words).toContain("records written");
  });

  it("is empty for a line that lights nothing", () => {
    expect(detailsModel(answer, null, null)).toBeNull();
    expect(detailsModel(answer, null, { prompt: "hi" })).toBeNull();
    expect(detailsModel(answer, null, { light: ["network/terraform_data.nope"] })).toBeNull();
    expect(detailsModel({ error: "x" }, null, { light: ["network/terraform_data.subnet"] })).toBeNull();
  });
});
