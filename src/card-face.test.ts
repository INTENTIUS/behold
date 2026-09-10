import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { cardFaces, cardLabel } from "./card-face.ts";
import { renderGraph } from "./render.ts";

/** The painted card titles, in document order: pinhole draws the title at
 * font-size 15, weight 700, and nothing else on a card does. */
const titles = (svg: string): string[] => [...svg.matchAll(/font-size="15" font-weight="700">([^<]*)</g)].map((m) => m[1]);
/** The second line — `kind · lexicon` before this rule, the kind alone after. */
const subs = (svg: string): string[] => [...svg.matchAll(/fill="var\(--pin-textFaint[^"]*\)" font-size="11">([^<]*)</g)].map((m) => m[1]);
const rows = (svg: string): string[] => [...svg.matchAll(/<tspan fill="var\(--pin-textFaint[^"]*\)">([^<]*)<\/tspan>/g)].map((m) => m[1].replace(/: $/, ""));

const estateIr = (): GraphIR => ({
  nodes: [
    { id: "terralith-4/aws_ecs_cluster.main", kind: "aws_ecs_cluster", lexicon: "choudoufu", attrs: { estate: "terralith-4", rung: "tag-governable", _status: "good" } },
    { id: "terralith-4/aws_iam_role.odd", kind: "aws_iam_role", lexicon: "choudoufu", attrs: { estate: "terralith-4", rung: "record-only", _status: "neutral" } },
  ],
  edges: [],
  groups: { byStack: { "terralith-4": ["terralith-4/aws_ecs_cluster.main", "terralith-4/aws_iam_role.odd"] } },
});

describe("cardLabel (#393 item 9)", () => {
  it("takes the box's own name off a choudoufu card's title", () => {
    expect(cardLabel(estateIr().nodes[0], "terralith-4")).toBe("aws_ecs_cluster.main");
  });

  it("titles a Terraform card with the address, not <member>/<root>/<address>", () => {
    const node = {
      id: "access/baseline/aws_iam_policy.boundary",
      kind: "aws_iam_policy",
      lexicon: "terraform",
      attrs: { block: "resource", address: "aws_iam_policy.boundary", root: "baseline" },
    };
    // The box is the bare root, so the id does not start with it — the address
    // the lexicon itself put on the node is the answer.
    expect(cardLabel(node, "baseline")).toBe("aws_iam_policy.boundary");
    // And when the box IS qualified, the prefix rule reaches the same string.
    expect(cardLabel(node, "access/baseline")).toBe("aws_iam_policy.boundary");
  });

  it("leaves a chant card alone", () => {
    expect(cardLabel({ id: "loomster/loomDb", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: {} }, "loomster")).toBeUndefined();
  });
});

describe("cardFaces", () => {
  it("hands a chant estate its own IR back, with nothing to restore", () => {
    const ir: GraphIR = {
      nodes: [{ id: "loomster/loomDb", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: {} }],
      edges: [],
      groups: { byStack: { loomster: ["loomster/loomDb"] } },
    };
    const face = cardFaces(ir, ir.groups.byStack);
    expect(face.ir).toBe(ir);
    expect(face.overrides).toEqual({});
    expect(face.restore('<g data-node-id="loomster/loomDb">')).toBe('<g data-node-id="loomster/loomDb">');
  });

  it("keeps the full id on both cards when two members declare the same address", () => {
    const ir: GraphIR = {
      nodes: [
        { id: "a/aws_iam_role.shared", kind: "aws_iam_role", lexicon: "choudoufu", attrs: { estate: "a" } },
        { id: "b/aws_iam_role.shared", kind: "aws_iam_role", lexicon: "choudoufu", attrs: { estate: "b" } },
      ],
      edges: [],
      groups: { byStack: { a: ["a/aws_iam_role.shared"], b: ["b/aws_iam_role.shared"] } },
    };
    const face = cardFaces(ir, ir.groups.byStack);
    expect(face.ir.nodes.map((n) => n.id)).toEqual(["a/aws_iam_role.shared", "b/aws_iam_role.shared"]);
  });

  it("remaps edge endpoints with the nodes, and puts every id back", () => {
    const ir: GraphIR = {
      nodes: [
        { id: "m/aws_iam_role.r", kind: "aws_iam_role", lexicon: "choudoufu", attrs: { estate: "m" } },
        { id: "m/data.aws_vpc.net", kind: "data.aws_vpc", lexicon: "choudoufu", attrs: { estate: "m", producer: { estate: "other", address: "aws_vpc.net" } } },
      ],
      edges: [{ from: "m/aws_iam_role.r", to: "m/data.aws_vpc.net", kind: "ref", viaAttr: "reads" }],
      groups: { byStack: { m: ["m/aws_iam_role.r", "m/data.aws_vpc.net"] } },
    };
    const face = cardFaces(ir, ir.groups.byStack);
    expect(face.ir.edges[0]).toMatchObject({ from: "aws_iam_role.r", to: "data.aws_vpc.net" });
    expect(face.ir.groups.byStack).toEqual({ m: ["aws_iam_role.r", "data.aws_vpc.net"] });
    expect(face.restore('<g data-edge-from="aws_iam_role.r" data-edge-to="data.aws_vpc.net">')).toBe(
      '<g data-edge-from="m/aws_iam_role.r" data-edge-to="m/data.aws_vpc.net">',
    );
  });
});

