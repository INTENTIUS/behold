import { describe, expect, it } from "vitest";
import { commitHref, commitOfPath, historyLabel, historyRows, mountHistoryPicker } from "./history-picker.js";

// #510: the picker inside a published commit's view, reading ../history.json.
const A = "a".repeat(40);
const B = "b".repeat(40);
const history = [
  { commit: A, at: "2026-10-09T08:00:00.000Z", project: "shop", generated: "2026-10-10T12:00:00.000Z" },
  { commit: B, at: "2026-10-08T08:00:00.000Z", project: "shop", generated: "2026-10-08T09:30:00.000Z" },
  { commit: "../x", at: "", project: "", generated: "" },
];

/** Just enough of a document for the picker. */
function fakeDocument() {
  const make = (tag) => {
    const el = {
      tag,
      children: [],
      style: {},
      attrs: {},
      listeners: {},
      appendChild: (c) => (el.children.push(c), c),
      setAttribute: (k, v) => (el.attrs[k] = v),
      addEventListener: (k, f) => (el.listeners[k] = f),
    };
    return el;
  };
  return { createElement: make, host: make("div") };
}

describe("the history picker (#510)", () => {
  it("offers the rows with a commit, newest first, labeled with the commit and when it was exported", () => {
    const rows = historyRows(history);
    expect(rows.map((r) => r.commit)).toEqual([A, B]);
    expect(historyLabel(rows[0])).toBe(`${A.slice(0, 12)} · exported 2026-10-10 12:00`);
    expect(historyRows({})).toEqual([]);
  });

  it("knows which commit the page is from its path", () => {
    const rows = historyRows(history);
    expect(commitOfPath(`/r/views/behold/${B}/index.html`, rows)).toBe(B);
    expect(commitOfPath(`/r/views/behold/${A}/`, rows)).toBe(A);
    expect(commitOfPath("/somewhere/else/", rows)).toBeNull();
  });

  it("reads ../history.json, selects this commit, and opens another in place, keeping the query and fragment", async () => {
    const asked = [];
    const went = [];
    const doc = fakeDocument();
    const location = { pathname: `/r/views/behold/${A}/index.html`, search: "?env=prod", hash: "#x", assign: (u) => went.push(u) };
    const fetch = async (u, o) => (asked.push([u, o]), { ok: true, json: async () => history });
    const select = await mountHistoryPicker(doc.host, { fetch, location, document: doc });
    expect(asked).toEqual([["../history.json", { cache: "no-cache" }]]);
    expect(doc.host.children).toEqual([select]);
    expect(select.children.map((o) => [o.value, !!o.selected])).toEqual([[A, true], [B, false]]);
    select.value = B;
    select.listeners.change();
    expect(went).toEqual([`../${B}/index.html?env=prod#x`]);
    expect(commitHref(A)).toBe(`../${A}/index.html`);
  });

  it("shows nothing when no history.json sits beside the view", async () => {
    const doc = fakeDocument();
    const location = { pathname: "/bundle/index.html", search: "", hash: "", assign: () => {} };
    expect(await mountHistoryPicker(doc.host, { fetch: async () => ({ ok: false }), location, document: doc })).toBeNull();
    expect(await mountHistoryPicker(doc.host, { fetch: async () => Promise.reject(new Error("offline")), location, document: doc })).toBeNull();
    expect(doc.host.children).toEqual([]);
  });

  it("marks a view that is not in the history rather than claiming to be another commit", async () => {
    const doc = fakeDocument();
    const location = { pathname: `/r/views/behold/${"c".repeat(40)}/index.html`, search: "", hash: "", assign: () => {} };
    const select = await mountHistoryPicker(doc.host, { fetch: async () => ({ ok: true, json: async () => history }), location, document: doc });
    expect(select.children[0]).toMatchObject({ value: "", selected: true });
    expect(select.children).toHaveLength(3);
  });
});
