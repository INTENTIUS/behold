import { describe, expect, it } from "vitest";
import { CHANT_DEMO_READS, TERRAGUCCI_READS, pageSource, readsFor } from "./kiosk-source.js";
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
