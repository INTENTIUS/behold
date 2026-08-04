import { describe, it, expect } from "vitest";
import { resourcesByComponent, nonResourceEntities } from "./resources.ts";
import type { GraphIR } from "@intentius/chant";

// Fixture mirrors the entity-graph IR shape #59's /api/resources correlates
// against — nodes with a `sourceLoc.file` under `src/<component>/…`.
const ir: GraphIR = {
  nodes: [
    {
      id: "loom-db-instance",
      kind: "RdsInstance",
      lexicon: "aws",
      attrs: {},
      sourceLoc: { file: "src/loom-db/database.ts", line: 12 },
    },
    {
      id: "loom-db-secret",
      kind: "SecretsManagerSecret",
      lexicon: "aws",
      attrs: {},
      sourceLoc: { file: "src/loom-db/database.ts", line: 20 },
      physicalId: "arn:aws:secretsmanager:...",
      ownership: "owned",
    },
    {
      id: "loom-backend-service",
      kind: "EcsService",
      lexicon: "aws",
      attrs: {},
      sourceLoc: { file: "src/loom-backend/service.ts", line: 5 },
    },
    // No sourceLoc at all — shouldn't crash, just excluded.
    { id: "no-source", kind: "Thing", lexicon: "aws", attrs: {} },
    // A top-level file with no component subdir ("src/<file>", not
    // "src/<dir>/<file>") — the convention this module documents as a miss.
    { id: "top-level", kind: "Thing", lexicon: "aws", attrs: {}, sourceLoc: { file: "src/root.ts", line: 1 } },
    // Outside src/ entirely.
    { id: "outside-src", kind: "Thing", lexicon: "aws", attrs: {}, sourceLoc: { file: "ops/deploy.ts", line: 1 } },
  ],
  edges: [],
  groups: {},
};

describe("resourcesByComponent", () => {
  it("groups nodes by the src/<component>/ segment of sourceLoc.file", () => {
    const byComponent = resourcesByComponent(ir);
    expect(Object.keys(byComponent).sort()).toEqual(["loom-backend", "loom-db"]);
    expect(byComponent["loom-db"]).toHaveLength(2);
    expect(byComponent["loom-backend"]).toHaveLength(1);
  });

  it("carries id/kind/lexicon and optional physicalId/ownership", () => {
    const byComponent = resourcesByComponent(ir);
    const secret = byComponent["loom-db"]!.find((r) => r.id === "loom-db-secret")!;
    expect(secret).toEqual({
      id: "loom-db-secret",
      kind: "SecretsManagerSecret",
      lexicon: "aws",
      physicalId: "arn:aws:secretsmanager:...",
      ownership: "owned",
    });
    const instance = byComponent["loom-db"]!.find((r) => r.id === "loom-db-instance")!;
    expect(instance.physicalId).toBeUndefined();
    expect(instance.ownership).toBeUndefined();
  });

  it("skips nodes with no sourceLoc, a top-level src/ file, or a file outside src/", () => {
    const byComponent = resourcesByComponent(ir);
    const allIds = Object.values(byComponent).flat().map((r) => r.id);
    expect(allIds).not.toContain("no-source");
    expect(allIds).not.toContain("top-level");
    expect(allIds).not.toContain("outside-src");
  });

  it("returns {} for an empty node set", () => {
    expect(resourcesByComponent({ nodes: [], edges: [], groups: {} })).toEqual({});
  });

  it("drops non-component src dirs when a known component set is given (no phantom 'examples')", () => {
    const withExamples: GraphIR = {
      nodes: [
        { id: "loom-db-instance", kind: "RdsInstance", lexicon: "aws", attrs: {}, sourceLoc: { file: "src/loom-db/database.ts", line: 1 } },
        // src/examples/ + src/composites/ are graphed but aren't deployable components.
        { id: "byo-example", kind: "Thing", lexicon: "aws", attrs: {}, sourceLoc: { file: "src/examples/byo/thing.ts", line: 1 } },
        { id: "shared-composite", kind: "Thing", lexicon: "aws", attrs: {}, sourceLoc: { file: "src/composites/util.ts", line: 1 } },
      ],
      edges: [],
      groups: {},
    };
    // Without the known set: naive grouping surfaces "examples" and "composites".
    expect(Object.keys(resourcesByComponent(withExamples)).sort()).toEqual(["composites", "examples", "loom-db"]);
    // With the real component set: only real components survive; the rest are
    // simply absent (→ summarizePlan counts their entries as uncorrelated).
    const known = new Set(["loom-db", "loom-backend", "shared-foundation"]);
    expect(Object.keys(resourcesByComponent(withExamples, known))).toEqual(["loom-db"]);
  });
});

