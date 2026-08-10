import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// composeEstate graphs each project via chant.ts; mock the ONE shell-out
// (`graphIr`) to test the wiring (naming + composition) without shelling
// chant. Everything else in the module stays real — #221's join asks
// `resolveChant`/`meetsFloor` whether a member's own chant can be sent
// `--namespace`, and a stub there would make the version gate untested.
vi.mock("./chant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chant.ts")>()),
  graphIr: vi.fn(),
}));
import { graphIr, type GraphOptions } from "./chant.ts";
import {
  awaitsNamespaceBinding,
  composeEstate,
  composeEstateOverlay,
  joinNamespaceBindings,
  pathAlignment,
  withoutJoinedMembers,
} from "./estate.ts";
import { attachRuntimeContainment } from "./overlay.ts";
import type { GraphIR as ChantGraphIR } from "@intentius/chant";

const stack = (nodeId: string, lexicon = "aws") => ({
  nodes: [{ id: nodeId, kind: "X", lexicon, attrs: {} }],
  edges: [],
  groups: {},
});

describe("composeEstate (#31)", () => {
  it("graphs each project and composes into one estate with per-project byStack groups", async () => {
    vi.mocked(graphIr)
      .mockResolvedValueOnce(stack("vpc") as never)
      .mockResolvedValueOnce(stack("svc") as never);

    const ir = await composeEstate(["/work/infra", "/work/api"]);

    expect(graphIr).toHaveBeenCalledTimes(2);
    // Nodes are namespaced per stack; byStack groups them by the short project name.
    expect(Object.keys(ir.groups.byStack ?? {}).sort()).toEqual(["api", "infra"]);
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(["api/svc", "infra/vpc"]);
  });
});

// #224: composeStacks namespaces node ids but not chant's `runtimeOwner`, so
// a composed estate's runtime children used to name an owner id that no node
// in the composed IR carries — attachRuntimeContainment then drew a box with
// the children in it and the owner outside (the #144 shape).
describe("composeEstateOverlay — runtime owners survive composition (#224)", () => {
  const owned = (owner: string) => ({
    nodes: [
      { id: "kustomization", kind: "K8s::Flux::Kustomization", lexicon: "k8s", attrs: { _status: "good" } },
      { id: "pod", kind: "K8s::Core::Pod", lexicon: "k8s", attrs: { _status: "runtime" }, runtimeOwner: owner },
    ],
    edges: [],
    groups: {},
  });

  it("re-points each runtime child at its owner's composed id, so the containment box holds both", async () => {
    // A fresh IR per call — chant hands each project its own graph, and the
    // remap mutates what it is given.
    vi.mocked(graphIr).mockImplementation(async () => owned("kustomization") as never);

    const est = await composeEstateOverlay(["/work/control-plane", "/work/app-a"], { env: "local" }, (ir) => ir);
    const child = est.ir.nodes.find((n) => n.id === "control-plane/pod")!;
    expect((child as { runtimeOwner?: string }).runtimeOwner).toBe("control-plane/kustomization");

    // `est.ir` is pinhole's GraphIR; chant's is the same IR with the index
    // signature on `groups` the containment pass reads through (see server.ts).
    const boxed = attachRuntimeContainment(est.ir as ChantGraphIR);
    // Owner AND child inside the box keyed by the owner's composed id (#144).
    expect(boxed.groups.byContainer?.["control-plane/kustomization"]).toEqual([
      "control-plane/kustomization",
      "control-plane/pod",
    ]);
  });

  it("leaves an owner name no node in that project carries alone — a rewrite would only move the lie", async () => {
    vi.mocked(graphIr).mockImplementation(async () => owned("someone-else") as never);
    const est = await composeEstateOverlay(["/work/control-plane"], { env: "local" }, (ir) => ir);
    const child = est.ir.nodes.find((n) => n.id.endsWith("/pod"))!;
    expect((child as { runtimeOwner?: string }).runtimeOwner).toBe("someone-else");
  });
});

// ---------------------------------------------------------------------------
// #221 — the GitOps namespace join. The control plane declares
// `Kustomization.spec.targetNamespace`; the app project declares bare objects
// something stamps at apply time. Composed, the estate knows where the app
// runs; separately, neither project does. These exercise the join against a
// real (miniature) checkout, because two of its gates — the manifests
// directory being on disk, and the member's own chant being new enough for
// `--namespace` — are questions about a filesystem, not about an IR.
// ---------------------------------------------------------------------------

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A miniature of the flux-estate demo on disk: a control plane and an app
 * project under one repo root, the app's `manifests/` really there, and a
 * chant of the given version installed where both members resolve it. */
