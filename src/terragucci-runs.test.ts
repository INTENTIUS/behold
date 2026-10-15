import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { readRun, readRunsIndex, runIdOf, runsIndexProblem, runProblemOf, terragucciRunsRoutes } from "./terragucci-runs.ts";
import { terragucciSource, TerragucciDenied, type TerragucciSource } from "./terragucci-source.ts";

// The fixtures are made from real runs of the demo repo's pipeline (#569):
// 443 a pull request's plan, 444 a merge whose wave 2 waited at the gate,
// 445 the /terragucci apply that resumed it; 447 and 448 are made from 444's
// logs, a wave that failed and a wave applying now.
const FIXTURES = join(import.meta.dirname, "__fixtures__", "terragucci-demo");
const fixtures = () => terragucciSource(FIXTURES);
const doc = (name: string) => JSON.parse(readFileSync(join(FIXTURES, "runs", name), "utf8")) as Record<string, unknown>;

describe("the runs fixtures (#569)", () => {
  it("are the driver's format", () => {
    expect(runsIndexProblem(doc("index.json"))).toBeUndefined();
    for (const id of [443, 444, 445, 447, 448]) expect(runProblemOf(doc(`${id}.json`), id)).toBeUndefined();
  });
  it("carry a wave held at the gate as waiting, never as failure", () => {
    const run = doc("444.json") as { status: string; jobs: { name: string; status: string; steps: { name: string; status: string }[] }[] };
    expect(run.status).toBe("waiting");
    const wave2 = run.jobs.find((j) => j.name === "apply-wave-2")!;
    expect(wave2.status).toBe("waiting");
    expect(wave2.steps.find((s) => s.status === "waiting")!.name).toBe("Apply wave 2 of 3");
  });
});

describe("the runs reads (#569)", () => {
  it("reads the index and a run, and refuses a run that isn't the format", async () => {
    const idx = await readRunsIndex(fixtures());
    expect("doc" in idx && idx.doc && (idx.doc as { runs: unknown[] }).runs.length).toBe(5);
    const one = await readRun(fixtures(), 444);
    expect(one.doc && (one.doc as { id: number }).id).toBe(444);
    expect(runProblemOf({ ...doc("444.json"), id: 1 }, 444)).toMatch(/not 444/);
    expect(runsIndexProblem({ schema: "demo.runs/v1", runs: [{ id: 1, title: "t", status: "exploded", jobs: [] }] })).toMatch(/status/);
    expect(runProblemOf({ ...doc("444.json"), jobs: [{ id: 1, name: "x", needs: [], status: "success", steps: [{ name: "s", status: "success", log: [3] }] }] }, 444)).toMatch(/log/);
  });
  it("says a missing run is absent, and a refused read in the permission's words", async () => {
    const missing = await readRun(fixtures(), 12);
    expect("absent" in missing && missing.absent).toMatch(/runs\/12\.json/);
    const denied: TerragucciSource = { kind: "s3", location: "s3://b/p", read: async () => { throw new TerragucciDenied("runs/index.json", "s3://b/p/runs/index.json", "AccessDenied"); } };
    const r = await readRunsIndex(denied);
    expect("error" in r && r.code).toBe("terragucci-runs");
  });
  it("takes only a positive integer as a run id", () => {
    expect(runIdOf("444")).toBe(444);
    for (const bad of ["0", "-1", "1.5", "x", "../index", "44 4", ""]) expect(runIdOf(bad)).toBe(null);
  });
});

describe("GET /api/terragucci/runs (#569)", () => {
  const app = () => {
    const a = new Hono();
    terragucciRunsRoutes(a, fixtures());
    return a;
  };
  it("answers the index and a run, 404 for a pruned run and 400 for a bad id", async () => {
    const a = app();
    const idx = await a.request("/api/terragucci/runs");
    expect(idx.status).toBe(200);
    expect(idx.headers.get("cache-control")).toBe("no-store");
    expect(((await idx.json()) as { doc: { runs: { id: number }[] } }).doc.runs.map((r) => r.id)).toEqual([448, 447, 445, 444, 443]);
    expect((await a.request("/api/terragucci/runs/443")).status).toBe(200);
    expect((await a.request("/api/terragucci/runs/12")).status).toBe(404);
    expect((await a.request("/api/terragucci/runs/abc")).status).toBe(400);
  });
  it("answers 502 for a runs object that isn't the format", async () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-runs-"));
    mkdirSync(join(dir, "runs"));
    writeFileSync(join(dir, "runs", "index.json"), "{not json");
    const a = new Hono();
    terragucciRunsRoutes(a, terragucciSource(dir));
    const r = await a.request("/api/terragucci/runs");
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toMatch(/not JSON/);
  });
  it("shares one read between kiosks for a moment", async () => {
    let reads = 0;
    const src: TerragucciSource = { kind: "dir", location: "x", read: async (k) => { reads++; return readFileSync(join(FIXTURES, k), "utf8"); } };
    const a = new Hono();
    terragucciRunsRoutes(a, src);
    await Promise.all([a.request("/api/terragucci/runs"), a.request("/api/terragucci/runs"), a.request("/api/terragucci/runs")]);
    expect(reads).toBe(1);
  });
  it("has no route that writes", async () => {
    const a = app();
    for (const m of ["POST", "PUT", "DELETE"]) expect((await a.request("/api/terragucci/runs/444", { method: m })).status).toBe(404);
  });
});
