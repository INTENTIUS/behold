import { describe, test, expect } from "vitest";
import { projectHelmLogical, releaseBoxTitle } from "./logical-helm.ts";
import { projectTopology, nestReleaseBoxes, placeHelmReleases, type ByContainer, type ClusterBoxes } from "./logical.ts";
import { namespaceBoxKey } from "./logical-k8s.ts";
import type { GraphIR, IRNode } from "@intentius/chant";

const chart = (id: string, name: string, file: string): IRNode => ({
  id,
  kind: "Helm::Chart",
  lexicon: "helm",
  attrs: { name },
  sourceLoc: { file },
});

const k8s = (id: string, kind: string, file: string, ns?: string): IRNode => ({
  id,
  kind,
  lexicon: "k8s",
  attrs: ns ? { metadata: { name: id, namespace: ns } } : { metadata: { name: id } },
  sourceLoc: { file },
});

const irOf = (nodes: IRNode[]): GraphIR => ({ nodes, edges: [], groups: {} });

describe("projectHelmLogical (behold#146)", () => {
  test("no helm nodes: empty projection, nothing invented", () => {
    const p = projectHelmLogical(irOf([k8s("web", "K8s::Apps::Deployment", "src/app.ts")]));
    expect(p.ir.nodes).toEqual([]);
    expect(p.byContainer).toEqual({});
  });

  test("a chart claims its own directory's k8s objects into a release box", () => {
    const p = projectHelmLogical(
      irOf([
        chart("webChart", "web-app", "src/helm/chart.ts"),
        k8s("webDeploy", "K8s::Apps::Deployment", "src/helm/chart.ts"),
        k8s("webSvc", "K8s::Core::Service", "src/helm/svc.ts"),
        k8s("other", "K8s::Apps::Deployment", "src/plain/other.ts"),
      ]),
    );

    expect(p.byContainer[releaseBoxTitle("web-app")]).toEqual(["webChart", "webDeploy", "webSvc"]);
    // Only the chart card is this lens's node — the k8s nodes stay the k8s
    // lens's, keeping the composed union duplicate-free.
    expect(p.ir.nodes.map((n) => n.id)).toEqual(["webChart"]);
  });

  test("values/notes plumbing never becomes a card or a box", () => {
    const p = projectHelmLogical(
      irOf([
        chart("c", "app", "src/h/c.ts"),
        { id: "vals", kind: "Helm::Values", lexicon: "helm", attrs: {}, sourceLoc: { file: "src/h/c.ts" } },
      ]),
    );
    expect(p.ir.nodes.map((n) => n.id)).toEqual(["c"]);
    expect(Object.keys(p.byContainer)).toEqual([releaseBoxTitle("app")]);
  });
});

describe("nestReleaseBoxes (behold#146 — the cross-lens half)", () => {
  test("a release whose objects all sit in one namespace box nests inside it, objects leave the parent", () => {
    const byContainer: ByContainer = {
      "namespace prod": ["webDeploy", "webSvc", "unrelated"],
      "release web-app": ["webChart", "webDeploy", "webSvc"],
    };
    nestReleaseBoxes(byContainer);
    expect(byContainer["namespace prod"]).toEqual(["unrelated", "release web-app"]);
    expect(byContainer["release web-app"]).toEqual(["webChart", "webDeploy", "webSvc"]);
  });

  test("objects spanning two namespaces: the release box stays at the root — no guessed home", () => {
    const byContainer: ByContainer = {
      "namespace a": ["x"],
      "namespace b": ["y"],
      "release app": ["chartCard", "x", "y"],
    };
    const before = JSON.parse(JSON.stringify(byContainer)) as ByContainer;
    nestReleaseBoxes(byContainer);
    expect(byContainer).toEqual(before);
  });

  test("helm-only estate (no other boxes): release boxes stay root", () => {
    const byContainer: ByContainer = { "release app": ["chartCard", "webDeploy"] };
    nestReleaseBoxes(byContainer);
    expect(byContainer).toEqual({ "release app": ["chartCard", "webDeploy"] });
  });
});

