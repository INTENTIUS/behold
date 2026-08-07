import { describe, it, expect } from "vitest";
import { deriveK8sEdges, addK8sDeclaredEdges } from "./k8s-edges.ts";
import { projectK8sLogical } from "./logical-k8s.ts";
import type { GraphIR, IRNode } from "@intentius/chant";

/** A k8s node the way chant emits one. */
const k8s = (id: string, kind: string, attrs: Record<string, unknown>) =>
  ({ id, kind, lexicon: "k8s", attrs }) as unknown as IRNode;

const meta = (name: string, namespace?: string, labels?: Record<string, string>) => ({
  metadata: { name, ...(namespace ? { namespace } : {}), ...(labels ? { labels } : {}) },
});

/** An example-k8s / AutoscaledService-shaped estate: Deployment + Service +
 * Ingress + HPA in one namespace. */
function estate(): IRNode[] {
  return [
    k8s("appDeployment", "K8s::Apps::Deployment", {
      ...meta("api", "app"),
      spec: { template: { metadata: { labels: { app: "api", tier: "web" } } } },
    }),
    k8s("appService", "K8s::Core::Service", {
      ...meta("api", "app"),
      spec: { selector: { app: "api" }, ports: [{ port: 80 }] },
    }),
    k8s("appIngress", "K8s::Networking::Ingress", {
      ...meta("api", "app"),
      spec: { rules: [{ http: { paths: [{ path: "/", backend: { service: { name: "api", port: { number: 80 } } } }] } }] },
    }),
    k8s("appHpa", "K8s::Autoscaling::HorizontalPodAutoscaler", {
      ...meta("api", "app"),
      spec: { scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "api" }, maxReplicas: 4 },
    }),
  ];
}

