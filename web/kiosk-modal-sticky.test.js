// behold#764: "'waiting on pipeline' keeps popping back after shutting and
// covering the detail overlay". A story modal the viewer closes stays closed
// for what it was about, across redraws and a reload; and no story modal
// opens over a card's details popover the viewer has open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coversRect, openEventModal } from "./event-help-modal.js";
import { DISMISS_MAX, DISMISS_STORE, createDismissals, dismissKey, ehStore, highlightOpens, waitingOpens } from "./kiosk-event-help.js";
import { startEventHelp } from "./kiosk-event-help-ui.js";

const HL = { title: "Same orchestration as the commercial platforms", body: "Fifteen OpenTofu states, applied in dependency order." };
const demo = (step, more = {}) => ({ cycle: 9, scenario: "fan-out", title: "t", step, label: `the ${step} line`, started_at: "2026-10-18T00:00:00Z", next: null, pull: 3, commit: null, ...more });
const WAIT = { key: "0|0|the pipeline to start the plan", what: "the pipeline to start the plan", why: "Pull request 106 is open.", fraction: 0.3, words: "usually about 21 s" };
/** A sessionStorage stand-in that outlives one page: what a reload keeps. */
const session = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
};

describe("the closed modals' keys", () => {
  it("say the kind, the cycle and beat, the pull request, the step and the modal's own key", () => {
    expect(dismissKey("waiting", demo("pull-request"), WAIT.key)).toBe(`waiting|9||3|pull-request|${WAIT.key}`);
    expect(dismissKey("waiting", demo("pull-request", { beat: "fix" }), "k")).not.toBe(dismissKey("waiting", demo("pull-request"), "k"));
    // A new wait: a later step, a new pull request, a new cycle.
    const k = dismissKey("waiting", demo("pull-request"), "k");
    for (const d of [demo("merged"), demo("pull-request", { pull: 4 }), demo("pull-request", { cycle: 10 })]) expect(dismissKey("waiting", d, "k")).not.toBe(k);
  });

  it("are kept in the store given (sessionStorage), so a new page reads them back", () => {
    const store = session();
    const a = createDismissals(store);
    a.add("x");
    a.add("x");
    expect(JSON.parse(store.getItem(DISMISS_STORE))).toEqual(["x"]);
    expect(createDismissals(store).has("x")).toBe(true);
    a.clear();
    expect(createDismissals(store).has("x")).toBe(false);
  });

  it("keep the newest DISMISS_MAX, and live in memory where storage throws or holds junk", () => {
    const store = session();
    const a = createDismissals(store);
    for (let i = 0; i < DISMISS_MAX + 5; i++) a.add(`k${i}`);
    expect(a.keys()).toHaveLength(DISMISS_MAX);
    expect(a.has("k0")).toBe(false);
    expect(a.has(`k${DISMISS_MAX + 4}`)).toBe(true);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const b = createDismissals(broken);
    b.add("y");
    expect(b.has("y")).toBe(true);
    store.setItem(DISMISS_STORE, "{not json");
    expect(createDismissals(store).keys()).toEqual([]);
    expect(createDismissals(null).has("z")).toBe(false);
  });
});

describe("when a story modal may open", () => {
  it("the waiting one: not over a details popover, not for a wait the viewer closed, not over another modal", () => {
    expect(waitingOpens({ waiting: WAIT })).toBe(true);
    expect(waitingOpens({ waiting: WAIT, pop: { left: 0, top: 0, width: 10, height: 10 } })).toBe(false);
    expect(waitingOpens({ waiting: WAIT, closed: true })).toBe(false);
    expect(waitingOpens({ waiting: WAIT, modal: {} })).toBe(false);
    expect(waitingOpens({ waiting: WAIT, due: true })).toBe(false);
    expect(waitingOpens({ waiting: WAIT, on: false })).toBe(false);
    expect(waitingOpens({ waiting: null })).toBe(false);
  });
  it("a highlight: waits while a details popover is open", () => {
    const pending = { key: "k", ...HL };
    expect(highlightOpens({ pending, on: true, watch: true, pop: { left: 0, top: 0, width: 10, height: 10 } })).toBe(false);
    expect(highlightOpens({ pending, on: true, watch: true, pop: null })).toBe(true);
  });
});

