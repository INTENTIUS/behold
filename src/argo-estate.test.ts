// behold#235: the argo-estate demo's composed shape — the acceptance surface
// for the Argo joins (#222, wired in #233).
//
// The fixtures below are the three members of example-argo-estate as chant
// 0.44.3 emits them (`chant graph src --format ir --detail 3` in each member:
// node ids `appA`/`appB`/`project` and `deployment`/`service`, metadata and
// spec verbatim), minus the attrs no pass reads — container specs, resource
// limits. They are composed here exactly as src/estate.ts composes a served
// estate, so what these tests pin is what `behold demo argo-estate` draws.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { composeStacks } from "@intentius/pinhole";
import type { GraphIR, IRNode } from "@intentius/chant";
import { deriveK8sEdges } from "./k8s-edges.ts";
import { projectK8sLogical } from "./logical-k8s.ts";
import { loadDemoRegistry } from "./demos.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const IN_CLUSTER = "https://kubernetes.default.svc";
const REPO_URL = "https://github.com/INTENTIUS/behold";

const k8s = (id: string, kind: string, attrs: Record<string, unknown>) =>
  ({ id, kind, lexicon: "k8s", attrs }) as unknown as IRNode;

/** example-argo-estate/control-plane/src/argo.ts. */
function controlPlane(): IRNode[] {
  const application = (name: string, wave: string) =>
    k8s(name === "app-a" ? "appA" : "appB", "K8s::Argo::Application", {
      metadata: { name, namespace: "argocd", annotations: { "argocd.argoproj.io/sync-wave": wave } },
      spec: {
        project: "estate",
        source: { repoURL: REPO_URL, targetRevision: "main", path: `example-argo-estate/${name}/manifests` },
        destination: { server: IN_CLUSTER, namespace: name },
        syncPolicy: { automated: { prune: true, selfHeal: true }, syncOptions: ["CreateNamespace=true"] },
      },
    });
  return [
    application("app-a", "0"),
    application("app-b", "1"),
    k8s("project", "K8s::Argo::AppProject", {
      metadata: { name: "estate", namespace: "argocd" },
      spec: {
        sourceRepos: [REPO_URL],
        destinations: [
          { server: IN_CLUSTER, namespace: "app-a" },
          { server: IN_CLUSTER, namespace: "app-b" },
        ],
        clusterResourceWhitelist: [{ group: "", kind: "Namespace" }],
      },
    }),
  ];
}

/** example-argo-estate/app-a/src/app.ts (and app-b's, same shape). */
function app(name: string): IRNode[] {
  const labels = { app: name };
  return [
    k8s("deployment", "K8s::Apps::Deployment", {
      metadata: { name, namespace: name, labels },
      spec: { selector: { matchLabels: labels }, template: { metadata: { labels } } },
    }),
    k8s("service", "K8s::Core::Service", {
      metadata: { name, namespace: name },
      spec: { selector: labels, ports: [{ port: 80, targetPort: 8080 }] },
    }),
  ];
}

const ir = (nodes: IRNode[]): GraphIR => ({ nodes, edges: [], groups: {} }) as unknown as GraphIR;

/** The three members composed, ids namespaced per member — what composeEstate
 * hands the edge passes on `behold serve control-plane app-a app-b`. */
const estate = (): GraphIR =>
  composeStacks([
    { name: "control-plane", ir: ir(controlPlane()) },
    { name: "app-a", ir: ir(app("app-a")) },
    { name: "app-b", ir: ir(app("app-b")) },
  ]);

describe("the argo-estate demo, composed (#235)", () => {
  it("boxes each member and namespaces its ids", () => {
    const composed = estate();
    expect(Object.keys(composed.groups.byStack ?? {}).sort()).toEqual(["app-a", "app-b", "control-plane"]);
    expect(composed.nodes.map((n) => n.id)).toEqual([
      "control-plane/appA",
      "control-plane/appB",
      "control-plane/project",
      "app-a/deployment",
      "app-a/service",
      "app-b/deployment",
      "app-b/service",
    ]);
  });

  it("joins both Applications to the AppProject they name, and nothing else (#222)", () => {
    const edges = deriveK8sEdges(estate().nodes);
    expect(edges).toContainEqual(
      expect.objectContaining({ from: "control-plane/appA", to: "control-plane/project", viaAttr: "project" }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ from: "control-plane/appB", to: "control-plane/project", viaAttr: "project" }),
    );
    // The apps' own selector joins, and no edge for the sync-wave annotations:
    // Argo's ordering is an annotation, not a reference (contrast Flux's
    // dependsOn, behold#223).
    expect(edges).toContainEqual(
      expect.objectContaining({ from: "app-a/service", to: "app-a/deployment", viaAttr: "selector" }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ from: "app-b/service", to: "app-b/deployment", viaAttr: "selector" }),
    );
    expect(edges).toHaveLength(4);
  });

  it("draws each Application's destination namespace as a box holding that app's objects", () => {
    const composed = estate();
    const { ir: projected, byContainer } = projectK8sLogical(composed);
    expect(byContainer["cluster"]).toEqual(["namespace app-a", "namespace app-b", "namespace argocd"]);
    expect(byContainer["namespace app-a"]).toEqual(["app-a/deployment", "app-a/service"]);
    expect(byContainer["namespace app-b"]).toEqual(["app-b/deployment", "app-b/service"]);
    // The Applications and their AppProject are cards where they actually live.
    expect(byContainer["namespace argocd"]).toEqual([
      "control-plane/appA",
      "control-plane/appB",
      "control-plane/project",
    ]);
    // Nothing is homeless: no cluster-scoped lane in this estate.
    expect(byContainer["cluster-scoped"]).toBeUndefined();
    expect(projected.nodes).toHaveLength(7);
  });

  it("names the app namespaces from the control plane ALONE — the destination harvest (#222)", () => {
    // Serving control-plane by itself, the app namespaces are declared by
    // nothing in the graph except each Application's spec.destination.namespace
    // (Argo creates them via CreateNamespace=true, so no Namespace object
    // exists — the difference from flux-estate, whose control plane must
    // declare them for targetNamespace to land).
    const { byContainer } = projectK8sLogical(ir(controlPlane()));
    expect(byContainer["cluster"]).toEqual(["namespace app-a", "namespace app-b", "namespace argocd"]);
    expect(byContainer["namespace app-a"]).toBeUndefined();
    expect(byContainer["namespace app-b"]).toBeUndefined();
  });
});

describe("the argo-estate catalog entry (#209 machinery)", () => {
  const entry = loadDemoRegistry(REPO).find((e) => e.name === "argo-estate");

  it("serves the three members composed, and needs no cluster tooling", () => {
    expect(entry).toBeDefined();
    expect(entry!.serve.dirs).toEqual(["control-plane", "app-a", "app-b"]);
    // Declared path only: nothing to install, nothing to stand up, no env.
    expect(entry!.requires).toEqual([]);
    expect(entry!.setup).toBeUndefined();
    expect(entry!.serve.env).toBeUndefined();
    expect(entry!.serve.local).toBeUndefined();
  });

  it("every member it names is a real chant project in the bundled dir", () => {
    for (const d of entry!.serve.dirs!) {
      expect(existsSync(join(REPO, entry!.dir!, d, "chant.config.ts")), `${d}: no chant.config.ts`).toBe(true);
    }
  });
});
