import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// #230 M3 — the manifest-driven strangler-fig, over the route.
// ---------------------------------------------------------------------------

/** The sample report plus carve manifests, in one throwaway output dir. The
 * applied manifest is the REAL one (src/__fixtures__/carve-manifests, whose
 * provenance src/carve-manifest.test.ts states); `aws_s3_bucket.assets` is an
 * address both it and the sample estate carry, which is what lets the two
 * fixtures compose. The second is written here at the emitted stage, because
 * no real manifest exists for an address this particular report ranks. */
function servedWithManifests(): ReturnType<typeof carveApp> {
  const dir = mkdtempSync(join(tmpdir(), "behold-carve-state-"));
  const report = join(dir, "carve-report.json");
  writeFileSync(report, readFileSync(FIXTURE, "utf8"));
  writeFileSync(
    join(dir, "aws_s3_bucket-assets.carve.json"),
    readFileSync(join(HERE, "__fixtures__", "carve-manifests", "aws_s3_bucket-assets.carve.json"), "utf8"),
  );
  writeFileSync(
    join(dir, "aws_lambda_function-api.carve.json"),
    // A VERSION-2 manifest (chant ≥ 0.54.0, chant#2039): paths relative to its
    // own directory — the shape behold 0.16.0 refused, which read every fresh
    // carve as nothing carved until the live walkthrough caught it.
    JSON.stringify({
      version: 2,
      target: "aws_lambda_function.api",
      from: "/tmp/carve-fixture/legacy-tf",
      boundary: {},
      emit: { source: "tfstate", files: ["src/api.ts"], at: "2026-08-30T04:12:44.246Z" },
    }),
  );
  return carveApp(report);
}

describe("the carve state manifests drive the picture (#230 M3)", () => {
  it("draws a graduated address in its own band, out of the ranking", async () => {
    const body = (await (await servedWithManifests().request("/api/graph")).json()) as {
      ir: GraphIR;
      svg: string;
      meta: Record<string, unknown>;
    };
    const bands = body.ir.groups.byStack as Record<string, string[]>;
    expect(Object.keys(bands)[0]).toBe("carved → chant");
    expect(bands["carved → chant"]).toEqual(["aws_s3_bucket.assets"]);
    expect(bands["carve now"]).not.toContain("aws_s3_bucket.assets");
    const carved = body.ir.nodes.find((n) => n.id === "aws_s3_bucket.assets")!;
    expect(carved.attrs._status).toBe("good");
    expect(carved.attrs.carve).toBe("carved → chant");
    expect(carved.attrs.ownedStack).toBe("assets");
    // Actually drawn, not merely in the IR.
    expect(body.svg).toContain("carved → chant");
  });

  it("leaves a partial carve in its band, repainted with the stage's word", async () => {
    const body = (await (await servedWithManifests().request("/api/graph")).json()) as { ir: GraphIR };
    const bands = body.ir.groups.byStack as Record<string, string[]>;
    const partial = body.ir.nodes.find((n) => n.id === "aws_lambda_function.api")!;
    expect(partial.attrs._status).toBe("accent");
    expect(partial.attrs.carve).toBe("emitted — not bridged");
    expect(Object.values(bands).flat()).toContain("aws_lambda_function.api");
    expect(bands["carved → chant"]).not.toContain("aws_lambda_function.api");
  });

  it("puts the progress read on the statusbar note, saying where the claim comes from", async () => {
    const body = (await (await servedWithManifests().request("/api/graph")).json()) as { meta: { note: string } };
    expect(body.meta.note).toContain("1 of 8 carved");
    expect(body.meta.note).toContain("2 manifests");
    expect(body.meta.note).toContain("1 emitted");
  });

  it("publishes the state on /api/project, with the apply boundary on the wire", async () => {
    const body = (await (await servedWithManifests().request("/api/project")).json()) as {
      carve: {
        state: {
          manifests: number;
          progress: { label: string; applied: number; inFlight: number };
          states: Array<{ target: string; stage: string; graduated: boolean; applyCommand: string }>;
          apply: { human: boolean; note: string };
        };
      };
    };
    const state = body.carve.state;
    expect(state.manifests).toBe(2);
    expect(state.progress).toMatchObject({ label: "1 of 8 carved", applied: 1, inFlight: 1 });
    expect(state.states.map((s) => s.stage)).toEqual(["emitted", "applied"]);
    expect(state.states[0].applyCommand).toContain("chant carve apply");
    expect(state.states[0].applyCommand).not.toContain("--select");
    expect(state.apply.human).toBe(true);
  });

  it("has no apply endpoint — the graduation step is a person, not a POST", async () => {
    const app = servedWithManifests();
    for (const path of ["/api/carve/apply", "/api/carve/graduate"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status, path).toBe(404);
    }
    // …and it isn't advertised either.
    const api = (await (await app.request("/api")).json()) as { routes: Array<{ path: string }> };
    expect(api.routes.some((r) => r.path.includes("apply") && r.path.includes("carve"))).toBe(false);
  });

  it("says nothing about carve state when no manifest exists — the #252 view, unchanged", async () => {
    const body = (await (await carveApp(FIXTURE).request("/api/graph")).json()) as { ir: GraphIR; meta: { note: string } };
    expect(Object.keys(body.ir.groups.byStack as Record<string, string[]>)).not.toContain("carved → chant");
    expect(body.meta.note).not.toContain("Carve state");
    const project = (await (await carveApp(FIXTURE).request("/api/project")).json()) as {
      carve: { state: { manifests: number } };
    };
    expect(project.carve.state.manifests).toBe(0);
  });
});

describe("a real project serve surfaces its carve state without the demo scaffolding (#230 M3)", () => {
  /** A chant project with a carveout inside it, the way `chant carve emit
   * --output ./carveout` leaves one. No report, no demo, no stepper. */
  function carvedProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-carved-project-"));
    writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["aws"] };\n');
    mkdirSync(join(dir, "carveout"), { recursive: true });
    for (const f of ["aws_s3_bucket-assets.carve.json", "aws_iam_role-api.carve.json"]) {
      writeFileSync(join(dir, "carveout", f), readFileSync(join(HERE, "__fixtures__", "carve-manifests", f), "utf8"));
    }
    return dir;
  }

  function projectApp(dir: string) {
    const broadcaster = new Broadcaster();
    return createApp(
      { projectDir: dir, port: 0 },
      broadcaster,
      new FrameBuffer(),
      new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }),
    );
  }

  it("finds the manifests in the project's carveout and publishes what they record", async () => {
    const dir = carvedProject();
    try {
      const body = (await (await projectApp(dir).request("/api/project")).json()) as {
        carve?: { state: { manifests: number; progress: { label: string }; states: Array<{ target: string; stage: string }> } };
      };
      expect(body.carve?.state.manifests).toBe(2);
      // No report, so there is no denominator to invent.
      expect(body.carve?.state.progress.label).toBe("1 carved");
      expect(body.carve?.state.states.map((s) => `${s.target}:${s.stage}`)).toEqual([
        "aws_iam_role.api:emitted",
        "aws_s3_bucket.assets:applied",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits `carve` entirely for a project that was never carved — no dead panel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-uncarved-project-"));
    writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["aws"] };\n');
    try {
      const body = (await (await projectApp(dir).request("/api/project")).json()) as Record<string, unknown>;
      expect("carve" in body).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
