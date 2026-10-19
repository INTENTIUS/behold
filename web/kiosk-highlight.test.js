// behold#757: a step's highlight, what is special about it in the driver's
// words, opened in Watch as a modal when its step arrives: once per arrival,
// at the same moment in a replay, never with Tips off, and nothing at all for
// a step without one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIGHLIGHT_KICKER, modeLine, openEventModal } from "./event-help-modal.js";
import { HIGHLIGHT_MS, ehStore, highlightOpens, highlightShown, highlightStepKey, highlightTurn, stepHighlight } from "./kiosk-event-help.js";
import { startEventHelp } from "./kiosk-event-help-ui.js";
import { replayAt, scrubDemo } from "./kiosk-vendor.js";

const HL = { title: "Same orchestration as the commercial platforms", body: "Fifteen OpenTofu states, applied in dependency order. This is the stack-dependency orchestration Terraform automation platforms sell, run here by terragucci on plain OpenTofu and Forgejo." };
const demo = (step, more = {}) => ({ cycle: 9, scenario: "fan-out", title: "t", step, label: `the ${step} line`, started_at: "2026-10-18T00:00:00Z", next: null, pull: 3, commit: null, ...more });

describe("highlight: the floor", () => {
  it("is a title and a body, both non-empty strings, else nothing", () => {
    expect(stepHighlight(demo("failed", { highlight: HL }))).toEqual(HL);
    for (const v of [null, undefined, "x", [], {}, { title: "t" }, { title: "", body: "b" }, { title: "t", body: " " }, { title: 2, body: "b" }]) expect(stepHighlight(demo("failed", { highlight: v }))).toBeNull();
    expect(stepHighlight(null)).toBeNull();
  });
});

describe("highlight: once per cycle, step and title (terragucci#1176)", () => {
  it("comes with its step, once, and goes with it", () => {
    let s = highlightTurn(null, demo("applying"));
    expect(s.pending).toBeNull();
    s = highlightTurn(s, demo("failed", { highlight: HL }));
    expect(s.pending).toMatchObject({ key: highlightStepKey(demo("failed")), ...HL });
    // Opened: the same step looked at again brings nothing back.
    s = highlightShown(s);
    expect(s.pending).toBeNull();
    expect(highlightTurn(s, demo("failed", { highlight: HL }))).toBe(s);
    // A step that goes takes a highlight not yet opened with it.
    const waiting = highlightTurn(null, demo("failed", { highlight: HL }));
    expect(highlightTurn(waiting, demo("resumed")).pending).toBeNull();
  });
  it("opens once though the driver writes its step again, around a hold", () => {
    const w = (step, t) => demo(step, { started_at: `2026-10-18T00:00:${t}Z`, highlight: step === "applying" ? HL : null });
    let s = highlightShown(highlightTurn(null, w("applying", 10)));
    s = highlightTurn(s, w("waiting", 20));
    s = highlightTurn(s, w("applying", 30));
    expect(s.pending).toBeNull();
  });
  it("opens when a step gains one partway through, as choudoufu's operator's apply does", () => {
    let s = highlightTurn(null, demo("applying", { started_at: "2026-10-18T00:00:10Z" }));
    expect(s.pending).toBeNull();
    s = highlightTurn(s, demo("applying", { started_at: "2026-10-18T00:00:10Z", highlight: HL }));
    expect(s.pending).toMatchObject(HL);
  });
  it("a fix's step opens its own title, not the same one again; the next cycle opens it again", () => {
    const opened = highlightShown(highlightTurn(null, demo("planned", { highlight: HL })));
    expect(highlightTurn(opened, demo("planned", { pull: 4, highlight: HL })).pending).toBeNull();
    expect(highlightTurn(opened, demo("planned", { pull: 4, highlight: { title: "Only what was blocked", body: "b" } })).pending).toMatchObject({ title: "Only what was blocked" });
    expect(highlightTurn(opened, demo("planned", { cycle: 10, highlight: HL })).pending).not.toBeNull();
  });
  it("opens in Watch with Tips on, over a Waiting modal but not over a critical one, nor on a held small stage", () => {
    const pending = { key: "k", ...HL };
    expect(highlightOpens({ pending, on: true, watch: true })).toBe(true);
    expect(highlightOpens({ pending, on: true, watch: true, modal: "waiting" })).toBe(true);
    expect(highlightOpens({ pending, on: false, watch: true })).toBe(false);
    expect(highlightOpens({ pending, on: true, watch: false })).toBe(false);
    expect(highlightOpens({ pending, on: true, watch: true, held: true })).toBe(false);
    expect(highlightOpens({ pending, on: true, watch: true, modal: "failed" })).toBe(false);
    expect(highlightOpens({ pending: null, on: true, watch: true })).toBe(false);
  });
  it("in a replay, arrives when the replay's clock reaches its step, and again each time the replay loops round", () => {
    const steps = [demo("applying", { at: "2026-10-18T00:00:00Z" }), demo("failed", { at: "2026-10-18T00:00:20Z", highlight: HL }), demo("reset", { at: "2026-10-18T00:00:40Z" })];
    let s = null;
    const opened = [];
    for (let t = 0; t < 130_000; t += 1_000) {
      const d = steps[replayAt(steps, t).index];
      s = highlightTurn(s, d);
      if (s.pending) {
        opened.push(t);
        s = highlightShown(s);
      }
    }
    const loop = replayAt(steps, 0).loop;
    expect(opened).toEqual([20_000, 20_000 + loop, 20_000 + 2 * loop].filter((t) => t < 130_000));
  });
});