describe("Tips: a closed modal stays closed, and none covers the details popover", () => {
  let t;
  beforeEach(() => {
    vi.useFakeTimers();
    t = 1_000_000;
  });
  afterEach(() => vi.useRealTimers());
  const FRAME = { getBoundingClientRect: () => ({ left: 5, top: 77, width: 1356, height: 686, right: 1361, bottom: 763 }) };
  /** One page of the kiosk; `store` is its sessionStorage, which a reload keeps. */
  const page = (store, { pop = null } = {}) => {
    const doc = fakeDoc();
    const view = { demo: demo("pull-request"), watch: true, waiting: WAIT, frame: FRAME, pop };
    const api = startEventHelp({ doc, store: shelf(), session: store, tipsHost: doc.body, modalHost: doc.body, now: () => t, get: () => ({ ...view, strip: null, stripReady: true }), reduced: () => true });
    const modal = (kind) => all(doc.body).find((n) => n.className && n.className.split(" ").includes(`eh-modal-${kind}`));
    const step = (ms = 1_000, more = {}) => {
      Object.assign(view, more);
      t += ms;
      vi.advanceTimersByTime(ms);
      api.tick();
    };
    const closeX = (kind) => {
      const x = all(modal(kind)).find((n) => n.className === "eh-modal-close");
      x.handlers.click.forEach((fn) => fn({}));
    };
    return { api, doc, view, modal, step, closeX };
  };

  it("the Waiting modal, closed with ×, does not come back on the next looks at the same wait", () => {
    const k = page(session());
    k.step();
    expect(k.modal("waiting")).toBeDefined();
    k.closeX("waiting");
    expect(k.modal("waiting")).toBeUndefined();
    for (let i = 0; i < 60; i++) k.step(1_000);
    expect(k.modal("waiting")).toBeUndefined();
  });

  it("closed with Escape, it stays closed too; a new wait (a later step) opens again", () => {
    const k = page(session());
    k.step();
    k.doc.fire("keydown", { key: "Escape" });
    k.step(5_000);
    expect(k.modal("waiting")).toBeUndefined();
    k.step(1_000, { demo: demo("merged"), waiting: { ...WAIT, key: "0|2|the pipeline to apply" } });
    expect(k.modal("waiting")).toBeDefined();
  });

  it("a close by the page (news, the wait ending) is no viewer's: the same wait may open again", () => {
    const k = page(session());
    k.step();
    k.step(1_000, { waiting: null });
    expect(k.modal("waiting")).toBeUndefined();
    k.step(1_000, { waiting: WAIT });
    expect(k.modal("waiting")).toBeDefined();
  });

  it("survives a reload: the next page, with the same session, does not reopen the wait the viewer closed", () => {
    const store = session();
    const first = page(store);
    first.step();
    first.closeX("waiting");
    const again = page(store);
    for (let i = 0; i < 10; i++) again.step(1_000);
    expect(again.modal("waiting")).toBeUndefined();
    // A fresh visit (a new session) opens it.
    const fresh = page(session());
    fresh.step();
    expect(fresh.modal("waiting")).toBeDefined();
  });

  it("a step's highlight is once per cycle, step and title across a reload too", () => {
    const store = session();
    const first = page(store);
    first.step(1_000, { demo: demo("failed", { highlight: HL }), waiting: null });
    expect(first.modal("highlight")).toBeDefined();
    first.closeX("highlight");
    const again = page(store);
    again.step(1_000, { demo: demo("failed", { highlight: HL }), waiting: null });
    again.step(1_000);
    expect(again.modal("highlight")).toBeUndefined();
  });

  it("a replay looping round forgets what was closed: its wait opens again", () => {
    const k = page(session());
    k.step(1_000, { demo: demo("pull-request", { at: "2026-10-18T00:00:10Z" }) });
    k.closeX("waiting");
    k.step(1_000);
    expect(k.modal("waiting")).toBeUndefined();
    k.step(1_000, { demo: demo("pull-request", { at: "2026-10-18T00:00:00Z" }) });
    expect(k.modal("waiting")).toBeDefined();
  });

  it("opens no story modal while a card's details popover is open; the one held back opens once it closes", () => {
    const k = page(session(), { pop: { x: 600, y: 80, w: 412, h: 141 } });
    for (let i = 0; i < 5; i++) k.step(1_000);
    expect(k.modal("waiting")).toBeUndefined();
    k.step(1_000, { demo: demo("failed", { highlight: HL }), waiting: null });
    expect(k.modal("highlight")).toBeUndefined();
    k.step(1_000, { pop: null });
    expect(k.modal("highlight")).toBeDefined();
  });
});

