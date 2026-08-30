// behold#166: the cross-member estate edge — the join neither bundled estate
// drew at any detail tier before this.
//
// Provenance: the node fixtures below are the bundled estates' own declared
// source, transcribed the way src/argo-estate.test.ts transcribes them (`chant
// graph src --format ir --detail 3` per member: ids `appA`/`appB`/`source`,
// metadata and spec verbatim), minus the attrs no pass reads. The MEMBER
// DIRECTORIES are the real ones in this repo — `pathAlignment`'s on-disk check
// runs against `example-flux-estate/app-a/manifests` as it ships, so what these
// tests pin is what `behold demo flux-estate` and `behold demo argo-estate`
// draw.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { composeStacks } from "@intentius/pinhole";
import type { GraphIR, IRNode } from "@intentius/chant";
import { addEstateMemberEdges, declaredDeliveries, deriveEstateMemberEdges } from "./estate-edges.ts";
import { addK8sDeclaredEdges } from "./k8s-edges.ts";
import { addValueMatchEdges } from "./value-match.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "https://github.com/INTENTIUS/behold";
const IN_CLUSTER = "https://kubernetes.default.svc";

const k8s = (id: string, kind: string, attrs: Record<string, unknown>) =>
  ({ id, kind, lexicon: "k8s", attrs }) as unknown as IRNode;

const ir = (nodes: IRNode[]): GraphIR => ({ nodes, edges: [], groups: {} }) as unknown as GraphIR;

/** One app project: a Deployment its Service selects. `namespace` omitted is
 * app-b's shape — the control plane stamps it via targetNamespace. */
function app(name: string, namespace?: string): IRNode[] {
  const labels = { app: name };
  const metadata = (extra: Record<string, unknown> = {}) => ({ name, ...(namespace ? { namespace } : {}), ...extra });
  return [
    k8s("deployment", "K8s::Apps::Deployment", {
      metadata: metadata({ labels }),
      spec: { selector: { matchLabels: labels }, template: { metadata: { labels } } },
    }),
    k8s("service", "K8s::Core::Service", {
      metadata: metadata(),
      spec: { selector: labels, ports: [{ port: 80, targetPort: 8080 }] },
    }),
  ];
}

/** example-flux-estate/control-plane/src/flux.ts. */
function fluxControlPlane(): IRNode[] {
  const kustomization = (id: string, name: string, dependsOn?: { name: string }[]) =>
    k8s(id, "K8s::Flux::Kustomization", {
      metadata: { name, namespace: "flux-system" },
      spec: {
        interval: "1m",
        prune: true,
        targetNamespace: name,
        sourceRef: { kind: "GitRepository", name: "behold" },
        path: `./example-flux-estate/${name}/manifests`,
        ...(dependsOn ? { dependsOn } : {}),
      },
    });
  return [
    k8s("nsAppA", "K8s::Core::Namespace", { metadata: { name: "app-a" } }),
    k8s("nsAppB", "K8s::Core::Namespace", { metadata: { name: "app-b" } }),
    k8s("source", "K8s::Flux::GitRepository", {
      metadata: { name: "behold", namespace: "flux-system" },
      spec: { interval: "1m", url: REPO_URL, ref: { branch: "main" } },
    }),
    kustomization("appA", "app-a"),
    kustomization("appB", "app-b", [{ name: "app-a" }]),
  ];
}

/** example-argo-estate/control-plane/src/argo.ts. */
function argoControlPlane(): IRNode[] {
  const application = (id: string, name: string) =>
    k8s(id, "K8s::Argo::Application", {
      metadata: { name, namespace: "argocd" },
      spec: {
        project: "estate",
        source: { repoURL: REPO_URL, targetRevision: "main", path: `example-argo-estate/${name}/manifests` },
        destination: { server: IN_CLUSTER, namespace: name },
      },
    });
  return [
    application("appA", "app-a"),
    application("appB", "app-b"),
    k8s("project", "K8s::Argo::AppProject", {
      metadata: { name: "estate", namespace: "argocd" },
      spec: { sourceRepos: [REPO_URL] },
    }),
  ];
}

/** The estate as behold serves it: members composed, then the two intra-member
 * passes, in the server's own order — which is what the cross-member pass reads
 * to find each member's entry nodes. */
function served(estate: string, members: { name: string; nodes: IRNode[] }[]) {
  const composed = composeStacks(members.map((m) => ({ name: m.name, ir: ir(m.nodes) }))) as GraphIR;
  addValueMatchEdges(addK8sDeclaredEdges(composed));
  return {
    ir: composed,
    members: members.map((m) => ({ name: m.name, dir: join(REPO, estate, m.name) })),
  };
}

