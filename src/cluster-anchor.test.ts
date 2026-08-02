import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { addClusterAnchorEdges, soleManagedCluster, ANCHOR_VIA, MANAGED_CLUSTER_KINDS } from "./cluster-anchor.ts";

const cloud = (id: string, kind: string, lexicon: string) => ({ id, kind, lexicon, attrs: {} });
const k8s = (id: string, kind: string, meta: Record<string, unknown>) => ({
  id,
  kind,
  lexicon: "k8s",
  // chant emits `{$ref}` placeholders for a resource's own read-back attrs
  // alongside the declared `metadata` block; the real IR carries both.
  attrs: { name: { $ref: `${id}.name` }, namespace: { $ref: `${id}.namespace` }, metadata: meta },
});

/** An EKS cluster + two namespaces + workloads, shaped like the real
 * `k8s-eks-microservice` IR: no edges of any kind to begin with. */
const mixed = (): GraphIR =>
  ({
    nodes: [
      cloud("cluster", "AWS::EKS::Cluster", "aws"),
      cloud("nodegroup", "AWS::EKS::Nodegroup", "aws"),
      k8s("namespace", "K8s::Core::Namespace", { name: "microservice" }),
      k8s("metricsNamespace", "K8s::Core::Namespace", { name: "amazon-metrics" }),
      k8s("apiDeployment", "K8s::Apps::Deployment", { name: "api", namespace: "microservice" }),
      k8s("apiService", "K8s::Core::Service", { name: "api", namespace: "microservice" }),
      k8s("adotDaemonSet", "K8s::Apps::DaemonSet", { name: "adot", namespace: "amazon-metrics" }),
      k8s("storageClass", "K8s::Storage::StorageClass", { name: "gp3" }),
      k8s("strayPod", "K8s::Core::Pod", { name: "stray", namespace: "kube-system" }),
    ],
    edges: [],
    groups: {},
  }) as unknown as GraphIR;

const anchors = (ir: GraphIR) => ir.edges.filter((e) => e.viaAttr === ANCHOR_VIA);
const parentOf = (ir: GraphIR, id: string) => anchors(ir).find((e) => e.to === id)?.from;

describe("addClusterAnchorEdges (#103)", () => {
  it("nests a namespaced workload under its declared namespace, not the cluster", () => {
    const ir = addClusterAnchorEdges(mixed());
    expect(parentOf(ir, "apiService")).toBe("namespace");
    expect(parentOf(ir, "apiDeployment")).toBe("namespace");
    expect(parentOf(ir, "adotDaemonSet")).toBe("metricsNamespace");
  });

  it("hangs each declared namespace off the managed cluster", () => {
    const ir = addClusterAnchorEdges(mixed());
    expect(parentOf(ir, "namespace")).toBe("cluster");
    expect(parentOf(ir, "metricsNamespace")).toBe("cluster");
  });

  it("hangs a cluster-scoped resource off the cluster directly", () => {
    expect(parentOf(addClusterAnchorEdges(mixed()), "storageClass")).toBe("cluster");
  });

  it("hangs a resource whose namespace this project doesn't declare off the cluster rather than dropping it", () => {
    // `kube-system` is real but not declared here. Inventing a Namespace node
    // would put a resource in the graph nobody declared; orphaning it would
    // reproduce the defect this fixes.
    expect(parentOf(addClusterAnchorEdges(mixed()), "strayPod")).toBe("cluster");
  });

  it("connects every k8s node — the whole point of the done-bar", () => {
    const ir = addClusterAnchorEdges(mixed());
    const k8sIds = ir.nodes.filter((n) => n.lexicon === "k8s").map((n) => n.id);
    for (const id of k8sIds) expect(parentOf(ir, id), `${id} is unanchored`).toBeDefined();
  });

  it("crosses the substrate boundary — that is what #103 asks for", () => {
    const ir = addClusterAnchorEdges(mixed());
    const lex = new Map(ir.nodes.map((n) => [n.id, n.lexicon]));
    const cross = ir.edges.filter((e) => lex.get(e.from) !== lex.get(e.to));
    expect(cross.length).toBeGreaterThan(0);
    expect(cross.every((e) => lex.get(e.from) === "aws" && lex.get(e.to) === "k8s")).toBe(true);
  });

  it("tags anchors inferred so a viewer can style them apart from declared wiring", () => {
    for (const e of anchors(addClusterAnchorEdges(mixed()))) {
      expect((e as { inferred?: boolean }).inferred).toBe(true);
    }
  });

  it("declines to guess when two managed clusters are declared", () => {
    const ir = mixed();
    ir.nodes.push(cloud("otherCluster", "AWS::EKS::Cluster", "aws") as never);
    expect(anchors(addClusterAnchorEdges(ir))).toHaveLength(0);
    // Which cluster a Service lands on is the kubeconfig's answer at deploy
    // time (#106), not something any declared attribute states.
    expect(soleManagedCluster(ir.nodes)).toBeUndefined();
  });

  it("leaves a cloud-only or k8s-only project untouched", () => {
    const cloudOnly = { nodes: [cloud("cluster", "AWS::EKS::Cluster", "aws")], edges: [], groups: {} } as unknown as GraphIR;
    expect(addClusterAnchorEdges(cloudOnly).edges).toHaveLength(0);

    const k8sOnly = { nodes: [k8s("apiService", "K8s::Core::Service", { name: "api", namespace: "x" })], edges: [], groups: {} } as unknown as GraphIR;
    expect(addClusterAnchorEdges(k8sOnly).edges).toHaveLength(0);
  });

  it("never duplicates an edge the graph already carries", () => {
    const ir = mixed();
    ir.edges.push({ from: "cluster", to: "namespace", kind: "ref" } as never);
    const ir2 = addClusterAnchorEdges(ir);
    expect(ir2.edges.filter((e) => e.from === "cluster" && e.to === "namespace")).toHaveLength(1);
  });

  it("recognises the managed-cluster kind on all three clouds", () => {
    for (const kind of ["AWS::EKS::Cluster", "GCP::Container::Cluster", "Microsoft.ContainerService/managedClusters"]) {
      expect(MANAGED_CLUSTER_KINDS.has(kind)).toBe(true);
      const ir = {
        nodes: [cloud("c", kind, "cloud"), k8s("svc", "K8s::Core::Service", { name: "api", namespace: "ns" })],
        edges: [],
        groups: {},
      } as unknown as GraphIR;
      expect(parentOf(addClusterAnchorEdges(ir), "svc")).toBe("c");
    }
  });

  it("is not fooled by a node group, which is capacity rather than the thing a Service runs on", () => {
    const ir = {
      nodes: [cloud("ng", "AWS::EKS::Nodegroup", "aws"), k8s("svc", "K8s::Core::Service", { name: "api", namespace: "ns" })],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    expect(addClusterAnchorEdges(ir).edges).toHaveLength(0);
  });
});
