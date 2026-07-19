import { describe, it, expect, vi, beforeEach } from "vitest";

// M4: adopting chant #821 (the source-anchored overlay, shipped 0.18.31).
// /api/overlay is just `graphIr(dir, {live, overlay, env})` — mock chant.ts's
// graphIr to return the shape chant's `sourceOverlayGraphs` actually produces
// (declared edges kept, `_status` tagged per node: good=managed/warn=foreign/
// accent=pending) and assert the route serves it through unmodified, with a
// real SVG rendered from it. No throwing placeholder in this path — see
// src/overlay.ts, which no longer exports a `sourceAnchoredOverlay` at all.
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

// Shaped like the real loomster response verified on Floci (chant 0.18.31):
// declared edges preserved, a mix of good (managed) and accent (pending)
// nodes, physicalId populated on the live ones (the multi-stack
// describeResources fix that shipped alongside #821).
const OVERLAY_IR: GraphIR = {
  nodes: [
    {
      id: "sharedFoundationRole",
      kind: "AWS::IAM::Role",
      lexicon: "aws",
      attrs: { _status: "good" },
      physicalId: "loom-local-a-shared-foundation-role",
    },
    { id: "loomAgentsQueue", kind: "AWS::SQS::Queue", lexicon: "aws", attrs: { _status: "accent" } },
  ] as unknown as GraphIR["nodes"],
  edges: [{ from: "loomAgentsQueue", to: "sharedFoundationRole", kind: "ref" }],
  groups: {},
};

function makeApp(env?: string) {
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {} });
  const app = createApp({ projectDir: "/proj", env, port: 0 }, broadcaster, new FrameBuffer(), runner);
  return app;
}

describe("GET /api/overlay (M4: chant #821 adoption)", () => {
  beforeEach(() => vi.mocked(graphIr).mockClear());

  it("returns the source-anchored overlay IR with _status-carrying nodes, unmodified by behold", async () => {
    vi.mocked(graphIr).mockResolvedValueOnce(OVERLAY_IR);

    const app = makeApp();
    const res = await app.request("/api/overlay?env=local");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ir: GraphIR; svg: string; meta: { mode: string; env: string } };

    // The declared edge survives the overlay — the whole point of #821 (the
    // source-anchored anchor keeps declared edges as the canvas instead of
    // reconstructing per-substrate islands from live identifiers).
    expect(body.ir.edges).toEqual(OVERLAY_IR.edges);
    // Every node still carries its _status tag, straight from chant.
    const statuses = body.ir.nodes.map((n) => (n.attrs as Record<string, unknown>)._status);
    expect(statuses.sort()).toEqual(["accent", "good"]);
    // Live enrichment (physicalId) rides along untouched.
    expect(body.ir.nodes.find((n) => n.id === "sharedFoundationRole")?.physicalId).toBe(
      "loom-local-a-shared-foundation-role",
    );
    expect(body.meta.mode).toBe("overlay");
    expect(body.meta.env).toBe("local");
    expect(body.svg).toContain("<svg");

    // graphIr was called with live+overlay for the picked env — behold never
    // joins the overlay itself, it just asks chant for it.
    expect(graphIr).toHaveBeenCalledWith("/proj", expect.objectContaining({ live: true, overlay: true, env: "local" }));
  });

  it("400s with no environment available — same guard as before #821 shipped", async () => {
    const app = makeApp();
    const res = await app.request("/api/overlay");
    expect(res.status).toBe(400);
    expect(graphIr).not.toHaveBeenCalled();
  });
});
