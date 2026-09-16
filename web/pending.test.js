import { describe, expect, it } from "vitest";
import { applyMemberFrame, pendingLine, stillPending } from "./pending.js";

const ir = () => ({
  nodes: [
    { id: "team-a/bucket", attrs: { _pendingRead: true } },
    { id: "team-a/role", attrs: { _pendingRead: true } },
    { id: "team-b/bucket", attrs: { _pendingRead: true } },
  ],
});

describe("applyMemberFrame (#422)", () => {
  it("clears pending and paints only the member that landed", () => {
    const graph = ir();
    const moved = applyMemberFrame(graph, { member: "team-a", statuses: { "team-a/bucket": "good", "team-a/role": "warn" } });

    expect(moved.sort()).toEqual(["team-a/bucket", "team-a/role"]);
    expect(graph.nodes[0].attrs).toEqual({ _status: "good" });
    expect(graph.nodes[1].attrs).toEqual({ _status: "warn" });
    // The member that has not answered is untouched, and still says so.
    expect(graph.nodes[2].attrs).toEqual({ _pendingRead: true });
  });

  it("carries a failed member's reason, which is not the same as pending", () => {
    const graph = ir();
    applyMemberFrame(graph, { member: "team-b", unobserved: "no credentials", statuses: { "team-b/bucket": "neutral" } });
    // Unobserved is "I looked and could not see"; pending was "I have not
    // finished looking". The card must stop claiming the second one.
    expect(graph.nodes[2].attrs).toEqual({ _status: "neutral", _unobserved: "no credentials" });
  });

  it("reports nothing moved when the status is what it already was", () => {
    const graph = { nodes: [{ id: "a", attrs: { _status: "good" } }] };
    expect(applyMemberFrame(graph, { member: "m", statuses: { a: "good" } })).toEqual([]);
    expect(graph.nodes[0].attrs._status).toBe("good");
  });

  it("ignores a malformed frame rather than throwing over the picture", () => {
    expect(applyMemberFrame(ir(), null)).toEqual([]);
    expect(applyMemberFrame(ir(), { member: "x" })).toEqual([]);
    expect(applyMemberFrame(null, { member: "x", statuses: {} })).toEqual([]);
  });
});

describe("what is still arriving", () => {
  it("drops the member that landed", () => {
    expect(stillPending(["a", "b", "c"], { member: "b", statuses: {} })).toEqual(["a", "c"]);
  });

  it("names them while the list is short enough to read", () => {
    expect(pendingLine(["team-a", "team-b"], 5)).toBe("3 of 5 members read — waiting on team-a, team-b");
  });

  it("counts them once naming would be a wall of text", () => {
    expect(pendingLine(["a", "b", "c", "d"], 11)).toBe("7 of 11 members read");
  });

  it("says nothing once nothing is pending", () => {
    expect(pendingLine([], 5)).toBeNull();
    expect(pendingLine(undefined, 5)).toBeNull();
  });
});
