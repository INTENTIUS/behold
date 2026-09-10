import { describe, it, expect, vi } from "vitest";

// M4 headline: the estate / app-of-apps view. `serve <dir…>` (cfg.projectDirs,
// length > 1) routes /api/graph through composeEstate (src/estate.ts) instead
// of a single graphIr call. This is the HTTP-level companion to
// src/estate.test.ts (which exercises composeEstate directly): it proves the
// composed, namespaced, boundary-boxed IR actually reaches the client through
// the route, SVG included — not just that composeEstate's pure join works.
vi.mock("./chant.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chant.ts")>();
  return { ...actual, graphIr: vi.fn() };
});
import { graphIr } from "./chant.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import type { GraphIR } from "@intentius/chant";

const loomsterIr: GraphIR = {
  nodes: [{ id: "loomDb", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: {} }],
  edges: [],
  groups: {},
};
const k8sGkeIr: GraphIR = {
  nodes: [{ id: "appDeployment", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} }],
  edges: [],
  groups: {},
};

function makeEstateApp() {
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: "/work/loomster", broadcaster, onDone: () => {} });
  const app = createApp(
    {
      projectDir: "/work/loomster",
      projectDirs: ["/work/loomster", "/work/k8s-gke-microservice"],
      port: 0,
    },
    broadcaster,
    new FrameBuffer(),
    runner,
  );
  return app;
}

describe("GET /api/graph — multi-estate composition (#31/M4)", () => {
  it("composes both projects: namespaced ids, per-project byStack groups, boundary boxes in the SVG", async () => {
    vi.mocked(graphIr).mockResolvedValueOnce(loomsterIr).mockResolvedValueOnce(k8sGkeIr);

    const app = makeEstateApp();
    const res = await app.request("/api/graph");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ir: GraphIR; svg: string; meta: { estate?: number } };

    // Both projects graphed.
    expect(graphIr).toHaveBeenCalledTimes(2);
    // Node ids are namespaced per project (pinhole composeStacks' `<name>/<id>`).
    const ids = body.ir.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["k8s-gke-microservice/appDeployment", "loomster/loomDb"]);
    // Per-project byStack groups — the boundary-box source data.
    const byStack = (body.ir.groups as { byStack?: Record<string, string[]> }).byStack ?? {};
    expect(Object.keys(byStack).sort()).toEqual(["k8s-gke-microservice", "loomster"]);
    // meta.estate reports the composed project count.
    expect(body.meta.estate).toBe(2);
    // The boxes are actually drawn (not just present in the IR): render.ts
    // opts into `boxes: "byStack"` for the multi-estate branch, and pinhole's
    // groupBox() emits a <text> label per box title.
    expect(body.svg).toContain("loomster");
    expect(body.svg).toContain("k8s-gke-microservice");
  });
});

/** A member the size of a real one: 60 edgeless cards under one project. */
const bigIr = (kind: string): GraphIR => ({
  nodes: Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, kind, lexicon: "choudoufu", attrs: { rung: "tag-governable" } })),
  edges: [],
  groups: {},
});

describe("GET /api/graph — the box's counts and the collapse lens (#393 C)", () => {
  it("badges every member box with what it holds", async () => {
    vi.mocked(graphIr).mockResolvedValueOnce(bigIr("aws_iam_role")).mockResolvedValueOnce(k8sGkeIr);
    const res = await makeEstateApp().request("/api/graph");
    const body = (await res.json()) as { svg: string };
    expect(body.svg).toContain("60 resources");
    expect(body.svg).toContain("1 card");
  });

  it("?collapse=1 draws a box over the limit as one summary card, and says so", async () => {
    vi.mocked(graphIr).mockResolvedValueOnce(bigIr("aws_iam_role")).mockResolvedValueOnce(k8sGkeIr);
    const res = await makeEstateApp().request("/api/graph?collapse=1");
    const body = (await res.json()) as { ir: GraphIR; svg: string; meta: { note?: string } };
    // The 60-card member became one card; the 1-card member is untouched.
    expect(body.ir.nodes.map((n) => n.id).sort()).toEqual(["box:loomster", "k8s-gke-microservice/appDeployment"]);
    expect(body.ir.nodes.find((n) => n.id === "box:loomster")!.attrs.summary).toBe("60 resources");
    expect(body.svg).toContain('data-node-id="box:loomster"');
    expect(body.meta.note).toContain("collapsed: loomster");
  });

  it("without the flag nothing collapses, whatever the size", async () => {
    vi.mocked(graphIr).mockResolvedValueOnce(bigIr("aws_iam_role")).mockResolvedValueOnce(k8sGkeIr);
    const res = await makeEstateApp().request("/api/graph");
    const body = (await res.json()) as { ir: GraphIR; meta: { note?: string } };
    expect(body.ir.nodes).toHaveLength(61);
    expect(body.meta.note ?? "").not.toContain("collapsed");
  });
});
