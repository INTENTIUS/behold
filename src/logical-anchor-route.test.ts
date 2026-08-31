import { describe, it, expect, vi, beforeEach } from "vitest";

// #328 — every route that runs the logical lens must hand it the SAME derived
// IR. Three passes feed it (src/k8s-edges.ts, src/value-match.ts,
// src/cluster-anchor.ts) and the single-project routes ran only the first two,
// so on those paths the cross-substrate anchors were not in the IR the lens
// received at all — no filtering decision, just an absent input.
//
// What this asserts is the lens's INPUT, not the picture. Anchors mostly do not
// survive as lines by design: a namespace becomes a *box*, and drawing
// `cluster → every object inside it` on top of the boxes is the spoke-star
// src/cluster-anchor.ts's note refuses ("connected but not a picture of
// anything"). So `projectTopology` is spied through to its real implementation
// and the edges it was called with are the subject.
vi.mock("./chant.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chant.ts")>();
  return { ...actual, graphIr: vi.fn() };
});
vi.mock("./logical.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logical.ts")>();
  return { ...actual, projectTopology: vi.fn(actual.projectTopology) };
});
import { graphIr } from "./chant.ts";
import { projectTopology } from "./logical.ts";
import { ANCHOR_VIA } from "./cluster-anchor.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import type { GraphIR } from "@intentius/chant";

/** The mixed estate #103 exists for: a cloud control plane, and a k8s half that
 * declares no reference to it. Split across two source graphs so the same
 * fixture serves the single-project routes (both halves in one) and the estate
 * routes (one half per member) — the anchors are identical either way. */
const PLANE: GraphIR = {
  nodes: [
    { id: "cluster", kind: "AWS::EKS::Cluster", lexicon: "aws", attrs: { Name: "shop", _status: "good" } },
    { id: "shopNs", kind: "K8s::Core::Namespace", lexicon: "k8s", attrs: { metadata: { name: "shop" }, _status: "good" } },
  ] as unknown as GraphIR["nodes"],
  edges: [],
  groups: {},
};
const APPS: GraphIR = {
  nodes: [
    { id: "api", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { metadata: { name: "api", namespace: "shop" }, _status: "good" } },
    { id: "apiSvc", kind: "K8s::Core::Service", lexicon: "k8s", attrs: { metadata: { name: "api", namespace: "shop" }, _status: "good" } },
  ] as unknown as GraphIR["nodes"],
  edges: [],
  groups: {},
};
const merged = (): GraphIR => ({ nodes: [...PLANE.nodes, ...APPS.nodes], edges: [], groups: {} });

const PLANE_DIR = "/work/plane";
const APPS_DIR = "/work/apps";

function serve(dirs: string[]) {
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: dirs[0], broadcaster, onDone: () => {} });
  return createApp(
    { projectDir: dirs[0], ...(dirs.length > 1 ? { projectDirs: dirs } : {}), env: "local", port: 0 },
    broadcaster,
    new FrameBuffer(),
    runner,
  );
}

/** `composeStacks` namespaces every composed id `<member>/<id>`, so an estate's
 * anchors name the same pairs with a prefix. Compared on the bare ids, which is
 * what makes "the same anchor-edge inputs" a comparison and not a coincidence. */
const bare = (id: string) => id.split("/").pop()!;

/** The anchor edges the route handed the lens, from the single call it made. */
function anchorsHandedToLens(): string[] {
  const calls = vi.mocked(projectTopology).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0].edges
    .filter((e) => (e as { viaAttr?: string }).viaAttr === ANCHOR_VIA)
    .map((e) => `${bare(e.from)} → ${bare(e.to)}`)
    .sort();
}

const EXPECTED = ["cluster → shopNs", "shopNs → api", "shopNs → apiSvc"];

describe("the logical lens is handed the cluster anchors on every route that runs it (#328)", () => {
  beforeEach(() => {
    vi.mocked(projectTopology).mockClear();
    vi.mocked(graphIr).mockReset();
    vi.mocked(graphIr).mockImplementation(async (dir: string) =>
      structuredClone(dir === APPS_DIR ? APPS : dir === PLANE_DIR ? PLANE : merged()),
    );
  });

  it("GET /api/graph?logical=1 — the single-project route #328 filed", async () => {
    const res = await serve(["/proj"]).request("/api/graph?logical=1");
    expect(res.status).toBe(200);
    expect(anchorsHandedToLens()).toEqual(EXPECTED);
  });

  it("GET /api/graph?logical=1 on an estate — unchanged, and the reference the other three match", async () => {
    const res = await serve([PLANE_DIR, APPS_DIR]).request("/api/graph?logical=1");
    expect(res.status).toBe(200);
    expect(anchorsHandedToLens()).toEqual(EXPECTED);
  });

  it("GET /api/overlay?logical=1 — the live single-project route", async () => {
    const res = await serve(["/proj"]).request("/api/overlay?env=local&logical=1");
    expect(res.status).toBe(200);
    expect(anchorsHandedToLens()).toEqual(EXPECTED);
  });

  it("GET /api/overlay?logical=1 on an estate — the live composed route", async () => {
    const res = await serve([PLANE_DIR, APPS_DIR]).request("/api/overlay?env=local&logical=1");
    expect(res.status).toBe(200);
    expect(anchorsHandedToLens()).toEqual(EXPECTED);
  });

  // The half the anchors are FOR. With the cluster declared, its node id is the
  // container key (the #142 join), so pinhole draws the card as the outer box —
  // and the anchors read as that nesting rather than as three more lines, which
  // is exactly what src/cluster-anchor.ts's spoke-star note asks for.
  it("states them as nesting, not as lines — no runs-on edge survives into the picture", async () => {
    const res = await serve(["/proj"]).request("/api/graph?logical=1");
    const body = (await res.json()) as { ir: GraphIR; byContainer: Record<string, string[]> };
    expect(body.byContainer["cluster"]).toEqual(["namespace shop"]);
    expect([...(body.byContainer["namespace shop"] ?? [])].sort()).toEqual(["api", "apiSvc"]);
    expect(body.ir.edges.some((e) => (e as { viaAttr?: string }).viaAttr === ANCHOR_VIA)).toBe(false);
  });
});