const fluxEstate = () =>
  served("example-flux-estate", [
    { name: "control-plane", nodes: fluxControlPlane() },
    { name: "app-a", nodes: app("app-a", "app-a") },
    { name: "app-b", nodes: app("app-b") },
  ]);

const argoEstate = () =>
  served("example-argo-estate", [
    { name: "control-plane", nodes: argoControlPlane() },
    { name: "app-a", nodes: app("app-a", "app-a") },
    { name: "app-b", nodes: app("app-b", "app-b") },
  ]);

describe("declaredDeliveries — what a reconciler says it applies", () => {
  it("reads a Flux Kustomization's spec.path", () => {
    const [k] = fluxControlPlane().filter((n) => n.id === "appA");
    expect(declaredDeliveries(k)).toEqual([{ from: "appA", path: "./example-flux-estate/app-a/manifests", viaAttr: "reconciles" }]);
  });

  it("reads an Argo Application's spec.source.path, and the multi-source spelling", () => {
    const [a] = argoControlPlane().filter((n) => n.id === "appA");
    expect(declaredDeliveries(a)).toEqual([{ from: "appA", path: "example-argo-estate/app-a/manifests", viaAttr: "delivers" }]);
    const multi = k8s("multi", "K8s::Argo::Application", {
      metadata: { name: "multi", namespace: "argocd" },
      spec: { sources: [{ repoURL: REPO_URL, path: "one" }, { repoURL: REPO_URL, path: "two" }] },
    });
    expect(declaredDeliveries(multi).map((d) => d.path)).toEqual(["one", "two"]);
  });

  it("reads nothing off the kinds whose path is not a member path", () => {
    // A HelmRelease's chart path is relative to the SOURCE and names a chart
    // directory, not a chant project; an ApplicationSet's is a generator
    // template, expanded per element — neither is a declared member path.
    const release = k8s("release", "K8s::Flux::HelmRelease", {
      metadata: { name: "podinfo", namespace: "flux-system" },
      spec: { chart: { spec: { chart: "./example-flux-estate/app-a/manifests", sourceRef: { kind: "GitRepository", name: "behold" } } } },
    });
    const set = k8s("set", "K8s::Argo::ApplicationSet", {
      metadata: { name: "apps", namespace: "argocd" },
      spec: { template: { spec: { project: "estate", source: { repoURL: REPO_URL, path: "{{path}}" } } } },
    });
    expect(declaredDeliveries(release)).toEqual([]);
    expect(declaredDeliveries(set)).toEqual([]);
  });
});

describe("the flux-estate demo's cross-member edges (#166)", () => {
  it("joins each Kustomization to the member its declared path points at", () => {
    const { ir: composed, members } = fluxEstate();
    const edges = deriveEstateMemberEdges(composed, members);
    expect(edges).toEqual([
      { from: "control-plane/appA", to: "app-a/service", kind: "ref", viaAttr: "reconciles", inferred: true },
      { from: "control-plane/appB", to: "app-b/service", kind: "ref", viaAttr: "reconciles", inferred: true },
    ]);
  });

  it("lands on the member's entry node, not on every card in it", () => {
    // app-a's Deployment is already the Service's selector target, so the
    // controller's arrow crosses the boundary once and the member's own edge
    // carries the rest: appA → service → deployment.
    const { ir: composed, members } = fluxEstate();
    addEstateMemberEdges(composed, members);
    const into = composed.edges.filter((e) => e.to.startsWith("app-a/"));
    expect(into.map((e) => `${e.from} → ${e.to}`)).toEqual([
      "app-a/service → app-a/deployment",
      "control-plane/appA → app-a/service",
    ]);
  });

  it("never crosses to the member the path does not name", () => {
    const { ir: composed, members } = fluxEstate();
    const edges = deriveEstateMemberEdges(composed, members);
    expect(edges.some((e) => e.from === "control-plane/appA" && e.to.startsWith("app-b/"))).toBe(false);
    expect(edges.some((e) => e.from === "control-plane/appB" && e.to.startsWith("app-a/"))).toBe(false);
  });

  it("adds them to the estate deduped, leaving the intra-member joins alone", () => {
    const { ir: composed, members } = fluxEstate();
    const before = composed.edges.length;
    addEstateMemberEdges(composed, members);
    addEstateMemberEdges(composed, members); // idempotent
    expect(composed.edges.length).toBe(before + 2);
  });
});

describe("the argo-estate demo's cross-member edges (#166)", () => {
  it("joins each Application to the member its source path points at", () => {
    const { ir: composed, members } = argoEstate();
    expect(deriveEstateMemberEdges(composed, members)).toEqual([
      { from: "control-plane/appA", to: "app-a/service", kind: "ref", viaAttr: "delivers", inferred: true },
      { from: "control-plane/appB", to: "app-b/service", kind: "ref", viaAttr: "delivers", inferred: true },
    ]);
  });
});

