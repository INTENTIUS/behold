import { describe, it, expect } from "vitest";
import { kebabKind, addCompositeDeps, addCompositeDepsCounted, type ComponentDag } from "./composite-deps.ts";
import type { GraphIR } from "@intentius/chant";

describe("kebabKind", () => {
  it("PascalCase composite kind → kebab component name", () => {
    expect(kebabKind("LoomBackend")).toBe("loom-backend");
    expect(kebabKind("SharedFoundation")).toBe("shared-foundation");
    expect(kebabKind("LoomDb")).toBe("loom-db");
  });
});

describe("addCompositeDeps — the kebab-kind fallback (loomster's shape)", () => {
  const ir = (): GraphIR => ({
    nodes: [
      { id: "foundation", kind: "SharedFoundation", lexicon: "aws", attrs: {} },
      { id: "backend", kind: "LoomBackend", lexicon: "aws", attrs: {} },
      { id: "byoBackend", kind: "LoomBackend", lexicon: "aws", attrs: {} }, // example twin
      { id: "loomProxy", kind: "Docker::Compose::Service", lexicon: "docker", attrs: {} },
    ],
    edges: [],
    groups: {},
  });
  // A DAG with no `liveNames` on its nodes — a chant predating #1491, or a
  // caller passing edges only. Every component falls through to the heuristic.
  const dag: ComponentDag = {
    edges: [
      { from: "loom-backend", to: "shared-foundation" },
      { from: "downstream-stub", to: "shared-foundation" }, // no composite node → skipped
    ],
  };

  it("overlays dependsOn onto the real composite nodes (not the byo twin)", () => {
    const out = addCompositeDeps(ir(), dag);
    expect(out.edges).toContainEqual({ from: "backend", to: "foundation", kind: "ref", viaAttr: "dependsOn", inferred: true });
    // downstream-stub has no composite node → no dangling edge; byo twin untouched.
    expect(out.edges).toHaveLength(1);
    expect(out.edges.some((e) => e.from === "byoBackend")).toBe(false);
  });

  it("doesn't duplicate an already-declared edge", () => {
    const withEdge = ir();
    withEdge.edges.push({ from: "backend", to: "foundation", kind: "ref" });
    expect(addCompositeDeps(withEdge, dag).edges).toHaveLength(1);
  });
});

