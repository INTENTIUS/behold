import { describe, expect, it } from "vitest";
import { helmIconFor, k8sIconFor, mappedKinds, type PackGlyph } from "./icon-packs.ts";

const { k8s, helm } = mappedKinds();

/** Every kind that must resolve, including the two mark families by prefix. */
const EVERY_MAPPED_KIND = [
  ...k8s,
  "K8s::Flux::Kustomization",
  "K8s::Flux::GitRepository",
  "K8s::Flux::HelmRelease",
  "K8s::Argo::Application",
  "K8s::Argo::ApplicationSet",
  "K8s::Argo::AppProject",
];

const resolve = (kind: string): PackGlyph | undefined =>
  kind.startsWith("Helm::") ? helmIconFor(kind) : k8sIconFor(kind);

describe("the vendored icon corpus", () => {
  it("resolves every mapped kind to a usable body", () => {
    for (const kind of [...EVERY_MAPPED_KIND, ...helm]) {
      const glyph = resolve(kind);
      expect(glyph, kind).toBeDefined();
      expect(glyph!.body.length, kind).toBeGreaterThan(0);
      expect(glyph!.colored, kind).toBe(true);
      expect(glyph!.viewBox, kind).toMatch(/^[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/);
    }
  });

  // The body is inlined into a host document, so a nested <svg> would open a new
  // coordinate system and a <script>/<foreignObject> would be live content.
  it("hands back inner markup only — no wrapper, nothing executable", () => {
    for (const kind of [...EVERY_MAPPED_KIND, ...helm]) {
      const body = resolve(kind)!.body;
      expect(body, kind).not.toMatch(/<svg\b/i);
      expect(body, kind).not.toMatch(/<\/svg\s*>/i);
      expect(body, kind).not.toMatch(/<script\b/i);
      expect(body, kind).not.toMatch(/<foreignObject\b/i);
      expect(body, kind).not.toMatch(/\son\w+\s*=/i);
    }
  });

  // Inlining several bodies into one document makes ids and CSS class names
  // global; upstream Flux and Helm both ship a `.cls-1`, and half the Inkscape
  // files call a layer `layer1`.
  it("namespaces ids and classes so two bodies can share a document", () => {
    const flux = k8sIconFor("K8s::Flux::Kustomization")!.body;
    const helmMark = helmIconFor("Helm::Release")!.body;
    const pod = k8sIconFor("K8s::Core::Pod")!.body;
    for (const [body, prefix] of [
      [flux, "cncf-flux-"],
      [helmMark, "cncf-helm-"],
      [pod, "k8s-pod-"],
    ] as const) {
      for (const name of [
        ...body.matchAll(/\sid\s*=\s*"([^"]*)"/g),
        ...body.matchAll(/\sclass\s*=\s*"([^"]*)"/g),
      ]) {
        for (const token of name[1].split(/\s+/)) {
          if (token) expect(token, `${prefix}${token}`).toContain(prefix);
        }
      }
    }
  });

  it("paints the kinds behold's own demos put on the graph", () => {
    expect(k8sIconFor("K8s::Apps::Deployment")!.body).toContain("k8s-deploy-");
    expect(k8sIconFor("K8s::Core::Service")!.body).toContain("k8s-svc-");
    expect(k8sIconFor("K8s::Core::Namespace")!.body).toContain("k8s-ns-");
    expect(k8sIconFor("K8s::Rbac::ClusterRoleBinding")!.body).toContain("k8s-crb-");
    expect(k8sIconFor("K8s::Autoscaling::HorizontalPodAutoscaler")!.body).toContain("k8s-hpa-");
  });

  it("gives Flux, Argo and Helm resources their own project marks", () => {
    const flux = k8sIconFor("K8s::Flux::Kustomization")!;
    const argo = k8sIconFor("K8s::Argo::Application")!;
    const chart = helmIconFor("Helm::Chart")!;
    expect(flux.body).toContain("cncf-flux-");
    expect(argo.body).toContain("cncf-argo-");
    expect(chart.body).toContain("cncf-helm-");
    expect(helmIconFor("Helm::Release")!.body).toBe(chart.body);
    // Three different marks, not one mark three times.
    expect(new Set([flux.body, argo.body, chart.body]).size).toBe(3);
  });

  // Falling through is the correct answer, not a gap to paper over: pinhole's
  // chain then reaches the keyword heuristic.
  it("falls through for kinds with no official icon", () => {
    for (const kind of [
      "K8s::Core::Node",
      "K8s::Apps::DeploymentList",
      "K8s::KubeMicroVM::MicroVMReplicaSet",
      "K8s::Monitoring::ServiceMonitor",
      "K8s::Core::Nonsense",
      "",
    ]) {
      expect(k8sIconFor(kind), kind).toBeUndefined();
    }
    expect(helmIconFor("Helm::Values")).toBeUndefined();
    expect(helmIconFor("K8s::Core::Pod")).toBeUndefined();
  });

  it("caches — the same kind hands back the same object", () => {
    expect(k8sIconFor("K8s::Core::Pod")).toBe(k8sIconFor("K8s::Core::Pod"));
    expect(k8sIconFor("K8s::Core::PodTemplate")).toBe(k8sIconFor("K8s::Core::Pod"));
  });
});
