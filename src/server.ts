/**
 * behold server — the read-only data plane.
 *
 * Serves the SPA and a small read-only API over chant's graph. It NEVER mutates:
 * every route reads (`chant graph`). Writes, when they land, are delegated to
 * chant Ops (ApplyOp/ReconcileOp) on your executor — the server only ever
 * *triggers* them, holding no apply creds. See README "Read-only core".
 */
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { graphIr, type GraphOptions } from "./chant.ts";
import { renderGraph } from "./render.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

export interface ServerOptions {
  /** The chant project directory behold observes. */
  projectDir: string;
  /** Environment name (for the live/overlay path, once chant #821 lands). */
  env?: string;
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

export function createApp(cfg: ServerOptions): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true, projectDir: cfg.projectDir, env: cfg.env ?? null }));

  // The mixed-substrate source graph — works today (cross-lexicon AttrRefs are
  // direct edges). This is behold's read-only core: the whole estate in one graph.
  // chant provides the IR; pinhole's painter lays it out and renders the SVG. The
  // IR rides along so the SPA can inspect a node (by data-node-id) against its attrs.
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
    if (!cfg.env) {
      return c.json({ error: "overlay needs an environment — start behold with --env <name>" }, 400);
    }
    try {
      const opts: GraphOptions = { ...optsFromQuery(new URL(c.req.url)), live: true, overlay: true, env: cfg.env };
      const ir = await graphIr(cfg.projectDir, opts);
      const { svg } = renderGraph(ir);
      return c.json({ ir, svg, meta: { projectDir: cfg.projectDir, env: cfg.env, mode: "overlay" } });
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
  const app = createApp(cfg);
  serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    process.stdout.write(
      `behold → http://localhost:${info.port}\n` +
        `  project: ${cfg.projectDir}${cfg.env ? `  env: ${cfg.env}` : ""}\n` +
        `  read-only. Ctrl-C to stop.\n`,
    );
  });
}
