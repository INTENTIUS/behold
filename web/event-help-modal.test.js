// behold#571: event-help's modal, one component in three modes. The countdown
// follows the driver's real action time, the button is pressed only once the
// real event arrives, narrated and replayed modals never write, and live mode
// writes only through the app's existing approve route, or waits on the ledger.
import { describe, expect, it, vi } from "vitest";
import { approveRoute, buttonState, modeLine, openEventModal, secondsLeft } from "./event-help-modal.js";

/** Just enough of a DOM for the modal: elements with children, text, attributes and listeners. */
function fakeDoc() {
  const listeners = {};
  const make = (tag) => {
    const n = {
      tagName: tag.toUpperCase(),
      children: [],
      attrs: {},
      handlers: {},
      textContent: "",
      className: "",
      style: { setProperty() {} },
      appendChild(c) {
        c.parent = n;
        n.children.push(c);
        return c;
      },
      replaceChildren() {
        n.children = [];
      },
      setAttribute(k, v) {
        n.attrs[k] = String(v);
      },
      addEventListener(ev, fn) {
        (n.handlers[ev] ||= []).push(fn);
      },
      remove() {
        if (n.parent) n.parent.children = n.parent.children.filter((x) => x !== n);
      },
    };
    return n;
  };
  return {
    createElement: make,
    addEventListener: (ev, fn) => ((listeners[ev] ||= []).push(fn)),
    removeEventListener() {},
    fire: (ev, e) => (listeners[ev] || []).forEach((fn) => fn(e)),
    body: make("body"),
  };
}
const all = (n) => [n, ...n.children.flatMap(all)];
const find = (root, cls) => all(root).find((n) => n.className && n.className.split(" ").includes(cls));
const click = (n) => (n.handlers.click || []).forEach((fn) => fn({ target: n }));

/** A clock and a timer the test drives. */
function clock(start = 1_000_000) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer() {},
    advance(ms) {
      t += ms;
      timers.forEach((fn) => fn());
    },
  };
}

describe("event-help modal: the countdown", () => {
  it("counts to the real action's time, says Approving… at zero, and is pressed only once resolved", () => {
    const at = 1_000_000 + 12_000;
    expect(buttonState("held", { at, now: 1_000_000 }).label).toBe("Approve · 12");
    expect(buttonState("held", { at, now: at - 1 }).label).toBe("Approve · 1");
    expect(buttonState("held", { at, now: at })).toMatchObject({ label: "Approving…", pressed: false });
    expect(buttonState("held", { at, now: at + 30_000 })).toMatchObject({ label: "Approving…", pressed: false });
    expect(buttonState("held", { at, now: at + 30_000, resolved: true })).toMatchObject({ label: "Approved", pressed: true });
    expect(buttonState("failed", { at, now: 1_000_000 }).label).toBe("Run again · 12");
    expect(secondsLeft(null, 0)).toBeNull();
  });

  it("fills a ring as the time runs out, and shows the number alone under reduced motion", () => {
    expect(buttonState("held", { at: 20_000, from: 0, now: 5_000 }).progress).toBeCloseTo(0.25);
    expect(buttonState("held", { at: 20_000, from: 0, now: 5_000, reduced: true }).progress).toBeNull();
  });

  it("says plainly what narrated and replayed modals are", () => {
    expect(modeLine("narrated", "held", { at: 12_000, now: 0 })).toBe("Live · the driver plays the reviewer and approves in 12 s");
    expect(modeLine("narrated", "held", { at: 12_000, now: 0, resolved: true, outcome: "approved by demo-reviewer" })).toBe("Live · approved by demo-reviewer");
    expect(modeLine("replay", "held", { replayAt: Date.parse("2026-10-16T04:08:00Z") })).toBe("Replay of the run at 04:08 UTC");
    expect(modeLine("live", "held", {})).toBeNull();
  });
});

