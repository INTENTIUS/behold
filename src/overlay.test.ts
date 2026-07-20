import { describe, it, expect } from "vitest";
import { overlayStatus, reclassifyOverlay, pruneImports } from "./overlay.ts";

describe("overlayStatus", () => {
  it("maps chant's _status vocabulary to overlay statuses", () => {
    expect(overlayStatus({ attrs: { _status: "good" } })).toBe("managed");
    expect(overlayStatus({ attrs: { _status: "warn" } })).toBe("foreign");
    expect(overlayStatus({ attrs: { _status: "accent" } })).toBe("pending");
    expect(overlayStatus({ attrs: {} })).toBeUndefined();
    expect(overlayStatus({})).toBeUndefined();
  });
});

describe("reclassifyOverlay", () => {
  // A deployed component (loom-db: one managed resource), its cross-stack
  // Parameter (chant paints it pending — no live resource matches it), and a
  // byo example node chant also paints pending.
  const ir = (): { nodes: Array<{ id: string; kind: string; sourceLoc?: { file?: string }; attrs?: Record<string, unknown> }> } => ({
    nodes: [
      { id: "dbRdsInstance", kind: "AWS::RDS::DBInstance", sourceLoc: { file: "src/loom-db/database.ts" }, attrs: { _status: "good" } },
      { id: "pRdsEndpoint", kind: "AWS::CloudFormation::Parameter", sourceLoc: { file: "src/loom-db/params.ts" }, attrs: { _status: "accent" } },
      // Parameter of a component with nothing deployed — stays pending.
      { id: "pFuture", kind: "AWS::CloudFormation::Parameter", sourceLoc: { file: "src/not-deployed/params.ts" }, attrs: { _status: "accent" } },
      { id: "byoFoundationAlb", kind: "AWS::ElasticLoadBalancingV2::LoadBalancer", sourceLoc: { file: "src/examples/byo/shared-foundation/foundation.ts" }, attrs: { _status: "accent" } },
    ],
  });

  it("gives a deployed component's Parameter its component's (managed) status, not pending", () => {
    const r = reclassifyOverlay(ir());
    expect(overlayStatus(r.nodes[1])).toBe("managed"); // pRdsEndpoint, loom-db is deployed
  });

  it("leaves a Parameter pending when its component has nothing deployed", () => {
    const r = reclassifyOverlay(ir());
    expect(overlayStatus(r.nodes[2])).toBe("pending"); // pFuture
  });

  it("clears pending on src/examples/ nodes and tags them _byo (an example, not drift)", () => {
    const r = reclassifyOverlay(ir());
    const byo = r.nodes[3];
    expect(overlayStatus(byo)).toBeUndefined(); // no longer pending — renders neutral
    expect(byo.attrs?._byo).toBe(true);
  });

  it("leaves a real resource's status untouched", () => {
    const r = reclassifyOverlay(ir());
    expect(overlayStatus(r.nodes[0])).toBe("managed"); // dbRdsInstance
  });
});

describe("pruneImports", () => {
  const ir = () => ({
    nodes: [
      { id: "backendService", kind: "AWS::ECS::Service" },
      { id: "LoomBackendpTargetGroupArn", kind: "AWS::CloudFormation::Parameter" },
      { id: "floatingImport", kind: "AWS::CloudFormation::Parameter" },
    ],
    edges: [{ from: "backendService", to: "LoomBackendpTargetGroupArn" }],
    imports: [{ node: "LoomBackendpTargetGroupArn" }, { node: "floatingImport" }],
  });

  it("drops import-handle nodes and any edges touching them", () => {
    const r = pruneImports(ir());
    expect(r.nodes.map((n) => n.id)).toEqual(["backendService"]); // resource kept
    expect(r.edges).toEqual([]); // the resource→import edge went with the import
  });

  it("is a no-op when there are no imports", () => {
    const noImports = { nodes: [{ id: "vpc", kind: "AWS::EC2::VPC" }], edges: [], imports: [] };
    expect(pruneImports(noImports).nodes).toHaveLength(1);
  });
});