describe("what the cross-member join refuses", () => {
  const withPath = (path: string) => {
    const control = [
      k8s("appA", "K8s::Flux::Kustomization", {
        metadata: { name: "app-a", namespace: "flux-system" },
        spec: { path, targetNamespace: "app-a" },
      }),
    ];
    return served("example-flux-estate", [
      { name: "control-plane", nodes: control },
      { name: "app-a", nodes: app("app-a", "app-a") },
    ]);
  };
  const edgesFor = (path: string) => {
    const { ir: composed, members } = withPath(path);
    return deriveEstateMemberEdges(composed, members);
  };

  it("a path whose remainder is not a real directory under the member", () => {
    expect(edgesFor("./example-flux-estate/app-a/behold-does-not-exist")).toEqual([]);
  });

  it("an absolute path, a `..` escape, and a path aimed at a PARENT of the member", () => {
    expect(edgesFor("/example-flux-estate/app-a/manifests")).toEqual([]);
    expect(edgesFor("../example-flux-estate/app-a/manifests")).toEqual([]);
    expect(edgesFor("./example-flux-estate")).toEqual([]);
  });

  it("a member delivering itself", () => {
    // The Kustomization declares its OWN member's manifests: the split across
    // projects is the premise of the join, so there is nothing to cross.
    const { ir: composed, members } = served("example-flux-estate", [
      { name: "app-a", nodes: [...app("app-a", "app-a"), ...fluxControlPlane().filter((n) => n.id === "appA")] },
      { name: "app-b", nodes: app("app-b") },
    ]);
    expect(deriveEstateMemberEdges(composed, members)).toEqual([]);
  });

  it("a path two members claim equally well", () => {
    // Both members are the same directory, so no reading of the path is more
    // specific than the other — ambiguous, and behold draws nothing.
    const composed = composeStacks([
      { name: "control-plane", ir: ir(fluxControlPlane().filter((n) => n.id === "appA")) },
      { name: "one", ir: ir(app("app-a", "app-a")) },
      { name: "two", ir: ir(app("app-a", "app-a")) },
    ]) as GraphIR;
    const dir = join(REPO, "example-flux-estate", "app-a");
    expect(
      deriveEstateMemberEdges(composed, [
        { name: "control-plane", dir: join(REPO, "example-flux-estate", "control-plane") },
        { name: "one", dir },
        { name: "two", dir },
      ]),
    ).toEqual([]);
  });

  it("a single-member estate, which has no boundary to cross", () => {
    const { ir: composed, members } = fluxEstate();
    expect(deriveEstateMemberEdges(composed, members.slice(0, 1))).toEqual([]);
  });
});

describe("member attribution", () => {
  it("falls back to composeStacks' id convention when the IR carries no byStack", () => {
    const { ir: composed, members } = fluxEstate();
    const groupless = { ...composed, groups: {} } as GraphIR;
    expect(deriveEstateMemberEdges(groupless, members).map((e) => e.to)).toEqual(["app-a/service", "app-b/service"]);
  });

  it("does not deliver a member's Op card — a reconciler applies manifests, not operations", () => {
    // Every bundled member carries a `Temporal::Op` from its `ops/` directory
    // (chant 0.52), and it is an entry node by the rule above — so the lexicon
    // filter is the only thing between it and an arrow saying Flux applies it.
    const withOp = [
      ...app("app-a", "app-a"),
      { id: "k3d-apply", kind: "Temporal::Op", lexicon: "temporal", attrs: {} } as unknown as IRNode,
    ];
    const { ir: composed, members } = served("example-flux-estate", [
      { name: "control-plane", nodes: fluxControlPlane().filter((n) => n.id === "appA") },
      { name: "app-a", nodes: withOp },
    ]);
    expect(deriveEstateMemberEdges(composed, members).map((e) => e.to)).toEqual(["app-a/service"]);
  });

  it("lands on every entry node when a member's cards reference nothing of each other's", () => {
    const loose = [
      k8s("configmap", "K8s::Core::ConfigMap", { metadata: { name: "app-a", namespace: "app-a" } }),
      k8s("quota", "K8s::Core::ResourceQuota", { metadata: { name: "app-a", namespace: "app-a" } }),
    ];
    const { ir: composed, members } = served("example-flux-estate", [
      { name: "control-plane", nodes: fluxControlPlane().filter((n) => n.id === "appA") },
      { name: "app-a", nodes: loose },
    ]);
    expect(deriveEstateMemberEdges(composed, members).map((e) => e.to)).toEqual(["app-a/configmap", "app-a/quota"]);
  });
});
