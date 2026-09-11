import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "./server.ts";
import { recordRead, recordShared, resetReadStats, type ReadSample, type ReadStats } from "./read-stats.ts";

/** The route's payload: the doctor report, plus #420's ledger and the cache. */
type DoctorBody = {
  dir: string;
  behold: string;
  ok: boolean;
  checks: { name: string; status: string }[];
  reads: Omit<ReadStats, "recent"> & { recent?: ReadSample[] };
  cache: { hits: number; misses: number; entries: number };
};

// #421: the doctor report over HTTP, with #420's read ledger on it. No chant
// spawn — `diagnose` reports what it finds, and what it finds here is a bare
// directory. The point under test is the route and the numbers, not the checks.
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "behold-doctor-route-"));
  made.push(root);
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  write("chant.config.ts", "export default {};\n");
  return root;
}

const app = (dir: string, previewMode = false) =>
  createApp({ projectDir: dir, env: "prod", ...(previewMode ? { previewMode } : {}) } as never);

beforeEach(resetReadStats);

describe("GET /api/doctor (#421)", () => {
  it("serves the diagnosis that until now only the CLI could ask for", async () => {
    const dir = project();
    const res = await app(dir).request("/api/doctor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DoctorBody;
    // The report's own shape, unchanged — this route publishes it, it does not
    // reshape it.
    expect(body).toMatchObject({ dir, behold: expect.any(String), ok: expect.any(Boolean) });
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.every((c) => c.name && c.status)).toBe(true);
  });

  it("carries the read ledger and the member IR cache counters", async () => {
    const dir = project();
    recordRead({ dir: join(dir, "monolith"), what: "graph", live: false, queuedMs: 2, runningMs: 900, outcome: "completed" });
    recordRead({ dir: join(dir, "monolith"), what: "graph --live", live: true, queuedMs: 40, runningMs: 147_000, outcome: "completed" });
    recordShared();

    const body = (await (await app(dir).request("/api/doctor")).json()) as DoctorBody;
    expect(body.reads).toMatchObject({
      runs: 2,
      shared: 1,
      refused: 0,
      source: { runs: 1, queuedMs: 2, runningMs: 900 },
      live: { runs: 1, queuedMs: 40, runningMs: 147_000 },
    });
    expect(body.cache).toEqual({ hits: expect.any(Number), misses: expect.any(Number), entries: expect.any(Number) });
  });

  it("names each member relative to the project, never by absolute path", async () => {
    const dir = project();
    recordRead({ dir: join(dir, "team-a"), what: "graph --live", live: true, queuedMs: 0, runningMs: 10, outcome: "completed" });
    recordRead({ dir, what: "graph", live: false, queuedMs: 0, runningMs: 10, outcome: "completed" });

    const body = (await (await app(dir).request("/api/doctor")).json()) as DoctorBody;
    expect(body.reads.recent!.map((r) => r.dir).sort()).toEqual([".", "team-a"]);
    expect(JSON.stringify(body.reads.recent)).not.toContain(tmpdir());
  });

  it("keeps the totals in preview mode and drops the per-member samples", async () => {
    const dir = project();
    recordRead({ dir: join(dir, "monolith"), what: "graph --live", live: true, queuedMs: 1, runningMs: 500, outcome: "completed" });

    const body = (await (await app(dir, true).request("/api/doctor")).json()) as DoctorBody;
    // "Is this slow" is answerable; "whose filesystem is this" is not.
    expect(body.reads.live).toEqual({ runs: 1, queuedMs: 1, runningMs: 500 });
    expect(body.reads.recent).toBeUndefined();
  });

  it("keeps a deadline and a cancellation apart, as #420 files them", async () => {
    const dir = project();
    // A deadline and a cancellation are different problems and #420 files them
    // apart; the route must not flatten them back together.
    recordRead({ dir, what: "graph --live", live: true, queuedMs: 0, runningMs: 180_000, outcome: "deadline" });
    recordRead({ dir: join(dir, "b"), what: "graph --live", live: true, queuedMs: 0, runningMs: 12, outcome: "cancelled" });

    const body = (await (await app(dir).request("/api/doctor")).json()) as DoctorBody;
    expect(body.reads.byOutcome).toEqual({ completed: 0, failed: 0, cancelled: 1, deadline: 1 });
  });
});
