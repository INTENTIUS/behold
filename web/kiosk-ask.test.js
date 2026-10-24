import { describe, expect, it } from "vitest";
import { BEAT_GAP_MS, KEEP, REPLY_PAUSE_MS, TYPE_MS, askBeats, beatTiming, createAskPane, fillReply, playback, replyValues, statusLine, typedChars } from "./kiosk-ask.js";

describe("fillReply (behold#936)", () => {
  it("fills the report's tokens", () => {
    const v = replyValues({ totals: { create: 2, update: 5 }, totals_roots: 3 });
    expect(fillReply("All {roots} states. One plan: {creates} to create, {updates} to change, {deletes} to delete.", v)).toBe("All 3 states. One plan: 2 to create, 5 to change, 0 to delete.");
  });
  it("renders an unknown token, or one without a value, as empty", () => {
    expect(fillReply("a {nope} b {error} c {dependents}.", replyValues(null))).toBe("a  b  c .");
    expect(fillReply("{roots}/{creates}", replyValues({ totals: null }))).toBe("/");
  });
  it("takes the failed root's error and extra tokens (behold#937's dependents)", () => {
    const v = replyValues({ totals: {}, totals_roots: 1 }, "range check", { dependents: 7 });
    expect(fillReply("{error}: {dependents}", v)).toBe("range check: 7");
  });
  it("does not read inherited names", () => {
    expect(fillReply("{constructor}{toString}", {})).toBe("");
  });
  it("returns empty for a missing template", () => {
    expect(fillReply(null, {})).toBe("");
  });
});

describe("typing (behold#936)", () => {
  it("types one character per TYPE_MS", () => {
    expect(typedChars(10, 0)).toBe(0);
    expect(typedChars(10, TYPE_MS * 3 + 1)).toBe(3);
    expect(typedChars(10, 100000)).toBe(10);
    expect(typedChars(10, -5)).toBe(0);
  });
  it("shows everything at once with reduced motion", () => {
    expect(typedChars(10, 0, { reduced: true })).toBe(10);
  });
  it("types at 30 to 50 ms a character", () => {
    expect(TYPE_MS).toBeGreaterThanOrEqual(30);
    expect(TYPE_MS).toBeLessThanOrEqual(50);
  });
});

describe("playback (behold#936)", () => {
  const prompt = { prompt: "abcd", reply: "ok" };
  const action = { action: "approve", reply: null };
  it("types a prompt, then prints its reply after a pause", () => {
    const t = beatTiming(prompt);
    expect(t.replyAt).toBe(4 * TYPE_MS + REPLY_PAUSE_MS);
    let p = playback([prompt], 2 * TYPE_MS);
    expect(p.frames[0]).toMatchObject({ mark: ">", text: "ab", typing: true, replied: false, over: false });
    expect(p.done).toBe(false);
    p = playback([prompt], t.replyAt);
    expect(p.frames[0]).toMatchObject({ text: "abcd", typing: false, replied: true, over: true });
    expect(p.done).toBe(true);
  });
  it("shows an action line at once with a check mark", () => {
    const p = playback([action], 0);
    expect(p.frames[0]).toMatchObject({ mark: "✓", text: "approve", typing: false, over: true });
    expect(p.done).toBe(true);
  });
  it("plays beats in order with a gap", () => {
    const first = beatTiming(prompt).end;
    expect(playback([prompt, action], first).frames).toHaveLength(1);
    expect(playback([prompt, action], first + BEAT_GAP_MS - 1).frames).toHaveLength(1);
    const p = playback([prompt, action], first + BEAT_GAP_MS);
    expect(p.frames).toHaveLength(2);
    expect(p.done).toBe(true);
  });
  it("prints everything at once with reduced motion", () => {
    const p = playback([prompt], 0, { reduced: true });
    expect(p.frames[0]).toMatchObject({ text: "abcd", replied: true, over: true });
  });
  it("plays a note (opening, closing) at once and unmarked", () => {
    expect(playback([{ note: "Hello" }], 0).frames[0]).toMatchObject({ mark: "", text: "Hello", over: true });
  });
});