describe("addCompositeDeps — liveNames ownership (#138, the pure-lexicon estates)", () => {
  // The fountain-ops/kubemicrovm-ops shape: every kind is lexicon-qualified, so
  // the kebab heuristic maps NOTHING — the measured failure in #138 (composites
  // rendered byte-identical to resources, 0 edges attached). The component DAG's
  // nodes carry `attrs.liveNames` (chant#1491): declared entity names, which are
  // entity-IR node ids.
  const ir = (): GraphIR => ({
    nodes: [
      { id: "workloadNs", kind: "K8s::Core::Namespace", lexicon: "k8s", attrs: {} },
      { id: "workloadImage", kind: "K8s::KubeMicroVM::MicroVMImage", lexicon: "k8s", attrs: {} },
      { id: "m80Deploy", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} },
      { id: "artifactBucket", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {} },
    ],
    edges: [],
    groups: {},
  });
  const dag: ComponentDag = {
    nodes: [
      { id: "workload", attrs: { wave: 4, liveNames: ["workloadNs", "workloadImage"] } },
      { id: "local-substrate", attrs: { wave: 1, liveNames: ["m80Deploy", "m80Svc"] } },
      { id: "aws-plane", attrs: { wave: 2, liveNames: ["artifactBucket"] } },
      // kubemicrovm's operator: helm deploy steps, no declared entities — its
      // liveNames name nothing in the graph, so it contributes no edge.
      { id: "operator", attrs: { wave: 3, liveNames: ["operator"] } },
    ],
    edges: [
      { from: "workload", to: "aws-plane" },
      { from: "workload", to: "operator" }, // operator unmappable → skipped
      { from: "local-substrate", to: "aws-plane" },
    ],
  };

  it("attaches dependsOn via each component's first present liveName", () => {
    const { ir: out, attached } = addCompositeDepsCounted(ir(), dag);
    expect(attached).toBe(2);
    expect(out.edges).toContainEqual({ from: "workloadNs", to: "artifactBucket", kind: "ref", viaAttr: "dependsOn", inferred: true });
    expect(out.edges).toContainEqual({ from: "m80Deploy", to: "artifactBucket", kind: "ref", viaAttr: "dependsOn", inferred: true });
  });

  it("a liveName pruned from this tier falls through to the next one present", () => {
    const pruned = ir();
    pruned.nodes = pruned.nodes.filter((n) => n.id !== "workloadNs");
    const { ir: out } = addCompositeDepsCounted(pruned, dag);
    expect(out.edges).toContainEqual({ from: "workloadImage", to: "artifactBucket", kind: "ref", viaAttr: "dependsOn", inferred: true });
  });

  it("ownership wins over the kebab heuristic when both could map", () => {
    // A composite node whose kind kebab-cases to the component name AND a
    // liveNames claim: the declared ownership decides.
    const mixed: GraphIR = {
      nodes: [
        { id: "impostor", kind: "AwsPlane", lexicon: "aws", attrs: {} },
        { id: "artifactBucket", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {} },
        { id: "workloadNs", kind: "K8s::Core::Namespace", lexicon: "k8s", attrs: {} },
      ],
      edges: [],
      groups: {},
    };
    const out = addCompositeDeps(mixed, {
      nodes: [
        { id: "aws-plane", attrs: { liveNames: ["artifactBucket"] } },
        { id: "workload", attrs: { liveNames: ["workloadNs"] } },
      ],
      edges: [{ from: "workload", to: "aws-plane" }],
    });
    expect(out.edges).toContainEqual({ from: "workloadNs", to: "artifactBucket", kind: "ref", viaAttr: "dependsOn", inferred: true });
    expect(out.edges.some((e) => e.to === "impostor")).toBe(false);
  });

  it("the [name] fallback is not a claim — a same-named foreign node doesn't capture the edges", () => {
    // Observed live on kubemicrovm-ops: the operator component's liveNames is
    // chant's ["operator"] fallback, and the aws-plane declares an OperatorRole
    // composite INSTANCE exported as `operator` — same string, different thing.
    const g: GraphIR = {
      nodes: [
        { id: "operator", kind: "OperatorRole", lexicon: "aws", attrs: {} },
        { id: "m80Deploy", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} },
      ],
      edges: [],
      groups: {},
    };
    const { attached, ir: out } = addCompositeDepsCounted(g, {
      nodes: [
        { id: "operator", attrs: { liveNames: ["operator"] } },
        { id: "local-substrate", attrs: { liveNames: ["m80Deploy"] } },
      ],
      edges: [{ from: "operator", to: "local-substrate" }],
    });
    expect(attached).toBe(0);
    expect(out.edges.some((e) => e.from === "operator")).toBe(false);
  });

  it("a liveName whose sourceLoc sits under ANOTHER component's directory is rejected", () => {
    const g: GraphIR = {
      nodes: [
        { id: "sharedThing", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {}, sourceLoc: { file: "src/aws-plane/plane.ts" } },
        { id: "workloadNs", kind: "K8s::Core::Namespace", lexicon: "k8s", attrs: {}, sourceLoc: { file: "src/workload/workload.ts" } },
        { id: "artifactBucket", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {}, sourceLoc: { file: "src/aws-plane/plane.ts" } },
      ],
      edges: [],
      groups: {},
    };
    const out = addCompositeDeps(g, {
      nodes: [
        // workload wrongly lists aws-plane's sharedThing first — the source
        // convention overrules the stale name and the next liveName wins.
        { id: "workload", attrs: { liveNames: ["sharedThing", "workloadNs"] } },
        { id: "aws-plane", attrs: { liveNames: ["artifactBucket"] } },
      ],
      edges: [{ from: "workload", to: "aws-plane" }],
    });
    expect(out.edges).toContainEqual({ from: "workloadNs", to: "artifactBucket", kind: "ref", viaAttr: "dependsOn", inferred: true });
  });

  it("a [name]-shaped claim WITH agreeing source evidence is real ownership (fountain's backup CronJob)", () => {
    const g: GraphIR = {
      nodes: [
        { id: "backup", kind: "K8s::Batch::CronJob", lexicon: "k8s", attrs: {}, sourceLoc: { file: "src/backup/cronjob.ts" } },
        { id: "pgDeployment", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {}, sourceLoc: { file: "src/data/postgres.ts" } },
      ],
      edges: [],
      groups: {},
    };
    const out = addCompositeDeps(g, {
      nodes: [
        { id: "backup", attrs: { liveNames: ["backup"] } },
        { id: "postgres", attrs: { liveNames: ["pgDeployment"] } },
      ],
      edges: [{ from: "backup", to: "postgres" }],
    });
    expect(out.edges).toContainEqual({ from: "backup", to: "pgDeployment", kind: "ref", viaAttr: "dependsOn", inferred: true });
  });

  it("a synthesized release card carrying attrs.component represents its component (the overlay's operator)", () => {
    const g: GraphIR = {
      nodes: [
        { id: "release/cert-manager/cert-manager", kind: "Helm::Release", lexicon: "helm", attrs: { component: "operator" } },
        { id: "m80Deploy", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} },
      ],
      edges: [],
      groups: {},
    };
    const out = addCompositeDeps(g, {
      nodes: [
        { id: "operator", attrs: { liveNames: ["operator"] } }, // the [name] fallback — no claim
        { id: "local-substrate", attrs: { liveNames: ["m80Deploy"] } },
      ],
      edges: [{ from: "operator", to: "local-substrate" }],
    });
    expect(out.edges).toContainEqual({
      from: "release/cert-manager/cert-manager",
      to: "m80Deploy",
      kind: "ref",
      viaAttr: "dependsOn",
      inferred: true,
    });
  });

  it("nothing mappable still attaches zero, honestly (the #131 note's trigger)", () => {
    const { attached } = addCompositeDepsCounted(ir(), {
      nodes: [{ id: "ghost", attrs: { liveNames: ["not-here"] } }],
      edges: [{ from: "ghost", to: "also-ghost" }],
    });
    expect(attached).toBe(0);
  });
});
