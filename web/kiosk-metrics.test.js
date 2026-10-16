// behold#571: the kiosk's "Pipeline metrics" pane, as words. No DOM: the
// model decides what shows, and an answer with nothing in it shows no pane.
import { describe, expect, it } from "vitest";
import { changeWords, METRICS_STORE, metricsModel, metricsStored, metricsTarget, metricsUrl, percentWords, perWeekWords, secondsWords } from "./kiosk-metrics.js";

const C1 = "9f3c2a71d04e5b8c6a1f2e3d4c5b6a7980716253";
const answer = () => ({
  read: "2026-10-16T00:00:00Z",
  repo: "terragucci-admin/demo",
  project: "forgejo:3000/terragucci-admin/demo",
  run: {
    commit: C1,
    current: true,
    waves: [
      { wave: 1, run: "4101", roots: [{ root: "network", plan_seconds: 6.4, apply_seconds: 2.1 }], changes: { update: 1 }, settled_at: 1000 },
      { wave: 2, run: "4102", roots: [{ root: "app", plan_seconds: 7.2, apply_seconds: 3.4 }], held_seconds: 95, changes: { update: 1, create: 2 }, settled_at: 1200 },
    ],
  },
  dora: { from: "prometheus", deployments_per_week: 30, lead_time_seconds: 900, change_failure_ratio: 0.1 },
});

describe("kiosk metrics: the words", () => {
  it("reads seconds with their unit, short", () => {
    expect([6.44, 48.4, 125, 120, 4800, 3600, 97200].map(secondsWords)).toEqual(["6.4 s", "48 s", "2 min 5 s", "2 min", "1 h 20 min", "1 h", "1 d 3 h"]);
    expect(secondsWords(undefined)).toBeNull();
    expect(secondsWords(-1)).toBeNull();
  });

  it("reads a ratio as a percent, a rate per week, and changes by action in terragucci's order", () => {
    expect([percentWords(0.1), percentWords(0.0833), percentWords(0)]).toEqual(["10%", "8.3%", "0%"]);
    expect(perWeekWords(4.54)).toBe("4.5 a week");
    expect(changeWords({ update: 1, create: 2, delete: 0 })).toBe("2 created, 1 updated");
    expect(changeWords({})).toBeNull();
  });
});

describe("kiosk metrics: what the pane shows", () => {
  it("each wave's roots with their plan and apply time, the gate's hold, what it applied, and the delivery metrics", () => {
    const m = metricsModel(answer());
    expect(m.count).toBe("2 waves · 3 delivery");
    expect(m.run.label).toBe("This run · 9f3c2a71");
    expect(m.run.waves).toEqual([
      { wave: 1, head: "Wave 1", rows: [["network", "plan 6.4 s · apply 2.1 s", "network"], ["Applied", "1 updated"]] },
      { wave: 2, head: "Wave 2", rows: [["app", "plan 7.2 s · apply 3.4 s", "app"], ["Held at the gate", "1 min 35 s"], ["Applied", "2 created, 1 updated"]] },
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
    a.run.waves = [{ wave: 2, run: "4101", roots: [{ root: "app", plan_seconds: 7.9 }], changes: {}, waiting_since: Date.parse("2026-10-16T14:05:00") / 1000 }];
    expect(metricsModel(a).run.waves[0].rows).toEqual([["app", "plan 7.9 s", "app"], ["Waiting since", "14:05"]]);
  });

  it("shows no pane for no answer, a refusal, or nothing for the repo; a part with no number is left out", () => {
    expect(metricsModel(null)).toBeNull();
    expect(metricsModel({ error: "behold reads no Prometheus" })).toBeNull();
    expect(metricsModel({ repo: "x/y", project: null, run: null, dora: null })).toBeNull();
    expect(metricsModel({ run: { commit: C1, current: true, waves: [{ wave: 1, roots: [], changes: {} }] }, dora: null })).toBeNull();
    const onlyDora = metricsModel({ run: null, dora: { from: "dora.json", restore_seconds: 600 } });
    expect(onlyDora).toEqual({ count: "1 delivery", run: null, dora: [["Time to restore", "10 min"]] });
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
