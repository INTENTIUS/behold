// behold#571: the kiosk's "Pipeline metrics" pane, as words. No DOM: the
// model decides what shows, and an answer with nothing in it shows no pane.
import { describe, expect, it } from "vitest";
import { changeWords, METRICS_STORE, metricsModel, metricsStored, metricsTarget, metricsUrl, percentWords, perWeekWords, secondsWords, steadyModel, startMetrics } from "./kiosk-metrics.js";

const C1 = "9f3c2a71d04e5b8c6a1f2e3d4c5b6a7980716253";
const answer = () => ({
  read: "2026-10-16T00:00:00Z",
  repo: "terragucci-admin/demo",
  project: "forgejo:3000/terragucci-admin/demo",
  run: {
    commit: C1,
    current: true,
    waves: [
      { wave: 1, run: "4101", seconds: 5.36, roots: [{ root: "network", init_seconds: 0.163, plan_seconds: 0.07, apply_seconds: 0.06 }], changes: { update: 1 }, settled_at: 1000 },
      { wave: 2, run: "4102", roots: [{ root: "app", plan_seconds: 7.2, apply_seconds: 3.4 }], held_seconds: 95, changes: { update: 1, create: 2 }, settled_at: 1200 },
    ],
  },
  dora: { from: "prometheus", deployments_per_week: 30, lead_time_seconds: 900, change_failure_ratio: 0.1 },
});

describe("kiosk metrics: the words", () => {
  it("reads seconds with their unit, short", () => {
    expect([0.07, 0.0004, 0.999, 6.44, 48.4, 125, 120, 4800, 3600, 97200].map(secondsWords)).toEqual(["70 ms", "1 ms", "999 ms", "6.4 s", "48 s", "2 min 5 s", "2 min", "1 h 20 min", "1 h", "1 d 3 h"]);
    expect(secondsWords(undefined)).toBeNull();
    expect(secondsWords(-1)).toBeNull();
  });

  it("reads a ratio as a percent, a rate per week, and changes by action in terragucci's order", () => {
    expect([percentWords(0.1), percentWords(0.0833), percentWords(0)]).toEqual(["10%", "8.3%", "0%"]);
    expect([percentWords(1 / 4235), percentWords(0.0004), percentWords(0.001)]).toEqual(["0.02%", "0.04%", "0.1%"]);
    expect(perWeekWords(4.54)).toBe("4.5 a week");
    expect(changeWords({ update: 1, create: 2, delete: 0 })).toBe("2 created, 1 updated");
    expect(changeWords({ "no-op": 2, read: 1, replace: 1 })).toBe("1 replaced");
    expect(changeWords({ "no-op": 2 })).toBeNull();
    expect(changeWords({})).toBeNull();
  });
});

describe("kiosk metrics: what the pane shows", () => {
  it("each wave's roots with their plan and apply time, the gate's hold, what it applied, and the delivery metrics", () => {
    const m = metricsModel(answer());
    expect(m.count).toBe("2 waves · 3 delivery");
    expect(m.run.label).toBe("This run · 9f3c2a71");
    expect(m.run.waves).toEqual([
      { wave: 1, head: "Wave 1", took: "5.4 s in all", rows: [["network", "init 163 ms · plan 70 ms · apply 60 ms", "network"], ["Applied", "1 updated"]], seconds: "5.4 s", held: null, changed: "1 updated", secondsRaw: 5.36, heldRaw: null, changesRaw: { update: 1 } },
      { wave: 2, head: "Wave 2", took: null, rows: [["app", "plan 7.2 s · apply 3.4 s", "app"], ["Held at the gate", "1 min 35 s"], ["Applied", "2 created, 1 updated"]], seconds: null, held: "1 min 35 s", changed: "2 created, 1 updated", secondsRaw: null, heldRaw: 95, changesRaw: { update: 1, create: 2 } },
    ]);
    expect(m.dora).toEqual([["Deploys", "30 a week"], ["Lead time", "15 min"], ["Change failure rate", "10%"]]);
  });

  it("names a run that is not the kiosk's commit as the latest, and a run with no commit by none", () => {
    const a = answer();
    a.run.current = false;
    expect(metricsModel(a).run.label).toBe("Latest run · 9f3c2a71");
    a.run.commit = null;
    expect(metricsModel(a).run.label).toBe("Latest run");
  });

  it("a waiting wave says since when, by the viewer's clock", () => {
    const a = answer();
    a.run.waves = [{ wave: 2, run: "4101", roots: [{ root: "app", plan_seconds: 7.9, lock_wait_seconds: 1.5 }], changes: {}, waiting_since: Date.parse("2026-10-16T14:05:00") / 1000 }];
    expect(metricsModel(a).run.waves[0].rows).toEqual([["app", "lock wait 1.5 s · plan 7.9 s", "app"], ["Waiting since", "14:05"]]);
  });

  it("shows no pane for no answer, a refusal, or nothing for the repo; a part with no number is left out", () => {
    expect(metricsModel(null)).toBeNull();
    expect(metricsModel({ error: "behold reads no Prometheus" })).toBeNull();
    expect(metricsModel({ repo: "x/y", project: null, run: null, dora: null })).toBeNull();
    expect(metricsModel({ run: { commit: C1, current: true, waves: [{ wave: 1, roots: [], changes: {} }] }, dora: null })).toBeNull();
    const onlyDora = metricsModel({ run: null, dora: { from: "dora.json", restore_seconds: 600 } });
    expect(onlyDora).toEqual({ count: "1 delivery", run: null, dora: [["Time to restore", "10 min"]] });
  });

  it("puts demo.json's delivery line over the delivery numbers, and only when there are numbers (behold#571)", () => {
    const line = "Counted from this demo loop's own runs, where the failure scenario fails on purpose each cycle.";
    expect(metricsModel(answer(), ` ${line}`).note).toBe(line);
    expect(metricsModel(answer(), null).note).toBeUndefined();
    expect(metricsModel(answer(), "  ").note).toBeUndefined();
    const noDora = { ...answer(), dora: null };
    expect(metricsModel(noDora, line).note).toBeUndefined();
    expect(metricsModel(noDora, line).dora).toBeNull();
  });
});

