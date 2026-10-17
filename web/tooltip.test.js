import { describe, expect, it } from "vitest";
import { HOVER_MS, TIP_ID, addId, dropId, installTooltips, isBadge, ownTitle, placeTip, reachBadges, tipHost } from "./tooltip.js";

// behold#725: a stand-in DOM, enough for the tooltip: elements with
// attributes, children, text and a rect, and a document with listeners.
class El {
  constructor(tag, attrs = {}, kids = []) {
    this.nodeType = 1;
    this.localName = tag;
    this.attrs = new Map(Object.entries(attrs));
    this.children = [];
    this.parentNode = null;
    this._text = "";
    this.hidden = false;
    this.style = {};
    this.rect = { left: 100, top: 100, right: 140, bottom: 120, width: 40, height: 20 };
    this.focusVisible = true;
    for (const k of kids) this.appendChild(typeof k === "string" ? Object.assign(new El("#text"), { _text: k }) : k);
  }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  get textContent() { return this.localName === "#text" ? this._text : this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.children = []; this._text = String(v); }
  getBoundingClientRect() { return this.rect; }
  matches(q) { return q === ":focus-visible" ? this.focusVisible : false; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(q) {
    if (q !== "svg title") return [];
    const out = [];
    for (const n of this.walk()) {
      if (n.localName !== "title") continue;
      for (let p = n.parentNode; p; p = p.parentNode) if (p.localName === "svg") { out.push(n); break; }
    }
    return out;
  }
}
const fakeDoc = (body, { bare = false } = {}) => {
  const listeners = new Map();
  const html = new El("html", {}, [body]);
  html.classList = { contains: (c) => c === "bare" && bare };
  html.clientWidth = 800;
  html.clientHeight = 600;
  const doc = {
    documentElement: html,
    body,
    defaultView: { innerWidth: 800, innerHeight: 600 },
    createElement: (tag) => new El(tag),
    getElementById: (id) => [...html.walk()].find((n) => n.getAttribute && n.getAttribute("id") === id) || null,
    querySelector: () => null,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type, e) => listeners.get(type) && listeners.get(type)(e),
  };
  html.parentNode = null;
  return doc;
};
const graph = () => {
  const badgeTitle = new El("title", {}, ["wave 2 · waiting\n(from terragucci's reports, not live)"]);
  const badgeRect = new El("rect");
  const badge = new El("g", { "data-tg-root": "badge" }, [badgeTitle, badgeRect]);
  const cardTitle = new El("title", {}, ["still reading this member"]);
  const card = new El("g", { "data-node-id": "a/b" }, [cardTitle, new El("rect"), badge]);
  const edge = new El("g", { "data-edge-from": "a/b" }, [new El("title", {}, ["data dependency"])]);
  const svg = new El("svg", {}, [card, edge]);
  const body = new El("body", {}, [svg]);
  return { body, svg, card, cardTitle, badge, badgeTitle, badgeRect, edge };
};
const timers = () => {
  const queue = [];
  return { setTimer: (fn, ms) => { queue.push({ fn, ms }); return queue.length; }, clearTimer: (i) => { if (queue[i - 1]) queue[i - 1].fn = () => {}; }, run: () => queue.splice(0).forEach((t) => t.fn()), queue };
};

describe("placeTip (behold#725)", () => {
  const view = { width: 800, height: 600 };
  it("centres the tooltip under its target", () => {
    expect(placeTip({ left: 100, right: 140, top: 100, bottom: 120 }, { width: 60, height: 30 }, view)).toEqual({ left: 90, top: 128, side: "below" });
  });
  it("goes above when there is no room below", () => {
    expect(placeTip({ left: 100, right: 140, top: 560, bottom: 580 }, { width: 60, height: 30 }, view)).toEqual({ left: 90, top: 522, side: "above" });
  });
  it("stays inside the window's sides", () => {
    expect(placeTip({ left: 0, right: 10, top: 10, bottom: 20 }, { width: 200, height: 30 }, view).left).toBe(8);
    expect(placeTip({ left: 790, right: 800, top: 10, bottom: 20 }, { width: 200, height: 30 }, view).left).toBe(592);
  });
});

