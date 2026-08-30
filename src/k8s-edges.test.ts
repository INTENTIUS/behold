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

  it("joins a Kustomization to the siblings its dependsOn names (#223)", () => {
    const nodes = [
      k8s("base", "K8s::Flux::Kustomization", { ...meta("infra", "flux-system"), spec: {} }),
      k8s("apps", "K8s::Flux::Kustomization", {
        ...meta("apps", "flux-system"),
        spec: { dependsOn: [{ name: "infra" }] },
      }),
      k8s("tenant", "K8s::Flux::Kustomization", {
        ...meta("tenant", "team-a"),
        // The declaring object's namespace is the default; the second entry
        // crosses namespaces explicitly.
        spec: { dependsOn: [{ name: "infra", namespace: "flux-system" }] },
      }),
    ];
    const edges = deriveK8sEdges(nodes);
    expect(edges).toContainEqual(expect.objectContaining({ from: "apps", to: "base", viaAttr: "dependsOn" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "tenant", to: "base", viaAttr: "dependsOn" }));
    expect(edges).toHaveLength(2);
  });

  it("a dependsOn naming a Kustomization nobody declared gets no edge", () => {
    const nodes = [
      k8s("apps", "K8s::Flux::Kustomization", { ...meta("apps", "flux-system"), spec: { dependsOn: [{ name: "infra" }] } }),
      // Right name, wrong namespace — dependsOn defaults to the declarer's.
      k8s("elsewhere", "K8s::Flux::Kustomization", { ...meta("infra", "other"), spec: {} }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(0);
  });

  it("joins an ImagePolicy to the ImageRepository its imageRepositoryRef names (#223)", () => {
    const nodes = [
      k8s("repo", "K8s::Flux::ImageRepository", { ...meta("api", "flux-system"), spec: { image: "ghcr.io/acme/api" } }),
      k8s("policy", "K8s::Flux::ImagePolicy", {
        ...meta("api", "flux-system"),
        spec: { imageRepositoryRef: { name: "api" }, policy: { semver: { range: "1.x" } } },
      }),
    ];
    const edges = deriveK8sEdges(nodes);
    expect(edges).toContainEqual(expect.objectContaining({ from: "policy", to: "repo", viaAttr: "imageRepositoryRef" }));
    expect(edges).toHaveLength(1);
  });

  it("an imageRepositoryRef naming an undeclared repository gets no edge", () => {
    const nodes = [
      k8s("policy", "K8s::Flux::ImagePolicy", { ...meta("api", "flux-system"), spec: { imageRepositoryRef: { name: "api" } } }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(0);
  });

  it("joins an ImageUpdateAutomation to its GitRepository, kind declared or CRD-defaulted (#223)", () => {
    const nodes = [
      k8s("git", "K8s::Flux::GitRepository", { ...meta("infra", "flux-system"), spec: {} }),
      k8s("explicit", "K8s::Flux::ImageUpdateAutomation", {
        ...meta("write-back", "flux-system"),
        spec: { sourceRef: { kind: "GitRepository", name: "infra" }, interval: "5m" },
      }),
      // The CRD defaults sourceRef.kind to GitRepository — the apiserver's rule.
      k8s("defaulted", "K8s::Flux::ImageUpdateAutomation", {
        ...meta("write-back-2", "flux-system"),
        spec: { sourceRef: { name: "infra" } },
      }),
    ];
    const edges = deriveK8sEdges(nodes);
    expect(edges).toContainEqual(expect.objectContaining({ from: "explicit", to: "git", viaAttr: "sourceRef" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "defaulted", to: "git", viaAttr: "sourceRef" }));
    expect(edges).toHaveLength(2);
  });

  it("an ImageUpdateAutomation whose source is undeclared gets no edge", () => {
    const nodes = [
      k8s("auto", "K8s::Flux::ImageUpdateAutomation", { ...meta("write-back", "flux-system"), spec: { sourceRef: { name: "infra" } } }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(0);
  });

  it("joins an Alert to its Provider and to every event source it forwards (#223)", () => {
    const nodes = [
      k8s("slack", "K8s::Flux::Provider", { ...meta("slack", "flux-system"), spec: { type: "slack" } }),
      k8s("ks", "K8s::Flux::Kustomization", { ...meta("apps", "flux-system"), spec: {} }),
      k8s("hr", "K8s::Flux::HelmRelease", { ...meta("db", "flux-system"), spec: {} }),
      k8s("alert", "K8s::Flux::Alert", {
        ...meta("on-call", "flux-system"),
        spec: {
          providerRef: { name: "slack" },
          eventSources: [
            { kind: "Kustomization", name: "apps" },
            { kind: "HelmRelease", name: "db" },
            // A wildcard names every object of a kind, not one node.
            { kind: "GitRepository", name: "*" },
          ],
        },
      }),
    ];
    const edges = deriveK8sEdges(nodes);
    expect(edges).toContainEqual(expect.objectContaining({ from: "alert", to: "slack", viaAttr: "providerRef" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "alert", to: "ks", viaAttr: "eventSource" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "alert", to: "hr", viaAttr: "eventSource" }));
    expect(edges).toHaveLength(3);
  });

  it("an Alert whose provider and event source are undeclared gets no edges", () => {
    const nodes = [
      k8s("alert", "K8s::Flux::Alert", {
        ...meta("on-call", "flux-system"),
        spec: { providerRef: { name: "slack" }, eventSources: [{ kind: "Kustomization", name: "apps" }] },
      }),
      // Same names, another namespace — an eventSource resolves in the Alert's.
      k8s("slack", "K8s::Flux::Provider", { ...meta("slack", "other"), spec: {} }),
      k8s("ks", "K8s::Flux::Kustomization", { ...meta("apps", "other"), spec: {} }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(0);
  });

  it("joins an Argo Application and ApplicationSet to the AppProject they name (#222)", () => {
    const nodes = [
      k8s("project", "K8s::Argo::AppProject", { ...meta("platform", "argocd"), spec: { destinations: [{ namespace: "web" }] } }),
      k8s("app", "K8s::Argo::Application", {
        ...meta("web", "argocd"),
        spec: { project: "platform", destination: { namespace: "web" }, source: { repoURL: "https://example.com/web.git" } },
      }),
      // apps-in-any-namespace: the Application need not sit beside its project.
      k8s("tenantApp", "K8s::Argo::Application", { ...meta("api", "team-a"), spec: { project: "platform" } }),
      k8s("set", "K8s::Argo::ApplicationSet", {
        ...meta("tenants", "argocd"),
        spec: { generators: [{ list: { elements: [] } }], template: { spec: { project: "platform" } } },
      }),
    ];
    const edges = deriveK8sEdges(nodes);
    expect(edges).toContainEqual(expect.objectContaining({ from: "app", to: "project", viaAttr: "project" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "tenantApp", to: "project", viaAttr: "project" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "set", to: "project", viaAttr: "template project" }));
    expect(edges).toHaveLength(3);
  });

  it("an Application naming an undeclared project gets no edge, and an ambiguous name is declined", () => {
    expect(
      deriveK8sEdges([
        k8s("app", "K8s::Argo::Application", { ...meta("web", "argocd"), spec: { project: "platform" } }),
      ]),
    ).toHaveLength(0);
    // Two AppProjects share the name and neither is the Application's own
    // namespace — nothing here can say which one Argo resolves.
    expect(
      deriveK8sEdges([
        k8s("p1", "K8s::Argo::AppProject", { ...meta("platform", "argocd"), spec: {} }),
        k8s("p2", "K8s::Argo::AppProject", { ...meta("platform", "argocd-2"), spec: {} }),
        k8s("app", "K8s::Argo::Application", { ...meta("web", "team-a"), spec: { project: "platform" } }),
      ]),
    ).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// #166 — the selector join beyond Service.
//
// Provenance: `example-k8s`'s own `WebApp` composite emits a Deployment, a
// Service and a PodDisruptionBudget over one label set (see
// example-k8s/src/infra.ts: `web.deployment`, `web.service`, `web.pdb`). The
// PDB's `spec.selector.matchLabels` is exactly the Deployment's pod-template
// labels, and it was an orphan card in every view — the #166 measurement's
// item 4.
// ---------------------------------------------------------------------------

/** The example-k8s trio, as chant emits it at detail 3. */
function webApp(): IRNode[] {
  const labels = { app: "web" };
  return [
    k8s("deployment", "K8s::Apps::Deployment", {
      ...meta("web", "default", labels),
      spec: { replicas: 2, selector: { matchLabels: labels }, template: { metadata: { labels } } },
    }),
    k8s("service", "K8s::Core::Service", { ...meta("web", "default"), spec: { selector: labels, ports: [{ port: 80 }] } }),
    k8s("pdb", "K8s::Policy::PodDisruptionBudget", {
      ...meta("web", "default"),
      spec: { minAvailable: 1, selector: { matchLabels: labels } },
    }),
  ];
}

describe("the selector join, generalised past Service (#166)", () => {
  it("joins a PodDisruptionBudget to the workload its selector lands on", () => {
    const edges = deriveK8sEdges(webApp());
    expect(edges).toContainEqual(expect.objectContaining({ from: "pdb", to: "deployment", viaAttr: "selector", inferred: true }));
    // The Service's own join is unchanged — the PDB is the edge that was missing.
    expect(edges).toContainEqual(expect.objectContaining({ from: "service", to: "deployment", viaAttr: "selector" }));
    expect(edges).toHaveLength(2);
  });

  it("joins a NetworkPolicy by its podSelector", () => {
    const nodes = [
      ...webApp(),
      k8s("netpol", "K8s::Networking::NetworkPolicy", {
        ...meta("web", "default"),
        spec: { podSelector: { matchLabels: { app: "web" } }, policyTypes: ["Ingress"] },
      }),
    ];
    expect(deriveK8sEdges(nodes)).toContainEqual(
      expect.objectContaining({ from: "netpol", to: "deployment", viaAttr: "podSelector" }),
    );
  });

  it("scopes the new carriers by namespace, exactly as the Service join is", () => {
    const nodes = [
      k8s("deployment", "K8s::Apps::Deployment", { ...meta("web", "prod"), spec: { template: { metadata: { labels: { app: "web" } } } } }),
      k8s("pdb", "K8s::Policy::PodDisruptionBudget", { ...meta("web", "staging"), spec: { selector: { matchLabels: { app: "web" } } } }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(0);
  });

  it("refuses a selector it cannot evaluate, and one that selects everything", () => {
    // matchExpressions is ANDed with matchLabels — matching on the labels half
    // alone would over-select, so the whole selector is refused.
    const expressions = [
      k8s("deployment", "K8s::Apps::Deployment", { ...meta("web", "default"), spec: { template: { metadata: { labels: { app: "web" } } } } }),
      k8s("pdb", "K8s::Policy::PodDisruptionBudget", {
        ...meta("web", "default"),
        spec: { selector: { matchLabels: { app: "web" }, matchExpressions: [{ key: "tier", operator: "In", values: ["web"] }] } },
      }),
    ];
    expect(deriveK8sEdges(expressions)).toHaveLength(0);
    // An empty podSelector is "every pod in this namespace" — a statement about
    // the namespace, not a reference to a workload.
    const everything = [
      k8s("deployment", "K8s::Apps::Deployment", { ...meta("web", "default"), spec: { template: { metadata: { labels: { app: "web" } } } } }),
      k8s("netpol", "K8s::Networking::NetworkPolicy", { ...meta("deny-all", "default"), spec: { podSelector: {}, policyTypes: ["Ingress"] } }),
    ];
    expect(deriveK8sEdges(everything)).toHaveLength(0);
  });

  it("draws no edge from a NetworkPolicy's PEER selectors", () => {
    // A peer is scoped by the namespaceSelector beside it — a selector over
    // Namespace labels this pass does not index. Left undrawn rather than wrong.
    const nodes = [
      ...webApp(),
      k8s("netpol", "K8s::Networking::NetworkPolicy", {
        ...meta("web", "default"),
        spec: {
          podSelector: { matchLabels: { app: "nothing-here" } },
          ingress: [{ from: [{ podSelector: { matchLabels: { app: "web" } }, namespaceSelector: {} }] }],
        },
      }),
    ];
    expect(deriveK8sEdges(nodes).some((e) => e.from === "netpol")).toBe(false);
  });

  it("does not turn a workload's OWN selector into a reference", () => {
    // Two Deployments sharing `app: web` in one namespace: each `spec.selector`
    // names its own pods, so neither may point at the other.
    const nodes = [
      k8s("a", "K8s::Apps::Deployment", { ...meta("a", "default"), spec: { selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } } } } }),
      k8s("b", "K8s::Apps::Deployment", { ...meta("b", "default"), spec: { selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } } } } }),
    ];
    expect(deriveK8sEdges(nodes)).toHaveLength(0);
  });
});
