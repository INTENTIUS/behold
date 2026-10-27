import { describe, expect, it } from "vitest";
import { applyDriftFrame, cardsFor, memberAddresses, worstTone } from "./drift-stream.js";

// behold#998/#1014: the addresses the page sends to POST /api/workspace/drift/stream.
describe("memberAddresses", () => {
  it("names each card of the member by its address, once", () => {
    const ir = {
      nodes: [
        { id: "monolith/aws_iam_role.team_a", attrs: { address: "aws_iam_role.team_a" } },
        { id: "monolith/aws_iam_policy.team_a", attrs: {} },
        { id: "team-a/aws_iam_role.team_a", attrs: { address: "aws_iam_role.team_a" } },
        { id: "monolith/aws_iam_role.team_a", attrs: { address: "aws_iam_role.team_a" } },
      ],
    };
    expect(memberAddresses(ir, "monolith")).toEqual(["aws_iam_role.team_a", "aws_iam_policy.team_a"]);
  });

  it("asks about the cards a stack holds, never the stack's `<kind> ×<n>` title", () => {
    // An estate's default zoom stacks alike cards (src/stack-lens.ts); the
    // stack's address is its title, which the server's resourceBlocks drops,
    // so before this the start named no resource and ended at once.
    const ir = {
      nodes: [
        {
          id: "monolith/aws_iam_policy ×3",
          attrs: {
            address: "aws_iam_policy ×3",
            _stackOf: [{ id: "monolith/aws_iam_policy.team_a" }, { id: "monolith/aws_iam_policy.team_b", status: "ok" }, "monolith/aws_iam_policy.team_c"],
          },
        },
        { id: "monolith/aws_iam_role.team_a", attrs: { address: "aws_iam_role.team_a" } },
        { id: "team-b/aws_iam_policy ×3", attrs: { _stackOf: [{ id: "team-b/aws_iam_policy.x" }] } },
      ],
    };
    expect(memberAddresses(ir, "monolith")).toEqual([
      "aws_iam_policy.team_a",
      "aws_iam_policy.team_b",
      "aws_iam_policy.team_c",
      "aws_iam_role.team_a",
    ]);
  });
});

