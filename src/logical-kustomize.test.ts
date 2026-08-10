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

// chant#1612 (behold#217): the stamped kustomize-root provenance annotation is
// authoritative — preferred over the directory walk, and working where the
// walk cannot: applied objects with no sourceLoc and no kustomization file
// anywhere on disk.
describe("projectKustomizeLogical — the provenance annotation (behold#217)", () => {
  const annotated = (id: string, root: string) =>
    ({
      id,
      kind: "K8s::Apps::Deployment",
      lexicon: "k8s",
      attrs: { metadata: { name: id, annotations: { "chant.intentius.io/kustomize-root": root } } },
    }) as never;

  test("the annotation wins over the directory walk when both would claim", () => {
    const ir = irOf([
      { ...(k8s("web", "K8s::Apps::Deployment", "overlays/dev/web.ts", { name: "web" }) as object),
        attrs: { metadata: { name: "web", annotations: { "chant.intentius.io/kustomize-root": "overlays/prod" } } } } as never,
    ]);
    const exists = (p: string) => p === "/proj/overlays/dev/kustomization.yaml";
    const proj = projectKustomizeLogical(ir, "/proj", exists);
    expect(proj.byContainer[overlayBoxTitle("prod")]).toEqual(["web"]);
    expect(proj.byContainer[overlayBoxTitle("dev")]).toBeUndefined();
  });

  test("an applied object — no sourceLoc, no kustomization file on disk — boxes by annotation alone", () => {
    const ir = irOf([annotated("web", "example/overlays/dev"), annotated("svc", "example/overlays/dev")]);
    const proj = projectKustomizeLogical(ir, "/proj", () => false);
    expect(proj.byContainer[overlayBoxTitle("dev")]).toEqual(["web", "svc"]);
  });

  test("a trailing slash on the annotated root still names the box by basename", () => {
    const ir = irOf([annotated("web", "overlays/staging/")]);
    const proj = projectKustomizeLogical(ir, "/proj", () => false);
    expect(proj.byContainer[overlayBoxTitle("staging")]).toEqual(["web"]);
  });

  test("a non-string annotation value is ignored — the walk (or nothing) decides", () => {
    const ir = irOf([
      { id: "web", kind: "K8s::Apps::Deployment", lexicon: "k8s",
        attrs: { metadata: { name: "web", annotations: { "chant.intentius.io/kustomize-root": 7 } } } } as never,
    ]);
    const proj = projectKustomizeLogical(ir, "/proj", () => false);
    expect(proj.byContainer).toEqual({});
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
