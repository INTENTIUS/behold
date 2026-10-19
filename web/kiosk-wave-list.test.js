import { describe, expect, it } from "vitest";
import { drawWaveList, waveHead, waveListKey, waveListOf } from "./kiosk-wave-list.js";

// behold#776: the fan-out's marks as componentMarks has them when cluster-a fails in wave 2.
const card = (root, wave, state, tone, words, facts = []) => ({ root, wave, state, tone, words, short: state, facts });
const marks = {
  cards: {
    network: card("network", 1, "applied", "ok", "applied"),
    "cluster-b": card("cluster-b", 2, "applied", "ok", "applied"),
    "cluster-a": card("cluster-a", 2, "failed", "bad", "failed: queue name lacks .fifo"),
    "app-02": card("app-02", 3, "blocked", "wait", "blocked by cluster-a"),
    "app-01": card("app-01", 3, "blocked", "wait", "blocked by cluster-a", ["plans 1 create"]),
  },
  waves: {
    1: { number: 1, state: "applied", tone: "ok", status: { words: "succeeded" } },
    2: { number: 2, state: "failed", tone: "bad", status: { words: "1 failed, 1 applied" } },
    3: { number: 3, state: "blocked", tone: "weird" },
  },
};

describe("a phone's Watch as a list of waves and roots (behold#776)", () => {
  it("lists the waves in the order they apply, each with its words and its roots by name", () => {
    const list = waveListOf(marks);
    expect(list.waves.map((w) => [w.wave, w.words, w.tone])).toEqual([
      [1, "succeeded", "ok"],
      [2, "1 failed, 1 applied", "bad"],
      // A wave with no status says its state; a tone the kiosk has no bar for is idle.
      [3, "blocked", "idle"],
    ]);
    expect(list.waves[1].roots.map((r) => [r.root, r.words, r.tone])).toEqual([
      ["cluster-a", "failed: queue name lacks .fifo", "bad"],
      ["cluster-b", "applied", "ok"],
    ]);
    expect(list.waves[2].roots[0]).toMatchObject({ root: "app-01", facts: ["plans 1 create"] });
  });
  it("carries each card's popover content when the frame has one", () => {
    const details = { "cluster-a": { root: "cluster-a", head: "1 of 2 resources change.", rows: [{ address: "aws_sqs_queue.events", state: "change", words: "changes" }], more: 0, changed: 1 } };
    const r = waveListOf(marks, details).waves[1].roots[0];
    expect(r.detail).toEqual({ head: "1 of 2 resources change.", rows: [{ address: "aws_sqs_queue.events", state: "change", words: "changes" }], more: 0 });
    expect(waveListOf(marks, details).waves[1].roots[1].detail).toBeUndefined();
  });
  it("is null with no cards, and keys equal lists alike", () => {
    expect(waveListOf(null)).toBeNull();
    expect(waveListOf({ cards: {} })).toBeNull();
    expect(waveListKey(waveListOf(marks))).toBe(waveListKey(waveListOf(marks)));
  });
  it("heads each wave by its number and words", () => {
    expect(waveHead({ wave: 2, words: "failed" })).toBe("Wave 2 · failed");
    expect(waveHead({ wave: 1, words: "" })).toBe("Wave 1");
    expect(waveHead({ wave: null, words: "" })).toBe("Other roots");
  });
});

describe("drawing the list (behold#776)", () => {
  // A small document: enough of the DOM for the list.
  const fakeDocument = () => {
    const make = (tag) => {
      const n = {
        tagName: tag.toUpperCase(),
        className: "",
        textContent: "",
        children: [],
        dataset: {},
        attrs: {},
        hidden: false,
        listeners: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        append(...xs) { for (const x of xs) this.appendChild(x); },
        appendChild(x) { this.children.push(x); return x; },
        replaceChildren() { this.children = []; },
        addEventListener(t, f) { this.listeners[t] = f; },
      };
      return n;
    };
    return { createElement: make };
  };
  const all = (n, cls) => (n.className && n.className.split(" ").includes(cls) ? [n] : []).concat(...(n.children || []).map((c) => all(c, cls)));

  it("draws a section a wave and a button a root, and opens a root's resources on a tap", () => {
    const doc = fakeDocument();
    const host = doc.createElement("section");
    const list = waveListOf(marks, { "cluster-a": { head: "1 of 2 resources change.", rows: [{ address: "aws_sqs_queue.events", state: "change", words: "changes" }], more: 3 } });
    const tapped = [];
    drawWaveList(host, list, { doc, open: new Set(["cluster-a"]), onToggle: (r) => tapped.push(r) });
    expect(host.hidden).toBe(false);
    expect(all(host, "k-wl-wave-head").map((h) => h.textContent)).toEqual(["Wave 1 · succeeded", "Wave 2 · 1 failed, 1 applied", "Wave 3 · blocked"]);
    const rows = all(host, "k-wl-row");
    expect(rows).toHaveLength(5);
    // The open root says it is open, and lists its resources under it.
    const open = all(host, "k-wl-open");
    expect(open.map((li) => li.dataset.kRoot)).toEqual(["cluster-a"]);
    expect(all(open[0], "k-wl-res-head")[0].textContent).toBe("1 of 2 resources change.");
    expect(all(open[0], "k-wl-res-more")[0].textContent).toBe("and 3 more");
    rows[2].listeners.click();
    expect(tapped).toEqual(["cluster-b"]);
  });
  it("hides itself with nothing to list", () => {
    const doc = fakeDocument();
    const host = doc.createElement("section");
    drawWaveList(host, null, { doc });
    expect(host.hidden).toBe(true);
  });
});
