import { describe, it, expect } from "vitest";
import { projectK8sLogical, declaredNamespaces, K8S_PLUMBING_KINDS } from "./logical-k8s.ts";
import type { GraphIR } from "@intentius/chant";

/** A k8s node the way chant emits one: identity lives under `metadata`. */
const node = (id: string, kind: string, namespace?: string, name?: string) =>
  ({
    id,
    kind,
    lexicon: "k8s",
    attrs: { metadata: { ...(name ? { name } : {}), ...(namespace ? { namespace } : {}) } },
  }) as never;

/** kubemicrovm-ops at prod-ha — two namespaces, four custom resources. */
const kmvIr = {
  nodes: [
    node("operatorNs", "K8s::Core::Namespace", undefined, "kube-microvm"),
    node("workloadNs", "K8s::Core::Namespace", undefined, "microvm-demo"),
    node("workloadImage", "K8s::KubeMicroVM::MicroVMImage", "microvm-demo"),
    node("workloadVmClass", "K8s::KubeMicroVM::MicroVMClass", "microvm-demo"),
    node("workloadNetwork", "K8s::KubeMicroVM::MicroVMNetwork", "microvm-demo"),
    node("workloadReplicaSet", "K8s::KubeMicroVM::MicroVMReplicaSet", "microvm-demo"),
  ],
  edges: [],
  groups: {},
} as unknown as GraphIR;

describe("declaredNamespaces", () => {
  it("finds a namespace from its own object and from anything living in it", () => {
    expect([...declaredNamespaces(kmvIr.nodes)].sort()).toEqual(["kube-microvm", "microvm-demo"]);
  });
});

describe("projectK8sLogical", () => {
  it("nests cluster -> namespace -> resource", () => {
    const { byContainer } = projectK8sLogical(kmvIr, "dev");
    expect(byContainer["cluster dev"]).toEqual(["namespace kube-microvm", "namespace microvm-demo"]);
    expect(byContainer["namespace microvm-demo"]).toEqual([
      "workloadImage",
      "workloadVmClass",
      "workloadNetwork",
      "workloadReplicaSet",
    ]);
  });

  // The whole reason this lens cannot use an allowlist like the other three:
  // every card in a KubeMicroVM estate is a kind no allowlist could name.
  it("draws custom resources, which no allowlist could have anticipated", () => {
    const { ir } = projectK8sLogical(kmvIr, "dev");
    expect(ir.nodes.map((n) => n.id)).toEqual([
      "workloadImage",
      "workloadVmClass",
      "workloadNetwork",
      "workloadReplicaSet",
    ]);
  });

  it("makes a namespace a box, never also a card", () => {
    const { ir } = projectK8sLogical(kmvIr, "dev");
    expect(ir.nodes.map((n) => n.id)).not.toContain("operatorNs");
    expect(K8S_PLUMBING_KINDS.has("K8s::Core::Namespace")).toBe(true);
  });

  it("keeps a declared namespace that holds nothing — it is still a fact about the estate", () => {
    const { byContainer } = projectK8sLogical(kmvIr, "dev");
    expect(byContainer["cluster dev"]).toContain("namespace kube-microvm");
    expect(byContainer["namespace kube-microvm"]).toBeUndefined();
  });

  it("drops support objects", () => {
    const ir = {
      nodes: [
        node("cfg", "K8s::Core::ConfigMap", "app"),
        node("sec", "K8s::Core::Secret", "app"),
        node("sa", "K8s::Core::ServiceAccount", "app"),
        node("dep", "K8s::Apps::Deployment", "app"),
      ],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    expect(projectK8sLogical(ir, "dev").ir.nodes.map((n) => n.id)).toEqual(["dep"]);
  });

  it("gives a cluster-scoped object its own lane rather than forcing it into a namespace", () => {
    const ir = {
      nodes: [node("crd", "K8s::Apiextensions::CustomResourceDefinition")],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    const { byContainer } = projectK8sLogical(ir, "dev");
    expect(byContainer["cluster dev"]).toContain("cluster-scoped");
    expect(byContainer["cluster-scoped"]).toEqual(["crd"]);
  });

  it("names the cluster from env, and says 'cluster' rather than inventing one when it cannot", () => {
    expect(Object.keys(projectK8sLogical(kmvIr).byContainer)).toContain("cluster");
    expect(Object.keys(projectK8sLogical(kmvIr, "dev").byContainer)).toContain("cluster dev");
  });

  it("is empty for a graph with no k8s nodes, so composing it costs nothing", () => {
    const aws = {
      nodes: [{ id: "b", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {} }],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    expect(projectK8sLogical(aws, "dev")).toEqual({
      ir: { nodes: [], edges: [], groups: {} },
      byContainer: {},
    });
  });
});
