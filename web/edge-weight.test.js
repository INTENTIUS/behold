import { describe, it, expect } from "vitest";
import { edgeWeights, weightLegend } from "./edge-weight.js";

describe("edgeWeights (#878)", () => {
  const kindOf = new Map([
    ["listener", "AWS::ElasticLoadBalancingV2::Listener"],
    ["tg", "AWS::ElasticLoadBalancingV2::TargetGroup"],
    ["svc", "AWS::ECS::Service"],
    ["task", "AWS::ECS::TaskDefinition"],
    ["fn1", "AWS::Lambda::Function"],
    ["fn2", "AWS::Lambda::Function"],
    ["fn3", "AWS::Lambda::Function"],
    ["role", "AWS::IAM::Role"],
    ["ownRole", "AWS::IAM::Role"],
    ["bucket", "AWS::S3::Bucket"],
    ["pod", "K8s::Core::Pod"],
  ]);
  const edges = [
    { from: "listener", to: "tg", kind: "ref", viaAttr: "DefaultActions.TargetGroupArn" },
    { from: "svc", to: "task", kind: "ref", viaAttr: "TaskDefinition" },
    { from: "pod", to: "bucket", kind: "ref", viaAttr: "env.value", inferred: true },
    { from: "fn1", to: "role", kind: "ref", viaAttr: "Role" },
    { from: "fn2", to: "role", kind: "ref", viaAttr: "Role" },
    { from: "fn3", to: "role", kind: "ref", viaAttr: "Role" },
    { from: "task", to: "ownRole", kind: "ref", viaAttr: "TaskRoleArn" },
    { from: "a", to: "b", kind: "needs" },
  ];
  const w = edgeWeights(edges, kindOf);

  it("weighs each reference by how it was found", () => {
    expect(w.get("listener→tg")).toBe("wired");
    expect(w.get("svc→task")).toBe("reference");
    expect(w.get("pod→bucket")).toBe("inferred");
    expect(w.get("task→ownRole")).toBe("plumbing");
  });

  it("draws no edge to plumbing more than two cards share", () => {
    expect(w.get("fn1→role")).toBe("hidden");
  });

  it("leaves a CI edge to its kind", () => {
    expect(w.has("a→b")).toBe(false);
  });

  it("keys each drawn weight with its count, and nothing for a graph of one weight", () => {
    expect(weightLegend(w).map((r) => [r.weight, r.count])).toEqual([["wired", 1], ["reference", 1], ["inferred", 1], ["plumbing", 1]]);
    expect(weightLegend(new Map([["x→y", "reference"]]))).toEqual([]);
  });
});

describe("edgeWeights over chant's derived edges (behold#1030)", () => {
  it("weighs an edge chant derived as inferred, as the matcher's were", () => {
    const kindOf = new Map([
      ["db", "AWS::RDS::DBInstance"],
      ["group", "AWS::RDS::DBSubnetGroup"],
    ]);
    const w = edgeWeights(
      [{ from: "db", to: "group", kind: "ref", viaAttr: "DBSubnetGroupName", origin: "derived", rule: "aws:AWS::RDS::DBInstance:DBSubnetGroupName" }],
      kindOf,
    );
    expect(w.get("db→group")).toBe("inferred");
  });

  it("keeps a declared edge a reference", () => {
    const w = edgeWeights([{ from: "db", to: "group", kind: "ref", viaAttr: "DBSubnetGroupName", origin: "declared" }], new Map());
    expect(w.get("db→group")).toBe("reference");
  });
});
