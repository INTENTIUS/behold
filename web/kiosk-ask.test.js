import { describe, expect, it } from "vitest";
import { BEAT_GAP_MS, CURSOR_PAUSE_MS, FLASH_MS, KEEP, REPLY_PAUSE_MS, REPLY_TYPE_MS, TYPE_MS, askBeats, askEventHelp, askMode, askShot, beatTiming, createAskPane, elapsedSecs, fillReply, firstSentence, hasAsk, paneHeight, playback, replyValues, statusText, typedChars } from "./kiosk-ask.js";

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
  it("types a prompt at about 65 ms a character after a 600 ms cursor, and a reply at about 25", () => {
    expect(TYPE_MS).toBe(65);
    expect(CURSOR_PAUSE_MS).toBe(600);
    expect(REPLY_TYPE_MS).toBe(25);
    expect(FLASH_MS).toBe(700);
  });
});

describe("playback (behold#936)", () => {
  const prompt = { prompt: "abcd", reply: "okay" };
  const action = { action: "approve", reply: null };
  it("pauses on the cursor, types a prompt, pauses, then types the reply", () => {
    const t = beatTiming(prompt);
    expect(t.cursor).toBe(CURSOR_PAUSE_MS);
    expect(t.replyAt).toBe(CURSOR_PAUSE_MS + 4 * TYPE_MS + REPLY_PAUSE_MS);
    expect(t.end).toBe(t.replyAt + 4 * REPLY_TYPE_MS);
    let p = playback([prompt], CURSOR_PAUSE_MS - 1);
    expect(p.frames[0]).toMatchObject({ mark: ">", text: "", typing: true, replied: false });
    p = playback([prompt], CURSOR_PAUSE_MS + 2 * TYPE_MS);
    expect(p.frames[0]).toMatchObject({ text: "ab", typing: true, replied: false, over: false });
    expect(p.done).toBe(false);
    p = playback([prompt], t.replyAt + 2 * REPLY_TYPE_MS);
    expect(p.frames[0]).toMatchObject({ text: "abcd", typing: false, replied: true, replyChars: 2, replyTyping: true, over: false });
    p = playback([prompt], t.end);
    expect(p.frames[0]).toMatchObject({ replyChars: 4, replyTyping: false, over: true });
    expect(p.done).toBe(true);
  });
  it("times a reply by its filled text when it is known", () => {
    expect(beatTiming(prompt, { reply: "a much longer reply" }).end).toBe(beatTiming(prompt).replyAt + 19 * REPLY_TYPE_MS);
  });
  it("shows an action line at once with a check mark", () => {
    const p = playback([action], 0);
    expect(p.frames[0]).toMatchObject({ mark: "✓", text: "approve", typing: false, over: true });
    expect(p.done).toBe(true);
  });
  it("plays beats in order with a gap", () => {
    const first = beatTiming(prompt).end;
    expect(playback([prompt, action], first).frames).toHaveLength(1);
    expect(playback([prompt, action], first + BEAT_GAP_MS).frames).toHaveLength(2);
  });
  it("prints everything at once with reduced motion", () => {
    const p = playback([prompt], 0, { reduced: true });
    expect(p.frames[0]).toMatchObject({ text: "abcd", replied: true, replyChars: 4, over: true });
    expect(p.done).toBe(true);
  });
  it("plays a note (opening, closing) at once and unmarked", () => {
    expect(playback([{ note: "Three states." }], 0).frames[0]).toMatchObject({ mark: "", text: "Three states.", typing: false, over: true });
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
    expect(playback([{ reply: "Applied." }], 600 + 9 * REPLY_TYPE_MS).frames[0]).toMatchObject({ mark: "", text: "", replied: true, over: true });
  });
  it("keeps a status alone as a beat", () => {
    expect(askBeats({ ask: { status: "Applying." } })).toHaveLength(1);
    expect(hasAsk({ ask: { status: "Applying." } })).toBe(true);
  });
  it("takes the status from the ask, else the label's first sentence, else none", () => {
    expect(statusText({ ask: { status: "Applying wave 1." }, label: "x" })).toBe("Applying wave 1.");
    expect(statusText({ asks: [{ prompt: "p", status: "Waiting" }], label: "x" })).toBe("Waiting");
    expect(statusText({ label: "The plan is merged. Applying next." })).toBe("The plan is merged");
    expect(statusText({ label: "Applying" })).toBe("Applying");
    expect(statusText({ ask: { prompt: "p" }, label: "Planned." })).toBeNull();
    expect(statusText({ closing: "Done.", label: "Applied." })).toBeNull();
    expect(statusText(null)).toBeNull();
  });
  it("cuts a label at its first sentence", () => {
    expect(firstSentence("Three estates. One apply.")).toBe("Three estates");
    expect(firstSentence("v1.2 is out")).toBe("v1.2 is out");
    expect(firstSentence(null)).toBe("");
  });
  it("counts seconds from the step's start, never below zero", () => {
    const t = Date.parse("2026-10-24T10:01:05Z");
    expect(elapsedSecs({ started_at: "2026-10-24T10:00:00Z" }, t, 0)).toBe(65);
    expect(elapsedSecs({ started_at: "2026-10-24T10:02:00Z" }, t, 0)).toBe(0);
    expect(elapsedSecs({}, t, t - 7000)).toBe(7);
  });
});

