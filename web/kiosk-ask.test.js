import { describe, expect, it } from "vitest";
import { EMPH_MS, newestLine, DIFF_MS, diffLines, diffParts, BEAT_GAP_MS, BUSY_MIN_MS, CURSOR_PAUSE_MS, ELLIPSIS_MS, KEEP, REPLY_TYPE_MS, SPINNER, TYPE_MS, askBeats, busyLabel, ellipsisAt, mergeTurns, settleTurns, spinnerAt, askEventHelp, askMode, askShot, beatTiming, createAskPane, elapsedSecs, fillReply, firstSentence, hasAsk, paneHeight, playback, replyValues, statusText, typedChars } from "./kiosk-ask.js";

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
  it("types a prompt at about 90 ms a character after a 600 ms cursor, and a reply at about 35", () => {
    expect(TYPE_MS).toBe(90);
    expect(CURSOR_PAUSE_MS).toBe(600);
    expect(REPLY_TYPE_MS).toBe(35);
    expect(BUSY_MIN_MS).toBe(1200);
    expect(ELLIPSIS_MS).toBe(400);
  });
});

describe("playback: the turn states (ready, typing, busy, replied)", () => {
  const prompt = { prompt: "abcd", reply: "okay" };
  const action = { action: "approve", reply: null };
  it("is ready on the cursor's pause, then typing, then busy for at least 1.2 s, then replied", () => {
    const t = beatTiming(prompt);
    expect(t.cursor).toBe(CURSOR_PAUSE_MS);
    expect(t.busyAt).toBe(CURSOR_PAUSE_MS + 4 * TYPE_MS);
    expect(t.replyAt - t.busyAt).toBe(BUSY_MIN_MS);
    expect(t.end).toBe(t.replyAt + 4 * REPLY_TYPE_MS);
    let f = playback([prompt], CURSOR_PAUSE_MS - 1).frames[0];
    expect(f).toMatchObject({ mark: ">", text: "", typing: true, ready: true, busy: false, replied: false });
    f = playback([prompt], CURSOR_PAUSE_MS + 2 * TYPE_MS).frames[0];
    expect(f).toMatchObject({ text: "ab", typing: true, ready: false, busy: false });
    f = playback([prompt], t.busyAt).frames[0];
    expect(f).toMatchObject({ text: "abcd", typing: false, busy: true, replied: false, sumSecs: null });
    f = playback([prompt], t.replyAt - 1).frames[0];
    expect(f).toMatchObject({ busy: true, replied: false });
    f = playback([prompt], t.replyAt + 2 * REPLY_TYPE_MS).frames[0];
    expect(f).toMatchObject({ busy: false, sumSecs: 1, replied: true, replyChars: 2, replyTyping: true, over: false });
    const p = playback([prompt], t.end);
    expect(p.frames[0]).toMatchObject({ replyChars: 4, replyTyping: false, over: true });
    expect(p.done).toBe(true);
  });
  it("times a reply by its filled text when it is known", () => {
    expect(beatTiming(prompt, { reply: "a much longer reply" }).end).toBe(beatTiming(prompt).replyAt + 19 * REPLY_TYPE_MS);
  });
  it("shows an action line at once with a check mark, busy while its reply is pending", () => {
    const p = playback([action], 0);
    expect(p.frames[0]).toMatchObject({ mark: "✓", text: "approve", typing: false, ready: false, busy: true, over: true });
    expect(p.done).toBe(true);
    expect(playback([{ action: "go", reply: "ok" }], 100).frames[0]).toMatchObject({ busy: true, replied: false });
  });
  it("plays beats in order with a gap, and the earlier busy line ends when the next beat begins", () => {
    const first = beatTiming(prompt).end;
    let p = playback([prompt, action], first);
    expect(p.frames).toHaveLength(1);
    expect(p.gap).toBe(true);
    p = playback([prompt, action], first + BEAT_GAP_MS);
    expect(p.frames).toHaveLength(2);
    expect(p.gap).toBe(false);
    const open = playback([action, prompt], BEAT_GAP_MS + 10);
    expect(open.frames[0]).toMatchObject({ busy: false, sumSecs: 2 });
  });
  it("prints everything at once with reduced motion, with no busy phase", () => {
    const p = playback([prompt], 0, { reduced: true });
    expect(p.frames[0]).toMatchObject({ text: "abcd", ready: false, busy: false, replied: true, replyChars: 4, over: true });
    expect(p.done).toBe(true);
  });
  it("plays a note (opening, closing) at once and unmarked, never busy", () => {
    expect(playback([{ note: "Three states." }], 0).frames[0]).toMatchObject({ mark: "", text: "Three states.", typing: false, busy: false, over: true });
  });
});