function fixtureEstate(chantVersion = "0.44.5"): { root: string; controlPlane: string; appB: string } {
  const root = mkdtempSync(join(tmpdir(), "behold-estate-"));
  made.push(root);
  const write = (rel: string, content: string): void => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const chant = "node_modules/@intentius/chant";
  write(
    `${chant}/package.json`,
    JSON.stringify({ name: "@intentius/chant", version: chantVersion, main: "index.js", bin: { chant: "bin/chant" } }),
  );
  write(`${chant}/index.js`, "");
  write(`${chant}/bin/chant`, "#!/usr/bin/env node\n");
  write("example-flux-estate/control-plane/src/flux.ts", "");
  write("example-flux-estate/app-b/src/app.ts", "");
  write("example-flux-estate/app-b/manifests/app.yaml", "");
  return {
    root,
    controlPlane: join(root, "example-flux-estate", "control-plane"),
    appB: join(root, "example-flux-estate", "app-b"),
  };
}

const kustomization = (path: string, targetNamespace: string, id = "appB") => ({
  id,
  kind: "K8s::Flux::Kustomization",
  lexicon: "k8s",
  attrs: {
    metadata: { name: id, namespace: "flux-system" },
    spec: { interval: "1m", path, targetNamespace, sourceRef: { kind: "GitRepository", name: "behold" } },
  },
});

const controlPlaneIr = (...kustomizations: ReturnType<typeof kustomization>[]) => ({
  // A Namespace is cluster-scoped: it declares no namespace of its own and
  // must not, alone, make the control plane look like an app project.
  nodes: [{ id: "nsAppB", kind: "K8s::Core::Namespace", lexicon: "k8s", attrs: { metadata: { name: "app-b" } } }, ...kustomizations],
  edges: [],
  groups: {},
});

const appBIr = (namespace?: string) => {
  const metadata = { name: "app-b", ...(namespace ? { namespace } : {}) };
  return {
    nodes: [
      { id: "deployment", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { metadata } },
      { id: "service", kind: "K8s::Core::Service", lexicon: "k8s", attrs: { metadata } },
    ],
    edges: [],
    groups: {},
  };
};

describe("pathAlignment (#221) — a declared spec.path against a member checkout", () => {
  const { controlPlane, appB } = fixtureEstate();

  it("aligns the path's leading segments with the member's trailing ones, scored by overlap", () => {
    expect(pathAlignment("./example-flux-estate/app-b/manifests", appB)).toBe(2);
  });

  it("refuses a path whose remainder is not a real directory under the member", () => {
    expect(pathAlignment("./example-flux-estate/app-b/behold-does-not-exist", appB)).toBe(0);
  });

  it("refuses a sibling's path, an absolute path and a `..` escape", () => {
    expect(pathAlignment("./example-flux-estate/app-a/manifests", appB)).toBe(0);
    expect(pathAlignment("/example-flux-estate/app-b/manifests", appB)).toBe(0);
    expect(pathAlignment("../example-flux-estate/app-b/manifests", appB)).toBe(0);
  });

  it("refuses a path aimed at a PARENT of the member — anchoring at the member's own tail is what stops a whole-estate Kustomization claiming everything under it", () => {
    expect(pathAlignment("./example-flux-estate", appB)).toBe(0);
  });

  it("does not match a member the path merely sits beside", () => {
    expect(pathAlignment("./example-flux-estate/app-b/manifests", controlPlane)).toBe(0);
  });
});

describe("awaitsNamespaceBinding (#221)", () => {
  it("is true for a project whose namespaced objects all declare nothing", () => {
    expect(awaitsNamespaceBinding(appBIr() as never)).toBe(true);
  });

  it("is false once one object says where it lives — that project already answered", () => {
    expect(awaitsNamespaceBinding(appBIr("app-b") as never)).toBe(false);
  });

  it("is false for a control plane: its Kustomizations name flux-system, and its Namespace is cluster-scoped evidence of nothing", () => {
    expect(awaitsNamespaceBinding(controlPlaneIr(kustomization("./x", "app-b")) as never)).toBe(false);
  });

  it("is false for a project with no k8s objects at all", () => {
    const aws = { nodes: [{ id: "db", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: {} }], edges: [], groups: {} };
    expect(awaitsNamespaceBinding(aws as never)).toBe(false);
  });
});