describe("kiosk metrics: which repo, and the fold", () => {
  it("follows the narration's repo and commit; on a tool's page while another tool runs, that tool's newest cycle's repo", () => {
    const demo = { demo: { repo: "terragucci-admin/demo", commit: C1, tool: "terraform" } };
    expect(metricsTarget(demo, null, null)).toEqual({ repo: "terragucci-admin/demo", commit: C1 });
    expect(metricsTarget(demo, null, "terraform")).toEqual({ repo: "terragucci-admin/demo", commit: C1 });
    expect(metricsTarget(demo, { cycle: { repo: "terragucci-admin/demo-terragrunt" } }, "terragrunt")).toEqual({ repo: "terragucci-admin/demo-terragrunt", commit: null });
    expect(metricsTarget({ demo: null }, null, null)).toBeNull();
  });

  it("asks for the repo by project, and the commit only when it is a commit", () => {
    expect(metricsUrl({ repo: "terragucci-admin/demo", commit: C1 })).toBe(`/api/metrics?project=terragucci-admin%2Fdemo&commit=${C1}`);
    expect(metricsUrl({ repo: "terragucci-admin/demo", commit: "main" })).toBe("/api/metrics?project=terragucci-admin%2Fdemo");
  });

  it("keeps the viewer's fold, and has none when they never chose or storage refuses", () => {
    const shelf = (v) => ({ getItem: (k) => (k === METRICS_STORE ? v : null) });
    expect(metricsStored(shelf("open"))).toBe(true);
    expect(metricsStored(shelf("closed"))).toBe(false);
    expect(metricsStored(shelf(null))).toBeNull();
    expect(metricsStored({ getItem: () => { throw new Error("denied"); } })).toBeNull();
  });
});

describe("kiosk metrics: a pane that stays put through a cycle (behold#571)", () => {
  const full = () => metricsModel(answer());
  const doraOnly = () => metricsModel({ ...answer(), run: null });

  it("keeps the last model when a read in the same cycle, or a failed read, has less in it", () => {
    expect(steadyModel(full(), null, { same: true })).toEqual(full());
    expect(steadyModel(full(), null, { failed: true })).toEqual(full());
    const kept = steadyModel(full(), doraOnly(), { same: true });
    expect(kept.run).toEqual(full().run);
    expect(kept.count).toBe("2 waves · 3 delivery");
  });

  it("takes a new cycle's model as it comes, nothing included", () => {
    expect(steadyModel(full(), null, { same: false })).toBeNull();
    expect(steadyModel(full(), doraOnly(), { same: false })).toEqual(doraOnly());
    expect(steadyModel(null, doraOnly(), { same: true })).toEqual(doraOnly());
  });

  it("never hides the pane between the steps of one cycle, whatever the reads answer", async () => {
    const C2 = "1111111111111111111111111111111111111111";
    // Cycle 7 steps through a pull request (no run of its commit yet), a failed read, and the merge's run.
    const reads = [
      { step: "pull-request", commit: C2, metrics: { ...answer(), run: { ...answer().run, current: false } } },
      { step: "planned", commit: C2, metrics: { error: "/api/metrics answered 502" } },
      { step: "merged", commit: C1, metrics: { ...answer(), run: null, dora: null } },
      { step: "applying", commit: C1, metrics: answer() },
    ];
    let i = 0;
    const fetchJson = async (url) => {
      const r = reads[Math.min(i, reads.length - 1)];
      if (url === "/api/terragucci/demo") return { demo: { repo: "terragucci-admin/demo", cycle: 7, step: r.step, commit: r.commit } };
      return r.metrics;
    };
    const shown = [];
    const host = { hidden: true, replaceChildren() {}, appendChild() {}, classList: { toggle() {} } };
    const doc = { createElement: () => ({ classList: { toggle() {} }, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, appendChild() {} }), body: null, head: null, getElementById: () => null };
    const m = startMetrics(host, { fetchJson, store: { getItem: () => "closed", setItem() {} }, setTimer: () => 0, clearTimer() {}, doc });
    await new Promise((r) => setTimeout(r)); // the first read, which the pane starts by itself
    shown.push(m.model() !== null);
    for (i = 1; i < reads.length; i++) {
      await m.tick();
      shown.push(m.model() !== null);
    }
    expect(shown).toEqual([true, true, true, true]);
    // Before: the failed read and the merge's empty answer each hid the pane for a step.
    expect(m.model().run.current).toBe(true);
  });
});
