import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnMock } from "node:child_process";

// Route-level guard/409 tests for the delegated-write routes (M3 #54's
// /api/apply, alongside the pre-existing /api/rollback) — mock the chant
// shell-out the same way op-runner.test.ts does, so the real OpRunner
// running-guard is exercised end-to-end through the HTTP layer without a
// real chant binary or project on disk.
let resolveDone: (code: number) => void;
const streamMock = vi.fn(() => ({
  pid: 1,
  kill: vi.fn(),
  done: new Promise<number>((res) => {
    resolveDone = res;
  }),
}));
vi.mock("./chant.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chant.ts")>();
  return { ...actual, runChantStream: () => streamMock() };
});

// #72: the precondition-error tests below mock the chant shell-out one layer
// deeper — `node:child_process`'s `spawn` — the same way chant.test.ts does,
// so `graphIr`/`runChantJson` run for REAL and produce a REAL `ChantCliError`
// from a REAL (fake) chant exit, rather than a route's dependency being
// swapped for a function that hands back a bare `Promise.reject(...)`. A
// directly-injected rejected promise is honest about the *shape* chant.ts
// throws but not about *how* — the real code always rejects via an event-
// emitter `close` callback a tick later, and Node's unhandled-rejection
// tracking (surfaced through Hono's own internal promise chaining in
// `app.request`) can flag an eagerly-constructed `Promise.reject` before the
// route's `try { await graphIr(...) } catch` attaches its handler, even
// though it always does moments later.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

/** A minimal fake ChildProcess: emits `data` on stdout/stderr, then `close`,
 * on the next microtask — enough for `runChantRaw`'s listeners. Mirrors
 * chant.test.ts's `fakeProc`. */
function fakeProc(code: number, stdout = "", stderr = ""): ReturnType<typeof spawnMock> {
  const proc = new EventEmitter() as unknown as ReturnType<typeof spawnMock>;
  const out = new EventEmitter();
  const err = new EventEmitter();
  Object.assign(proc, { stdout: out, stderr: err });
  // Emit once the consumer attaches its `close` listener — not on a
  // construction-time microtask — so the fake is robust to any async work the
  // caller does before spawning (e.g. graphPath → detectProject, #71).
  let fired = false;
  proc.on("newListener", (event) => {
    if (event !== "close" || fired) return;
    fired = true;
    queueMicrotask(() => {
      if (stdout) out.emit("data", Buffer.from(stdout));
      if (stderr) err.emit("data", Buffer.from(stderr));
      proc.emit("close", code);
    });
  });
  return proc;
}

import { createApp } from "./server.ts";
import { OpRunner } from "./op-runner.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeApp(env?: string) {
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {} });
  const app = createApp({ projectDir: "/proj", env, port: 0 }, broadcaster, new FrameBuffer(), runner);
  return { app, runner };
}

function makeAppFor(projectDir: string) {
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir, broadcaster, onDone: () => {} });
  return createApp({ projectDir, port: 0 }, broadcaster, new FrameBuffer(), runner);
}

