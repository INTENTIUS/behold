// behold#1246: the estate merge view's pure helpers.
import { describe, expect, it } from "vitest";
import { mergeUrl, renderMerge } from "./estate-merge.js";

const side = (name, resources) => ({ members: [{ name, kind: "chant", resources }], resources, cloudIds: 2, substrates: [{ lexicon: "aws", resources }] });

describe("the merge view", () => {
  it("asks a GET with only the sides given", () => {
    expect(mergeUrl()).toBe("/api/graphdb/estate-merge");
    expect(mergeUrl(["a", "b"], ["c"])).toBe("/api/graphdb/estate-merge?left=a%2Cb&right=c");
  });

  it("draws both sides, the shared claims and the references across, with values escaped", () => {
    const html = renderMerge({
      left: side("shop", 4),
      right: side("analytics", 5),
      shared: [{ value: "acme-shared", kind: "import-id", left: [{ member: "shop", name: "<b>x</b>", kind: "aws_s3_bucket", source: "engine" }], right: [{ member: "analytics", name: "x", kind: "aws_s3_bucket", source: "engine" }] }],
      references: [{ from: "right", fromKey: "analytics/p", toKey: "shop/q", viaAttr: "policy_resource", origin: "derived", rule: "identity:arn", ambiguous: false }],
      unassigned: 0,
      notes: ["a note"],
    });
    expect(html).toContain("Shared claims (1)");
    expect(html).toContain("References across (1)");
    expect(html).toContain("derived (identity:arn)");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("aws 4");
  });

  it("says plainly when nothing is shared", () => {
    const html = renderMerge({ left: side("a", 1), right: side("b", 1), shared: [], references: [], unassigned: 0, notes: [] });
    expect(html).toContain("No cloud id is known on both sides.");
    expect(html).toContain("No reference runs from one side into the other.");
  });
});
