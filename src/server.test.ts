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
import { shortStackNames } from "@intentius/pinhole";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// #76 (follow-up to #71): the stack picker's options. `/api/project` is where
// the SPA's stack picker gets its names (web/app.js initPickers gates on
// `info.stacks` — mirrors the tier axis block above precisely, per #76's
// design note). A `chant.config.ts` field, unlike tiers' `.behold.json`.
describe("GET /api/project — stack axis sourced from chant.config.ts (#76)", () => {
  let dirs: string[] = [];
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });
  const tmpProjectDir = (chantConfig: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "behold-server-stacks-"));
    if (chantConfig !== null) writeFileSync(join(dir, "chant.config.ts"), chantConfig);
    dirs.push(dir);
    return dir;
  };

  it("no chant.config.ts — no stacks field at all, so the SPA's picker doesn't render", async () => {
    const app = makeAppFor(tmpProjectDir(null));
    const res = await app.request("/api/project");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.stacks).toBeUndefined();
  });

  it("a chant.config.ts with no stacks[] key — same as absent: no stacks field (single-stack/sourceDir project unaffected)", async () => {
    const app = makeAppFor(tmpProjectDir(`export default { lexicons: ["aws"], sourceDir: "infra" };`));
    const res = await app.request("/api/project");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.stacks).toBeUndefined();
  });

  it("a declared stacks[] surfaces just the names, in order — the picker's option list", async () => {
    const dir = tmpProjectDir(
      `export default { lexicons: ["aws"], stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`,
    );
    const app = makeAppFor(dir);
    const res = await app.request("/api/project");
    const body = (await res.json()) as { stacks?: string[] };
    expect(body.stacks).toEqual(["api", "web"]);
  });

  // The committed fixture (e2e/fixtures/multi-stack, #76) end-to-end through
  // the real HTTP route, not just detectProject()/graphPath() in isolation.
  it("the committed e2e/fixtures/multi-stack fixture surfaces both stack names", async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e", "fixtures", "multi-stack");
    const app = makeAppFor(fixture);
    const res = await app.request("/api/project");
    const body = (await res.json()) as { stacks?: string[] };
    expect(body.stacks).toEqual(["api", "web"]);
  });
});

// #76: `?stack=` (optsFromQuery) must reach the ACTUAL spawned `chant graph
// <src>` invocation through the real /api/graph route — the same end-to-end
// shape as chant.test.ts's "graphIr — the stack lens reaches the actual
// chant graph invocation", but exercised through the HTTP layer so the
// route's own opts-threading (not just chant.ts's functions in isolation) is
// covered too.
describe("GET /api/graph — the stack lens (#76) reaches the actual chant graph invocation", () => {
  let dirs: string[] = [];
  // Reset BEFORE each test too, not just after — a prior describe block's
  // last test can leave calls recorded on the shared module-level mock, which
  // would otherwise make `mock.calls[0]` here read a stale call.
  beforeEach(() => vi.mocked(spawnMock).mockReset());
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });
  const tmpProjectDir = (chantConfig: string) => {
    const dir = mkdtempSync(join(tmpdir(), "behold-server-graph-stack-"));
    writeFileSync(join(dir, "chant.config.ts"), chantConfig);
    dirs.push(dir);
    return dir;
  };
  const STACKS_CONFIG =
    `export default { lexicons: ["aws"], ` +
    `stacks: [{ name: "api", src: "stacks/api" }, { name: "web", src: "stacks/web" }] };`;
  // `groups` is required on chant's own `GraphIR` type (render.ts's
  // `renderGraph` reads `ir.groups.byWave`) — an empty object, not an absent
  // field, is the honest "no groups" shape a real `chant graph` would emit.
  const EMPTY_GRAPH_IR = JSON.stringify({ nodes: [], edges: [], groups: {} });

  it("?stack=web shells chant graph against the web stack's src, not the default (first) stack", async () => {
    const dir = tmpProjectDir(STACKS_CONFIG);
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, EMPTY_GRAPH_IR));
    const app = makeAppFor(dir);
    const res = await app.request("/api/graph?stack=web");
    expect(res.status).toBe(200);
    const args = vi.mocked(spawnMock).mock.calls[0]![1] as string[];
    expect(args).toContain(join(dir, "stacks/web"));
  });

  it("no ?stack= defaults to the first declared stack — the picker's default", async () => {
    const dir = tmpProjectDir(STACKS_CONFIG);
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, EMPTY_GRAPH_IR));
    const app = makeAppFor(dir);
    const res = await app.request("/api/graph");
    expect(res.status).toBe(200);
    const args = vi.mocked(spawnMock).mock.calls[0]![1] as string[];
    expect(args).toContain(join(dir, "stacks/api"));
  });

  it("a single-stack/sourceDir project ignores ?stack= entirely — no-regression", async () => {
    const dir = tmpProjectDir(`export default { lexicons: ["aws"], sourceDir: "infra" };`);
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, EMPTY_GRAPH_IR));
    const app = makeAppFor(dir);
    const res = await app.request("/api/graph?stack=nonexistent");
    expect(res.status).toBe(200);
    const args = vi.mocked(spawnMock).mock.calls[0]![1] as string[];
    expect(args).toContain(join(dir, "infra"));
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