describe("POST /api/apply", () => {
  beforeEach(() => streamMock.mockClear());

  it("400s with no environment available — no ?env=, no launch --env", async () => {
    const { app } = makeApp(undefined);
    const res = await app.request("/api/apply", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/environment/);
  });

  it("triggers the delegated write and returns 200 with the target/env it started", async () => {
    const { app } = makeApp("local");
    const res = await app.request("/api/apply?component=shared-foundation", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true, component: "shared-foundation", env: "local" });
  });

  it('defaults component to "all" when unset — the whole-set apply', async () => {
    const { app } = makeApp("local");
    const res = await app.request("/api/apply", { method: "POST" });
    const body = (await res.json()) as { component: string };
    expect(body.component).toBe("all");
  });

  it("?env= overrides the launch --env for this one apply", async () => {
    const { app } = makeApp("local");
    const res = await app.request("/api/apply?env=staging&component=all", { method: "POST" });
    const body = (await res.json()) as { env: string };
    expect(body.env).toBe("staging");
  });

  it("409s a second apply while the first is still running — one delegated write at a time", async () => {
    const { app } = makeApp("local");
    const first = await app.request("/api/apply?component=all", { method: "POST" });
    expect(first.status).toBe(200);

    const second = await app.request("/api/apply?component=loom-db", { method: "POST" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/busy/);
  });

  it("409s /api/rollback while an apply is in flight — the SAME running-guard covers every delegated write", async () => {
    const { app } = makeApp("local");
    await app.request("/api/apply?component=all", { method: "POST" });
    const res = await app.request("/api/rollback?to=abc123", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("409s an apply while a rollback is in flight — guard is shared in both directions", async () => {
    const { app } = makeApp("local");
    await app.request("/api/rollback?to=abc123", { method: "POST" });
    const res = await app.request("/api/apply?component=all", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("frees the guard once the process ends, so a follow-up apply can start", async () => {
    const { app } = makeApp("local");
    await app.request("/api/apply?component=all", { method: "POST" });
    resolveDone(0);
    await Promise.resolve();
    await Promise.resolve();
    const res = await app.request("/api/apply?component=all", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/ops — applyProgress + running surface the write state", () => {
  it("reports applyProgress: idle and running: null before anything has run", async () => {
    const { app } = makeApp("local");
    const res = await app.request("/api/ops");
    const body = (await res.json()) as { running: string | null; applyProgress: { status: string } };
    expect(body.running).toBeNull();
    expect(body.applyProgress).toEqual({ status: "idle", waves: [], components: [] });
  });

  it('reports running: "apply <target>" while an apply is in flight', async () => {
    const { app } = makeApp("local");
    await app.request("/api/apply?component=all", { method: "POST" });
    const res = await app.request("/api/ops");
    const body = (await res.json()) as { running: string | null };
    expect(body.running).toBe("apply all");
  });
});

// #70: tiers come from the served project's own `.behold.json`, not a
// hardcoded loomster convention. `/api/project` is where the SPA's tier
// picker gets its options (web/app.js initPickers gates on `info.tiers &&
// info.tiers.length`) — these assert the two ends of that gate end-to-end.
describe("GET /api/project — tier axis sourced from .behold.json (#70)", () => {
  let dirs: string[] = [];
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });
  const tmpProjectDir = (beholdJson: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "behold-server-project-"));
    if (beholdJson !== null) writeFileSync(join(dir, ".behold.json"), beholdJson);
    dirs.push(dir);
    return dir;
  };

  it("no .behold.json — no tiers field at all, so the SPA's picker doesn't render", async () => {
    const app = makeAppFor(tmpProjectDir(null));
    const res = await app.request("/api/project");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tiers).toBeUndefined();
    expect(body.tier).toBeUndefined();
  });

  it(".behold.json with no tiers key — same as absent: no tiers field", async () => {
    const app = makeAppFor(tmpProjectDir(JSON.stringify({})));
    const res = await app.request("/api/project");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tiers).toBeUndefined();
  });

  it("a declared .behold.json surfaces its values verbatim — the loomster parity shape", async () => {
    const dir = tmpProjectDir(
      JSON.stringify({ tiers: { envVar: "LOOM_TIER", values: ["light", "production", "production-ha"] } }),
    );
    const app = makeAppFor(dir);
    const res = await app.request("/api/project");
    const body = (await res.json()) as { tiers?: string[] };
    expect(body.tiers).toEqual(["light", "production", "production-ha"]);
  });

  it("a project's own envVar name (not LOOM_TIER) works too — never hardcoded", async () => {
    const dir = tmpProjectDir(JSON.stringify({ tiers: { envVar: "DEPLOY_TIER", values: ["small", "big"] } }));
    const app = makeAppFor(dir);
    const res = await app.request("/api/project");
    const body = (await res.json()) as { tiers?: string[] };
    expect(body.tiers).toEqual(["small", "big"]);
  });
});

// #72: a graph/facet route's failure gets a structured {error, code, remedy}
// body instead of an opaque 500 — errorResponse (src/server.ts) classifying
// whatever the chant shell-out (mocked at the `spawn` layer above) reported.
// Exercised through the real HTTP layer, through the real graphIr/
// runChantJson/ChantCliError chain, so the route wiring itself — which error
// routes to which endpoint, and how `?tier=` changes the outcome — is
// covered too, not just errorResponse/tierFailure in isolation.
describe("GET /api/graph — structured precondition errors (#72)", () => {
  beforeEach(() => vi.mocked(spawnMock).mockReset());

  it("classifies chant's lint gate as code: lint, with a remedy pointing at `chant lint`", async () => {
    vi.mocked(spawnMock).mockReturnValue(
      fakeProc(1, "", "error: Refusing to emit graph: source has lint errors. Run `chant lint` and fix them first."),
    );
    const { app } = makeApp(undefined);
    const res = await app.request("/api/graph");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string; remedy: string };
    expect(body.code).toBe("lint");
    expect(body.error).toMatch(/lint errors/);
    expect(body.remedy).toMatch(/chant lint/);
  });

  it("classifies a missing-dependency failure as code: not-installed, with an npm install + typegen remedy", async () => {
    vi.mocked(spawnMock).mockReturnValue(
      fakeProc(1, "", "error: Cannot find package '@intentius/chant-lexicon-aws' imported from x.ts"),
    );
    const { app } = makeApp(undefined);
    const res = await app.request("/api/graph");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string; remedy: string };
    expect(body.code).toBe("not-installed");
    expect(body.remedy).toMatch(/npm install/);
    expect(body.remedy).toMatch(/chant typegen/);
  });

  it("classifies anything else as code: eval — the generic fallback", async () => {
    vi.mocked(spawnMock).mockReturnValue(fakeProc(1, "", "error: something totally unrelated broke"));
    const { app } = makeApp(undefined);
    const res = await app.request("/api/graph");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string; remedy: string };
    expect(body.code).toBe("eval");
    expect(body.error).toMatch(/something totally unrelated broke/);
  });

  it("?tier= reports code: tier instead of the underlying chant classification (M2, #54, generalized)", async () => {
    vi.mocked(spawnMock).mockReturnValue(
      fakeProc(1, "", "error: Refusing to emit graph: source has lint errors. Run `chant lint` and fix them first."),
    );
    const { app } = makeApp(undefined);
    const res = await app.request("/api/graph?tier=production");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string; remedy: string };
    expect(body.code).toBe("tier");
    expect(body.error).toContain('"production"');
    expect(body.remedy).toMatch(/different tier/);
  });

  it("a not-installed failure keeps its own code even under a picked tier — it isn't a tier problem", async () => {
    vi.mocked(spawnMock).mockReturnValue(fakeProc(1, "", "error: Cannot find package 'x' imported from y.ts"));
    const { app } = makeApp(undefined);
    const res = await app.request("/api/graph?tier=production");
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not-installed");
  });
});

// /api/overlay is where a picked tier's creds gate USUALLY surfaces in
// practice — the SPA's load() routes an env pick here, not /api/graph (see
// web/app.js). Same errorResponse under the hood; verify the wiring reaches
// it too, not just /api/graph's.
describe("GET /api/overlay — structured precondition errors (#72)", () => {
  beforeEach(() => vi.mocked(spawnMock).mockReset());

  it("classifies a tier/creds failure the same way as /api/graph", async () => {
    vi.mocked(spawnMock).mockReturnValue(
      fakeProc(1, "", "error: Refusing to emit graph: source has lint errors. Run `chant lint` and fix them first."),
    );
    const { app } = makeApp(undefined);
    const res = await app.request("/api/overlay?env=local&tier=production");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string; remedy: string };
    expect(body.code).toBe("tier");
    expect(body.remedy).toMatch(/different tier/);
  });

  it("still 400s with no environment available, unaffected by the #72 changes", async () => {
    const { app } = makeApp(undefined);
    const res = await app.request("/api/overlay");
    expect(res.status).toBe(400);
  });
});