// The fixture above is the shape this module was written against, and it is
// not the shape chant emits. chant reports `sourceLoc.file` relative to the
// graph root it is handed, and `graphPath()` hands it the project's
// `sourceDir` — so the leading `src/` is already spent and never appears.
// Verified by running `chant graph src --format ir` against both consumer
// repos: loomster emits `loom-agents/agents.ts`, kubemicrovm-ops emits
// `aws-plane/plane.ts`. The prefixed fixture passed while the live join
// returned {} for every project, which is what /api/reconcile's
// `byComponent: {}, uncorrelated: 11` was.
describe("resourcesByComponent — sourceDir-relative paths, as chant actually emits them", () => {
  const known = new Set(["aws-plane", "workload", "operator", "golden-image"]);
  const ir: GraphIR = {
    nodes: [
      { id: "artifactBucket", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {}, sourceLoc: { file: "aws-plane/plane.ts", line: 60 } },
      { id: "buildRole", kind: "AWS::IAM::Role", lexicon: "aws", attrs: {}, sourceLoc: { file: "aws-plane/plane.ts", line: 104 } },
      { id: "image", kind: "K8s::KubeMicroVM::MicroVMImage", lexicon: "k8s", attrs: {}, sourceLoc: { file: "workload/workload.ts", line: 96 } },
      // src/lib/ is graphed but names no component — dropped, not a phantom.
      { id: "helper", kind: "Thing", lexicon: "aws", attrs: {}, sourceLoc: { file: "lib/naming.ts", line: 1 } },
    ],
    edges: [],
    groups: {},
  };

  it("correlates a node whose path carries no src/ prefix", () => {
    const byComponent = resourcesByComponent(ir, known);
    expect(Object.keys(byComponent).sort()).toEqual(["aws-plane", "workload"]);
    expect(byComponent["aws-plane"]).toHaveLength(2);
    expect(byComponent["workload"]).toHaveLength(1);
  });

  it("still correlates the prefixed form, for a project graphed from its root", () => {
    const prefixed: GraphIR = {
      nodes: [{ id: "b", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {}, sourceLoc: { file: "src/aws-plane/plane.ts", line: 60 } }],
      edges: [],
      groups: {},
    };
    expect(Object.keys(resourcesByComponent(prefixed, known))).toEqual(["aws-plane"]);
  });

  it("does not read a filename as a component, even when it matches one", () => {
    // `src/lib/workload.ts` is a helper named after a component, not the
    // component's own directory. Matching the last segment would invent an
    // owner for it.
    const decoy: GraphIR = {
      nodes: [{ id: "d", kind: "Thing", lexicon: "aws", attrs: {}, sourceLoc: { file: "lib/workload.ts", line: 1 } }],
      edges: [],
      groups: {},
    };
    expect(resourcesByComponent(decoy, known)).toEqual({});
  });
});

// #104 — an output is a value a stack publishes, never a resource anyone
// creates. chant emits `chant:output` on every lexicon (13 of them in the
// mixed AWS example, alongside 3 CloudFormation Parameters), so listing only
// the AWS kind left the reconcile counting them as perpetual pending changes
// on every substrate.
describe("nonResourceEntities — substrate-neutral interface nodes (#104)", () => {
  const ir = {
    nodes: [
      { id: "domainName", kind: "AWS::CloudFormation::Parameter", lexicon: "aws" },
      { id: "clusterEndpoint", kind: "chant:output", lexicon: "aws" },
      { id: "gkeEndpoint", kind: "chant:output", lexicon: "gcp" },
      { id: "bucket", kind: "AWS::S3::Bucket", lexicon: "aws" },
      { id: "svc", kind: "K8s::Core::Service", lexicon: "k8s" },
    ],
    edges: [],
    groups: {},
  } as unknown as GraphIR;

  it("excludes chant:output on any lexicon, not just the AWS parameter kind", () => {
    const skip = nonResourceEntities(ir);
    expect(skip.has("clusterEndpoint")).toBe(true);
    expect(skip.has("gkeEndpoint")).toBe(true);
    expect(skip.has("domainName")).toBe(true);
  });

  it("still counts real resources on every substrate", () => {
    const skip = nonResourceEntities(ir);
    expect(skip.has("bucket")).toBe(false);
    expect(skip.has("svc")).toBe(false);
  });
});