describe("deriveK8sEdges (#143)", () => {
  it("joins Service → workload by selector, Ingress → Service by backend, HPA → workload by scaleTargetRef", () => {
    const edges = deriveK8sEdges(estate());
    expect(edges).toContainEqual(expect.objectContaining({ from: "appService", to: "appDeployment", viaAttr: "selector" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "appIngress", to: "appService", viaAttr: "ingress backend" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "appHpa", to: "appDeployment", viaAttr: "scaleTargetRef" }));
    expect(edges).toHaveLength(3);
    for (const e of edges) expect(e.inferred).toBe(true);
  });

  it("scopes every join by namespace, with the apiserver's own default", () => {
    const other = [
      k8s("svc", "K8s::Core::Service", { ...meta("api", "prod"), spec: { selector: { app: "api" } } }),
      k8s("dep", "K8s::Apps::Deployment", {
        ...meta("api", "staging"),
        spec: { template: { metadata: { labels: { app: "api" } } } },
      }),
    ];
    expect(deriveK8sEdges(other)).toHaveLength(0);
    // No namespace declared on either side → both land in `default` and join.
    const defaulted = [
      k8s("svc", "K8s::Core::Service", { ...meta("api"), spec: { selector: { app: "api" } } }),
      k8s("dep", "K8s::Apps::Deployment", { ...meta("api"), spec: { template: { metadata: { labels: { app: "api" } } } } }),
    ];
    expect(deriveK8sEdges(defaulted)).toHaveLength(1);
  });

  it("requires the whole selector to match, not one key", () => {
    const nodes = [
      k8s("svc", "K8s::Core::Service", { ...meta("api"), spec: { selector: { app: "api", tier: "db" } } }),
      k8s("dep", "K8s::Apps::Deployment", { ...meta("api"), spec: { template: { metadata: { labels: { app: "api", tier: "web" } } } } }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(0);
  });

  it("adds an edge per workload when two genuinely match — the match is real on the cluster too", () => {
    const nodes = [
      k8s("svc", "K8s::Core::Service", { ...meta("api"), spec: { selector: { app: "api" } } }),
      k8s("blue", "K8s::Apps::Deployment", { ...meta("api-blue"), spec: { template: { metadata: { labels: { app: "api", slot: "blue" } } } } }),
      k8s("green", "K8s::Apps::Deployment", { ...meta("api-green"), spec: { template: { metadata: { labels: { app: "api", slot: "green" } } } } }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(2);
  });

  it("stays out of matchExpressions and ARBITRARY CRD reference fields — named contracts only", () => {
    // The refined rule (behold#171): a random CRD's strings get no edge (which
    // of them are references is per-CRD knowledge), while NAMED upstream
    // contracts like Flux's sourceRef do — asserted separately below.
    const nodes = [
      k8s("svc", "K8s::Core::Service", { ...meta("api"), spec: { selector: { matchExpressions: [{ key: "app" }] } } }),
      k8s("vm", "K8s::KubeMicroVM::MicroVMReplicaSet", { ...meta("vm"), spec: { imageRef: "some-image" } }),
      k8s("dep", "K8s::Apps::Deployment", { ...meta("api"), spec: { template: { metadata: { labels: { app: "api" } } } } }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(0);
  });

  it("joins a Flux Kustomization to the source its sourceRef names (behold#171)", () => {
    const nodes = [
      k8s("repo", "K8s::Flux::GitRepository", { ...meta("infra", "flux-system"), spec: { url: "https://example.com/infra.git" } }),
      k8s("ks", "K8s::Flux::Kustomization", { ...meta("apps", "flux-system"), spec: { sourceRef: { kind: "GitRepository", name: "infra" }, path: "./apps" } }),
    ];
    const edges = deriveK8sEdges(nodes);
    expect(edges).toContainEqual(expect.objectContaining({ from: "ks", to: "repo", viaAttr: "sourceRef" }));
    expect(edges).toHaveLength(1);
  });

  it("a sourceRef namespace override wins; no override resolves in the CR's own namespace", () => {
    const nodes = [
      k8s("repoA", "K8s::Flux::GitRepository", { ...meta("infra", "team-a"), spec: {} }),
      k8s("repoShared", "K8s::Flux::GitRepository", { ...meta("infra", "flux-system"), spec: {} }),
      k8s("ksLocal", "K8s::Flux::Kustomization", { ...meta("local", "team-a"), spec: { sourceRef: { kind: "GitRepository", name: "infra" } } }),
      k8s("ksCross", "K8s::Flux::Kustomization", { ...meta("cross", "team-a"), spec: { sourceRef: { kind: "GitRepository", name: "infra", namespace: "flux-system" } } }),
    ];
    const edges = deriveK8sEdges(nodes);
    expect(edges).toContainEqual(expect.objectContaining({ from: "ksLocal", to: "repoA" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "ksCross", to: "repoShared" }));
    expect(edges).toHaveLength(2);
  });

  it("joins a HelmRelease to its chart's source, three levels down (behold#171)", () => {
    const nodes = [
      k8s("charts", "K8s::Flux::HelmRepository", { ...meta("bitnami", "flux-system"), spec: {} }),
      k8s("hr", "K8s::Flux::HelmRelease", {
        ...meta("db", "flux-system"),
        spec: { chart: { spec: { chart: "postgresql", sourceRef: { kind: "HelmRepository", name: "bitnami" } } } },
      }),
    ];
    const edges = deriveK8sEdges(nodes);
    expect(edges).toContainEqual(expect.objectContaining({ from: "hr", to: "charts", viaAttr: "chart sourceRef" }));
    expect(edges).toHaveLength(1);
  });

  it("an Argo Application's repoURL gets no edge — a URL is not a node reference", () => {
    const nodes = [
      k8s("app", "K8s::Argo::Application", { ...meta("web", "argocd"), spec: { source: { repoURL: "https://example.com/web.git", path: "." } } }),
      k8s("repo", "K8s::Flux::GitRepository", { ...meta("web", "argocd"), spec: { url: "https://example.com/web.git" } }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(0);
  });
});

describe("addK8sDeclaredEdges", () => {
  it("appends deduped edges to the IR, leaving declared edges alone", () => {
    const ir = {
      nodes: estate(),
      edges: [{ from: "appService", to: "appDeployment", kind: "ref" }],
      groups: {},
    } as unknown as GraphIR;
    addK8sDeclaredEdges(ir);
    // The declared duplicate survives once; the two new joins are appended.
    expect(ir.edges).toHaveLength(3);
  });

  it("is a no-op on a graph with no k8s nodes", () => {
    const ir = {
      nodes: [{ id: "vpc", kind: "AWS::EC2::VPC", lexicon: "aws", attrs: {} }],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    addK8sDeclaredEdges(ir);
    expect(ir.edges).toHaveLength(0);
  });
});

describe("projectK8sLogical passes derived edges through (#143)", () => {
  it("keeps edges whose endpoints both survive as cards", () => {
    const ir = { nodes: estate(), edges: [], groups: {} } as unknown as GraphIR;
    addK8sDeclaredEdges(ir);
    const { ir: out } = projectK8sLogical(ir, "dev");
    expect(out.edges).toHaveLength(3);
  });

  it("drops an edge to a node the lens filtered away", () => {
    const nodes = [
      ...estate(),
      k8s("cfg", "K8s::Core::ConfigMap", meta("cfg", "app")),
    ];
    const ir = {
      nodes,
      edges: [{ from: "appDeployment", to: "cfg", kind: "ref" }],
      groups: {},
    } as unknown as GraphIR;
    addK8sDeclaredEdges(ir);
    const { ir: out } = projectK8sLogical(ir, "dev");
    expect(out.edges.some((e) => e.to === "cfg")).toBe(false);
    expect(out.edges).toHaveLength(3);
  });
});
