import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { shortKind, stackAlike, stackFields, stackNote, STACK_OF, USED_BY } from "./stack-lens.ts";

const node = (id: string, kind: string, status?: string) => ({ id, kind, lexicon: "aws", attrs: status ? { _status: status } : {} });

function estate(): GraphIR {
  return {
    nodes: [
      node("a/sg1", "AWS::EC2::SecurityGroup", "good"),
      node("a/sg2", "AWS::EC2::SecurityGroup", "good"),
      node("a/sg3", "AWS::EC2::SecurityGroup", "warn"),
      node("a/alb", "AWS::ElasticLoadBalancingV2::LoadBalancer", "good"),
      node("a/s1", "AWS::EC2::Subnet"),
      node("a/s2", "AWS::EC2::Subnet"),
      node("b/sg1", "AWS::EC2::SecurityGroup"),
      node("b/sg2", "AWS::EC2::SecurityGroup"),
    ],
    edges: [
      { from: "a/alb", to: "a/sg1", kind: "ref", viaAttr: "SecurityGroups" },
      { from: "a/alb", to: "a/sg2", kind: "ref", viaAttr: "SecurityGroups" },
      { from: "a/alb", to: "a/s1", kind: "ref", viaAttr: "Subnets" },
      { from: "a/sg3", to: "b/sg1", kind: "ref", viaAttr: "SourceSecurityGroupId" },
    ],
    groups: { byStack: { a: ["a/sg1", "a/sg2", "a/sg3", "a/alb", "a/s1", "a/s2"], b: ["b/sg1", "b/sg2"] } },
  } as unknown as GraphIR;
}

describe("stackAlike (#877)", () => {
  it("keeps a card the plan would change out of its stack, so its plan rows stay on the canvas (#910)", () => {
    const g = estate();
    g.nodes.push(node("a/sg4", "AWS::EC2::SecurityGroup", "good"));
    g.nodes.find((n) => n.id === "a/sg4")!.attrs._plan = { source: "plan", action: "replace" };
    g.nodes.find((n) => n.id === "a/sg1")!.attrs._plan = { source: "plan", action: "no-op" };
    (g.groups.byStack as Record<string, string[]>).a!.push("a/sg4");
    const ids = stackAlike(g).ir.nodes.map((n) => n.id);
    expect(ids).toContain("a/sg4");
    expect(ids).toContain("a/SecurityGroup ×3");
  });

  it("stacks three or more of one kind within a box, and leaves smaller sets and other boxes alone", () => {
    const r = stackAlike(estate());
    const ids = r.ir.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["a/SecurityGroup ×3", "a/alb", "a/s1", "a/s2", "b/sg1", "b/sg2"]);
    expect(r.ir.groups.byStack).toEqual({ a: ["a/SecurityGroup ×3", "a/alb", "a/s1", "a/s2"], b: ["b/sg1", "b/sg2"] });
    expect(r).toMatchObject({ stacked: 3, stacks: 1, hubs: 0 });
  });

  it("lists the stack's cards and paints it as foreign when any card is", () => {
    const stack = stackAlike(estate()).ir.nodes.find((n) => n.id === "a/SecurityGroup ×3")!;
    expect(stack.kind).toBe("AWS::EC2::SecurityGroup");
    expect(stack.lexicon).toBe("aws");
    expect(stack.attrs._status).toBe("warn");
    expect(stack.attrs[STACK_OF]).toEqual([
      { id: "a/sg1", status: "good" },
      { id: "a/sg2", status: "good" },
      { id: "a/sg3", status: "warn" },
    ]);
  });

  it("re-points edges at the stack and draws two that now say the same thing once", () => {
    const { edges } = stackAlike(estate()).ir;
    expect(edges.map((e) => `${e.from}>${e.to}`)).toEqual(["a/alb>a/SecurityGroup ×3", "a/alb>a/s1", "a/SecurityGroup ×3>b/sg1"]);
  });

  it("gives a card many merely refer to a count instead of the lines, and keeps the traffic path", () => {
    const ir = {
      nodes: [node("role", "AWS::IAM::Role"), node("tg", "AWS::ElasticLoadBalancingV2::TargetGroup"), ...["f1", "f2", "f3", "f4", "f5"].map((id) => node(id, `K::${id}`))],
      edges: [
        ...["f1", "f2", "f3", "f4", "f5"].map((from) => ({ from, to: "role", kind: "ref", viaAttr: "Role" })),
        ...["f1", "f2", "f3", "f4", "f5"].map((from) => ({ from, to: "tg", kind: "ref", viaAttr: "TargetGroupArn" })),
        { from: "f1", to: "f2", kind: "needs" },
      ],
      groups: {},
    } as unknown as GraphIR;
    const r = stackAlike(ir);
    expect(r.hubs).toBe(1);
    expect(r.ir.nodes.find((n) => n.id === "role")!.attrs[USED_BY]).toBe(5);
    expect(r.ir.edges.filter((e) => e.to === "role")).toEqual([]);
    expect(r.ir.edges.filter((e) => e.to === "tg")).toHaveLength(5);
    expect(r.ir.edges.some((e) => e.kind === "needs")).toBe(true);
  });

  it("hands back the same graph when there's nothing to stack or count", () => {
    const ir = { nodes: [node("x", "K::A"), node("y", "K::A")], edges: [], groups: {} } as unknown as GraphIR;
    expect(stackAlike(ir).ir).toBe(ir);
  });

  it("says what it did, and what a stacked or counted card shows", () => {
    expect(stackNote({ stacked: 3, stacks: 1, hubs: 1 })).toBe("alike: 3 cards stacked into 1, 1 card carries a count instead of its lines (click a stack to see its cards)");
    expect(stackNote({ stacked: 0, stacks: 0, hubs: 0 })).toBeUndefined();
    expect(stackFields({ [STACK_OF]: [{}, {}, {}], [USED_BY]: 6 })).toEqual([
      { label: "stack", value: "3 cards" },
      { label: "used by", value: "6 cards" },
    ]);
    expect(shortKind("Microsoft.Network/networkSecurityGroups")).toBe("networkSecurityGroups");
    expect(shortKind("GCP::Compute::Subnetwork")).toBe("Subnetwork");
  });
});