describe("the id list (behold#725)", () => {
  it("adds the tooltip's id once and takes it out again, keeping the others", () => {
    expect(addId("", TIP_ID)).toBe(TIP_ID);
    expect(addId(`x ${TIP_ID}`, TIP_ID)).toBe(`x ${TIP_ID}`);
    expect(addId("x", TIP_ID)).toBe(`x ${TIP_ID}`);
    expect(dropId(`x ${TIP_ID}`, TIP_ID)).toBe("x");
    expect(dropId(null, TIP_ID)).toBe("");
  });
});

describe("the graph's badges (behold#725)", () => {
  it("finds a mark's own <title> and the element whose words a tooltip shows", () => {
    const g = graph();
    expect(ownTitle(g.badge)).toBe(g.badgeTitle);
    expect(tipHost(g.badgeRect)).toBe(g.badge);
    expect(tipHost(g.card.children[1])).toBe(g.card);
    expect(tipHost(g.svg)).toBe(null);
  });

  it("counts a mark on a card as a badge, and the card, an edge and the drawing as not", () => {
    const g = graph();
    expect(isBadge(g.badge)).toBe(true);
    expect(isBadge(g.card)).toBe(false);
    expect(isBadge(g.edge)).toBe(false);
    expect(isBadge(g.svg)).toBe(false);
  });

  it("gives each badge with words a tab stop, once", () => {
    const g = graph();
    expect(reachBadges(g.body)).toBe(1);
    expect(g.badge.getAttribute("tabindex")).toBe("0");
    expect(g.card.hasAttribute("tabindex")).toBe(false);
    expect(reachBadges(g.body)).toBe(0);
  });
});

describe("installTooltips (behold#725)", () => {
  it("opens on a resting pointer with the <title>'s words, which leave the <title> while it shows and come back after", () => {
    const g = graph();
    const doc = fakeDoc(g.body);
    const t = timers();
    installTooltips(doc, t);
    doc.fire("pointerover", { target: g.badgeRect });
    // Emptied at once, so the browser's own tooltip has nothing to show.
    expect(g.badgeTitle.textContent).toBe("");
    expect(t.queue[0].ms).toBe(HOVER_MS);
    t.run();
    const tip = doc.getElementById(TIP_ID);
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toContain("wave 2 · waiting");
    expect(g.badge.getAttribute("aria-describedby")).toBe(TIP_ID);
    doc.fire("pointerout", { target: g.badgeRect, relatedTarget: g.svg });
    expect(tip.hidden).toBe(true);
    expect(g.badgeTitle.textContent).toContain("wave 2 · waiting");
    expect(g.badge.hasAttribute("aria-describedby")).toBe(false);
  });

  it("opens at once on keyboard focus, closes on Escape, and keeps the <title> empty until the focus leaves", () => {
    const g = graph();
    const doc = fakeDoc(g.body);
    const t = timers();
    installTooltips(doc, t);
    doc.fire("focusin", { target: g.badge });
    const tip = doc.getElementById(TIP_ID);
    expect(tip.hidden).toBe(false);
    doc.fire("keydown", { key: "Escape" });
    expect(tip.hidden).toBe(true);
    expect(g.badgeTitle.textContent).toBe("");
    doc.fire("focusout", { target: g.badge });
    expect(g.badgeTitle.textContent).toContain("wave 2 · waiting");
  });

  it("stays shut on a click's focus", () => {
    const g = graph();
    g.badge.focusVisible = false;
    const doc = fakeDoc(g.body);
    installTooltips(doc, timers());
    doc.fire("focusin", { target: g.badge });
    expect(doc.getElementById(TIP_ID)).toBe(null);
    expect(g.badgeTitle.textContent).toContain("wave 2");
  });

  it("is placed fixed under its target", () => {
    const g = graph();
    const doc = fakeDoc(g.body);
    installTooltips(doc, timers());
    doc.fire("focusin", { target: g.badge });
    const tip = doc.getElementById(TIP_ID);
    expect(tip.style.top).toBe("128px");
  });

  it("does nothing in a kiosk frame, which has its own popover", () => {
    const g = graph();
    const doc = fakeDoc(g.body, { bare: true });
    const t = timers();
    installTooltips(doc, t);
    doc.fire("pointerover", { target: g.badgeRect });
    expect(t.queue.length).toBe(0);
    expect(g.badgeTitle.textContent).toContain("wave 2");
  });
});