// #193: the first-contact dead end. behold pointed at a directory that isn't
// a chant project used to serve a blank graph — chant happily emits an empty
// graph for an empty directory. The base entity route 404s with a structured
// no-project error instead. A chant.config.ts project whose graph is
// legitimately empty keeps its 200 — asserted by the stack-lens tests above,
// whose fixtures all write a chant.config.ts and expect 200 on EMPTY_GRAPH_IR.
describe("GET /api/graph — no-project on an empty graph from a non-project dir (#193)", () => {
  let dirs: string[] = [];
  beforeEach(() => vi.mocked(spawnMock).mockReset());
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });
  const EMPTY_GRAPH_IR = JSON.stringify({ nodes: [], edges: [], groups: {} });
  const tmpBareDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-server-noproject-"));
    dirs.push(dir);
    return dir;
  };

  it("empty graph + no chant.config.ts → 404 {code: no-project} with a `behold demo` remedy", async () => {
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, EMPTY_GRAPH_IR));
    const app = makeAppFor(tmpBareDir());
    const res = await app.request("/api/graph");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: string; remedy: string };
    expect(body.code).toBe("no-project");
    expect(body.error).toMatch(/chant\.config\.ts/);
    expect(body.remedy).toMatch(/behold demo/);
  });

  it("a lens that filters to nothing is NOT a no-project — the lens did that", async () => {
    vi.mocked(spawnMock).mockReturnValue(fakeProc(0, EMPTY_GRAPH_IR));
    const app = makeAppFor(tmpBareDir());
    const res = await app.request("/api/graph?lens=lexicon:aws");
    expect(res.status).toBe(200);
  });
});

// #193: the API's front door for agents — GET /api enumerates the routes so
// nothing has to be discovered by reading source.
describe("GET /api — the route index (#193)", () => {
  it("lists the routes, the version, and the agents guide", async () => {
    const { app } = makeApp(undefined);
    const res = await app.request("/api");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; agentsGuide: string; routes: { path: string }[] };
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.agentsGuide).toMatch(/AGENTS\.md/);
    const paths = body.routes.map((r) => r.path);
    expect(paths).toContain("/api/graph");
    expect(paths).toContain("/api/events");
    expect(paths).toContain("/api/apply");
  });
});