describe("the busy line's pieces", () => {
  it("cycles the spinner glyph and steps the ellipsis every 400 ms", () => {
    expect(SPINNER).toEqual(["✻", "✶", "✳", "✢", "·"]);
    expect(new Set(SPINNER.map((_, i) => spinnerAt(i * 140))).size).toBe(5);
    expect([0, 400, 800, 1200].map((t) => ellipsisAt(t))).toEqual([".", "..", "...", "."]);
  });
  it("is still under reduced motion", () => {
    expect([0, 140, 5000].map((t) => spinnerAt(t, true))).toEqual(["✻", "✻", "✻"]);
    expect([0, 400, 800].map((t) => ellipsisAt(t, true))).toEqual(["…", "…", "…"]);
  });
  it("drops a closing full stop or ellipsis from the label", () => {
    expect(busyLabel("Applying across estates.")).toBe("Applying across estates");
    expect(busyLabel("Planning…")).toBe("Planning");
    expect(busyLabel("")).toBe("Working");
  });
  it("lets a lone reply or a status continue the last turn, and settles busy lines into summaries", () => {
    const t = mergeTurns([{ mark: ">", text: "a", parts: [] }], [{ cont: true, parts: [{ k: "reply", text: "r" }] }, { mark: ">", text: "b", parts: [] }]);
    expect(t.map((x) => x.text)).toEqual(["a", "b"]);
    expect(t[0].parts).toHaveLength(1);
    const s = settleTurns([{ mark: ">", text: "a", ready: true, typing: true, parts: [{ k: "busy", label: "Applying", since: 1000 }] }], 36000);
    expect(s[0]).toMatchObject({ ready: false, typing: false, parts: [{ k: "sum", label: "Applying", secs: 35 }] });
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

describe("createAskPane: a session of turns", () => {
  function fakeDoc() {
    const make = (tag) => {
      const n = { tag, className: "", textContent: "", children: [], hidden: false, attrs: {}, classes: [], offsetWidth: 0, ownerDocument: null, style: {} };
      n.classList = { add: (c) => n.classes.push(c), remove: (c) => (n.classes = n.classes.filter((x) => x !== c)), toggle: (c, on) => (on ? (n.classes.includes(c) ? 0 : n.classes.push(c)) : (n.classes = n.classes.filter((x) => x !== c))) };
      n.setAttribute = (k, v) => (n.attrs[k] = v);
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
  const T0 = Date.parse("2026-10-24T10:00:00Z");
  const demo = (step, extra = {}) => ({ cycle: 1, scenario: "compose-edit", step, started_at: "2026-10-24T10:00:00Z", next: null, ...extra });
  const names = (events) => events.map((e) => e[0]).filter((n) => n !== "behold:ask-busy" && n !== "behold:ask-line" && n !== "behold:ask-light");
  function make(clock, reduced = false) {
    const events = [];
    const win = { dispatchEvent: (e) => events.push([e.type, e.detail]) };
    const host = fakeDoc();
    let timer = null;
    const pane = createAskPane({ host, win, now: () => new Date(clock.t), fill: () => ({ roots: 3 }), reduced: () => reduced, setTimer: (f) => ((timer = f), 1), clearTimer: () => (timer = null) });
    return { pane, host, events, tick: () => timer && timer() };
  }
  const entries = (host) => host.children.map((c) => c.className).filter((c) => !c.includes("ask-ready-line"));

  it("goes ready, typing, busy, replied; ask-done only after the reply has typed", () => {
    const clock = { t: T0 };
    const { pane, host, events, tick } = make(clock);
    const ask = { prompt: "go", status: "Planning network, app and edge", reply: "All {roots} states." };
    expect(pane.setStep(demo("planned", { ask }))).toBe(true);
    // 1. ready: the edge is lit, an empty prompt line waits with its cursor.
    expect(names(events)).toEqual(["behold:ask-hold", "behold:ask-start"]);
    expect(host.classes).toContain("ask-ready");
    expect(flat(host)).toContain(">|");
    expect(host.children[0].classes).toContain("ask-waiting");
    // 2. typing: the light dims.
    clock.t += CURSOR_PAUSE_MS + TYPE_MS + 1;
    tick();
    expect(host.classes).not.toContain("ask-ready");
    expect(flat(host)).toContain("g");
    expect(host.children[0].classes).toContain("ask-typing");
    // 3. busy: the label, for at least 1.2 s, and no reply yet.
    clock.t += TYPE_MS + 50;
    tick();
    let text = flat(host);
    expect(text).toContain("Planning network, app and edge");
    expect(text).not.toContain("All");
    expect(host.children[0].children.some((c) => c.className === "ask-busy")).toBe(true);
    clock.t += BUSY_MIN_MS - 200;
    tick();
    expect(flat(host)).not.toContain("All");
    // 4. replied: the busy line is a dim summary, the reply types, and the graph waits.
    clock.t += 200 + 3 * REPLY_TYPE_MS;
    tick();
    text = flat(host);
    expect(text).toMatch(/✓ Planning network, app and edge \(0:01\)/);
    expect(text).toContain("All");
    expect(text).not.toContain("All 3 states.");
    expect(names(events)).not.toContain("behold:ask-done");
    clock.t += 30 * REPLY_TYPE_MS;
    tick();
    expect(names(events)).toEqual(["behold:ask-hold", "behold:ask-start", "behold:ask-done"]);
    expect(flat(host)).toContain("All 3 states.");
    expect(events[1][1]).toEqual({ ask, step: "planned", scenario: "compose-edit" });
  });
  it("tells the tip cards when a busy line shows and when it ends (ask-busy)", () => {
    const clock = { t: T0 };
    const { pane, events, tick } = make(clock);
    const tips = [{ title: "t", body: "b" }];
    const busy = () => events.filter((e) => e[0] === "behold:ask-busy").map((e) => [e[1].busy, e[1].tips]);
    // A status-only step: busy at once, with the status's tips.
    pane.setStep(demo("applying", { ask: { status: "Applying", tips } }));
    expect(busy()).toEqual([[true, tips]]);
    clock.t += BUSY_MIN_MS + 10;
    tick();
    // The next step is a turn: the status line ends, and no busy shows while the prompt types.
    pane.setStep(demo("planned", { ask: { prompt: "go", status: "Planning", reply: "ok", tips: [{ title: "x", body: "y" }] } }));
    expect(busy()).toEqual([[true, tips], [false, null]]);
    // The turn's wait, then its reply: the busy event follows the busy line only.
    clock.t += CURSOR_PAUSE_MS + 2 * TYPE_MS + 100;
    tick();
    expect(busy().slice(2)).toEqual([[true, [{ title: "x", body: "y" }]]]);
    clock.t += BUSY_MIN_MS + 10;
    tick();
    expect(busy().slice(3)).toEqual([[false, null]]);
  });
  it("lights the edge again between beats and once a reply is done, while another prompt can follow", () => {
    const clock = { t: T0 };
    const { pane, host, tick } = make(clock);
    pane.setStep(demo("planned", { asks: [{ prompt: "a", reply: "r" }, { prompt: "b", reply: "s" }] }));
    clock.t += beatTiming({ prompt: "a", reply: "r" }).end + 10;
    tick();
    expect(host.classes).toContain("ask-ready");
    expect(host.children.at(-1).className).toContain("ask-ready-line");
    clock.t += BEAT_GAP_MS;
    tick();
    expect(host.children.at(-1).className).not.toContain("ask-ready-line");
  });
  it("shows a status-only step as a busy line under the turn, with a timer that counts", () => {
    const clock = { t: T0 };
    const { pane, host, tick } = make(clock);
    pane.setStep(demo("planned", { ask: { action: "approve" } }));
    expect(pane.setStep(demo("applying", { ask: { status: "Applying across estates." } }))).toBe(true);
    // The step before has nothing left to play (an action is at once), so this one begins; its busy line sits under the action.
    expect(flat(host)).toContain("approve");
    expect(flat(host)).toContain("Applying across estates");
    expect(host.classes).not.toContain("ask-ready");
    const turn = host.children[0];
    expect(turn.children.map((c) => c.className)).toEqual(["ask-line", "ask-sum", "ask-busy"]);
    clock.t += 65000;
    tick();
    expect(flat(host)).toContain("(1:05)");
  });
  it("holds the graph at every step, and lights a status-only step as its busy line shows", () => {
    const clock = { t: T0 };
    const { pane, events, tick } = make(clock);
    pane.setStep(demo("planned", { ask: { action: "approve" } }));
    pane.setStep(demo("merged", { label: "The plan is merged. Applying next." }));
    expect(events.filter((e) => e[0] === "behold:ask-hold")).toHaveLength(2);
    // The busy line is on screen in the same draw: the graph lights with it, not 1.2 s later.
    expect(events.filter((e) => e[0] === "behold:ask-status")).toEqual([["behold:ask-status", { status: "The plan is merged", step: "merged", scenario: "compose-edit" }]]);
    const at = names(events).indexOf("behold:ask-status");
    expect(events.findIndex((e) => e[0] === "behold:ask-busy" && e[1].busy)).toBeLessThan(events.findIndex((e) => e[0] === "behold:ask-status"));
    expect(at).toBeGreaterThan(0);
    clock.t += 5000;
    tick();
    expect(events.filter((e) => e[0] === "behold:ask-status")).toHaveLength(1);
  });
  it("still lets a status-only step's busy line show 1.2 s before the next step plays", () => {
    const clock = { t: T0 };
    const { pane, host, tick } = make(clock);
    pane.setStep(demo("planned", { ask: { action: "approve" } }));
    pane.setStep(demo("merged", { label: "Merged." }));
    pane.setStep(demo("applying", { label: "Applying." }));
    expect(flat(host)).toContain("Merged");
    expect(flat(host)).not.toContain("Applying");
    clock.t += BUSY_MIN_MS;
    tick();
    expect(flat(host)).toContain("Applying");
  });
  it("lets a step with no ask at all clear the graph only after its busy line has shown", () => {
    const clock = { t: T0 };
    const { pane, events, tick } = make(clock);
    pane.setStep(demo("pull-request", { opening: "Three states." }));
    expect(names(events)).toEqual(["behold:ask-hold"]);
    clock.t += BUSY_MIN_MS;
    tick();
    expect(names(events)).toEqual(["behold:ask-hold", "behold:ask-clear"]);
  });
  it("lights the graph as the reply starts to print, in the same draw, and still says when it is done", () => {
    const clock = { t: T0 };
    const { pane, host, events, tick } = make(clock);
    const ask = { prompt: "go", status: "Planning", reply: "All {roots} states.", light: ["network/x"] };
    pane.setStep(demo("planned", { ask }));
    const t = beatTiming(ask, { reply: "All 3 states." });
    clock.t = T0 + t.replyAt - 1;
    tick();
    expect(events.map((e) => e[0])).not.toContain("behold:ask-light");
    clock.t = T0 + t.replyAt;
    tick();
    // The reply line is on screen and the light is asked for in the same tick: no lag past the 40 ms draw.
    expect(host.children[0].children.some((c) => (c.className || "").startsWith("ask-reply"))).toBe(true);
    expect(events.filter((e) => e[0] === "behold:ask-light")).toEqual([["behold:ask-light", { ask, step: "planned", scenario: "compose-edit" }]]);
    expect(events.map((e) => e[0])).not.toContain("behold:ask-done");
    clock.t = T0 + t.end;
    tick();
    const order = events.map((e) => e[0]).filter((n) => n === "behold:ask-light" || n === "behold:ask-done");
    expect(order).toEqual(["behold:ask-light", "behold:ask-done"]);
  });
  it("lights a beat with no reply once its line is done", () => {
    const clock = { t: T0 };
    const { pane, events } = make(clock);
    pane.setStep(demo("planned", { ask: { action: "approve", light: ["a/b"] } }));
    expect(events.map((e) => e[0]).filter((n) => n === "behold:ask-light" || n === "behold:ask-done")).toEqual(["behold:ask-light", "behold:ask-done"]);
  });
  it("says when each new line starts (ask-line): prompt, busy, reply, ready", () => {
    const clock = { t: T0 };
    const { pane, events, tick } = make(clock);
    const ask = { prompt: "go", status: "Planning", reply: "ok" };
    pane.setStep(demo("planned", { ask }));
    const t = beatTiming(ask, { reply: "ok" });
    for (const at of [t.cursor + 1, t.busyAt + 1, t.replyAt + 1, t.end + 1, t.end + 2]) {
      clock.t = T0 + at;
      tick();
    }
    expect(events.filter((e) => e[0] === "behold:ask-line").map((e) => e[1].kind)).toEqual(["prompt", "busy", "reply", "ready"]);
  });
  it("underlines the newest line while it is new, dims the lines before it in its turn, and lets go after EMPH_MS", () => {
    const clock = { t: T0 };
    const { pane, host, tick } = make(clock);
    const ask = { prompt: "go", status: "Planning", reply: "a long enough reply to type for a while" };
    pane.setStep(demo("planned", { ask }));
    const t = beatTiming(ask, { reply: ask.reply });
    clock.t = T0 + t.replyAt;
    tick();
    clock.t = T0 + t.replyAt + 100;
    tick();
    const kids = () => host.children[0].children;
    const reply = kids().find((c) => (c.className || "").startsWith("ask-reply"));
    expect(reply.classes).toContain("ask-new");
    // The sweep picks up where it was when the line is drawn again (a reply redraws on every character).
    expect(reply.style.animationDelay).toBe("-100ms");
    expect(kids()[0].classes).toContain("ask-before");
    clock.t = T0 + t.replyAt + EMPH_MS + 10;
    tick();
    const later = kids().find((c) => (c.className || "").startsWith("ask-reply"));
    expect(later.classes).not.toContain("ask-new");
  });
  it("makes a step that arrives while another plays wait for it, then plays it in order", () => {
    const clock = { t: T0 };
    const { pane, host, events, tick } = make(clock);
    pane.setStep(demo("planned", { ask: { prompt: "go", reply: "Done." } }));
    pane.setStep(demo("merged", { label: "Merged." }));
    expect(flat(host)).not.toContain("Merged");
    expect(events.filter((e) => e[0] === "behold:ask-hold")).toHaveLength(1);
    clock.t += beatTiming({ prompt: "go", reply: "Done." }).end + 10;
    tick();
    expect(names(events)).toContain("behold:ask-done");
    expect(flat(host)).toContain("Merged");
    expect(flat(host)).toContain("Done.");
    expect(events.filter((e) => e[0] === "behold:ask-hold")).toHaveLength(2);
  });
  it("keeps the transcript, dims older turns and leaves the newest bright", () => {
    const clock = { t: T0 };
    const { pane, host, tick } = make(clock);
    for (const [i, w] of ["one", "two", "three", "four", "five"].entries()) {
      pane.setStep(demo(`s${i}`, { ask: { prompt: w, reply: "r" } }));
      clock.t += 20000;
      tick();
    }
    const text = flat(host);
    for (const w of ["one", "two", "three", "four", "five"]) expect(text).toContain(w);
    expect(entries(host).at(-1)).toContain("ask-cur");
    expect(entries(host).at(-2)).toContain("ask-old-1");
    expect(entries(host).at(-4)).toContain("ask-old-3");
    expect(entries(host)[0]).toContain("ask-old-3");
    expect(KEEP).toBe(3);
  });
  it("continues a turn with a lone reply after a status step, the busy line collapsed into a summary", () => {
    const clock = { t: T0 };
    const { pane, host, tick } = make(clock);
    pane.setStep(demo("planned", { ask: { prompt: "go" } }));
    clock.t += 10000;
    tick();
    pane.setStep(demo("applying", { ask: { status: "Applying." } }));
    clock.t += 10000;
    tick();
    pane.setStep(demo("applied", { ask: { reply: "All applied." } }));
    clock.t += 5000;
    tick();
    const kinds = host.children[0].children.map((c) => c.className.split(" ")[0]);
    expect(kinds).toEqual(["ask-line", "ask-sum", "ask-sum", "ask-reply"]);
    expect(flat(host)).toMatch(/✓ Applying \(0:\d\d\)/);
  });
  it("shows static text under reduced motion: no busy phase, the reply at once", () => {
    const clock = { t: T0 };
    const { pane, host } = make(clock, true);
    pane.setStep(demo("planned", { ask: { prompt: "go", status: "Planning", reply: "Done." } }));
    expect(flat(host)).toContain("Done.");
    expect(flat(host)).toContain("go");
    pane.setStep(demo("applying", { ask: { status: "Applying." } }));
    expect(host.children[0].children.some((c) => c.className === "ask-busy")).toBe(true);
    expect(flat(host)).toContain("…");
  });
  it("hides at a reset, and when the scenario changes to one without an ask", () => {
    const clock = { t: T0 };
    const { pane, host } = make(clock);
    pane.setStep(demo("planned", { ask: { action: "approve" } }));
    expect(pane.setStep(null)).toBe(false);
    expect(host.hidden).toBe(true);
    pane.setStep(demo("planned", { ask: { action: "approve" } }));
    expect(pane.setStep(demo("merged", { scenario: "other", label: "x" }))).toBe(false);
    expect(host.hidden).toBe(true);
  });
  it("shows a pane that was never given an ask on a plain scenario only after one", () => {
    const clock = { t: T0 };
    const { pane } = make(clock);
    expect(pane.setStep(demo("merged", { label: "x" }))).toBe(false);
  });
  it("does not restart on the same step", () => {
    const clock = { t: T0 };
    const { pane, events } = make(clock);
    pane.setStep(demo("planned", { ask: { prompt: "go" } }));
    const n = events.length;
    pane.setStep(demo("planned", { ask: { prompt: "go" } }));
    expect(events).toHaveLength(n);
  });
  it("shows the opening once and the closing at applied, without a ready light after it", () => {
    const clock = { t: T0 };
    const { pane, host, tick } = make(clock);
    expect(pane.setStep(demo("pull-request", { opening: "Three states." }))).toBe(true);
    expect(flat(host)).toContain("Three states.");
    clock.t += 20000;
    tick();
    pane.setStep(demo("planned", { opening: "Three states.", ask: { action: "approve" } }));
    expect(flat(host).split("Three states.")).toHaveLength(2);
    clock.t += 20000;
    tick();
    pane.setStep(demo("applied", { closing: "3 states. 1 plan." }));
    expect(flat(host)).toContain("3 states. 1 plan.");
    expect(host.classes).not.toContain("ask-ready");
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

describe("diff under a reply", () => {
  const beat = { prompt: "go", reply: "Opened pull request #12.", diff: ["+ network  aws_subnet.subnet_b  10.0.2.0/24", "~ edge     terraform_data.allowlist  + 10.0.2.0/24", "- app      old", 5, ""] };
  const R = "Opened pull request #12.";
  it("keeps strings only, and only under a reply", () => {
    expect(diffLines(beat)).toHaveLength(3);
    expect(diffLines({ prompt: "go", diff: ["+ a"] })).toEqual([]);
  });
  it("splits the sign column", () => {
    expect(diffParts("+ network  x")).toEqual({ sign: "+", rest: "network  x" });
    expect(diffParts("~ edge")).toEqual({ sign: "~", rest: "edge" });
    expect(diffParts("plain")).toEqual({ sign: "", rest: "plain" });
  });
  it("lines appear one per DIFF_MS after the reply has typed, and the beat ends after them", () => {
    const t = beatTiming(beat, { reply: R });
    expect(t.diffMs).toBe(3 * DIFF_MS);
    expect(t.end).toBe(t.replyAt + t.replyType + 3 * DIFF_MS);
    const at = (ms) => playback([beat], ms, { replies: [R] }).frames[0];
    const start = t.replyAt + t.replyType;
    expect(at(start - 1).diffShown).toBe(0);
    expect(at(start).diffShown).toBe(1);
    expect(at(start + DIFF_MS).diffShown).toBe(2);
    expect(at(start + 10 * DIFF_MS).diffShown).toBe(3);
    expect(at(start + DIFF_MS).over).toBe(false);
    expect(at(t.end).over).toBe(true);
  });
  it("shows at once under reduced motion", () => {
    const f = playback([beat], 0, { reduced: true, replies: [R] }).frames[0];
    expect(f.diffShown).toBe(3);
    expect(f.over).toBe(true);
  });
  it("fires ask-done only after the diff has shown, and renders the lines", () => {
    const T = Date.parse("2026-10-24T10:00:00Z");
    const clock = { t: T };
    const events = [];
    const mk = (tag) => {
      const n = { tag, className: "", textContent: "", children: [], hidden: false, attrs: {}, classes: [], ownerDocument: null };
      n.classList = { add: (c) => n.classes.push(c), remove: () => {}, toggle: () => {} };
      n.setAttribute = () => {};
      n.append = (...c) => n.children.push(...c);
      n.appendChild = (c) => n.children.push(c);
      n.replaceChildren = (...c) => (n.children = c);
      return n;
    };
    const host = mk("section");
    host.ownerDocument = { createElement: mk };
    let timer = null;
    const pane = createAskPane({ host, win: { dispatchEvent: (e) => events.push(e.type) }, now: () => new Date(clock.t), setTimer: (f) => ((timer = f), 1), clearTimer: () => (timer = null) });
    const two = { ...beat, diff: ["+ a", "~ b"] };
    pane.setStep({ cycle: 1, scenario: "s", step: "pull-request", started_at: "2026-10-24T10:00:00Z", ask: two });
    const t = beatTiming(two, { reply: R });
    clock.t = T + t.replyAt + t.replyType + 1;
    timer();
    expect(events).not.toContain("behold:ask-done");
    const all = (n) => [n.className, n.textContent, ...n.children.map(all)].join("|");
    expect(all(host)).toContain("ask-diff-add");
    expect(all(host)).not.toContain("ask-diff-chg");
    clock.t = T + t.end + 1;
    timer();
    expect(all(host)).toContain("ask-diff-chg");
    expect(events).toContain("behold:ask-done");
  });
});

describe("newestLine", () => {
  it("names the newest line, a diff belonging to its reply, and only changes its key when a new line starts", () => {
    const turn = (parts, extra = {}) => ({ mark: ">", text: "go", parts, ...extra });
    expect(newestLine([], false)).toBe(null);
    expect(newestLine([turn([])], false)).toMatchObject({ kind: "prompt", part: -1 });
    expect(newestLine([turn([{ k: "busy" }])], false)).toMatchObject({ kind: "busy", part: 0 });
    const r1 = newestLine([turn([{ k: "sum" }, { k: "reply", text: "a" }])], false);
    const r2 = newestLine([turn([{ k: "sum" }, { k: "reply", text: "ab" }, { k: "diff", lines: [] }])], false);
    expect(r1).toMatchObject({ kind: "reply", part: 1 });
    expect(r2.key).toBe(r1.key);
    expect(newestLine([turn([])], true)).toMatchObject({ kind: "ready" });
    expect(newestLine([turn([], { mark: "✓", text: "approve" })], false).kind).toBe("line");
  });
});
