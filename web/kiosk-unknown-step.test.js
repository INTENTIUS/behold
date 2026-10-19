import { describe, expect, it } from "vitest";
import { STRIP, renderKiosk, stripStops } from "./kiosk.js";
import { captionModel, stepTone } from "./kiosk-watch.js";
import { cycleTrack, trackModel } from "./kiosk-track.js";

// behold#752 (chant#4102): a step can be added within demo-step contract 1, so a step the kiosk doesn't know is
// unclassified: shown by its own name, lighting no stop, never breaking the page.
const UNKNOWN = "rolling-back";
const demo = (step, extra = {}) => ({ cycle: 610, scenario: "fan-out", title: "A broken stack shouldn't stall the whole rollout", step, label: "The driver does something new.", started_at: "2026-10-19T02:25:07Z", next: null, pull: 774, commit: "80eef4a5e0eb747fddb04a7067e91ea59dd8dade", tool: "chant-fanout", repo: "chant-demo/fan-out-estate", ...extra });

describe("a step the kiosk doesn't know (behold#752)", () => {
  it("lights no stop of the strip and takes a running tone", () => {
    expect(stripStops(UNKNOWN, STRIP).every((s) => s.state === "ahead")).toBe(true);
    expect(stepTone(UNKNOWN)).toBe("busy");
  });
  it("is captioned by its own name, with the driver's label", () => {
    const c = captionModel(demo(UNKNOWN, { chapter: { n: 3, of: 4, headline: "The fix", short: "The fix" } }), { now: new Date("2026-10-19T02:27:05Z") });
    expect(c.step).toMatchObject({ word: UNKNOWN, text: "The driver does something new.", id: UNKNOWN });
  });
  it("leaves the projected track drawn from the last cycle, with nothing current", () => {
    const T = (s) => `2026-10-19T02:${s}Z`;
    const cycle = { cycle: 610, started: T("25:07"), ended: T("27:37"), steps: [
      { at: T("25:09"), step: "pull-request", pull: 773 },
      { at: T("25:20"), step: "planned", pull: 773 },
      { at: T("25:48"), step: "applying", pull: 773 },
      { at: T("26:00"), step: UNKNOWN, pull: 773 },
      { at: T("26:12"), step: "failed", pull: 773 },
      { at: T("27:37"), step: "reset", pull: null },
    ] };
    const track = cycleTrack(cycle);
    const now = Date.parse(T("40:00"));
    const m = trackModel(track, { demo: demo(UNKNOWN, { pull: 773 }), pulls: [773], since: now - 1000, now });
    expect(m).toBeTruthy();
  });
  it("renders in the bar, its row named by the step", () => {
    const make = (tag) => {
      const n = { tagName: tag, className: "", textContent: "", children: [] };
      n.appendChild = (c) => (n.children.push(c), c);
      n.append = (...cs) => cs.forEach((c) => n.children.push(typeof c === "string" ? { tagName: "#text", textContent: c, children: [] } : c));
      n.replaceChildren = () => (n.children = []);
      return n;
    };
    const find = (n, cls) => (n.className.split(" ").includes(cls) ? [n] : []).concat(...(n.children || []).map((c) => (c.className !== undefined ? find(c, cls) : [])));
    const was = globalThis.document;
    globalThis.document = { createElement: make };
    try {
      const bar = document.createElement("header");
      const s = { demo: { source: "fx", read: "2026-10-19T02:27:05Z", demo: demo(UNKNOWN) }, answer: null, progress: null };
      expect(() => renderKiosk(bar, s, new Date("2026-10-19T02:27:05Z"))).not.toThrow();
      const row = find(bar, "k-row-step")[0];
      expect(row.className).toContain(`k-step-${UNKNOWN}`);
      expect(row.children[0].textContent).toBe(UNKNOWN);
      expect(find(bar, "k-stop").length).toBeGreaterThan(0);
    } finally {
      globalThis.document = was;
    }
  });
});
