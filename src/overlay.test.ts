import { describe, it, expect } from "vitest";
import { overlayStatus, reclassifyOverlay, pruneImports, attachRuntimeContainment } from "./overlay.ts";

describe("overlayStatus", () => {
  it("maps chant's _status vocabulary to overlay statuses", () => {
    expect(overlayStatus({ attrs: { _status: "good" } })).toBe("managed");
    expect(overlayStatus({ attrs: { _status: "warn" } })).toBe("foreign");
    expect(overlayStatus({ attrs: { _status: "accent" } })).toBe("pending");
    expect(overlayStatus({ attrs: {} })).toBeUndefined();
    expect(overlayStatus({})).toBeUndefined();
  });

  // chant#1168 (#1089): a declared node chant couldn't read live state for —
  // its own category, distinct from "pending" (which means the provider
  // confirmed the resource absent).
  it("maps `neutral` to `unobserved` (chant#1168)", () => {
    expect(overlayStatus({ attrs: { _status: "neutral" } })).toBe("unobserved");
    expect(overlayStatus({ attrs: { _status: "neutral", _unobserved: "read-failed" } })).toBe("unobserved");
  });

  // chant#1180 (#1077): a live, undeclared node whose owner chain reaches a
  // declared entity — expected runtime, distinct from "foreign" (which used
  // to be the only bucket a live-but-undeclared node could land in).
  it("maps `runtime` to `runtime` (chant#1180)", () => {
    expect(overlayStatus({ attrs: { _status: "runtime" } })).toBe("runtime");
  });
});

// The `groups` shape attachRuntimeContainment reads/writes — annotated
// explicitly so a fixture's inferred type carries the optional `byContainer`
// key even when the fixture itself starts with an empty `groups: {}`.
type Groups = { byContainer?: Record<string, string[]> };

describe("attachRuntimeContainment (#86, chant#1180/#1077)", () => {
  it("nests a runtime child under its declared owner in groups.byContainer", () => {
    const ir = {
      nodes: [
        { id: "appDeployment", kind: "K8s::Apps::Deployment", attrs: { _status: "good" } },
        { id: "appDeployment-pod-1", kind: "K8s::Core::Pod", attrs: { _status: "runtime" }, runtimeOwner: "appDeployment" },
        { id: "appDeployment-pod-2", kind: "K8s::Core::Pod", attrs: { _status: "runtime" }, runtimeOwner: "appDeployment" },
      ],
      groups: {} as Groups,
    };
    const r = attachRuntimeContainment(ir);
    expect(r.groups.byContainer).toEqual({ appDeployment: ["appDeployment-pod-1", "appDeployment-pod-2"] });
  });

  it("is a no-op when no node carries runtimeOwner — graceful on a substrate with no owner chain", () => {
    const ir = { nodes: [{ id: "bucket", kind: "AWS::S3::Bucket", attrs: { _status: "good" } }], groups: {} as Groups };
    const r = attachRuntimeContainment(ir);
    expect(r.groups.byContainer).toBeUndefined();
  });

  it("merges into an existing groups.byContainer rather than replacing it (chant's own live containment, #779)", () => {
    const ir = {
      nodes: [
        { id: "argoApp-pod-1", kind: "ArgoCd::Application::Pod", attrs: { _status: "runtime" }, runtimeOwner: "argoApp" },
      ],
      groups: { byContainer: { vpc1: ["subnetA"] } },
    };
    const r = attachRuntimeContainment(ir);
    expect(r.groups.byContainer).toEqual({ vpc1: ["subnetA"], argoApp: ["argoApp-pod-1"] });
  });

  it("dedupes and sorts a runtime child's ids, and works for any kind string (a CRD, not just Pods, #85/#86)", () => {
    const ir = {
      nodes: [
        { id: "zPod", kind: "K8s::Core::Pod", attrs: { _status: "runtime" }, runtimeOwner: "owner" },
        { id: "aCrdChild", kind: "ArgoCd::Application", attrs: { _status: "runtime" }, runtimeOwner: "owner" },
      ],
      groups: {} as Groups,
    };
    const r = attachRuntimeContainment(ir);
    expect(r.groups.byContainer).toEqual({ owner: ["aCrdChild", "zPod"] });
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
