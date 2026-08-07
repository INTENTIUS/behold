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

  test("the probe base is the graphed root, not the project dir (sourceDir estates)", () => {
    // `chant graph <sourceDir>` reports sourceLoc.file relative to that root:
    // an estate with `sourceDir: "src"` yields `overlay/dev/main.ts`, and the
    // kustomization.yaml lives at `<project>/src/overlay/dev/`. The caller
    // hands the lens graphPath's resolution ("/proj/src"), so the probe hits;
    // against the project root it would miss every root and the lens would
    // stay dark on every sourceDir estate.
    const ir = irOf([k8s("web", "K8s::Apps::Deployment", "overlay/dev/main.ts", { name: "dev-web", namespace: "kz-web" })]);
    const exists = (p: string) => p === "/proj/src/overlay/dev/kustomization.yaml";
    const proj = projectKustomizeLogical(ir, "/proj/src", exists);
    expect(proj.byContainer[overlayBoxTitle("dev")]).toEqual(["web"]);
  });

  test("both sourceLoc shapes claim when given both bases (declared vs live overlay)", () => {
    // The declared path reports root-relative files, the --live overlay path
    // project-relative ones (it ignores the path positional). The server hands
    // the lens both bases, so the same estate boxes identically in both views.
    const exists = (p: string) => p === "/proj/src/overlay/dev/kustomization.yaml";
    const declared = irOf([k8s("web", "K8s::Apps::Deployment", "overlay/dev/main.ts")]);
    const live = irOf([k8s("web", "K8s::Apps::Deployment", "src/overlay/dev/main.ts")]);
    for (const ir of [declared, live]) {
      const proj = projectKustomizeLogical(ir, ["/proj/src", "/proj"], exists);
      expect(proj.byContainer[overlayBoxTitle("dev")]).toEqual(["web"]);
    }
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
