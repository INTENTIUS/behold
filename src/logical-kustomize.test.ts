import { describe, test, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { projectKustomizeLogical, overlayBoxTitle } from "./logical-kustomize.ts";
import { projectTopology, nestReleaseBoxes } from "./logical.ts";

const k8s = (id: string, kind: string, file: string, meta: Record<string, unknown> = {}) =>
  ({ id, kind, lexicon: "k8s", attrs: { metadata: meta }, sourceLoc: { file } }) as never;

const irOf = (nodes: unknown[]): GraphIR => ({ nodes: nodes as never, edges: [], groups: {} });

describe("projectKustomizeLogical (behold#171)", () => {
  test("no kustomization roots anywhere: empty projection, nothing invented", () => {
    const ir = irOf([k8s("web", "K8s::Apps::Deployment", "src/app/web.ts")]);
    const p = projectKustomizeLogical(ir, "/proj", () => false);
    expect(p.ir.nodes).toHaveLength(0);
    expect(p.byContainer).toEqual({});
  });

  test("nodes under a kustomization root claim into an `overlay <name>` box, membership only", () => {
    const ir = irOf([
      k8s("web", "K8s::Apps::Deployment", "overlays/dev/web.ts", { name: "web", namespace: "prod" }),
      k8s("svc", "K8s::Core::Service", "overlays/dev/svc.ts", { name: "web", namespace: "prod" }),
      k8s("other", "K8s::Apps::Deployment", "src/app/other.ts"),
    ]);
    const exists = (p: string) => p === "/proj/overlays/dev/kustomization.yaml";
    const proj = projectKustomizeLogical(ir, "/proj", exists);
    expect(proj.byContainer[overlayBoxTitle("dev")]).toEqual(["web", "svc"]);
    // Membership only — the k8s lens owns the nodes.
    expect(proj.ir.nodes).toHaveLength(0);
  });

  test("the nearest ancestor root wins, walked at most a few levels", () => {
    const ir = irOf([k8s("web", "K8s::Apps::Deployment", "overlays/dev/apps/web.ts")]);
    const exists = (p: string) => p === "/proj/overlays/dev/kustomization.yaml";
    const proj = projectKustomizeLogical(ir, "/proj", exists);
    expect(proj.byContainer[overlayBoxTitle("dev")]).toEqual(["web"]);
  });
});

describe("overlay boxes nest like release boxes (behold#171)", () => {
  test("an overlay whose members all sit in one namespace box moves inside it", () => {
    const byContainer = {
      "cluster local": ["namespace prod"],
      "namespace prod": ["web", "svc"],
      [overlayBoxTitle("dev")]: ["web", "svc"],
    };
    nestReleaseBoxes(byContainer);
    expect(byContainer["namespace prod"]).toEqual([overlayBoxTitle("dev")]);
    expect(byContainer[overlayBoxTitle("dev")]).toEqual(["web", "svc"]);
  });

  test("projectTopology without a projectDir skips the lens entirely", () => {
    const ir = irOf([k8s("web", "K8s::Apps::Deployment", "overlays/dev/web.ts", { name: "web", namespace: "prod" })]);
    const { byContainer } = projectTopology(ir, "dev");
    expect(Object.keys(byContainer).some((k) => k.startsWith("overlay "))).toBe(false);
  });
});