describe("a modal already up when the details popover opens", () => {
  /** A box the size of a modal, in the middle of a 1366x768 window. */
  const layoutDoc = () => {
    const doc = fakeDoc();
    doc.defaultView = { innerWidth: 1366, innerHeight: 768 };
    const make = doc.createElement;
    doc.createElement = (tag) => {
      const n = make(tag);
      n.getBoundingClientRect = () => ({ left: 383, top: 284, width: 600, height: 200 });
      return n;
    };
    return doc;
  };
  const classes = (n) => n.classes;
  it("moves clear of it, its sheet no longer over it", () => {
    const doc = layoutDoc();
    let keep = null;
    const timers = [];
    openEventModal(doc.body, { mode: "narrated", kind: "waiting", data: { title: "Waiting on the pipeline", lines: [], keepClear: () => keep }, doc, now: () => 0, setTimer: (fn) => timers.push(fn), clearTimer() {} });
    const wrap = doc.body.children[0];
    const box = wrap.children[0];
    expect(classes(wrap).has("eh-modal-keep")).toBe(false);
    // The popover opens under the middle of the window, where the modal stands; the modal's next tick moves it.
    keep = { left: 500, top: 300, width: 300, height: 140 };
    timers.forEach((fn) => fn());
    expect(classes(wrap).has("eh-modal-keep")).toBe(true);
    expect(classes(wrap).has("eh-modal-placed")).toBe(true);
    const at = { left: Number.parseFloat(box.style.marginLeft), top: Number.parseFloat(box.style.marginTop), width: 600, height: 200 };
    expect(coversRect(at, keep)).toBe(false);
    expect(classes(wrap).has("eh-modal-yield")).toBe(false);
    // It closes: the modal goes back to the middle.
    keep = null;
    timers.forEach((fn) => fn());
    expect(classes(wrap).has("eh-modal-keep")).toBe(false);
    expect(classes(wrap).has("eh-modal-placed")).toBe(false);
    expect(box.style.marginLeft).toBe("");
  });
  it("steps out of sight, its time held, where no spot clears it", () => {
    const doc = layoutDoc();
    const keep = { left: 0, top: 0, width: 1366, height: 768 };
    let now = 0;
    const timers = [];
    const m = openEventModal(doc.body, { mode: "narrated", kind: "highlight", data: { title: "h", lines: [], closeAfter: 1_000, keepClear: () => keep }, doc, now: () => now, setTimer: (fn) => timers.push(fn), clearTimer() {} });
    const wrap = doc.body.children[0];
    expect(classes(wrap).has("eh-modal-yield")).toBe(true);
    now = 5_000;
    timers.forEach((fn) => fn());
    expect(m.state.closed).toBe(false);
    expect(m.state.closedBy).toBeUndefined();
    m.close();
    expect(m.state.closedBy).toBe("page");
  });
});

/** Just enough of a DOM for Tips and its modal (kiosk-highlight.test.js's, with a classList that keeps its classes). */
function fakeDoc() {
  const listeners = {};
  const make = (tag) => {
    const classes = new Set();
    const n = {
      tagName: tag.toUpperCase(),
      children: [],
      handlers: {},
      textContent: "",
      dataset: {},
      classes,
      style: { setProperty() {} },
      classList: {
        toggle: (c, on) => ((on === undefined ? !classes.has(c) : on) ? classes.add(c) : classes.delete(c)),
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c),
      },
      appendChild(c) {
        c.parent = n;
        n.children.push(c);
        return c;
      },
      append(...cs) {
        cs.forEach((c) => typeof c === "object" && n.appendChild(c));
      },
      prepend(c) {
        n.appendChild(c);
      },
      replaceChildren() {
        n.children = [];
      },
      setAttribute() {},
      addEventListener(ev, fn) {
        (n.handlers[ev] ||= []).push(fn);
      },
      querySelector: () => null,
      remove() {
        if (n.parent) n.parent.children = n.parent.children.filter((x) => x !== n);
      },
    };
    // className is the classList's words, as the DOM's is.
    Object.defineProperty(n, "className", { get: () => [...classes].join(" "), set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); } });
    return n;
  };
  return {
    createElement: make,
    head: make("head"),
    body: make("body"),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: (ev, fn) => ((listeners[ev] ||= []).push(fn)),
    removeEventListener(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter((x) => x !== fn);
    },
    fire: (ev, e) => (listeners[ev] || []).forEach((fn) => fn(e)),
  };
}
const all = (n) => (n ? [n, ...n.children.flatMap(all)] : []);
const shelf = () => {
  const m = new Map();
  ehStore({ setItem: (k, v) => m.set(k, v) }, true);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
};
