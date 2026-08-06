import { describe, test, expect } from "vitest";
import { projectHelmLogical, releaseBoxTitle } from "./logical-helm.ts";
import { projectTopology, nestReleaseBoxes, type ByContainer } from "./logical.ts";
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
