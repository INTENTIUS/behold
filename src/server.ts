/**
 * behold server — the read-only data plane.
 *
 * Serves the SPA and a small read-only API over chant's graph. It NEVER mutates:
 * every route reads (`chant graph`). Writes, when they land, are delegated to
 * chant Ops (ApplyOp/ReconcileOp) on your executor — the server only ever
 * *triggers* them, holding no apply creds. See README "Read-only core".
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { graphIr, runChantRaw, type GraphOptions } from "./chant.ts";
import { renderGraph } from "./render.ts";
import { discoverEstateOps } from "./ops.ts";
import { LIVE_IMPORT_LEXICONS } from "./adopt.ts";
import { detectProject } from "./project.ts";
import { nodeDiff, nodeObserved, type LiveDiffJson } from "./diff.ts";
import { classifyHealth } from "./health.ts";
import { OpRunner } from "./op-runner.ts";
import { pickAutoSyncOp, type AutoSyncMode } from "./autosync.ts";
import { sourceCommits } from "./history.ts";
import { composeEstate } from "./estate.ts";
import { Broadcaster, watchSource } from "./events.ts";
import { startDriftPoll } from "./poll.ts";
import { FrameBuffer } from "./frames.ts";
import { renderLanes } from "./lanes.ts";
import { emulatorUp, emulatorDown, mergedEnv, type EmulatorInfo } from "./emulator.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

export interface ServerOptions {
  /** The chant project directory behold observes. When multiple projects are
   * served (#31), this is the primary — the one ops/overlay/rollback act on. */
  projectDir: string;
  /** All served project dirs (#31 multi-estate). Present with length > 1 only when
   * composing several projects; the source graph then merges them. */
  projectDirs?: string[];
  /** Environment name — enables the live/overlay path. */
  env?: string;
  /** Seconds between live-drift polls (#4). Only with `env`; off when unset. */
  pollSecs?: number;
  /** Auto-sync mode (#29): on a polled drift, trigger the ApplyOp ("apply") or
   * ReconcileOp ("pull-request"). Off by default; needs `env` + `pollSecs`. */
  autoSync?: AutoSyncMode;
  /** Local mode (#46): boot the project's emulator(s) on start and observe them.
   * The creds-free first apply — deploys and overlay hit the emulator. Needs Docker. */
  local?: boolean;
  /** The emulators booted for `local` mode, populated at startup. Drives the header
   * banner (surfaced on /api/ops) so the mode is visible. */
  emulators?: EmulatorInfo[];
  port: number;
}

function optsFromQuery(url: URL): GraphOptions {
  const q = url.searchParams;
  const opts: GraphOptions = {};
  const detail = q.get("detail");
  if (detail !== null) opts.detail = Number(detail);
  const lens = q.get("lens");
  if (lens) opts.lens = lens;
  if (q.get("up") === "1") opts.up = true;
  if (q.get("down") === "1") opts.down = true;
  const env = q.get("env");
  if (env) opts.env = env;
  return opts;
}

/**
 * Query the current estate (the live overlay when `env` is set, else the source
 * graph) and capture a lanes keyframe. Deduped by digest — an unchanged estate
 * stores nothing. Returns the queried IR and whether a new frame was stored, or
 * null on error. Shared by manual Refresh (#24), post-op capture (#25), and the
 * startup/watch/poll captures.
 */