describe("createAskPane (behold#936)", () => {
  function fakeDoc() {
    const make = (tag) => {
      const n = { tag, className: "", textContent: "", children: [], hidden: false, classList: { add: (c) => n.classes.push(c), remove: (c) => (n.classes = n.classes.filter((x) => x !== c)) }, classes: [], offsetWidth: 0, ownerDocument: null };
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
    const pane = createAskPane({ host, win, now: () => new Date(clock.t), fill: () => ({ roots: 3 }), reduced: () => false, later: () => {}, setTimer: (f) => ((timer = f), 1), clearTimer: () => (timer = null) });
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
    expect(host.classes).toContain("ask-flash");
    // The reply has started but is still typing: the graph must not light yet.
    clock.t += CURSOR_PAUSE_MS + 2 * TYPE_MS + REPLY_PAUSE_MS + 3 * REPLY_TYPE_MS;
    tick();
    expect(events.map((e) => e[0])).toEqual(["behold:ask-start"]);
    expect(flat(host)).toContain("All");
    expect(flat(host)).not.toContain("All 3 states.");
    clock.t += 30 * REPLY_TYPE_MS;
    tick();
    expect(events.map((e) => e[0])).toEqual(["behold:ask-start", "behold:ask-done"]);
    expect(flat(host)).toContain("All 3 states.");
  });
  it("keeps the pane on a step with no ask: ask-clear, the transcript and a status line from the label", () => {
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const { pane, host, events } = make(clock);
    pane.setStep(demo("planned", { ask: { action: "approve" } }));
    expect(pane.setStep(demo("merged", { label: "The plan is merged. Applying next." }))).toBe(true);
    expect(events.map((e) => e[0])).toContain("behold:ask-clear");
    expect(host.hidden).toBe(false);
    expect(flat(host)).toContain("approve");
    expect(flat(host)).toContain("The plan is merged");
    expect(flat(host)).not.toContain("Applying next");
    expect(flat(host)).toContain("0:00");
    const st = events.filter((e) => e[0] === "behold:ask-status");
    expect(st).toEqual([["behold:ask-status", { status: "The plan is merged", step: "merged", scenario: "compose-edit" }]]);
  });
  it("shows an ask's status once its beats are over, with a timer that counts", () => {
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const { pane, host, events, tick } = make(clock);
    pane.setStep(demo("applying", { ask: { action: "You approve.", status: "Applying across estates." } }));
    expect(flat(host)).toContain("Applying across estates.");
    clock.t += 65000;
    tick();
    expect(flat(host)).toContain("1:05");
    expect(events.filter((e) => e[0] === "behold:ask-status")).toHaveLength(1);
    expect(pane.setStep(demo("resumed", { ask: { status: "Resuming." } }))).toBe(true);
    expect(flat(host)).toContain("Resuming.");
  });
  it("hides at a reset, and when the scenario changes to one without an ask", () => {
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const { pane, host } = make(clock);
    pane.setStep(demo("planned", { ask: { action: "approve" } }));
    expect(pane.setStep(null)).toBe(false);
    expect(host.hidden).toBe(true);
    pane.setStep(demo("planned", { ask: { action: "approve" } }));
    expect(pane.setStep(demo("merged", { scenario: "other", label: "x" }))).toBe(false);
    expect(host.hidden).toBe(true);
  });
  it("shows a pane that was never given an ask on a plain scenario only after one", () => {
    const clock = { t: Date.parse("2026-10-24T10:00:00Z") };
    const { pane } = make(clock);
    expect(pane.setStep(demo("merged", { label: "x" }))).toBe(false);
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
    expect(pane.setStep(demo("waiting"))).toBe(true);
    pane.setStep(demo("planned", { opening: "Three states.", ask: { action: "approve" } }));
    // Shown once: it is a faded entry above the action now, not printed again.
    expect(flat(host).split("Three states.")).toHaveLength(2);
    pane.setStep(demo("applied", { closing: "3 states. 1 plan." }));
    expect(flat(host)).toContain("3 states. 1 plan.");
    expect(KEEP).toBe(3);
  });
});

describe("ask mode (behold#939)", () => {
  it("is on only while the pane shows in Watch", () => {
    expect(askMode({ askOn: true, watchMode: true })).toBe(true);
    expect(askMode({ askOn: true, watchMode: false })).toBe(false);
    expect(askMode({ askOn: false, watchMode: true })).toBe(false);
    expect(askMode(null)).toBe(false);
  });

  it("knows a step with a beat from one without", () => {
    expect(hasAsk({ ask: { prompt: "p" } })).toBe(true);
    expect(hasAsk({ asks: [{ reply: "r" }] })).toBe(true);
    expect(hasAsk({ ask: null, asks: null, opening: "o" })).toBe(false);
    expect(hasAsk(null)).toBe(false);
  });

  it("quiets event-help in ask mode: no bubble, modal, strip, waiting line or result", () => {
    const h = { watch: true, held: false, hideTrail: false, waiting: { key: "k" }, result: { counts: ["3 created"] }, label: "x" };
    expect(askEventHelp(h, true)).toEqual({ ...h, held: true, hideTrail: true, waiting: null, result: null });
    expect(askEventHelp(h, false)).toBe(h);
  });

  it("turns any step's shot into the whole graph, asked to fill, in ask mode only", () => {
    const shot = { id: "3|planned|change|app", kind: "change", roots: ["app"], waves: [2], whole: false };
    expect(askShot(shot, true)).toEqual({ id: shot.id, kind: "whole", roots: [], waves: [], whole: true, ask: true });
    expect(askShot(shot, false)).toBe(shot);
  });

  it("keeps the pane from shrinking within a scenario", () => {
    expect(paneHeight(0, 120)).toBe(120);
    expect(paneHeight(200, 120)).toBe(200);
    expect(paneHeight(200, NaN)).toBe(200);
  });
});