describe("highlight: on a tool's page", () => {
  it("goes whole when it names a rival of the page's tool, as the step's line does", () => {
    expect(scrubDemo(demo("failed", { highlight: HL }), "tofu-fanout").highlight).toEqual(HL);
    expect(scrubDemo(demo("failed", { highlight: HL }), "chant-fanout").highlight).toBeNull();
    expect("highlight" in scrubDemo(demo("failed"), "tofu-fanout")).toBe(false);
  });
});

/** Just enough of a DOM for Tips and its modal. */
function fakeDoc() {
  const listeners = {};
  const make = (tag) => {
    const n = {
      tagName: tag.toUpperCase(),
      children: [],
      handlers: {},
      textContent: "",
      className: "",
      dataset: {},
      style: { setProperty() {} },
      classList: { toggle() {}, add() {}, remove() {} },
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
    return n;
  };
  return {
    createElement: make,
    head: make("head"),
    body: make("body"),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: (ev, fn) => ((listeners[ev] ||= []).push(fn)),
    removeEventListener() {},
    fire: (ev, e) => (listeners[ev] || []).forEach((fn) => fn(e)),
  };
}
const all = (n) => [n, ...n.children.flatMap(all)];
const find = (root, cls) => all(root).find((n) => n.className && n.className.split(" ").includes(cls));
/** The Tips switch's shelf, on or off (event-help-store.js). */
const shelf = (on = true) => {
  const m = new Map();
  ehStore({ setItem: (k, v) => m.set(k, v) }, on);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
};

describe("highlight: Tips draws it", () => {
  let t;
  beforeEach(() => {
    vi.useFakeTimers();
    t = 1_000_000;
  });
  afterEach(() => vi.useRealTimers());
  const start = ({ on = true, watch = true, replay = false } = {}) => {
    const doc = fakeDoc();
    const view = { demo: demo("applying"), watch, replay };
    const api = startEventHelp({ doc, store: shelf(on), tipsHost: doc.body, modalHost: doc.body, now: () => t, get: () => ({ ...view, strip: null, stripReady: true }), reduced: () => true });
    const modal = () => find(doc.body, "eh-modal");
    const step = (d, ms = 0) => {
      view.demo = d;
      t += ms;
      vi.advanceTimersByTime(ms);
      api.tick();
    };
    return { api, doc, view, modal, step };
  };

  it("opens with its step in Watch, with its kicker, title and body, and no button", () => {
    const k = start();
    k.step(demo("applying"));
    expect(k.modal()).toBeUndefined();
    k.step(demo("failed", { highlight: HL }), 1_000);
    const m = k.modal();
    expect(m.className).toContain("eh-modal-highlight");
    expect(find(m, "eh-modal-mode").textContent).toBe(HIGHLIGHT_KICKER);
    expect(find(m, "eh-modal-title").textContent).toBe(HL.title);
    expect(find(m, "eh-modal-line").textContent).toBe(HL.body);
    expect(find(m, "eh-modal-act")).toBeUndefined();
    expect(k.api.state.modal.kind).toBe("highlight");
  });

  it("stays HIGHLIGHT_MS, then goes, and does not come back for the same step", () => {
    const k = start();
    k.step(demo("failed", { highlight: HL }));
    k.step(demo("failed", { highlight: HL }), HIGHLIGHT_MS - 1_000);
    expect(k.modal()).toBeDefined();
    k.step(demo("failed", { highlight: HL }), 1_500);
    expect(k.modal()).toBeUndefined();
    k.step(demo("failed", { highlight: HL }), 5_000);
    expect(k.modal()).toBeUndefined();
  });

  it("goes with its step, and closes with Esc", () => {
    const k = start();
    k.step(demo("failed", { highlight: HL }));
    k.step(demo("resumed"), 2_000);
    expect(k.modal()).toBeUndefined();
    k.step(demo("applied", { highlight: HL }), 2_000);
    expect(k.modal()).toBeDefined();
    k.doc.fire("keydown", { key: "Escape" });
    expect(k.modal()).toBeUndefined();
    k.step(demo("applied", { highlight: HL }), 1_000);
    expect(k.modal()).toBeUndefined();
  });

  it("shows nothing with Tips off, nor in Inspect, nor for a step without one", () => {
    const off = start({ on: false });
    off.step(demo("failed", { highlight: HL }));
    expect(off.modal()).toBeUndefined();
    const inspect = start({ watch: false });
    inspect.step(demo("failed", { highlight: HL }));
    expect(inspect.modal()).toBeUndefined();
    const none = start();
    none.step(demo("failed"));
    none.step(demo("failed", { highlight: { title: "", body: "b" } }), 1_000);
    expect(none.modal()).toBeUndefined();
  });

  it("in a replay, opens as the replay reaches its step, marked a replay", () => {
    const k = start({ replay: true });
    k.step(demo("applying"));
    expect(k.modal()).toBeUndefined();
    k.step(demo("failed", { highlight: HL }), 20_000);
    expect(k.modal().className).toContain("eh-mode-replay");
    expect(find(k.modal(), "eh-modal-mode").textContent).toBe(HIGHLIGHT_KICKER);
  });
});

describe("highlight: the modal", () => {
  it("says its kicker in every mode", () => {
    for (const mode of ["narrated", "replay", "live"]) expect(modeLine(mode, "highlight", {})).toBe(HIGHLIGHT_KICKER);
  });
  it("closes after `closeAfter`, and holds while hovered", () => {
    let now = 0;
    const timers = [];
    const doc = fakeDoc();
    const m = openEventModal(doc.body, { mode: "narrated", kind: "highlight", data: { title: HL.title, lines: [{ text: HL.body }], closeAfter: 12_000 }, doc, now: () => now, setTimer: (fn) => timers.push(fn), clearTimer() {} });
    const box = find(doc.body, "eh-modal");
    box.handlers.pointerenter.forEach((fn) => fn());
    now = 13_000;
    timers.forEach((fn) => fn());
    expect(m.state.closed).toBe(false);
    box.handlers.pointerleave.forEach((fn) => fn());
    now = 16_000;
    timers.forEach((fn) => fn());
    expect(m.state.closed).toBe(true);
  });
});
