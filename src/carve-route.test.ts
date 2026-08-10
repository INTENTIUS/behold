import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import type { GraphIR } from "@intentius/chant";

// The HTTP half of #252: carve mode's routes must win /api/graph and
// /api/project from the project-shaped handlers, so the existing SPA renders a
// peelability report with (almost) no client change — it asks for {ir, svg,
// meta} and gets exactly that. src/carve-lens.test.ts covers the conversion
// itself; this proves it reaches a client through the route, SVG included, and
// that a bad report is #193's structured error rather than a blank graph.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "carve-sample-estate.json");

function carveApp(reportPath: string) {
  const broadcaster = new Broadcaster();
  const dir = dirname(reportPath);
  return createApp(
    { projectDir: dir, carveReport: reportPath, port: 0 },
    broadcaster,
    new FrameBuffer(),
    new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }),
  );
}

/** Write `body` to a throwaway file and serve it. */
function servedText(body: string, name = "report.json") {
  const path = join(mkdtempSync(join(tmpdir(), "behold-carve-")), name);
  writeFileSync(path, body);
  return carveApp(path);
}

describe("GET /api/graph — carve mode (#252)", () => {
  it("renders the real sample-estate report: banded nodes, band boxes, an SVG", async () => {
    const res = await carveApp(FIXTURE).request("/api/graph");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ir: GraphIR; svg: string; meta: Record<string, unknown> };

    expect(body.ir.nodes).toHaveLength(8);
    expect(body.ir.nodes.every((n) => n.lexicon === "terraform")).toBe(true);
    // The drift palette's own vocabulary — the SPA colours these everywhere.
    const statuses = new Set(body.ir.nodes.map((n) => n.attrs._status));
    expect([...statuses].sort()).toEqual(["good", "neutral", "warn"]);

    // The bands are actually DRAWN, not merely present in the IR: renderGraph
    // opts into `boxes: "byStack"` here, and pinhole labels each box.
    expect(body.svg).toContain("<svg");
    for (const band of ["carve now", "boundary work", "leave in Terraform"]) {
      expect(body.svg).toContain(band);
    }
    // The score reaches the card (the terraform presentation pack, src/render.ts).
    expect(body.svg).toContain("score");
    expect(body.meta.carve).toBe(true);
    expect(String(body.meta.note)).toContain("chant carve advisory");
  });

  it("ignores the project lenses the SPA sends along — a report has no env/tier/detail", async () => {
    const res = await carveApp(FIXTURE).request("/api/graph?detail=3&components=1&env=prod&radial=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ir: GraphIR; meta: { env: unknown; tier: unknown } };
    expect(body.ir.nodes).toHaveLength(8);
    expect(body.meta.env).toBeNull();
    expect(body.meta.tier).toBeNull();
  });

  it("answers a malformed report with a structured error, not a blank graph (#193)", async () => {
    const app = servedText(JSON.stringify({ hello: "world" }));
    const res = await app.request("/api/graph");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string; remedy: string };
    expect(body.code).toBe("carve-report");
    expect(body.error).toContain("no `resources` array");
    expect(body.remedy).toContain("chant carve advise");
  });

  it("refuses a schema major it doesn't speak", async () => {
    const app = servedText(JSON.stringify({ version: 9, resources: [] }));
    const res = await app.request("/api/graph");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("version 9");
  });
});

describe("GET /api/carve — the raw report, for agents", () => {
  it("serves the report verbatim", async () => {
    const res = await carveApp(FIXTURE).request("/api/carve");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { from: string; count: number; bands: Record<string, number> };
    expect(body.from).toBe("sample-estate");
    expect(body.count).toBe(8);
    expect(body.bands["clean leaf"]).toBe(6);
  });

  it("is listed on /api, so an agent finds it without reading source", async () => {
    const res = await carveApp(FIXTURE).request("/api");
    const body = (await res.json()) as { routes: Array<{ path: string }> };
    expect(body.routes.map((r) => r.path)).toContain("/api/carve");
  });

  it("is absent from /api on an ordinary project serve", async () => {
    const broadcaster = new Broadcaster();
    const app = createApp(
      { projectDir: "/work/loomster", port: 0 },
      broadcaster,
      new FrameBuffer(),
      new OpRunner({ projectDir: "/work/loomster", broadcaster, onDone: () => {} }),
    );
    const body = (await (await app.request("/api")).json()) as { routes: Array<{ path: string }> };
    expect(body.routes.map((r) => r.path)).not.toContain("/api/carve");
  });
});

describe("GET /api/project — carve mode", () => {
  it("offers no live axes and names the report, so every picker stays empty", async () => {
    const res = await carveApp(FIXTURE).request("/api/project");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.environments).toEqual([]);
    expect(body.targets).toEqual([]);
    expect(body.currentEnv).toBeNull();
    expect(body.lexicons).toEqual(["terraform"]);
    expect(body.tiers).toBeUndefined();
    expect(body.stacks).toBeUndefined();
    expect(body.carve).toMatchObject({ from: "sample-estate", count: 8 });
  });
});

describe("carve mode probes nothing and writes nothing", () => {
  it("answers substrates and history empty rather than running Docker and git for a static file", async () => {
    const app = carveApp(FIXTURE);
    expect(await (await app.request("/api/substrates")).json()).toEqual({ substrates: [] });
    expect(await (await app.request("/api/history")).json()).toEqual({ commits: [] });
  });

  it("refuses the hand-layout sidecar (#228) — the report's directory is not a project to write into", async () => {
    const app = carveApp(FIXTURE);
    const read = (await (await app.request("/api/layout")).json()) as { writable: boolean; reason: string };
    expect(read.writable).toBe(false);
    expect(read.reason).toContain("isn't a project");

    const write = await app.request("/api/layout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lens: "resources", deltas: { "aws_vpc.main": { dx: 10, dy: 10 } } }),
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { code: string }).code).toBe("read-only");
  });
});
