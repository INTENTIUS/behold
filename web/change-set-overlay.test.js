import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { overlayFrom } from "../src/change-set-overlay.ts";
import { gatesFromStatus } from "../src/workspace-gates.ts";
import { actionWords, attributeWords, BUCKETS, entriesFor, gapLines, nodeMarks, offGraph, overlayHeader, overlayLegend, valueWords } from "./change-set-overlay.js";

// #681: the overlay drawn from the stored change set chant printed for the
// fixture workspace (src/__fixtures__/change-set-overlay), as the route
// answers it: the release gate waiting in prod and its change set.
const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "change-set-overlay");
const fixture = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const gates = gatesFromStatus(fixture("status-prod.json"), "/ws");
const { dir: _dir, ...gate } = gates.gates[0];
const answer = { workspace: true, chant: "0.124.28", ...overlayFrom(gate, fixture("change-set-show.json"), new Date("2026-10-16T00:00:00Z")) };

describe("the overlay's colours (#681)", () => {
  it("draws create, change and delete in the drift legend's tokens", () => {
    expect(BUCKETS.map((b) => [b.bucket, b.color])).toEqual([
      ["create", "var(--managed)"],
      ["change", "var(--foreign)"],
      ["delete", "var(--degraded)"],
    ]);
  });
  it("gives a legend row per bucket with its count, and counts what changes nothing", () => {
    expect(overlayLegend(answer).map((r) => [r.label, r.count])).toEqual([
      ["create", 1],
      ["update or replace", 2],
      ["delete or forget", 1],
      ["no change (not drawn)", 1],
    ]);
  });
});

describe("the overlay on the graph (#681)", () => {
  it("marks each node the change set touches, with its colour and its actions", () => {
    const marks = nodeMarks(answer);
    expect(Object.keys(marks).sort()).toEqual(["web/AppBucket", "web/AppFunction", "web/AppQueue"]);
    expect(marks["web/AppQueue"]).toMatchObject({ bucket: "create", color: "var(--managed)", tag: "create" });
    expect(marks["web/AppFunction"]).toMatchObject({ bucket: "change", color: "var(--foreign)", tag: "replace" });
    expect(marks["web/AppBucket"].title).toBe("change set 9cf74a6fee02 (preview, not applied):\nupdate AppBucket");
  });
  it("names the commit, gate and release it belongs to", () => {
    expect(overlayHeader(answer)).toMatchObject({
      lines: ["change set 9cf74a6fee02 · gate web/release/promote in prod", "commit a14610e · run run-9 · release 1a23268fa8b1 planned for prod"],
      tone: "quiet",
    });
    expect(overlayHeader(answer).title).toContain("chant approve release promote --env prod");
  });
  it("says why when the change set wasn't read", () => {
    const refusal = { error: "Change set needs chant 0.124.28 or newer. This project has chant 0.124.24.", code: "chant-too-old", remedy: "Upgrade" };
    expect(overlayHeader({ workspace: true, refusal })).toEqual({ lines: [`change set not read: ${refusal.error}`], tone: "refusal", title: "Upgrade" });
    expect(nodeMarks({ refusal })).toEqual({});
  });
});

describe("a node's entries (#681)", () => {
  it("lists address, action and fields when a node is clicked", () => {
    expect(entriesFor(answer, "web/AppFunction")).toEqual([
      {
        head: "replace AppFunction",
        bucket: "change",
        color: "var(--foreign)",
        facts: "AWS::Lambda::Function · disruption replace",
        fields: ['FunctionName: before "cart-v1", after "cart-v2" (forces replacement)', "Environment: sensitive, not shown"],
      },
    ]);
    expect(entriesFor(answer, "web/AppBucket")[0].fields).toEqual(['VersioningConfiguration: before {"Status":"Suspended"}, after {"Status":"Enabled"}', 'Tags: before [{"Key":"team","Value":"cart"}], after: known after apply']);
    expect(entriesFor(answer, "web/AppRole")).toEqual([]);
  });
  it("keeps the entries with no node in the side list, and those this view does not draw", () => {
    const off = offGraph(answer, new Set(["web/AppQueue", "web/AppBucket"]));
    expect(off.noNode.map((e) => e.head)).toEqual(["delete LegacyTopic"]);
    expect(off.noNode[0].color).toBe("var(--degraded)");
    expect(off.notDrawn.map((e) => [e.head, e.node])).toEqual([["replace AppFunction", "web/AppFunction"]]);
  });
  it("words the small things plainly", () => {
    expect(actionWords({ create: 2, delete: 1 })).toBe("2 create, delete");
    expect(attributeWords({ path: "a", after: 1 })).toBe("a: after 1");
    expect(valueWords("x".repeat(200))).toHaveLength(80);
    expect(gapLines({ ...answer, gaps: [{ member: "api", status: "failed", error: "no credentials", holes: [] }] })).toEqual([{ text: "api did not plan: no credentials, so its changes are not drawn", title: "" }]);
  });
});
