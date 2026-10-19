// behold#787: on /kiosk a visitor replays a step already past, or the failure, and goes back to live.
import { describe, expect, it } from "vitest";
import { BACK_WORDS, FAILURE_WORDS, REPLAY_IDLE_MS, askedLine, drawResult, replayOver, viewerReplay } from "./kiosk.js";
import { REPLAY_LAST_HOLD_MS } from "./kiosk-vendor.js";

const fakeDocument = () => {
  const make = (tag) => {
    const n = { tagName: tag, className: "", textContent: "", children: [], dataset: {}, style: {}, hidden: false, attrs: {}, on: {} };
    n.appendChild = (c) => (n.children.push(c), c);
    n.append = (...cs) => cs.forEach((c) => n.children.push(c));
    n.replaceChildren = () => (n.children = []);
    n.setAttribute = (k, v) => (n.attrs[k] = v);
    n.addEventListener = (ev, fn) => (n.on[ev] = fn);
    return n;
  };
  return { createElement: make };
};
const withDocument = (fn) => {
  const was = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    return fn();
  } finally {
    globalThis.document = was;
  }
};

const steps = [
  { at: "2026-10-19T20:05:36Z", step: "pull-request" },
  { at: "2026-10-19T20:06:47Z", step: "applying" },
  { at: "2026-10-19T20:08:30Z", step: "failed" },
  { at: "2026-10-19T20:12:12Z", step: "applied" },
  { at: "2026-10-19T20:14:09Z", step: "reset" },
];

describe("a replay the viewer asked for (behold#787)", () => {
  it("is the one the live poll leaves alone; a tool page's own replay is not", () => {
    expect(viewerReplay({ mode: "replay", replay: { asked: true } })).toBe(true);
    expect(viewerReplay({ mode: "replay", replay: { asked: false } })).toBe(false);
    expect(viewerReplay({ mode: "live", replay: null })).toBe(false);
    expect(viewerReplay(null)).toBe(false);
  });

  it("ends at the cycle's end, or after a while with no input", () => {
    const toApplied = Date.parse(steps[3].at) - Date.parse(steps[0].at);
    const toReset = Date.parse(steps[4].at) - Date.parse(steps[0].at);
    expect(replayOver(steps, toApplied, 0)).toBe(false);
    expect(replayOver(steps, toReset, 0)).toBe(true);
    expect(replayOver(steps, toReset + REPLAY_LAST_HOLD_MS - 1, 0)).toBe(true);
    expect(replayOver(steps, 0, REPLAY_IDLE_MS)).toBe(false);
    expect(replayOver(steps, 0, REPLAY_IDLE_MS + 1)).toBe(true);
    expect(replayOver([], 0, 0)).toBe(true);
  });

  it("says it is a replay, with a button back to live", () =>
    withDocument(() => {
      let back = 0;
      const p = askedLine({ replay: { banner: "Replay of the run at 20:05 UTC" }, backToLive: () => back++ });
      expect(p.className).toBe("k-replay k-replay-asked");
      expect(p.children.map((c) => c.textContent)).toEqual(["Replay of the run at 20:05 UTC", BACK_WORDS]);
      p.children[1].on.click();
      expect(back).toBe(1);
    }));

  it("puts a Replay the failure chip on the done card when the cycle failed", () =>
    withDocument(() => {
      const host = document.createElement("aside");
      const model = { head: "Applied", counts: ["3 waves applied"], waves: [] };
      let seek = null;
      drawResult(host, model, { waveTraces: {}, failureAt: () => "2026-10-19T20:08:00Z", seekTo: (at) => (seek = at) });
      const chip = host.children.find((c) => c.className === "k-result-replay");
      expect(chip.textContent).toBe(FAILURE_WORDS);
      host.on.click({ target: { closest: (sel) => (sel === ".k-result-replay" ? chip : null) } });
      expect(seek).toBe("2026-10-19T20:08:00Z");
      // A cycle with no failure: no chip.
      drawResult(host, model, { waveTraces: {}, failureAt: () => null });
      expect(host.children.some((c) => c.className === "k-result-replay")).toBe(false);
    }));
});