async function captureFrame(
  projectDir: string,
  env: string | undefined,
  frames: FrameBuffer,
  broadcaster: Broadcaster,
): Promise<{ ir: GraphIR; captured: boolean } | null> {
  try {
    const ir = await graphIr(projectDir, env ? { live: true, overlay: true, env } : {});
    const captured = frames.capture(ir) !== null;
    if (captured) broadcaster.emit("frames");
    return { ir, captured };
  } catch (err) {
    process.stderr.write(`frame capture: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

export function createApp(
  cfg: ServerOptions,
  broadcaster: Broadcaster = new Broadcaster(),
  frames: FrameBuffer = new FrameBuffer(),
  runner: OpRunner = new OpRunner({
    projectDir: cfg.projectDir,
    broadcaster,
    onDone: (opEnv) => captureFrame(cfg.projectDir, opEnv ?? cfg.env, frames, broadcaster),
  }),
): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, projectDir: cfg.projectDir, env: cfg.env ?? null, frames: frames.size }));

  // Deployment lanes (#5): the captured keyframes as a per-substrate filmstrip.
  app.get("/api/frames", (c) => c.json({ frames: frames.summaries() }));

  // The lanes page: the graph morphing between keyframes (pinhole #81), a playhead
  // filmstrip below. Needs ≥2 distinct frames — edit the source or wait for a poll.
  app.get("/lanes", (c) => {
    const all = frames.all();
    if (all.length < 2) {
      return c.html(
        `<!doctype html><meta charset=utf-8><body style="font:14px system-ui;background:#0d1117;color:#8b949e;padding:2rem">` +
          `<h3 style="color:#e6edf3">deployment lanes</h3><p>${all.length} frame(s) captured — need at least two to scrub.</p>` +
          `<p>Frames accrue when the estate moves: hit <b style="color:#e6edf3">↻ Refresh</b> (captures the current live state), run a <b style="color:#e6edf3">Sync</b>/Adopt, edit the source, or serve with <code>--poll</code> against a moving environment. Then reload.</p>` +
          `<p><a href="/" style="color:#58a6ff;text-decoration:none">← back to the graph</a></p></body>`,
      );
    }
    return c.html(renderLanes(all, frames.summaries()));
  });

  // Delegated writes (#7 Sync / #8 Adopt): the project's committed Ops, and a
  // trigger. behold NEVER applies — it runs `chant run <op>` on the executor and
  // streams the phases as the now-line. It holds no apply creds.
  // Ops are discovered across every served project (#31): an Op lives in its own
  // project and `chant run` executes it there.
  const estateDirs = cfg.projectDirs ?? [cfg.projectDir];
  const estateOps = () => discoverEstateOps(estateDirs);

  app.get("/api/ops", (c) =>
    c.json({
      ops: estateOps(),
      running: runner.running,
      // The substrates Adopt is offered on — the SPA gates the per-node button on
      // this so the "which lexicons live-import" truth stays server-side.
      adoptLexicons: LIVE_IMPORT_LEXICONS,
      // Auto-sync mode (#29), so the SPA can show the banner.
      autoSync: cfg.autoSync ?? "off",
      // Local mode (#46): the booted emulators, so the SPA shows a "local · up"
      // banner. null when not in --local (or nothing to boot).
      local: cfg.emulators && cfg.emulators.length
        ? { emulators: cfg.emulators.map((e) => ({ lexicon: e.lexicon, name: e.name, endpoint: e.endpoint })) }
        : null,
    }),
  );

  app.post("/api/ops/:name/run", (c) => {
    const name = c.req.param("name");
    const info = estateOps().find((o) => o.name === name);
    if (!info) {
      return c.json({ error: `no Op named "${name}" in the estate` }, 404);
    }
    if (!runner.trigger(name, info.env, info.dir)) {
      return c.json({ error: `an Op is already running (${runner.running})` }, 409);
    }
    return c.json({ started: true, name });
  });

  // Approve a gated apply: signal the Op's wait-for-approval gate, in its own dir.
  app.post("/api/ops/:name/signal/:gate", async (c) => {
    const { name, gate } = c.req.param();
    const info = estateOps().find((o) => o.name === name);
    broadcaster.emit("op", `✎ signal ${name} ${gate}`);
    const { code, stderr } = await runChantRaw(["run", "signal", name, gate], info?.dir ?? cfg.projectDir);
    if (code !== 0) return c.json({ error: stderr.trim() || `signal exited ${code}` }, 500);
    return c.json({ signalled: true });
  });

  // Live updates (#3): SSE stream the SPA subscribes to. On a "changed" event
  // (a source edit — see startServer's watcher) the SPA re-pulls the current view.
  // Keep-alive pings hold the connection open; the browser's EventSource reconnects.
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = broadcaster.subscribe((type, data) => {
        void stream.writeSSE({ event: type, data: data || String(Date.now()) });
      });
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(30_000);
      }
      unsubscribe();
    }),
  );

  // The mixed-substrate source graph — works today (cross-lexicon AttrRefs are
  // direct edges). This is behold's read-only core: the whole estate in one graph.
  // chant provides the IR; pinhole's painter lays it out and renders the SVG. The
  // IR rides along so the SPA can inspect a node (by data-node-id) against its attrs.
  // Autodetect what the project offers, so the SPA can populate pickers (env,
  // detail) instead of the env being a launch-only flag. `currentEnv` is the
  // launch `--env`, the picker's initial selection.
  app.get("/api/project", async (c) => {
    const { environments, lexicons } = await detectProject(cfg.projectDir);
    return c.json({ projectDir: cfg.projectDir, environments, lexicons, currentEnv: cfg.env ?? null });
  });

  app.get("/api/graph", async (c) => {
    try {
      const opts = optsFromQuery(new URL(c.req.url));
      // Multi-estate (#31): graph each project and compose into one IR (namespaced
      // ids, per-project boundary boxes, cross-stack edges). Single project → as-is.
      const multi = cfg.projectDirs && cfg.projectDirs.length > 1;
      const ir = multi ? await composeEstate(cfg.projectDirs!, opts) : await graphIr(cfg.projectDir, opts);
      const { svg } = renderGraph(ir);
      return c.json({
        ir,
        svg,
        meta: {
          projectDir: cfg.projectDir,
          env: cfg.env ?? null,
          ...(multi ? { estate: cfg.projectDirs!.length } : {}),
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Live / overlay — the drift-coloured graph (chant #821, shipped in 0.18.0).
  // `chant graph --live --overlay` defaults to the source-anchored overlay:
  // declared edges (the cross-substrate topology) kept, live status joined per
  // node (managed/foreign/pending). Needs cloud creds + an environment.
  app.get("/api/overlay", async (c) => {
    // Env comes from the picker (`?env=`), falling back to the launch `--env`.
    // Either lets the overlay run without a restart; neither is a 400.
    const query = optsFromQuery(new URL(c.req.url));
    const env = query.env ?? cfg.env;
    if (!env) {
      return c.json({ error: "overlay needs an environment — pick one, or start behold with --env <name>" }, 400);
    }
    try {
      const opts: GraphOptions = { ...query, live: true, overlay: true, env };
      const ir = await graphIr(cfg.projectDir, opts);
      const { svg } = renderGraph(ir);
      return c.json({ ir, svg, meta: { projectDir: cfg.projectDir, env, mode: "overlay" } });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Manual refresh (#24): re-query the current view *now* and capture a lanes
  // frame in the same round-trip — re-checks drift on demand and gives the
  // timeline a datapoint without waiting for a source edit or --poll. Returns the
  // rendered graph so the caller renders from this one query (no double pull); the
  // `frames` event (emitted by captureFrame when the estate moved) updates lanes.
  app.post("/api/refresh", async (c) => {
    const env = optsFromQuery(new URL(c.req.url)).env ?? cfg.env;
    const result = await captureFrame(cfg.projectDir, env, frames, broadcaster);
    if (!result) return c.json({ error: "refresh failed — see server log" }, 500);
    const { svg } = renderGraph(result.ir);
    return c.json({
      ir: result.ir,
      svg,
      meta: { projectDir: cfg.projectDir, env: env ?? null, ...(env ? { mode: "overlay" } : {}) },
      captured: result.captured,
    });
  });

  // Per-node live diff (#27): `chant lifecycle diff <env> --live --json` (chant
  // #852), sliced to one node. Field-level `changes` appear for a resource that
  // drifted since a snapshot; otherwise just its presence category. On demand
  // (a full build + cloud query), so it's a click, not part of the graph pull.
  app.get("/api/diff/:node", async (c) => {
    const node = c.req.param("node");
    const env = optsFromQuery(new URL(c.req.url)).env ?? cfg.env;
    if (!env) return c.json({ error: "diff needs an environment — pick one, or start with --env" }, 400);
    const { code, stdout, stderr } = await runChantRaw(
      ["lifecycle", "diff", env, "--live", "--json"],
      cfg.projectDir,
    );
    if (code !== 0) return c.json({ error: stderr.trim() || `diff exited ${code}` }, 500);
    let parsed: LiveDiffJson;
    try {
      parsed = JSON.parse(stdout) as LiveDiffJson;
    } catch {
      return c.json({ error: "diff output was not JSON — chant may predate --live --json (needs 0.18.7+)" }, 500);
    }
    const observed = nodeObserved(parsed, node);
    // Health (#26): a verdict derived from the observed status — distinct from
    // drift (a node can be managed yet degraded).
    return c.json({ node, env, diff: nodeDiff(parsed, node), observed, health: classifyHealth(observed?.status) });
  });

  // Source history (#28): recent commits, offered as rollback targets.
  app.get("/api/history", async (c) => c.json({ commits: await sourceCommits(cfg.projectDir) }));

  // Rollback (#28): open a PR restoring source to a chosen revision, via chant's
  // delegated `lifecycle rollback` (chant #873). Never a direct cloud write — the
  // PR is reviewed and a gated Sync applies it. Streams like an op; the PR URL
  // surfaces on the `pr` event.
  app.post("/api/rollback", (c) => {
    const to = new URL(c.req.url).searchParams.get("to");
    if (!to) return c.json({ error: "rollback needs ?to=<git-ref>" }, 400);
    const args = ["lifecycle", "rollback", ...(cfg.env ? [cfg.env] : []), "--to", to];
    if (!runner.run(args, `rollback → ${to}`, cfg.env)) {
      return c.json({ error: `busy — ${runner.running} is running` }, 409);
    }
    return c.json({ started: true, to });
  });

  // Static SPA. Served last so /api and /healthz win.
  const rel = relative(process.cwd(), webRoot) || ".";
  app.use("/*", serveStatic({ root: rel }));
  app.get("/", serveStatic({ path: join(rel, "index.html") }));

  return app;
}

export async function startServer(cfg: ServerOptions): Promise<void> {
  // Local mode (#46): boot the project's emulator(s) first, then apply their env
  // to *this* process — every chant shell-out (graph --live, run <op>) inherits it
  // via spawn, so observe and deploy both hit the emulator. Do this before the
  // baseline capture so the first overlay already sees local state.
  if (cfg.local) {
    try {
      const emulators = await emulatorUp(cfg.projectDir);
      cfg.emulators = emulators;
      if (emulators.length === 0) {
        process.stderr.write(
          "behold serve --local: no configured lexicon has a local emulator — serving without one.\n",
        );
      } else {
        Object.assign(process.env, mergedEnv(emulators));
        for (const e of emulators) {
          process.stdout.write(`  local: ${e.lexicon} ${e.name} up on ${e.endpoint}\n`);
        }
      }
    } catch (err) {
      // A viewer must still come up. If the emulator can't boot (Docker down),
      // warn loudly and serve the source graph anyway — the user starts Docker
      // and restarts to get the emulator, rather than facing a dead server.
      cfg.emulators = [];
      process.stderr.write(
        `behold serve --local: ${err instanceof Error ? err.message : String(err)}\n` +
          "  Serving the source graph without the emulator — start Docker and restart to enable local deploys.\n",
      );
    }
  }

  const broadcaster = new Broadcaster();
  const frames = new FrameBuffer();
  // One runner shared by the HTTP routes and the auto-sync loop (one running-guard).
  const runner = new OpRunner({
    projectDir: cfg.projectDir,
    broadcaster,
    onDone: (opEnv) => captureFrame(cfg.projectDir, opEnv ?? cfg.env, frames, broadcaster),
  });
  const app = createApp(cfg, broadcaster, frames, runner);
  const autoSync = cfg.autoSync ?? "off";

  // Capture the current graph as a keyframe (overlay when an env is set, else the
  // source graph). Shares the module helper with Refresh + post-op capture.
  const capture = (): Promise<unknown> => captureFrame(cfg.projectDir, cfg.env, frames, broadcaster);
  // A change to the estate: re-render the live graph (SPA re-pulls) and capture a
  // keyframe for the lanes timeline.
  const onEstateChange = (): void => {
    broadcaster.emit("changed");
    void capture();
  };
  // A polled *drift* (live moved) — re-render, and if auto-sync is on, trigger the
  // configured Op to heal/adopt (#29). Source edits (watchSource) don't auto-sync:
  // a new declaration is new desired state, not drift.
  const onPollDrift = (): void => {
    onEstateChange();
    if (autoSync === "off") return;
    const op = pickAutoSyncOp(autoSync, discoverEstateOps(cfg.projectDirs ?? [cfg.projectDir]), runner.running);
    if (op) {
      broadcaster.emit("op", `⟳ auto-sync (${autoSync}) → ${op.name}`);
      runner.trigger(op.name, op.env, op.dir);
    }
  };

  // Watch the served project's source (the dev loop) and, with an env + --poll,
  // poll live drift (#4) — the latter also drives auto-sync.
  const stopWatch = watchSource(cfg.projectDir, onEstateChange);
  const stopPoll =
    cfg.env && cfg.pollSecs
      ? startDriftPoll({
          intervalMs: cfg.pollSecs * 1000,
          query: () => graphIr(cfg.projectDir, { live: true, overlay: true, env: cfg.env }),
          onChange: onPollDrift,
          onError: (err) => process.stderr.write(`poll: ${err instanceof Error ? err.message : String(err)}\n`),
        })
      : () => {};
  void capture(); // baseline keyframe at startup
  process.on("SIGINT", () => {
    stopWatch();
    stopPoll();
    // Local mode (#46): tear the emulator(s) down so nothing is left running.
    // Best-effort — never block shutdown on a docker error.
    const shutdown = cfg.local && cfg.emulators && cfg.emulators.length
      ? emulatorDown(cfg.projectDir).catch((err) =>
          process.stderr.write(`emulator down: ${err instanceof Error ? err.message : String(err)}\n`))
      : Promise.resolve();
    void shutdown.finally(() => process.exit(0));
  });
  const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    const poll = cfg.env && cfg.pollSecs ? `, polling drift every ${cfg.pollSecs}s` : "";
    const auto = autoSync !== "off" ? `  auto-sync: ${autoSync}` : "";
    const localTag =
      cfg.emulators && cfg.emulators.length
        ? `  local: ${cfg.emulators.map((e) => e.name).join(", ")} up (creds-free — deploys hit the emulator)`
        : "";
    process.stdout.write(
      `behold → http://localhost:${info.port}\n` +
        `  project: ${cfg.projectDir}${cfg.env ? `  env: ${cfg.env}` : ""}${auto}${localTag}\n` +
        `  read-only, watching for edits${poll}. lanes: /lanes. Ctrl-C to stop.\n`,
    );
    // Report what the pickers will offer, so an empty env picker is diagnosable.
    void detectProject(cfg.projectDir).then(({ environments, lexicons }) => {
      const envs = environments.length ? environments.join(", ") : "(none declared — env picker shows only source)";
      process.stdout.write(`  detected: environments [${envs}]  lexicons [${lexicons.join(", ")}]\n`);
    });
  });
  // Fail loudly on a taken port. Otherwise a stale behold squatting on 4600 keeps
  // answering while your new launch silently no-ops — you stare at the OLD project
  // ("No Ops") and blame the new one. Tear down any emulator we just booted.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `behold: port ${cfg.port} is already in use — another behold is probably running there.\n` +
          `  Stop it (\`lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN\` to find it), or pass --port <n>.\n`,
      );
    } else {
      process.stderr.write(`behold: server error: ${err.message}\n`);
    }
    const cleanup = cfg.local && cfg.emulators && cfg.emulators.length
      ? emulatorDown(cfg.projectDir).catch(() => {})
      : Promise.resolve();
    void cleanup.finally(() => process.exit(1));
  });
}