// #228: the hand-layout sidecar — behold's first (and only) write into a
// served project. What may be written, what must be refused, and that a stored
// delta reaches the SVG a `behold export` would capture.
describe("GET/POST /api/layout — the hand-layout sidecar (#228)", () => {
  let dirs: string[] = [];
  beforeEach(() => vi.mocked(spawnMock).mockReset());
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });
  const tmpProject = () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-layout-route-"));
    writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: ["aws"] };`);
    dirs.push(dir);
    return dir;
  };
  const appFor = (cfg: Parameters<typeof createApp>[0]) => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: cfg.projectDir, broadcaster, onDone: () => {} });
    return createApp(cfg, broadcaster, new FrameBuffer(), runner);
  };
  const post = (app: ReturnType<typeof makeAppFor>, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    app.request("/api/layout", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("writes one lens and reads it back — through the file, not memory", async () => {
    const dir = tmpProject();
    const app = appFor({ projectDir: dir, port: 0 });
    const wrote = await post(app, { lens: "components", deltas: { api: { dx: 12, dy: -4 }, ghost: { dx: 0 } } });
    expect(wrote.status).toBe(200);
    expect(await wrote.json()).toMatchObject({ ok: true, lens: "components", count: 1, deltas: { api: { dx: 12, dy: -4 } } });

    // On disk, at the one path behold is allowed to write.
    expect(JSON.parse(readFileSync(join(dir, ".behold", "layout.json"), "utf8"))).toEqual({
      version: 1,
      lenses: { components: { api: { dx: 12, dy: -4 } } },
    });

    // A FRESH app (nothing cached) reads the same thing back.
    const read = await appFor({ projectDir: dir, port: 0 }).request("/api/layout?lens=components");
    expect(await read.json()).toMatchObject({ lens: "components", writable: true, deltas: { api: { dx: 12, dy: -4 } } });
  });

  it("keeps lenses independent, and lists them all with no ?lens=", async () => {
    const app = appFor({ projectDir: tmpProject(), port: 0 });
    await post(app, { lens: "components", deltas: { api: { dx: 1 } } });
    await post(app, { lens: "logical", deltas: { api: { dy: 2 } } });
    const all = (await (await app.request("/api/layout")).json()) as { lenses: Record<string, unknown> };
    expect(all.lenses).toEqual({ components: { api: { dx: 1 } }, logical: { api: { dy: 2 } } });
    expect(((await (await app.request("/api/layout?lens=components")).json()) as { deltas: unknown }).deltas).toEqual({ api: { dx: 1 } });
  });

  it("an empty map is the reset — the lens goes, and with the last lens the file", async () => {
    const dir = tmpProject();
    const app = appFor({ projectDir: dir, port: 0 });
    await post(app, { lens: "components", deltas: { api: { dx: 1 } } });
    const res = await post(app, { lens: "components", deltas: {} });
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, ".behold", "layout.json"))).toBe(false);
  });

  it("touches nothing else in the project", async () => {
    const dir = tmpProject();
    writeFileSync(join(dir, ".behold.json"), JSON.stringify({ tiers: { envVar: "T", values: ["a"] } }));
    const before = readdirSync(dir).sort();
    await post(appFor({ projectDir: dir, port: 0 }), { lens: "components", deltas: { api: { dx: 1 } } });
    expect(readdirSync(dir).sort()).toEqual([...before, ".behold"].sort());
    // …and the config it sits beside is untouched (`.behold.json` is tracked
    // config; `.behold/` is per-user state — two different things, #228).
    expect(JSON.parse(readFileSync(join(dir, ".behold.json"), "utf8"))).toEqual({ tiers: { envVar: "T", values: ["a"] } });
  });

  it("403s in preview mode, and says so — reads still answer", async () => {
    const dir = tmpProject();
    const app = appFor({ projectDir: dir, port: 0, previewMode: true });
    const res = await post(app, { lens: "components", deltas: { api: { dx: 1 } } });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string; code: string }).toMatchObject({ code: "read-only" });
    expect(existsSync(join(dir, ".behold"))).toBe(false);
    const read = (await (await app.request("/api/layout?lens=components")).json()) as { writable: boolean; reason: string };
    expect(read.writable).toBe(false);
    expect(read.reason).toMatch(/preview mode/);
  });

  it("403s during a static-export capture — a snapshot reads the project, never writes it", async () => {
    const dir = tmpProject();
    const app = appFor({ projectDir: dir, port: 0, layoutWrites: false });
    expect((await post(app, { lens: "components", deltas: { api: { dx: 1 } } })).status).toBe(403);
    const read = (await (await app.request("/api/layout?lens=components")).json()) as { writable: boolean; reason: string };
    expect(read.reason).toMatch(/static export/);
  });

  it("403s a project directory that isn't there", async () => {
    const app = appFor({ projectDir: join(tmpdir(), "behold-not-a-dir-228"), port: 0 });
    const res = await post(app, { lens: "components", deltas: { api: { dx: 1 } } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/no such project directory/);
  });

  it("rejects an oversized body before parsing it", async () => {
    const dir = tmpProject();
    const app = appFor({ projectDir: dir, port: 0 });
    const deltas: Record<string, { dx: number }> = {};
    for (let i = 0; i < 5000; i++) deltas[`node-${"x".repeat(40)}-${i}`] = { dx: i };
    const res = await post(app, { lens: "components", deltas });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("too-large");
    expect(existsSync(join(dir, ".behold"))).toBe(false);
  });

  it("400s a body that isn't a layout, and 415s one that isn't JSON at all", async () => {
    const app = appFor({ projectDir: tmpProject(), port: 0 });
    expect((await post(app, "{not json")).status).toBe(400);
    expect((await post(app, { deltas: {} })).status).toBe(400); // no lens
    expect((await post(app, { lens: "///", deltas: {} })).status).toBe(400); // not a lens key
    expect((await post(app, { lens: "components" })).status).toBe(400); // no deltas
    expect((await post(app, { lens: "components", deltas: [1, 2] })).status).toBe(400);
    // A JSON content-type is the CSRF guard (cross-origin JSON POSTs preflight).
    expect((await post(app, { lens: "components", deltas: {} }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await app.request("/api/layout?lens=%2F%2F%2F")).status).toBe(400);
  });

  it("a stored delta lands in the SVG a `behold export` captures (?layout=1)", { timeout: 20_000 }, async () => {
    const dir = tmpProject();
    const app = appFor({ projectDir: dir, port: 0 });
    await post(app, { lens: "components", deltas: { api: { dx: 40, dy: -25 } } });
    const IR = JSON.stringify({
      nodes: [
        { id: "api", kind: "Component", lexicon: "aws", attrs: {} },
        { id: "worker", kind: "Component", lexicon: "aws", attrs: {} },
      ],
      edges: [{ from: "api", to: "worker" }],
      groups: {},
    });
    vi.mocked(spawnMock).mockImplementation((() => fakeProc(0, IR)) as never);

    const plain = (await (await app.request("/api/graph?components=1")).json()) as { svg: string; meta: { layout?: unknown } };
    const baked = (await (await app.request("/api/graph?components=1&layout=1")).json()) as { svg: string; meta: { layout?: { applied: number; lens: string } } };

    // The interactive SPA never asks, and gets dagre's own coordinates.
    expect(plain.meta.layout).toBeUndefined();
    expect(plain.svg).not.toContain("translate(40, -25)");
    // An export asks, and the card carries the delta. (pinhole positions cards
    // by absolute child coordinates, so a real card group usually has no
    // transform of its own for the delta to ride on — both cases are covered
    // in src/layout.test.ts against a fabricated SVG.)
    expect(baked.meta.layout).toEqual({ lens: "components", applied: 1 });
    expect(baked.svg).toContain(`<g data-node-id="api" transform="translate(40, -25)">`);
    expect(baked.svg).toContain(`<g data-node-id="worker">`); // the node that didn't move is untouched
    // …and the edge between them re-anchors: the moved end shifts by the
    // node's own delta, the other stays exactly where pinhole put it.
    const anchors = /<path class="pin-edge-line" d="M ([-\d.]+) ([-\d.]+) L ([-\d.]+) ([-\d.]+)"/.exec(baked.svg);
    const before = /<path class="pin-edge-line" d="M ([-\d.]+) ([-\d.]+)[^"]*?([-\d.]+) ([-\d.]+)"/.exec(plain.svg);
    expect(anchors).not.toBeNull();
    expect(Number(anchors![1]) - Number(before![1])).toBe(40);
    expect(Number(anchors![2]) - Number(before![2])).toBe(-25);
    expect(anchors![3]).toBe(before![3]);
    expect(anchors![4]).toBe(before![4]);

    // A different lens's request is untouched by this lens's deltas.
    const other = (await (await app.request("/api/graph?detail=2&layout=1")).json()) as { meta: { layout?: unknown } };
    expect(other.meta.layout).toBeUndefined();
  });
});

// #195: runtime project switching + reveal-in-file-manager. The switch
// mutates the shared cfg the routes read at request time; recents go through
// BEHOLD_RECENTS_FILE so tests never touch the real ~/.behold/recents.json.
describe("POST /api/project/open + /api/project/reveal (#195)", () => {
  let dirs: string[] = [];
  beforeEach(() => {
    vi.mocked(spawnMock).mockReset();
    const store = mkdtempSync(join(tmpdir(), "behold-recents-store-"));
    dirs.push(store);
    process.env.BEHOLD_RECENTS_FILE = join(store, "recents.json");
  });
  afterEach(() => {
    delete process.env.BEHOLD_RECENTS_FILE;
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });
  const tmpProject = (withConfig: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "behold-server-switch-"));
    if (withConfig) writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: ["aws"] };`);
    dirs.push(dir);
    return dir;
  };
  const jsonPost = (app: ReturnType<typeof makeAppFor>, path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("403s in preview mode — the demo's no-arbitrary-project-switching contract", async () => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {} });
    const app = createApp({ projectDir: "/proj", port: 0, previewMode: true }, broadcaster, new FrameBuffer(), runner);
    const res = await jsonPost(app, "/api/project/open", { dir: tmpProject(true) });
    expect(res.status).toBe(403);
  });

  it("400s a directory that isn't a chant project — same honesty as the no-project graph error", async () => {
    const app = makeAppFor(tmpProject(true));
    const res = await jsonPost(app, "/api/project/open", { dir: tmpProject(false) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/chant\.config\.ts/);
  });

  it("switches in place: /api/project reports the new dir, and the left project lands in recents", async () => {
    const a = tmpProject(true);
    const b = tmpProject(true);
    const app = makeAppFor(a);
    const res = await jsonPost(app, "/api/project/open", { dir: b });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { projectDir: string }).projectDir).toBe(b);
    const info = (await (await app.request("/api/project")).json()) as { projectDir: string; recents: string[] };
    expect(info.projectDir).toBe(b);
    expect(info.recents).toContain(a);
  });

  it("reveal 400s a directory outside the served + recents allowlist — no arbitrary paths from the browser", async () => {
    const app = makeAppFor(tmpProject(true));
    const res = await jsonPost(app, "/api/project/reveal", { dir: "/somewhere/else" });
    expect(res.status).toBe(400);
  });
});

