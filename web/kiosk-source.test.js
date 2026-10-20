import { describe, expect, it } from "vitest";
import { CHANT_DEMO_READS, CI_RUNS_READS, TERRAGUCCI_READS, pageRuns, pageSource, readsFor, runsReadsFor } from "./kiosk-source.js";
import { startMetrics } from "./kiosk-metrics.js";

// behold#752: a kiosk page reads terragucci's loop unless the server tells it chant's demo is its source.
const docWith = (content) => ({ querySelector: (q) => (q === 'meta[name="kiosk-source"]' && content !== null ? { getAttribute: () => content } : null) });

describe("where a kiosk page reads its demo (behold#752)", () => {
  it("a page without the tag reads terragucci's loop, as every page did before", () => {
    expect(pageSource(docWith(null))).toBeNull();
    expect(readsFor(pageSource(docWith(null)))).toBe(TERRAGUCCI_READS);
    expect(TERRAGUCCI_READS).toMatchObject({ demo: "/api/terragucci/demo", runs: "/api/terragucci/runs", own: false });
    expect(TERRAGUCCI_READS.cycle("chant-fanout")).toBe("/api/terragucci/cycles/chant-fanout");
    expect(TERRAGUCCI_READS.run(7)).toBe("/api/terragucci/runs/7");
  });
  it("a page told `chant-demo` reads chant's records, and nothing of terragucci's", () => {
    const r = readsFor(pageSource(docWith("chant-demo")));
    expect(r).toBe(CHANT_DEMO_READS);
    expect([r.demo, r.cycle("chant-fanout"), r.runs, r.run(61002)]).toEqual(["/api/chant/demo", "/api/chant/demo/cycle", "/api/chant/demo/runs", "/api/chant/demo/runs/61002"]);
    expect(r.own).toBe(true);
    expect(JSON.stringify([r.demo, r.cycle("x"), r.runs, r.run(1)])).not.toMatch(/terragucci/);
  });
  it("an unknown source name is no source", () => {
    expect(pageSource(docWith("elsewhere"))).toBeNull();
  });
  it("the metrics pane asks the page's own demo", async () => {
    const host = { hidden: true, replaceChildren() {}, appendChild() {}, classList: { toggle() {} } };
    const doc = { createElement: () => ({ classList: { toggle() {} }, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, appendChild() {} }), body: null, head: null, getElementById: () => null };
    const asked = async (reads) => {
      const urls = [];
      const fetchJson = async (url) => (urls.push(url), { error: "none" });
      const m = startMetrics(host, { tool: "chant-fanout", ...(reads ? { reads } : {}), fetchJson, store: { getItem: () => "closed", setItem() {} }, setTimer: () => 0, clearTimer() {}, doc });
      await m.tick();
      return urls;
    };
    expect(await asked(null)).toEqual(["/api/terragucci/demo", "/api/terragucci/cycles/chant-fanout"]);
    expect(await asked(CHANT_DEMO_READS)).toEqual(["/api/chant/demo", "/api/chant/demo/cycle"]);
  });
});

// behold#815: with --ci-report-url, the runs pane alone reads chant's run index.
const runsDoc = (content) => ({ querySelector: (q) => (q === 'meta[name="kiosk-runs"]' && content !== null ? { getAttribute: () => content } : null) });

describe("where the runs pane reads its runs (behold#815)", () => {
  it("a page without the tag reads the source's runs, the forge's or chant's demo's", () => {
    expect(pageRuns(runsDoc(null))).toBeNull();
    expect(runsReadsFor(null, TERRAGUCCI_READS)).toEqual({ runs: "/api/terragucci/runs", run: TERRAGUCCI_READS.run });
    expect(runsReadsFor(null, CHANT_DEMO_READS).runs).toBe("/api/chant/demo/runs");
  });
  it("a page told `chant-ci` reads chant's run index, whatever its source, and says so in the sidebar", () => {
    expect(pageRuns(runsDoc("chant-ci"))).toBe("chant-ci");
    for (const reads of [TERRAGUCCI_READS, CHANT_DEMO_READS]) expect(runsReadsFor("chant-ci", reads)).toBe(CI_RUNS_READS);
    expect([CI_RUNS_READS.runs, CI_RUNS_READS.run("chant-1792376662004"), CI_RUNS_READS.run("a/b")]).toEqual(["/api/chant/ci/runs", "/api/chant/ci/runs/chant-1792376662004", "/api/chant/ci/runs/a%2Fb"]);
    expect(CI_RUNS_READS.from).toBe("From chant's run index, newest first.");
    expect(pageRuns(runsDoc("forge"))).toBeNull();
  });
});
