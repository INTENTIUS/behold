import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collisionsFrom } from "../src/collision-marks.ts";
import { COLLISION_COLOR, COLLISION_NOTE, collisionFilter, collisionHeader, collisionMarks, collisionsFor, FILTER_OFF, FILTER_ON, gapLines, hideEdge, itemRow, nodeRow, sideLines } from "./collision-marks.js";

// #684: the marks drawn from what chant printed for the fixture workspace
// (src/__fixtures__/collision-marks): W-001 and W-002 both change
// web/queue.ts, and a waiting gate's change set has an entry on web/Queue.
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "__fixtures__", "collision-marks", "status-staging.json"), "utf8"));
const base = { workspace: true, chant: "0.124.29", ...collisionsFrom(fixture, new Date("2026-10-17T00:00:00Z")) };
// The fixture plus a third in-flight item that collides with none, and a second node only one item reaches (not marked).
const answer = { ...base, items: [...base.items, { item: "work:W-003", path: "work/W-003.md", state: "open", commits: ["abcdef1234567"], with: [] }] };
const IDS = ["web/Queue", "web/Topic", "api/Fn"];

describe("collision marks on the graph (#684)", () => {
  it("marks the node two work items touch and lists them, and leaves other cards alone", () => {
    const m = collisionMarks(answer, IDS);
    expect(Object.keys(m)).toEqual(["web/Queue"]);
    expect(m["web/Queue"]).toMatchObject({ tag: "collision: W-001, W-002", color: COLLISION_COLOR, items: ["work:W-001", "work:W-002"] });
    expect(m["web/Queue"].title).toContain("work:W-001\nwork:W-002");
    expect(m["web/Queue"].title).toContain("declared in web/queue.ts");
    expect(m["web/Queue"].title).toContain(COLLISION_NOTE);
  });
  it("marks nothing for a node not on the graph, or for a refusal", () => {
    expect(collisionMarks(answer, ["api/Fn"])).toEqual({});
    expect(collisionMarks({ refusal: { error: "x" } }, IDS)).toEqual({});
  });
  it("lists a card's colliding items in the inspect pane", () => {
    expect(collisionsFor(answer, "web/Queue").map((r) => r.text)).toEqual(["work:W-001", "work:W-002"]);
    expect(collisionsFor(answer, "web/Topic")).toEqual([]);
  });
});

describe("the filter shows only colliding work (#684)", () => {
  it("off, hides nothing and lists every in-flight item", () => {
    const f = collisionFilter(answer, IDS, false);
    expect(f.hide).toEqual([]);
    expect(f.items.map((i) => i.item)).toEqual(["work:W-001", "work:W-002", "work:W-003"]);
  });
  it("on, hides every card but the colliding node, and lists only the items that collide", () => {
    const f = collisionFilter(answer, IDS, true);
    expect(f.hide).toEqual(["web/Topic", "api/Fn"]);
    expect(f.nodes.map((n) => n.node)).toEqual(["web/Queue"]);
    expect(f.items.map((i) => i.item)).toEqual(["work:W-001", "work:W-002"]);
  });
  it("on, hides an edge unless both of its ends are colliding nodes", () => {
    expect(hideEdge(answer, "web/Queue", "web/Topic", true)).toBe(true);
    expect(hideEdge(answer, "web/Queue", "web/Queue", true)).toBe(false);
    expect(hideEdge(answer, "web/Queue", "web/Topic", false)).toBe(false);
  });
  it("on, with nothing colliding, shows nothing", () => {
    const none = { ...answer, nodes: [], items: answer.items.map((i) => ({ ...i, with: [] })), files: [] };
    const f = collisionFilter(none, IDS, true);
    expect(f.hide).toEqual(IDS);
    expect(f.items).toEqual([]);
  });
  it("says what the button does", () => {
    expect([FILTER_OFF, FILTER_ON]).toEqual(["Show only colliding work", "Show all work"]);
  });
});

describe("the Collisions tab (#684)", () => {
  it("counts the colliding items and the marked nodes", () => {
    expect(collisionHeader(answer)).toMatchObject({ text: "2 work items collide, 1 node marked", tone: "quiet" });
    expect(collisionHeader({ ...answer, nodes: [], items: base.items.map((i) => ({ ...i, with: [] })) }).text).toBe("no work items collide (2 work items in flight)");
  });
  it("shows each item with its state, record, commits and who it collides with", () => {
    const r = itemRow(answer.items[0]);
    expect(r).toMatchObject({ title: "work:W-001", with: "collides with work:W-002", colliding: true });
    expect(r.facts).toMatch(/^in-progress · work\/W-001-the-queue\.md · 1 commit \([0-9a-f]{7}\)$/);
    expect(itemRow(answer.items[2])).toMatchObject({ with: "collides with none", colliding: false });
  });
  it("lists the marked node, and the shared file on the side with no node", () => {
    expect(nodeRow(answer.nodes[0])).toMatchObject({ node: "web/Queue", text: "web/Queue: work:W-001 and work:W-002" });
    expect(sideLines(answer).map((s) => s.text)).toEqual(["work:W-001 and work:W-002: web/queue.ts"]);
  });
  it("lists a shared entry chant mapped to no node on the side", () => {
    const unplaced = { ...answer, unplaced: [{ items: ["work:W-001", "work:W-002"], changeSet: "jcs1-sha256:" + "ab".repeat(32), member: "web", address: "web", source: "web/queue.ts" }] };
    expect(sideLines(unplaced).map((s) => s.text)).toContain("work:W-001 and work:W-002: web of web in change set abababababab, declared in web/queue.ts");
  });
  it("says why nothing was read, and what is missing below the floor", () => {
    const h = collisionHeader({ refusal: { error: "Work overlap needs chant 0.124.29 or newer.", remedy: "Upgrade." }, degraded: "the graph draws no collision marks" });
    expect(h).toMatchObject({ tone: "refusal", text: "collisions not read: Work overlap needs chant 0.124.29 or newer." });
    expect(h.title).toContain("Without it, the graph draws no collision marks.");
    expect(gapLines({ ...answer, unattributed: 3 }).map((g) => g.text)).toEqual(["3 change-set entries could not be attributed to a work item"]);
    expect(gapLines(answer)).toEqual([]);
  });
});