// #188: estate composition (`serve a b …`) skipped every edge-derivation pass
// — the single-project branch's only k8s edge source — so a composed k8s
// estate rendered as a node cloud (146 nodes, 0 edges on the reporting
// estate, fewer edges than serving one project alone). The passes join on
// namespace/name attributes, never node ids, so they run cleanly after
// composeStacks' id prefixing — and a ns/name match spanning two projects
// becomes exactly the cross-stack edge the estate view promises.
describe("GET /api/graph — estate composition runs the edge passes (#188)", () => {
  let dirs: string[] = [];
  beforeEach(() => vi.mocked(spawnMock).mockReset());
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });
  const tmpProj = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `behold-estate-${name}-`));
    writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: ["k8s"] };`);
    dirs.push(dir);
    return dir;
  };
  const k8sNode = (id: string, kind: string, attrs: Record<string, unknown>) => ({ id, kind, lexicon: "k8s", attrs });

  it("a Service in one project joins its workload in another — the cross-stack selector edge", { timeout: 20_000 }, async () => {
    const a = tmpProj("svc");
    const b = tmpProj("dep");
    const IR_A = JSON.stringify({
      nodes: [
        k8sNode("svc", "K8s::Core::Service", {
          metadata: { name: "api", namespace: "app" },
          spec: { selector: { app: "api" } },
        }),
      ],
      edges: [],
      groups: {},
    });
    const IR_B = JSON.stringify({
      nodes: [
        k8sNode("dep", "K8s::Apps::Deployment", {
          metadata: { name: "api", namespace: "app" },
          spec: { template: { metadata: { labels: { app: "api" } } } },
        }),
      ],
      edges: [],
      groups: {},
    });
    // Dispatch on the project path in the spawn args — Promise.all may
    // interleave the two graph calls, so a call-order queue would be flaky.
    vi.mocked(spawnMock).mockImplementation(((_cmd: unknown, args: unknown) =>
      fakeProc(0, String(args).includes(a) ? IR_A : IR_B)) as never);
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: a, broadcaster, onDone: () => {} });
    const app = createApp({ projectDir: a, projectDirs: [a, b], port: 0 }, broadcaster, new FrameBuffer(), runner);
    const res = await app.request("/api/graph");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ir: { edges: { from: string; to: string; viaAttr?: string }[] };
      meta: { estate?: number };
    };
    expect(body.meta.estate).toBe(2);
    const edge = body.ir.edges.find((e) => e.viaAttr === "selector");
    expect(edge).toBeDefined();
    expect(edge!.from.endsWith("/svc")).toBe(true);
    expect(edge!.to.endsWith("/dep")).toBe(true);
  });

  // #190: the multi branch wins the if/else chain, so ?components=1 /
  // ?logical=1 on an estate returned the plain composed entity graph as a
  // silent 200 — no mode, no note. The graph is still the honest fallback;
  // the note now says the lens didn't apply.
  it("?components=1 on an estate notes that the lens didn't apply (#190)", { timeout: 20_000 }, async () => {
    const a = tmpProj("na");
    const b = tmpProj("nb");
    const EMPTY = JSON.stringify({ nodes: [], edges: [], groups: {} });
    vi.mocked(spawnMock).mockImplementation((() => fakeProc(0, EMPTY)) as never);
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: a, broadcaster, onDone: () => {} });
    const app = createApp({ projectDir: a, projectDirs: [a, b], port: 0 }, broadcaster, new FrameBuffer(), runner);
    const res = await app.request("/api/graph?components=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { note?: string; mode?: string } };
    expect(body.meta.mode).toBeUndefined();
    expect(body.meta.note).toMatch(/components lens doesn't apply to a composed estate/);
  });

  // #224 turned that note off for `logical`, which now runs (see the block
  // below); the lens that still genuinely has nothing to run keeps it, and a
  // plain estate request stays note-free.
  it("?logical=1 on an estate no longer claims the lens didn't apply — and a plain estate request stays note-free", { timeout: 20_000 }, async () => {
    const a = tmpProj("la");
    const b = tmpProj("lb");
    const EMPTY = JSON.stringify({ nodes: [], edges: [], groups: {} });
    vi.mocked(spawnMock).mockImplementation((() => fakeProc(0, EMPTY)) as never);
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: a, broadcaster, onDone: () => {} });
    const app = createApp({ projectDir: a, projectDirs: [a, b], port: 0 }, broadcaster, new FrameBuffer(), runner);
    const logical = (await (await app.request("/api/graph?logical=1")).json()) as { meta: { note?: string; mode?: string } };
    expect(logical.meta.mode).toBe("logical");
    expect(logical.meta.note ?? "").not.toMatch(/doesn't apply to a composed estate/);
    const plain = (await (await app.request("/api/graph")).json()) as { meta: { note?: string } };
    expect(plain.meta.note).toBeUndefined();
  });
});

// #224: the composed estate applies the runtime and logical lenses instead of
// apologizing for them. The fixtures are the flux-estate demo's declared shape
// (example-flux-estate): a control plane declaring the app namespaces, the
// GitRepository and one Kustomization per app; app-a's objects carrying
// `metadata.namespace`; app-b's carrying none (Flux's targetNamespace stamps
// it at apply time). The point of the estate is that the namespaces are
// declared in ONE project and filled from the others — no single-project view
// can draw that picture.
describe("estate lenses — the composed IR gets the runtime and logical passes (#224)", () => {
  let dirs: string[] = [];
  beforeEach(() => vi.mocked(spawnMock).mockReset());
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });
  const tmpProj = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `behold-estate-lens-${name}-`));
    writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: ["k8s"] };`);
    dirs.push(dir);
    return dir;
  };
  const node = (id: string, kind: string, attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id,
    kind,
    lexicon: "k8s",
    attrs,
    ...extra,
  });
  const CONTROL_PLANE = {
    nodes: [
      node("nsAppA", "K8s::Core::Namespace", { metadata: { name: "app-a" }, _status: "good" }),
      node("nsAppB", "K8s::Core::Namespace", { metadata: { name: "app-b" }, _status: "good" }),
      node("source", "K8s::Flux::GitRepository", { metadata: { name: "behold", namespace: "flux-system" }, _status: "good" }),
      node("appA", "K8s::Flux::Kustomization", {
        metadata: { name: "app-a", namespace: "flux-system" },
        spec: { targetNamespace: "app-a", sourceRef: { kind: "GitRepository", name: "behold" } },
        _status: "good",
      }),
      node("appB", "K8s::Flux::Kustomization", {
        metadata: { name: "app-b", namespace: "flux-system" },
        spec: { targetNamespace: "app-b", sourceRef: { kind: "GitRepository", name: "behold" }, dependsOn: [{ name: "app-a" }] },
        _status: "good",
      }),
    ],
    edges: [],
    groups: {},
  };
  // What `--live --overlay` adds: a workload Flux applied, attributed back to
  // the Kustomization that declared it (chant#1549's owner chain). Only the
  // live read carries these — the declared graph stops at the source.
  const CONTROL_PLANE_LIVE = {
    ...CONTROL_PLANE,
    nodes: [
      ...CONTROL_PLANE.nodes,
      node("appAPod", "K8s::Core::Pod", { metadata: { name: "app-a-7c9", namespace: "app-a" }, _status: "runtime" }, { runtimeOwner: "appA" }),
    ],
  };
  const APP_A = {
    nodes: [
      node("deployment", "K8s::Apps::Deployment", { metadata: { name: "app-a", namespace: "app-a" }, _status: "good" }),
      node("service", "K8s::Core::Service", { metadata: { name: "app-a", namespace: "app-a" }, _status: "good" }),
    ],
    edges: [],
    groups: {},
  };
  const APP_B = {
    nodes: [
      node("deployment", "K8s::Apps::Deployment", { metadata: { name: "app-b" }, _status: "accent" }),
      node("service", "K8s::Core::Service", { metadata: { name: "app-b" }, _status: "accent" }),
    ],
    edges: [],
    groups: {},
  };
  /** Serve the three demo projects as one estate, dispatching chant's output
   * on the project path in the spawn args (Promise.all interleaves them).
   * Returns the composed per-project id prefixes too — the same
   * `shortStackNames` the route's composition uses. */
  const fluxEstate = () => {
    const cp = tmpProj("cp");
    const a = tmpProj("a");
    const b = tmpProj("b");
    vi.mocked(spawnMock).mockImplementation(((_cmd: unknown, args: unknown) => {
      const s = String(args);
      const ir = s.includes(cp) ? (s.includes("--live") ? CONTROL_PLANE_LIVE : CONTROL_PLANE) : s.includes(a) ? APP_A : APP_B;
      // #261: chant only carries an object's full `spec` (where sourceRef and
      // dependsOn live) at detail 3 — below that there is nothing for
      // addK8sDeclaredEdges to derive from. The fixture above doesn't vary by
      // detail on its own, so mirror chant's real behaviour here: strip
      // `spec` off the control plane's Kustomizations unless the request
      // actually asked for detail 3. Without this, a route test could pass
      // the #261 regression for free, from a fixture that always hands back
      // the rich attrs regardless of what was requested.
      const shaped =
        s.includes(cp) && !s.includes("--detail,3")
          ? { ...ir, nodes: ir.nodes.map((n) => (n.kind === "K8s::Flux::Kustomization" ? { ...n, attrs: { ...n.attrs, spec: undefined } } : n)) }
          : ir;
      return fakeProc(0, JSON.stringify(shaped));
    }) as never);
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: cp, broadcaster, onDone: () => {} });
    const app = createApp({ projectDir: cp, projectDirs: [cp, a, b], env: "local", port: 0 }, broadcaster, new FrameBuffer(), runner);
    const [cpName, aName, bName] = shortStackNames([cp, a, b]);
    return { app, cp: cpName, a: aName, b: bName };
  };
  type LogicalBody = {
    ir: { nodes: { id: string; attrs?: { _status?: string } }[]; edges: { from: string; to: string; viaAttr?: string }[] };
    byContainer: Record<string, string[]>;
    meta: { mode?: string; note?: string; estate?: number };
  };
  const sorted = (ids: string[] | undefined) => [...(ids ?? [])].sort();

  it("the declared estate's logical lens draws cluster ⊃ namespace ⊃ the apps' objects", { timeout: 20_000 }, async () => {
    const est = fluxEstate();
    const body = (await (await est.app.request("/api/graph?logical=1")).json()) as LogicalBody;
    expect(body.meta.mode).toBe("logical");
    expect(body.meta.estate).toBe(3);

    // One cluster box, named from the served env (no managed cluster node is
    // declared on a k8s-only estate — logical-k8s.ts's preference chain).
    const cluster = body.byContainer["cluster local"];
    expect(cluster).toBeDefined();
    expect([...cluster].sort()).toEqual(["cluster-scoped", "namespace app-a", "namespace app-b", "namespace flux-system"]);

    // app-a's objects sit in the namespace the CONTROL PLANE declared — the
    // cross-project containment that only the composed IR can show.
    expect(sorted(body.byContainer["namespace app-a"])).toEqual([`${est.a}/deployment`, `${est.a}/service`].sort());
    // The control plane's own Flux objects live in flux-system.
    expect(sorted(body.byContainer["namespace flux-system"])).toEqual(
      [`${est.cp}/appA`, `${est.cp}/appB`, `${est.cp}/source`].sort(),
    );
    // app-b declares no namespace, so its objects are honestly cluster-scoped
    // here rather than filed under a namespace nothing in the source names.
    expect(sorted(body.byContainer["cluster-scoped"])).toEqual([`${est.b}/deployment`, `${est.b}/service`].sort());
    // Namespaces are boxes, not cards (K8S_PLUMBING_KINDS).
    expect(body.ir.nodes.some((n) => n.id.endsWith("/nsAppA"))).toBe(false);
    // The cross-stack sourceRef edges survive the projection (#171/#188).
    expect(body.ir.edges.some((e) => e.viaAttr === "sourceRef" && e.to.endsWith("/source"))).toBe(true);
  });

  it("the live estate's logical lens keeps each card's drift colour inside its namespace box", { timeout: 20_000 }, async () => {
    const est = fluxEstate();
    const body = (await (await est.app.request("/api/overlay?env=local&logical=1")).json()) as LogicalBody;
    expect(body.meta.mode).toBe("logical");
    expect(body.byContainer["cluster local"]).toContain("namespace app-a");
    expect(sorted(body.byContainer["namespace app-a"])).toEqual([`${est.a}/deployment`, `${est.a}/service`].sort());
    const byStatus = Object.fromEntries(body.ir.nodes.map((n) => [n.id.split("/").pop(), n.attrs?._status]));
    expect(byStatus.appA).toBe("good");
    expect(byStatus.deployment).toBe("accent"); // app-b's, the pending half
    expect(body.meta.note ?? "").not.toMatch(/doesn't apply to a composed estate/);
    // The runtime child is not in a logical view — no ?runtime=1 was asked for.
    expect(body.ir.nodes.some((n) => n.id.endsWith("/appAPod"))).toBe(false);
  });

  it("?runtime=1 on the estate overlay keeps the runtime children and boxes them under their Kustomization", { timeout: 20_000 }, async () => {
    const res = await fluxEstate().app.request("/api/overlay?env=local&runtime=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ir: { nodes: { id: string }[]; edges: { from: string; to: string; viaAttr?: string }[]; groups: { byContainer?: Record<string, string[]> } };
      meta: { mode?: string; note?: string };
    };
    const pod = body.ir.nodes.find((n) => n.id.endsWith("/appAPod"));
    expect(pod).toBeDefined();
    // The containment box is keyed by the owner's COMPOSED id and holds the
    // owner as well as the child (#144, via estate.ts's runtimeOwner remap).
    const owner = body.ir.nodes.find((n) => n.id.endsWith("/appA"))!.id;
    expect(body.ir.groups.byContainer?.[owner]).toEqual([owner, pod!.id].sort());
    expect(body.meta.note ?? "").not.toMatch(/doesn't apply to a composed estate/);
  });

  it("without ?runtime=1 the estate overlay prunes the runtime children, exactly as before", { timeout: 20_000 }, async () => {
    const body = (await (await fluxEstate().app.request("/api/overlay?env=local")).json()) as {
      ir: { nodes: { id: string }[]; groups: { byContainer?: Record<string, string[]> } };
    };
    expect(body.ir.nodes.some((n) => n.id.endsWith("/appAPod"))).toBe(false);
    expect(body.ir.groups.byContainer).toBeUndefined();
  });

  // #261, found by the #256 live e2e: `?runtime=1` on a composed estate used
  // to compose at chant's default detail 2, where `spec` (and so
  // sourceRef/dependsOn) isn't in the IR at all — addK8sDeclaredEdges had
  // nothing to derive the reconcile-ordering edges from, the view rendered
  // edgeless, and edgelessNote then asserted that edgelessness as a fact
  // about the estate ("nothing in this estate references anything else")
  // rather than a detail-tier artifact.
  it("?runtime=1 on the estate overlay carries the sourceRef/dependsOn edges, and drops no note about it (#261)", { timeout: 20_000 }, async () => {
    const body = (await (await fluxEstate().app.request("/api/overlay?env=local&runtime=1")).json()) as {
      ir: { edges: { from: string; to: string; viaAttr?: string }[] };
      meta: { note?: string };
    };
    // The same three edges /api/graph?detail=3 draws (see the issue): appA
    // and appB's sourceRef onto the shared GitRepository, plus appB's
    // dependsOn gating it on appA.
    expect(body.ir.edges.filter((e) => e.viaAttr === "sourceRef")).toHaveLength(2);
    expect(body.ir.edges.some((e) => e.viaAttr === "dependsOn")).toBe(true);
    expect(body.meta.note ?? "").not.toMatch(/no edges/);
  });
});