// behold#1021: in the default stacked view a record colours the stack card that holds its card, worst tone wins.
describe("streamed drift on a stack card", () => {
  const stacked = () => ({
    nodes: [
      {
        id: "monolith/aws_iam_policy ×3",
        attrs: {
          address: "aws_iam_policy ×3",
          _status: "neutral",
          _stackOf: [{ id: "monolith/aws_iam_policy.team_a" }, { id: "monolith/aws_iam_policy.team_b" }, "monolith/aws_iam_policy.team_c"],
        },
      },
      { id: "monolith/aws_iam_role.team_a", attrs: { address: "aws_iam_role.team_a" } },
      { id: "team-a/aws_iam_policy ×3", attrs: { _stackOf: [{ id: "team-a/aws_iam_policy.team_a" }] } },
    ],
  });
  const ADDRS = ["aws_iam_policy.team_a", "aws_iam_policy.team_b", "aws_iam_policy.team_c", "aws_iam_role.team_a"];
  const start = (ir) => applyDriftFrame(ir, { run: 7, kind: "start", member: "monolith", expected: ADDRS });
  const record = (ir, address, tone, status, extra = {}) =>
    applyDriftFrame(ir, { run: 7, kind: "record", member: "monolith", address, node: null, status, read: "ownership", tone, label: status, ...extra });

  it("cardsFor finds the stack card that holds the address, in its own member only", () => {
    const ir = stacked();
    expect(cardsFor(ir, "monolith", "aws_iam_policy.team_c", null)).toEqual(["monolith/aws_iam_policy ×3"]);
    expect(cardsFor(ir, "monolith", "x", "monolith/aws_iam_policy.team_b")).toEqual(["monolith/aws_iam_policy ×3"]);
    expect(cardsFor(ir, "monolith", "x", "aws_iam_policy.team_a")).toEqual(["monolith/aws_iam_policy ×3"]);
    expect(cardsFor(ir, "monolith", "aws_iam_role.team_a", null)).toEqual(["monolith/aws_iam_role.team_a"]);
    expect(cardsFor(ir, "team-a", "aws_iam_policy.team_b", null)).toEqual([]);
  });

  it("a start marks the stack reading; it reads until every held card reported", () => {
    const ir = stacked();
    expect(start(ir).reading).toBe(2);
    const stack = ir.nodes[0].attrs;
    expect(stack._driftReading).toBe(7);
    record(ir, "aws_iam_policy.team_a", "good", "in-sync");
    record(ir, "aws_iam_policy.team_b", "good", "in-sync");
    expect(stack._driftReading).toBe(7);
    // A green so far is no claim while a card is unread: the stack keeps its colour.
    expect(stack._status).toBe("neutral");
    expect(stack._drift).toBeUndefined();
    const { moved } = record(ir, "aws_iam_policy.team_c", "good", "in-sync");
    expect(moved).toEqual(["monolith/aws_iam_policy ×3"]);
    expect(stack._driftReading).toBeUndefined();
    expect(stack._status).toBe("good");
    expect(stack._drift.label).toBe("in-sync: 3 of 3 cards");
  });

  it("worst tone wins, and paints as soon as it arrives", () => {
    const ir = stacked();
    start(ir);
    const stack = ir.nodes[0].attrs;
    record(ir, "aws_iam_policy.team_a", "good", "in-sync");
    record(ir, "aws_iam_policy.team_b", "warn", "drifted");
    expect(stack._status).toBe("warn");
    expect(stack._drift.status).toBe("drifted");
    expect(stack._drift.label).toBe("drifted: 1 of 3 cards, 2 reported");
    expect(stack._driftReading).toBe(7);
    record(ir, "aws_iam_policy.team_c", "accent", "pending");
    expect(stack._status).toBe("warn");
    expect(stack._driftReading).toBeUndefined();
    // The pane's list carries each held card's tone; a bare-string entry stays a string.
    expect(stack._stackOf).toEqual([
      { id: "monolith/aws_iam_policy.team_a", status: "good" },
      { id: "monolith/aws_iam_policy.team_b", status: "warn" },
      "monolith/aws_iam_policy.team_c",
    ]);
    // The lone card is untouched by the stack's records.
    expect(ir.nodes[1].attrs._status).toBeUndefined();
  });

  it("an unobserved card keeps a stack from green; all unobserved marks the stack unobserved", () => {
    const ir = stacked();
    start(ir);
    const stack = ir.nodes[0].attrs;
    record(ir, "aws_iam_policy.team_a", "good", "in-sync");
    record(ir, "aws_iam_policy.team_b", "neutral", "not-observed", { reason: "read-failed", notReached: true });
    record(ir, "aws_iam_policy.team_c", "good", "in-sync");
    expect(stack._status).toBe("neutral");
    expect(stack._unobserved).toBeUndefined();
    const all = stacked();
    start(all);
    for (const a of ADDRS.slice(0, 3)) record(all, a, "neutral", "not-observed", { reason: "not-reached", notReached: true });
    expect(all.nodes[0].attrs._unobserved).toEqual({ reason: "not-reached" });
  });

  it("a new run starts the stack afresh", () => {
    const ir = stacked();
    start(ir);
    for (const a of ADDRS.slice(0, 3)) record(ir, a, "warn", "drifted");
    applyDriftFrame(ir, { run: 8, kind: "start", member: "monolith", expected: ADDRS });
    for (const a of ADDRS.slice(0, 3)) applyDriftFrame(ir, { run: 8, kind: "record", member: "monolith", address: a, node: null, status: "in-sync", read: "ownership", tone: "good", label: "in-sync" });
    expect(ir.nodes[0].attrs._status).toBe("good");
  });

  it("worstTone ranks warn, accent, neutral, runtime, good; an unknown tone as neutral", () => {
    expect(worstTone(["good", "runtime"])).toBe("runtime");
    expect(worstTone(["good", "neutral", "accent"])).toBe("accent");
    expect(worstTone(["good", "bogus"])).toBe("neutral");
    expect(worstTone([])).toBeUndefined();
  });
});

