import { describe, it, expect } from "vitest";
import { edgeWeights, weightLegend, WEIGHTS } from "./edge-weight.js";

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

describe("edgeWeights over chant's catalog (behold#1080)", () => {
  const rules = { "k8s:K8s::Apps::Deployment:spec.template.spec.serviceAccountName": { label: "runs as", relation: "reference" } };
  const joined = { from: "app/web", to: "app/runner", kind: "ref", viaAttr: "spec", origin: "derived", rule: "k8s:K8s::Apps::Deployment:spec.template.spec.serviceAccountName", relation: "reference" };

  it("weighs an edge with a catalog rule as joined, apart from inferred", () => {
    const guess = { from: "a", to: "b", kind: "ref", origin: "derived", rule: "identity-match:name" };
    const w = edgeWeights([joined, guess], new Map(), rules);
    expect(w.get("app/web→app/runner")).toBe("joined");
    expect(w.get("a→b")).toBe("inferred");
  });

  it("reads a catalog edge by its relation when the graph carries no rule table", () => {
    expect(edgeWeights([joined], new Map()).get("app/web→app/runner")).toBe("joined");
    expect(edgeWeights([{ ...joined, relation: undefined }], new Map()).get("app/web→app/runner")).toBe("inferred");
  });

  it("weighs the edge to a placeholder dangling and each edge of an ambiguous reference ambiguous", () => {
    const w = edgeWeights(
      [
        { from: "h", to: "dangling:x", kind: "ref", dangling: true, rule: "r" },
        { from: "h", to: "c1", kind: "ref", ambiguous: { of: 2, rule: "r", value: "v" }, rule: "r" },
        { from: "h", to: "c2", kind: "ref", ambiguous: { of: 2, rule: "r", value: "v" }, rule: "r" },
      ],
      new Map(),
    );
    expect([...w.values()]).toEqual(["dangling", "ambiguous", "ambiguous"]);
  });

  it("gives each its legend row even when it is the only weight drawn", () => {
    expect(weightLegend(new Map([["a→b", "joined"]])).map((r) => [r.weight, r.title, r.count])).toEqual([["joined", WEIGHTS.joined, 1]]);
    expect(weightLegend(new Map([["a→b", "dangling"], ["c→d", "ambiguous"], ["c→e", "ambiguous"]])).map((r) => [r.weight, r.count])).toEqual([["dangling", 1], ["ambiguous", 2]]);
    expect(WEIGHTS.joined).toBe("joined: a field names or selects the other object");
  });
});