describe("askBeats and statusLine (behold#936)", () => {
  it("prefers asks, then ask, else none", () => {
    expect(askBeats(null)).toEqual([]);
    expect(askBeats({ ask: null, asks: null })).toEqual([]);
    expect(askBeats({ ask: { prompt: "a" } })).toHaveLength(1);
    expect(askBeats({ ask: { prompt: "a" }, asks: [{ prompt: "b" }, { action: "c" }] })).toHaveLength(2);
  });
  it("keeps a reply with no prompt or action, and gives it no line of its own", () => {
    expect(askBeats({ ask: { prompt: null, action: null, reply: "Applied." } })).toHaveLength(1);
    expect(askBeats({ ask: { prompt: null, action: null, reply: null } })).toEqual([]);
    expect(playback([{ reply: "Applied." }], 600).frames[0]).toMatchObject({ mark: "", text: "", replied: true, over: true });
  });
  it("says what the job is doing, its elapsed time and what is next", () => {
    const d = { step: "approved", started_at: "2026-10-24T10:00:00Z", next: { action: "apply wave-2", at: "2026-10-24T10:01:10Z" } };
    expect(statusLine(d, new Date("2026-10-24T10:01:05Z"))).toBe("Applying the plan · 1:05 · next: apply wave-2 in 5 s");
    expect(statusLine({ ...d, step: "pull-request", next: null }, new Date("2026-10-24T10:00:07Z"))).toBe("Planning the change · 0:07");
  });
  it("has no status where no job runs", () => {
    expect(statusLine({ step: "planned", started_at: "2026-10-24T10:00:00Z", next: null })).toBeNull();
    expect(statusLine(null)).toBeNull();
  });
});

describe("createAskPane (behold#936)", () => {
  function fakeDoc() {
    const make = (tag) => {
      const n = { tag, className: "", textContent: "", children: [], hidden: false, classList: { add() {} }, ownerDocument: null };
      n.append = (...c) => n.children.push(...c);
      n.appendChild = (c) => n.children.push(c);
      n.replaceChildren = (...c) => (n.children = c);
      return n;
    };
    const doc = { createElement: make };
    const host = make("section");
    host.ownerDocument = doc;
    return host;
  }
  const flat = (n) => [n.textContent, ...n.children.map(flat)].join("|");
  const demo = (step, extra = {}) => ({ cycle: 1, scenario: "compose-edit", step, started_at: "2026-10-24T10:00:00Z", next: null, ...extra });
  function make(clock) {
    const events = [];
    const win = { dispatchEvent: (e) => events.push([e.type, e.detail]) };
    const host = fakeDoc();
    let timer = null;
    const pane = createAskPane({ host, win, now: () => new Date(clock.t), fill: () => ({ roots: 3 }), reduced: () => false, setTimer: (f) => ((timer = f), 1), clearTimer: () => (timer = null) });
    return { pane, host, events, tick: () => timer && timer() };
  }
  it("dispatches ask-start, then ask-done when the reply has printed", () => {
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const { pane, host, events, tick } = make(clock);
    const ask = { prompt: "go", reply: "All {roots} states." };
    expect(pane.setStep(demo("planned", { ask }))).toBe(true);
    expect(events.map((e) => e[0])).toEqual(["behold:ask-start"]);
    expect(events[0][1]).toEqual({ ask, step: "planned", scenario: "compose-edit" });
    expect(host.hidden).toBe(false);
    clock.t += 2 * TYPE_MS + REPLY_PAUSE_MS;
    tick();
    expect(events.map((e) => e[0])).toEqual(["behold:ask-start", "behold:ask-done"]);
    expect(flat(host)).toContain("All 3 states.");
  });
  it("dispatches ask-clear on a step with no ask, and hides", () => {
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const { pane, host, events } = make(clock);
    pane.setStep(demo("planned", { ask: { action: "approve" } }));
    expect(pane.setStep(demo("waiting"))).toBe(false);
    expect(events.at(-1)[0]).toBe("behold:ask-clear");
    expect(host.hidden).toBe(true);
  });
  it("does not restart on the same step", () => {
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const { pane, events } = make(clock);
    pane.setStep(demo("planned", { ask: { prompt: "go" } }));
    const n = events.length;
    pane.setStep(demo("planned", { ask: { prompt: "go" } }));
    expect(events).toHaveLength(n);
  });
  it("shows the opening once and the closing at applied, and keeps the last entries faded", () => {
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const { pane, host } = make(clock);
    expect(pane.setStep(demo("pull-request", { opening: "Three states." }))).toBe(true);
    expect(flat(host)).toContain("Three states.");
    expect(pane.setStep(demo("waiting"))).toBe(false);
    pane.setStep(demo("planned", { opening: "Three states.", ask: { action: "approve" } }));
    // Shown once: it is a faded entry above the action now, not printed again.
    expect(flat(host).split("Three states.")).toHaveLength(2);
    pane.setStep(demo("applied", { closing: "3 states. 1 plan." }));
    expect(flat(host)).toContain("3 states. 1 plan.");
    expect(KEEP).toBe(3);
  });
});