describe("joinNamespaceBindings (#221)", () => {
  const { controlPlane, appB } = fixtureEstate();

  it("binds the app project to the namespace the OTHER member's Kustomization targets", () => {
    const joins = joinNamespaceBindings([
      { dir: controlPlane, ir: controlPlaneIr(kustomization("./example-flux-estate/app-b/manifests", "app-b")) as never },
      { dir: appB, ir: appBIr() as never },
    ]);
    expect(joins).toEqual([
      { dir: appB, namespace: "app-b", path: "./example-flux-estate/app-b/manifests", declaredBy: controlPlane },
    ]);
  });

  it("leaves a member that declares its own namespace alone", () => {
    const joins = joinNamespaceBindings([
      { dir: controlPlane, ir: controlPlaneIr(kustomization("./example-flux-estate/app-b/manifests", "somewhere-else")) as never },
      { dir: appB, ir: appBIr("app-b") as never },
    ]);
    expect(joins).toEqual([]);
  });

  it("joins nothing when two bindings claim one member for different namespaces — an estate that says two things says nothing", () => {
    const joins = joinNamespaceBindings([
      {
        dir: controlPlane,
        ir: controlPlaneIr(
          kustomization("./example-flux-estate/app-b/manifests", "app-b", "appB"),
          kustomization("./example-flux-estate/app-b/manifests", "app-b-canary", "appBCanary"),
        ) as never,
      },
      { dir: appB, ir: appBIr() as never },
    ]);
    expect(joins).toEqual([]);
  });

  it("joins nothing from a member's own declaration — the split across projects is the premise", () => {
    const own = { ...appBIr(), nodes: [...appBIr().nodes, kustomization("./example-flux-estate/app-b/manifests", "app-b")] };
    expect(joinNamespaceBindings([{ dir: appB, ir: own as never }])).toEqual([]);
  });

  it("joins nothing when a member's source could not be graphed at all", () => {
    const joins = joinNamespaceBindings([
      { dir: controlPlane, ir: undefined },
      { dir: appB, ir: appBIr() as never },
    ]);
    expect(joins).toEqual([]);
  });
});

describe("composeEstateOverlay — threading the joined namespace into the live read (#221)", () => {
  /** One fixture IR per member dir, copied per call: the composition passes
   * mutate what they are given, and each member is graphed twice now. */
  const wire = (source: Record<string, unknown>): void => {
    // These read the recorded calls, so each starts from an empty log.
    vi.mocked(graphIr).mockClear();
    vi.mocked(graphIr).mockImplementation(async (dir: string) => {
      const ir = source[dir];
      if (!ir) throw new Error(`no fixture for ${dir}`);
      return JSON.parse(JSON.stringify(ir)) as never;
    });
  };

  it("reads the app project in the namespace the control plane binds, and reports the join", async () => {
    const { controlPlane, appB } = fixtureEstate();
    wire({
      [controlPlane]: controlPlaneIr(kustomization("./example-flux-estate/app-b/manifests", "app-b")),
      [appB]: appBIr(),
    });

    const est = await composeEstateOverlay([controlPlane, appB], { env: "local" }, (ir) => ir);

    const live = vi.mocked(graphIr).mock.calls.filter(([, o]) => (o as GraphOptions | undefined)?.live);
    expect(live.find(([dir]) => dir === appB)?.[1]).toMatchObject({ live: true, overlay: true, namespace: "app-b" });
    // The control plane's own objects say where they live — nothing to default.
    expect(live.find(([dir]) => dir === controlPlane)?.[1]).not.toHaveProperty("namespace");
    expect(est.joined).toEqual([{ name: "app-b", namespace: "app-b" }]);
  });

  it("sends no --namespace to a member whose own chant predates chant#1629 — an unknown flag is a hard error there, and unobserved is a worse picture than pending", async () => {
    const { controlPlane, appB } = fixtureEstate("0.44.3");
    wire({
      [controlPlane]: controlPlaneIr(kustomization("./example-flux-estate/app-b/manifests", "app-b")),
      [appB]: appBIr(),
    });

    const est = await composeEstateOverlay([controlPlane, appB], { env: "local" }, (ir) => ir);

    for (const [, o] of vi.mocked(graphIr).mock.calls) expect(o as GraphOptions).not.toHaveProperty("namespace");
    expect(est.joined).toEqual([]);
  });

  it("asks for the bindings at detail 3 without touching the cluster — spec is the attributes tier, and reading live to decide where to read live is circular", async () => {
    const { controlPlane, appB } = fixtureEstate();
    wire({
      [controlPlane]: controlPlaneIr(kustomization("./example-flux-estate/app-b/manifests", "app-b")),
      [appB]: appBIr(),
    });

    await composeEstateOverlay([controlPlane, appB], { env: "local", detail: 2 }, (ir) => ir);

    const pre = vi.mocked(graphIr).mock.calls.filter(([, o]) => !(o as GraphOptions | undefined)?.live);
    expect(pre).toHaveLength(2);
    for (const [, o] of pre) {
      expect(o as GraphOptions).toMatchObject({ detail: 3, env: "local" });
      expect(o as GraphOptions).not.toHaveProperty("overlay");
    }
  });
});

describe("withoutJoinedMembers (#221)", () => {
  const nodes = [{ id: "app-b/deployment" }, { id: "app-b/service" }, { id: "app-c/deployment" }];

  it("drops a joined member's slice of the composed IR, so #192's note speaks only for the members the join missed", () => {
    expect(withoutJoinedMembers(nodes, [{ name: "app-b" }]).map((n) => n.id)).toEqual(["app-c/deployment"]);
  });

  it("is the identity when nothing joined", () => {
    expect(withoutJoinedMembers(nodes, []).map((n) => n.id)).toEqual(nodes.map((n) => n.id));
  });
});
