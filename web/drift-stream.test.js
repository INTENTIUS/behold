import { describe, expect, it } from "vitest";
import { memberAddresses } from "./drift-stream.js";

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