describe("renderGraph paints the short face and keeps the real ids (#393 item 9)", () => {
  it("titles a choudoufu card with the address alone", () => {
    const { svg } = renderGraph(estateIr(), { boxes: "byStack" });
    expect(titles(svg)).toEqual(expect.arrayContaining(["aws_ecs_cluster.main", "aws_iam_role.odd"]));
    expect(svg).not.toContain("terralith-4/aws_ecs_cluster.main<");
  });

  it("keeps <member>/<address> as the node id the SPA joins on", () => {
    const { svg } = renderGraph(estateIr(), { boxes: "byStack" });
    expect(svg).toContain('data-node-id="terralith-4/aws_ecs_cluster.main"');
    expect(svg).toContain('data-node-id="terralith-4/aws_iam_role.odd"');
  });

  it("drops the word choudoufu from line two and keeps the type", () => {
    const { svg } = renderGraph(estateIr(), { boxes: "byStack" });
    expect(subs(svg)).toEqual(expect.arrayContaining(["aws_ecs_cluster", "aws_iam_role"]));
    expect(svg).not.toContain("choudoufu");
  });

  it("drops the estate row the box already stands for, and the rung all but a handful sit on", () => {
    const { svg } = renderGraph(estateIr(), { boxes: "byStack" });
    // The common rung says nothing; the rare one is the whole reason to look.
    expect(rows(svg)).toEqual(["rung"]);
    expect(svg).toContain("record-only");
  });

  it("keeps the estate row when a box holds cards from two estates", () => {
    const ir = estateIr();
    ir.nodes[0].attrs.estate = "somewhere-else";
    const { svg } = renderGraph(ir, { boxes: "byStack" });
    expect(rows(svg)).toContain("estate");
    expect(svg).toContain("somewhere-else");
  });

  it("names the estate that owns an unowned card", () => {
    const ir = estateIr();
    ir.nodes[0].attrs = { estate: "terralith-4", rung: "tag-governable", ownedBy: "neighbour", _status: "warn" };
    const { svg } = renderGraph(ir, { boxes: "byStack" });
    expect(rows(svg)).toContain("owned by");
    expect(svg).toContain("neighbour");
  });

  it("titles a Terraform card with its address inside its root box", () => {
    const ir: GraphIR = {
      nodes: [
        {
          id: "access/baseline/aws_iam_policy.boundary",
          kind: "aws_iam_policy",
          lexicon: "terraform",
          attrs: { block: "resource", address: "aws_iam_policy.boundary", root: "baseline" },
        },
      ],
      edges: [],
      groups: { byStack: { baseline: ["access/baseline/aws_iam_policy.boundary"] } },
    };
    const { svg } = renderGraph(ir, { boxes: "byStack" });
    expect(titles(svg)).toEqual(["aws_iam_policy.boundary"]);
    expect(svg).toContain('data-node-id="access/baseline/aws_iam_policy.boundary"');
  });
});
