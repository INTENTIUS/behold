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
import { graphIr, runChantStream, runChantRaw, type GraphOptions } from "./chant.ts";
import { renderGraph } from "./render.ts";
import { discoverOps } from "./ops.ts";
import { LIVE_IMPORT_LEXICONS, extractPrUrl } from "./adopt.ts";
import { detectProject } from "./project.ts";
import { Broadcaster, watchSource } from "./events.ts";
import { startDriftPoll } from "./poll.ts";
import { FrameBuffer } from "./frames.ts";
import { renderLanes } from "./lanes.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

export interface ServerOptions {
  /** The chant project directory behold observes. */
  projectDir: string;
  /** Environment name — enables the live/overlay path. */
  env?: string;
  /** Seconds between live-drift polls (#4). Only with `env`; off when unset. */
  pollSecs?: number;
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

export function createApp(
  cfg: ServerOptions,
  broadcaster: Broadcaster = new Broadcaster(),
  frames: FrameBuffer = new FrameBuffer(),
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
          `<h3 style="color:#e6edf3">deployment lanes</h3><p>${all.length} frame(s) captured — need at least two. ` +
          `Edit the served project's source, or run with <code>--poll</code> against a moving environment, then reload.</p></body>`,
      );
    }
    return c.html(renderLanes(all, frames.summaries()));
  });

  // Delegated writes (#7 Sync / #8 Adopt): the project's committed Ops, and a
  // trigger. behold NEVER applies — it runs `chant run <op>` on the executor and
  // streams the phases as the now-line. It holds no apply creds.
  let running: { name: string; op: ReturnType<typeof runChantStream> } | null = null;
  app.get("/api/ops", (c) =>
    c.json({
      ops: discoverOps(cfg.projectDir),
      running: running?.name ?? null,
      // The substrates Adopt is offered on — the SPA gates the per-node button on
      // this so the "which lexicons live-import" truth stays server-side.
      adoptLexicons: LIVE_IMPORT_LEXICONS,
    }),
  );

  app.post("/api/ops/:name/run", (c) => {
    const name = c.req.param("name");
    if (!discoverOps(cfg.projectDir).some((o) => o.name === name)) {
      return c.json({ error: `no Op named "${name}" in the project` }, 404);
    }
    if (running) return c.json({ error: `an Op is already running (${running.name})` }, 409);
    broadcaster.emit("op", `▶ chant run ${name}`);
    const op = runChantStream(["run", name], cfg.projectDir, (line) => {
      broadcaster.emit("op", line);
      // A ReconcileOp opens a PR and surfaces the URL as an outcome (chant #841);
      // lift it to a `pr` event so the SPA can link the opened PR.
      const pr = extractPrUrl(line);
      if (pr) broadcaster.emit("pr", pr);
    });
    running = { name, op };
    void op.done.then((code) => {
      broadcaster.emit("op", `■ ${name} exited ${code}`);
      broadcaster.emit("changed"); // the estate may have moved — re-pull the graph
      running = null;
    });
    return c.json({ started: true, name });
  });

  // Approve a gated apply: signal the Op's wait-for-approval gate.
  app.post("/api/ops/:name/signal/:gate", async (c) => {
    const { name, gate } = c.req.param();
    broadcaster.emit("op", `✎ signal ${name} ${gate}`);
    const { code, stderr } = await runChantRaw(["run", "signal", name, gate], cfg.projectDir);
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
      const ir = await graphIr(cfg.projectDir, opts);
      const { svg } = renderGraph(ir);
      return c.json({ ir, svg, meta: { projectDir: cfg.projectDir, env: cfg.env ?? null } });
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

  // Static SPA. Served last so /api and /healthz win.
  const rel = relative(process.cwd(), webRoot) || ".";
  app.use("/*", serveStatic({ root: rel }));
  app.get("/", serveStatic({ path: join(rel, "index.html") }));

  return app;
}

export function startServer(cfg: ServerOptions): void {
  const broadcaster = new Broadcaster();
  const frames = new FrameBuffer();
  const app = createApp(cfg, broadcaster, frames);

  // Capture the current graph as a keyframe (overlay when an env is set, else the
  // source graph). Deduped by digest, so only real state changes become frames.
  const captureFrame = async (): Promise<void> => {
    try {
      const ir = await graphIr(cfg.projectDir, cfg.env ? { live: true, overlay: true, env: cfg.env } : {});
      if (frames.capture(ir)) broadcaster.emit("frames");
    } catch (err) {
      process.stderr.write(`frame capture: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
  // A change to the estate: re-render the live graph (SPA re-pulls) and capture a
  // keyframe for the lanes timeline.
  const onEstateChange = (): void => {
    broadcaster.emit("changed");
    void captureFrame();
  };

  // Watch the served project's source (the dev loop) and, with an env + --poll,
  // poll live drift (#4). Both feed onEstateChange.
  const stopWatch = watchSource(cfg.projectDir, onEstateChange);
  const stopPoll =
    cfg.env && cfg.pollSecs
      ? startDriftPoll({
          intervalMs: cfg.pollSecs * 1000,
          query: () => graphIr(cfg.projectDir, { live: true, overlay: true, env: cfg.env }),
          onChange: onEstateChange,
          onError: (err) => process.stderr.write(`poll: ${err instanceof Error ? err.message : String(err)}\n`),
        })
      : () => {};
  void captureFrame(); // baseline keyframe at startup
  process.on("SIGINT", () => {
    stopWatch();
    stopPoll();
    process.exit(0);
  });
  serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    const poll = cfg.env && cfg.pollSecs ? `, polling drift every ${cfg.pollSecs}s` : "";
    process.stdout.write(
      `behold → http://localhost:${info.port}\n` +
        `  project: ${cfg.projectDir}${cfg.env ? `  env: ${cfg.env}` : ""}\n` +
        `  read-only, watching for edits${poll}. lanes: /lanes. Ctrl-C to stop.\n`,
    );
    // Report what the pickers will offer, so an empty env picker is diagnosable.
    void detectProject(cfg.projectDir).then(({ environments, lexicons }) => {
      const envs = environments.length ? environments.join(", ") : "(none declared — env picker shows only source)";
      process.stdout.write(`  detected: environments [${envs}]  lexicons [${lexicons.join(", ")}]\n`);
    });
  });
}