// #189: the estate-wide overlay — every project observed and composed, with
// per-project failure isolation: a project whose live observe fails degrades
// to its source graph painted unobserved (never dropped silently, never
// blanking the estate), and the note reports coverage.
describe("GET /api/overlay — estate-wide drift (#189)", () => {
  let dirs: string[] = [];
  beforeEach(() => vi.mocked(spawnMock).mockReset());
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    dirs = [];
  });
  const tmpProj = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `behold-estate-ov-${name}-`));
    writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: ["k8s"] };`);
    dirs.push(dir);
    return dir;
  };
  const irOf = (id: string, status?: string) =>
    JSON.stringify({
      nodes: [{ id, kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { metadata: { name: id, namespace: "app" }, ...(status ? { _status: status } : {}) } }],
      edges: [],
      groups: {},
    });
  const estateApp = (a: string, b: string) => {
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: a, broadcaster, onDone: () => {} });
    return createApp({ projectDir: a, projectDirs: [a, b], port: 0 }, broadcaster, new FrameBuffer(), runner);
  };

  it("observes every project and composes the classified results — the estate is coloured N/N", { timeout: 20_000 }, async () => {
    const a = tmpProj("a");
    const b = tmpProj("b");
    vi.mocked(spawnMock).mockImplementation(((_cmd: unknown, args: unknown) => {
      const s = String(args);
      return fakeProc(0, s.includes(a) ? irOf("api", "good") : irOf("worker", "warn"));
    }) as never);
    const res = await estateApp(a, b).request("/api/overlay?env=prod");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ir: { nodes: { id: string; attrs: { _status?: string } }[] };
      meta: { mode: string; estate?: number; note?: string };
    };
    expect(body.meta.mode).toBe("overlay");
    expect(body.meta.estate).toBe(2);
    expect(body.meta.note).toBeUndefined(); // full coverage → nothing to confess
    const byStatus = Object.fromEntries(body.ir.nodes.map((n) => [n.id.split("/").pop(), n.attrs._status]));
    expect(byStatus).toEqual({ api: "good", worker: "warn" });
  });

  it("a project whose live observe fails degrades to source painted unobserved, and the note says so", { timeout: 20_000 }, async () => {
    const a = tmpProj("ok");
    const b = tmpProj("down");
    vi.mocked(spawnMock).mockImplementation(((_cmd: unknown, args: unknown) => {
      const s = String(args);
      if (s.includes(b) && s.includes("--live")) return fakeProc(1, "", "error: cluster unreachable");
      if (s.includes(b)) return fakeProc(0, irOf("worker"));
      return fakeProc(0, irOf("api", "good"));
    }) as never);
    const res = await estateApp(a, b).request("/api/overlay?env=prod");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ir: { nodes: { id: string; attrs: { _status?: string; _unobserved?: string } }[] };
      meta: { note?: string };
    };
    const worker = body.ir.nodes.find((n) => n.id.endsWith("/worker"))!;
    expect(worker.attrs._status).toBe("neutral");
    expect(worker.attrs._unobserved).toMatch(/cluster unreachable/);
    expect(body.meta.note).toMatch(/covered 1 of 2 projects/);
    expect(body.meta.note).toMatch(/painted unobserved/);
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

// #166: the cross-member estate edge, through the routes. The measurement
// found ZERO edges crossing a member boundary in either bundled estate, at
// every detail tier — the Kustomization/Application that declares the
// directory a member holds had nothing joining it to that member's cards.
//
// The estate on disk here is the flux-estate demo's shape under a real root
// (`<tmp>/estate/{control-plane,app-a}`, app-a's `manifests/` really there),
// because the join's whole defence is an on-disk check: the declared path's
// leading segments must match a member's trailing ones AND its remainder must
// exist under that member. The two requests below assert the SAME edge on
// /api/graph and /api/overlay — a live read colours the estate, it does not
// give it a different topology.
describe("the cross-member estate edge on both paths (#166)", () => {
  let root: string | undefined;
  beforeEach(() => vi.mocked(spawnMock).mockReset());
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const CONTROL_PLANE = {
    nodes: [
      {
        id: "appA",
        kind: "K8s::Flux::Kustomization",
        lexicon: "k8s",
        attrs: {
          metadata: { name: "app-a", namespace: "flux-system" },
          spec: { targetNamespace: "app-a", path: "./estate/app-a/manifests", sourceRef: { kind: "GitRepository", name: "behold" } },
          _status: "good",
        },
      },
    ],
    edges: [],
    groups: {},
  };
  const APP_A = {
    nodes: [
      { id: "deployment", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { metadata: { name: "app-a", namespace: "app-a", labels: { app: "app-a" } }, spec: { template: { metadata: { labels: { app: "app-a" } } } }, _status: "good" } },
      { id: "service", kind: "K8s::Core::Service", lexicon: "k8s", attrs: { metadata: { name: "app-a", namespace: "app-a" }, spec: { selector: { app: "app-a" } }, _status: "good" } },
    ],
    edges: [],
    groups: {},
  };

  /** The two members on disk under one root, with app-a's manifests directory
   * actually present — what `pathAlignment` verifies. */
  const estateApp = () => {
    root = mkdtempSync(join(tmpdir(), "behold-166-"));
    const member = (name: string, ...subdirs: string[]) => {
      const dir = join(root!, "estate", name);
      mkdirSync(dir, { recursive: true });
      for (const s of subdirs) mkdirSync(join(dir, s), { recursive: true });
      writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: ["k8s"] };`);
      return dir;
    };
    const cp = member("control-plane");
    const a = member("app-a", "manifests");
    vi.mocked(spawnMock).mockImplementation(((_cmd: unknown, args: unknown) =>
      fakeProc(0, JSON.stringify(String(args).includes(cp) ? CONTROL_PLANE : APP_A))) as never);
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: cp, broadcaster, onDone: () => {} });
    const app = createApp({ projectDir: cp, projectDirs: [cp, a], env: "local", port: 0 }, broadcaster, new FrameBuffer(), runner);
    const [cpName, aName] = shortStackNames([cp, a]);
    return { app, cp: cpName, a: aName };
  };

  type Body = { ir: { edges: { from: string; to: string; viaAttr?: string; inferred?: boolean }[] } };

  it("the source graph draws the Kustomization onto the member it reconciles", { timeout: 20_000 }, async () => {
    const est = estateApp();
    const body = (await (await est.app.request("/api/graph?detail=3")).json()) as Body;
    expect(body.ir.edges).toContainEqual(
      expect.objectContaining({ from: `${est.cp}/appA`, to: `${est.a}/service`, viaAttr: "reconciles", inferred: true }),
    );
    // Landing on the member's ENTRY node only: the Deployment is already the
    // Service's selector target, so the boundary is crossed once.
    expect(body.ir.edges.filter((e) => e.viaAttr === "reconciles")).toHaveLength(1);
  });

  it("the live overlay draws exactly the same edge", { timeout: 20_000 }, async () => {
    const est = estateApp();
    const body = (await (await est.app.request("/api/overlay?env=local&detail=3")).json()) as Body;
    expect(body.ir.edges).toContainEqual(
      expect.objectContaining({ from: `${est.cp}/appA`, to: `${est.a}/service`, viaAttr: "reconciles", inferred: true }),
    );
  });
});