describe("event-help modal: narrated and replayed modals never write", () => {
  for (const mode of ["narrated", "replay"]) {
    it(`${mode}: a click on every button calls no fetch, and the button presses only on the real event`, () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const doc = fakeDoc();
      const c = clock();
      const approve = vi.fn();
      const m = openEventModal(doc.body, { mode, kind: "held", data: { title: "Wave 2 waits for an approval", at: c.now() + 3_000, command: "chant approve tf-apply wave-2 --actor <reviewer> --sign <reviewer key>", gate: { kind: "converge", op: "a", gate: "b" } }, actions: { approve }, doc, ...c });
      const act = () => find(doc.body, "eh-modal-act");
      expect(act().textContent).toBe("Approve · 3");
      click(act());
      c.advance(10_000); // the driver's time passes; no record has landed
      expect(act().textContent).toBe("Approving…");
      expect(act().className).not.toContain("eh-pressed");
      for (const b of all(doc.body).filter((n) => n.tagName === "BUTTON" && n.className !== "eh-modal-close")) click(b);
      m.resolve("approved by demo-reviewer");
      expect(act().className).toContain("eh-pressed");
      expect(approve).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  }

  it("narrated closes a while after its event resolved, later while hovered, and at once on Escape", () => {
    const doc = fakeDoc();
    const c = clock();
    const closed = vi.fn();
    const m = openEventModal(doc.body, { mode: "narrated", kind: "held", data: { title: "t", at: c.now() + 1_000 }, doc, onClose: closed, ...c });
    m.resolve("approved");
    c.advance(5_000);
    expect(closed).not.toHaveBeenCalled();
    c.advance(1_500);
    expect(closed).toHaveBeenCalledTimes(1);
    const m2 = openEventModal(doc.body, { mode: "narrated", kind: "held", data: { title: "t" }, doc, onClose: closed, ...c });
    doc.fire("keydown", { key: "Escape" });
    expect(m2.state.closed).toBe(true);
  });
});

describe("event-help modal: live mode", () => {
  it("clears an Op's gate only through the route the app already calls", async () => {
    expect(approveRoute({ kind: "converge", op: "fountain-apply", gate: "rollout-gate", approve: { path: "/api/operator/approve/fountain-apply/rollout-gate" } })).toEqual({ method: "POST", path: "/api/operator/approve/fountain-apply/rollout-gate" });
    expect(approveRoute({ kind: "run", op: "apply prod", gate: "approve" })).toEqual({ method: "POST", path: "/api/ops/apply%20prod/signal/approve" });
    expect(approveRoute({ kind: "terragucci", gate: "wave-2" })).toBeNull();
    const doc = fakeDoc();
    const c = clock();
    const calls = [];
    const approve = vi.fn(async () => calls.push(approveRoute({ kind: "converge", op: "fountain-apply", gate: "rollout-gate" })));
    const m = openEventModal(doc.body, { mode: "live", kind: "held", data: { title: "rollout-gate waits", gate: { kind: "converge", op: "fountain-apply", gate: "rollout-gate" } }, actions: { approve }, doc, ...c });
    // It waits for the person: no countdown, no closing on its own.
    expect(find(doc.body, "eh-modal-act").textContent).toBe("Approve");
    c.advance(60_000);
    expect(m.state.closed).toBe(false);
    click(find(doc.body, "eh-modal-act"));
    await Promise.resolve();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ method: "POST", path: "/api/operator/approve/fountain-apply/rollout-gate" }]);
    // The gate cleared: the app resolves it, and it closes after showing so.
    m.resolve("the gate cleared");
    c.advance(3_000);
    expect(m.state.closed).toBe(true);
  });

  it("for a terragucci or chant gate, offers the signed command and waits for the ledger, never writing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const doc = fakeDoc();
    const c = clock();
    let landed = null;
    const watch = vi.fn(async () => landed);
    const m = openEventModal(doc.body, { mode: "live", kind: "held", data: { title: "wave 2 waits", command: "chant approve tf-apply wave-2 --plan jcs1-sha256:… --sign <your key>", gate: { kind: "terragucci", gate: "wave-2" } }, actions: { watch }, doc, ...c });
    expect(find(doc.body, "eh-modal-act")).toBeUndefined();
    expect(find(doc.body, "eh-modal-copy").textContent).toBe("Copy");
    await Promise.resolve();
    expect(watch).toHaveBeenCalledTimes(1);
    c.advance(4_000);
    await Promise.resolve();
    expect(m.state.resolved).toBe(false);
    landed = "approved by demo-reviewer, signed";
    c.advance(4_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(m.state.resolved).toBe(true);
    expect(m.state.outcome).toBe("approved by demo-reviewer, signed");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