describe("projectTopology composes the helm lens", () => {
  test("mixed helm+k8s estate: release box inside the namespace box, one set of cards", () => {
    const ir = irOf([
      chart("webChart", "web-app", "src/helm/chart.ts"),
      k8s("webDeploy", "K8s::Apps::Deployment", "src/helm/chart.ts", "prod"),
      k8s("webSvc", "K8s::Core::Service", "src/helm/chart.ts", "prod"),
    ]);
    const p = projectTopology(ir);

    const release = releaseBoxTitle("web-app");
    // The namespace box holds the release box, not the objects directly.
    expect(p.byContainer["namespace prod"]).toContain(release);
    expect(p.byContainer["namespace prod"]).not.toContain("webDeploy");
    expect(p.byContainer[release]).toEqual(expect.arrayContaining(["webChart", "webDeploy", "webSvc"]));
    // No duplicate cards in the union.
    const ids = p.ir.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// behold#328 / pinhole#119 — the title re-parse debt. `placeHelmReleases` used
// to find the namespace box a release belongs in by re-minting the display
// string `namespace <ns>`, which made every box title load-bearing: pinhole#119
// asks for a mark channel on GroupBox precisely because behold could not
// decorate a namespace title without silently unparenting the releases inside
// it. The lens that drew the box now hands over its container KEY.
describe("placeHelmReleases parents by container key, not by box title (#328, pinhole#119)", () => {
  const release = (id: string, ns?: string): IRNode => ({
    id,
    kind: "Helm::Release",
    lexicon: "helm",
    attrs: ns ? { name: id, namespace: ns } : { name: id },
  });
  /** The k8s lens's own report for a cluster with one `prod` namespace box. */
  const cluster = (): { byContainer: ByContainer; boxes: ClusterBoxes } => ({
    byContainer: { "cluster local": [namespaceBoxKey("prod")], [namespaceBoxKey("prod")]: ["webDeploy"] },
    boxes: { cluster: "cluster local", namespaces: { prod: namespaceBoxKey("prod") } },
  });

  test("a release joins the namespace box the k8s lens already drew", () => {
    const { byContainer, boxes } = cluster();
    placeHelmReleases([release("shop/api", "prod")], byContainer, boxes);
    expect(byContainer[namespaceBoxKey("prod")]).toEqual(["webDeploy", "shop/api"]);
  });

  // The test that would have caught the coupling: same estate, same release,
  // only the box's TITLE decorated. The key travels, so the placement is
  // unchanged — no second box, nothing stranded at the root.
  test("a DECORATED namespace title still parents its releases — the key travels, the title is presentation", () => {
    const decorated = `${namespaceBoxKey("prod")} ⚙`;
    const byContainer: ByContainer = { "cluster local": [decorated], [decorated]: ["webDeploy"] };
    placeHelmReleases([release("shop/api", "prod")], byContainer, {
      cluster: "cluster local",
      namespaces: { prod: decorated },
    });
    expect(byContainer[decorated]).toEqual(["webDeploy", "shop/api"]);
    expect(byContainer[namespaceBoxKey("prod")]).toBeUndefined();
    expect(byContainer["cluster local"]).toEqual([decorated]);
  });

  test("a namespace the estate never declared gets its box under the cluster — reporting where the release was observed", () => {
    const { byContainer, boxes } = cluster();
    placeHelmReleases([release("bootstrap", "kube-system")], byContainer, boxes);
    expect(byContainer["cluster local"]).toEqual([namespaceBoxKey("prod"), namespaceBoxKey("kube-system")]);
    expect(byContainer[namespaceBoxKey("kube-system")]).toEqual(["bootstrap"]);
  });

  test("no cluster picture, or no namespace on the release: the card stays at the root", () => {
    const helmOnly: ByContainer = { "release web": ["chartCard"] };
    placeHelmReleases([release("shop/api", "prod")], helmOnly, { namespaces: {} });
    expect(helmOnly).toEqual({ "release web": ["chartCard"] });

    const { byContainer, boxes } = cluster();
    const before = structuredClone(byContainer);
    placeHelmReleases([release("nsless")], byContainer, boxes);
    expect(byContainer).toEqual(before);
  });
});

// The pin: the placement a real estate gets through the whole composition,
// asserted end to end so the re-parenting refactor above stays behaviour-free.
describe("projectTopology places an observed release in its namespace box (#328 pin)", () => {
  /** A deploy-step estate: the k8s half declares the namespace and a workload,
   * the helm half is an observed release synthesized by src/helm-releases.ts
   * (no declared chart node). */
  const estate = (): GraphIR =>
    irOf([
      { id: "prodNs", kind: "K8s::Core::Namespace", lexicon: "k8s", attrs: { metadata: { name: "prod" } } },
      k8s("webDeploy", "K8s::Apps::Deployment", "src/app.ts", "prod"),
      { id: "prod/ingress-nginx", kind: "Helm::Release", lexicon: "helm", attrs: { name: "ingress-nginx", namespace: "prod" } },
      { id: "kube-system/metrics", kind: "Helm::Release", lexicon: "helm", attrs: { name: "metrics", namespace: "kube-system" } },
    ]);

  test("declared namespace claims its release; an undeclared one is boxed under the cluster", () => {
    const { byContainer } = projectTopology(estate(), "local");
    expect(byContainer["cluster local"]).toEqual(expect.arrayContaining(["namespace prod", "namespace kube-system"]));
    expect(byContainer["namespace prod"]).toEqual(["webDeploy", "prod/ingress-nginx"]);
    expect(byContainer["namespace kube-system"]).toEqual(["kube-system/metrics"]);
  });
});
