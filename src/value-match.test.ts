import { describe, it, expect } from "vitest";
import { addValueMatchEdges, isOwnNameAttr } from "./value-match.ts";
import type { GraphIR } from "@intentius/chant";

describe("isOwnNameAttr", () => {
  it("is true for a node's own name attribute", () => {
    expect(isOwnNameAttr("AWS::RDS::DBSubnetGroup", "DBSubnetGroupName")).toBe(true);
    expect(isOwnNameAttr("AWS::ECS::Cluster", "ClusterName")).toBe(true);
    expect(isOwnNameAttr("AWS::EC2::SecurityGroup", "GroupName")).toBe(true); // type ends with prefix
    expect(isOwnNameAttr("AWS::Anything", "Name")).toBe(true);
  });
  it("is false when the same key names a DIFFERENT resource (a reference)", () => {
    // DBSubnetGroupName on an RDS *instance* points at the subnet group, not self.
    expect(isOwnNameAttr("AWS::RDS::DBInstance", "DBSubnetGroupName")).toBe(false);
  });
  it("is false for non-name attributes", () => {
    expect(isOwnNameAttr("AWS::RDS::DBInstance", "Engine")).toBe(false);
  });
});

describe("addValueMatchEdges", () => {
  const base = (): GraphIR => ({
    nodes: [
      { id: "dbRdsInstance", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: { DBSubnetGroupName: "loom-local-a-loom-db-subnet-group", Engine: "postgres" } },
      { id: "dbRdsSubnetGroup", kind: "AWS::RDS::DBSubnetGroup", lexicon: "aws", attrs: { DBSubnetGroupName: "loom-local-a-loom-db-subnet-group" } },
    ],
    edges: [],
    groups: {},
  });

  it("connects a by-name reference the symbolic graph missed", () => {
    const ir = addValueMatchEdges(base());
    expect(ir.edges).toContainEqual({ from: "dbRdsInstance", to: "dbRdsSubnetGroup", kind: "ref", viaAttr: "DBSubnetGroupName", inferred: true });
    // ...and not the reverse, and not a self-edge.
    expect(ir.edges).toHaveLength(1);
  });

  it("does not duplicate an already-declared edge", () => {
    const ir = base();
    ir.edges.push({ from: "dbRdsInstance", to: "dbRdsSubnetGroup", kind: "ref", viaAttr: "subnetGroup" });
    const out = addValueMatchEdges(ir);
    expect(out.edges).toHaveLength(1); // no inferred duplicate
  });

  it("skips ambiguous names (two resources claiming the same own-name)", () => {
    const ir: GraphIR = {
      nodes: [
        { id: "a", kind: "AWS::ECS::Cluster", lexicon: "aws", attrs: { ClusterName: "shared-cluster-name" } },
        { id: "b", kind: "AWS::ECS::Cluster", lexicon: "aws", attrs: { ClusterName: "shared-cluster-name" } },
        { id: "svc", kind: "AWS::ECS::Service", lexicon: "aws", attrs: { Cluster: "shared-cluster-name" } },
      ],
      edges: [],
      groups: {},
    };
    // Ambiguous owner → no phantom edge to either cluster.
    expect(addValueMatchEdges(ir).edges).toHaveLength(0);
  });

  it("ignores short values that would collide", () => {
    const ir: GraphIR = {
      nodes: [
        { id: "c", kind: "AWS::ECS::Cluster", lexicon: "aws", attrs: { ClusterName: "db" } },
        { id: "svc", kind: "AWS::ECS::Service", lexicon: "aws", attrs: { Cluster: "db" } },
      ],
      edges: [],
      groups: {},
    };
    expect(addValueMatchEdges(ir).edges).toHaveLength(0);
  });
});
