import { describe, expect, it } from "vitest";
import { DEFAULT_TIPS, TIP_FADE_MS, TIP_MIN_MS, createTipSequencer } from "./kiosk-ask-tips.js";

function rig(opts = {}) {
  const log = [];
  let t = 0;
  const timers = [];
  const seq = createTipSequencer({
    show: (tip) => log.push(["show", tip.title, t]),
    hide: () => log.push(["hide", t]),
    setTimer: (f, ms) => {
      const x = { f, at: t + ms };
      timers.push(x);
      return x;
    },
    clearTimer: (x) => {
      const i = timers.indexOf(x);
      if (i >= 0) timers.splice(i, 1);
    },
    ...opts,
  });
  const advance = (ms) => {
    const to = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      t = next.at;
      next.f();
    }
    t = to;
  };
  return { seq, log, advance };
}
const tips = [1, 2, 3].map((n) => ({ title: `T${n}`, body: `B${n}` }));
const busy = (id, extra = {}) => ({ busy: true, id, cycle: 1, scenario: "s", step: "applying", tips: null, ...extra });
const idle = { busy: false, id: null, tips: null };

describe("tip cards: timing", () => {
  it("shows one card at once and keeps it at least 7 s before the next replaces it", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips }));
    expect(log).toEqual([["show", "T1", 0]]);
    advance(TIP_MIN_MS - 1);
    expect(log).toHaveLength(1);
    advance(1);
    expect(log.slice(1)).toEqual([["show", "T2", TIP_MIN_MS]]);
    advance(TIP_MIN_MS);
    expect(log.map((x) => x[1])).toEqual(["T1", "T2", "T3"]);
    // One at a time: replacing never hides, and the last card stays however long the step lasts.
    advance(60_000);
    expect(log.filter((x) => x[0] === "hide")).toHaveLength(0);
    expect(log).toHaveLength(3);
  });
  it("hides the card when the busy line ends, and stops the sequence", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips }));
    advance(3_000);
    seq.busy(idle);
    expect(log.slice(1)).toEqual([["hide", 3_000]]);
    advance(60_000);
    expect(log).toHaveLength(2);
  });
  it("hides at once when the next turn's busy line replaces the step's", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips }));
    advance(1_000);
    seq.busy(busy("b", { tips: [{ title: "N", body: "n" }] }));
    expect(log.slice(1)).toEqual([["hide", 1_000], ["show", "N", 1_000]]);
  });
  it("ignores a repeat of the same busy line, and tips with no title or body", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips: [{ title: "", body: "x" }, { title: "ok", body: "y" }] }));
    seq.busy(busy("a", { tips }));
    advance(TIP_MIN_MS * 3);
    expect(log).toEqual([["show", "ok", 0]]);
  });
  it("shows nothing while the Tips switch is off, and drops the card when it turns off", () => {
    let on = false;
    const { seq, log, advance } = rig({ enabled: () => on });
    seq.busy(busy("a", { tips }));
    expect(log).toEqual([]);
    on = true;
    seq.busy(busy("b", { tips }));
    advance(2_000);
    on = false;
    seq.off();
    advance(TIP_MIN_MS * 2);
    expect(log.map((x) => x[0])).toEqual(["show", "hide"]);
  });
  it("a card the viewer closed ends the sequence without a second hide", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a", { tips }));
    seq.dismiss();
    advance(TIP_MIN_MS * 2);
    seq.busy(idle);
    expect(log).toEqual([["show", "T1", 0]]);
  });
});

describe("tip cards: the built-in three", () => {
  it("shows them in order for a step without tips, and never repeats a card within the scenario cycle", () => {
    const { seq, log, advance } = rig();
    seq.busy(busy("a"));
    advance(TIP_MIN_MS);
    seq.busy(idle);
    expect(log.filter((x) => x[0] === "show").map((x) => x[1])).toEqual(["Across estates", "terragucci"]);
    seq.busy(busy("b"));
    advance(TIP_MIN_MS * 5);
    expect(log.filter((x) => x[0] === "show").map((x) => x[1])).toEqual(["Across estates", "terragucci", "choudoufu"]);
    seq.busy(idle);
    seq.busy(busy("c"));
    expect(log.filter((x) => x[0] === "show")).toHaveLength(3);
    // The next cycle starts over.
    seq.busy(busy("d", { cycle: 2 }));
    expect(log.filter((x) => x[0] === "show").pop()[1]).toBe("Across estates");
  });
  it("leaves a step's own tips to that step, and uses no other product's name", () => {
    const { seq, log } = rig();
    seq.busy(busy("a", { tips }));
    seq.busy(idle);
    seq.busy(busy("b"));
    expect(log.filter((x) => x[0] === "show").pop()[1]).toBe("Across estates");
    const words = DEFAULT_TIPS.map((t) => `${t.title} ${t.body}`).join(" ");
    expect(words).not.toMatch(/atomic|transaction/i);
    expect(DEFAULT_TIPS).toHaveLength(3);
  });
  it("fades well inside 400 ms", () => {
    expect(TIP_FADE_MS).toBeLessThan(400);
  });
});
