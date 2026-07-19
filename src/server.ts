/**
 * behold server — a read-mostly control plane, delegated writes on top.
 *
 * Most of the API only reads (`chant graph`, `chant lifecycle plan`, …). Writes
 * are never done in-process: behold *triggers* them and streams what the
 * executor reports, holding no apply creds itself — `/api/ops/:name/run` (Sync/
 * Adopt, your committed `*.op.ts` Ops), `/api/rollback` (a `lifecycle rollback`
 * PR), and, since M3 (#54), `/api/apply` (`chant run <target> --components
 * --env <env> --progress-json` — the observe→reconcile→apply dial's write
 * step). All three share one running-guard (src/op-runner.ts's OpRunner) — at
 * most one delegated action in flight at a time. See README "Read-only core,
 * delegated gated writes".
 */
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { GraphIR } from "@intentius/chant";
import {
  graphIr,
  componentGraphIr,
  componentStatus,
  ciPipeline,
  lifecyclePlan,
  runChantRaw,
  type GraphOptions,
} from "./chant.ts";
import { joinComponentStatus, componentStatusColor } from "./component-status.ts";
import { reclassifyOverlay } from "./overlay.ts";
import { resourcesByComponent, nonResourceEntities } from "./resources.ts";
import { summarizePlan } from "./reconcile.ts";
import { renderGraph } from "./render.ts";
import { discoverEstateOps } from "./ops.ts";
import { LIVE_IMPORT_LEXICONS } from "./adopt.ts";
import { detectProject } from "./project.ts";
import { nodeDiff, nodeObserved, type LiveDiffJson } from "./diff.ts";
import { classifyHealth } from "./health.ts";
import { OpRunner } from "./op-runner.ts";
import { detectSubstrates } from "./substrates.ts";
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
  // The tier/target lenses (M2, #54): `?tier=` overrides LOOM_TIER, `?target=`
  // overrides AWS_ENDPOINT_URL for this request's chant shell-outs (see
  // chant.ts `envOverridesFor`) — neither is a chant CLI flag.
  const tier = q.get("tier");
  if (tier) opts.tier = tier;
  const target = q.get("target");
  if (target) opts.target = target;
  return opts;
}

/** Just the tier/target lens overrides out of a parsed `GraphOptions` — for
 * threading into a chant call that wants a DIFFERENT env/live/overlay shape
 * than the query's own (e.g. `/api/resources`, `/api/reconcile`, which force
 * `live`/`overlay` themselves) but should still honour the picked lens. */
function tierTargetOpts(opts: GraphOptions): Pick<GraphOptions, "tier" | "target"> {
  const out: Pick<GraphOptions, "tier" | "target"> = {};
  if (opts.tier) out.tier = opts.tier;
  if (opts.target) out.target = opts.target;
  return out;
}

/** The real deployable component set (`chant graph --components` node ids) for
 * the current lens, so the reconcile / resources correlation can drop
 * non-component `src/` dirs (examples, composites, lib) instead of surfacing
 * them as phantom components. Best-effort: undefined on failure → the
 * correlation stays unfiltered (no worse than before). */
async function knownComponents(projectDir: string, opts: GraphOptions): Promise<Set<string> | undefined> {
  try {
    const ir = await componentGraphIr(projectDir, { env: opts.env, ...tierTargetOpts(opts) });
    return new Set(ir.nodes.map((n) => n.id));
  } catch {
    return undefined;
  }
}

/** A clear, generic note for a graph/facet call that failed while a non-default
 * tier was picked (M2, #54) — e.g. loomster's `full` tier trips chant's lint
 * gate on Floci (needs real-AWS params it doesn't have here). Undefined when
 * no tier was picked, so a plain failure still reads as a plain error.
 * Deliberately substrate-name-free (no "Floci"/"loomster" literal) — behold
 * has zero per-substrate logic; the note explains the SHAPE of the problem
 * (a non-default tier can need parameters this environment lacks), not a
 * specific project's story. */
function tierErrorNote(tier: string | undefined, message: string): string | undefined {
  if (!tier) return undefined;
  return (
    `chant couldn't evaluate the "${tier}" tier here: ${message}\n` +
    `A non-default tier (e.g. a production-only one) can need parameters — real ` +
    `credentials, a different target — this environment doesn't have. Pick a ` +
    `different tier to see its graph.`
  );
}

/** A read route's error response, with a `tierNote` alongside `error` when the
 * failure happened under a picked (non-default) tier — see `tierErrorNote`. */
function errorResponse(c: Context, opts: GraphOptions, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const tierNote = tierErrorNote(opts.tier, message);
  return c.json({ error: message, ...(tierNote ? { tierNote } : {}) }, 500);
}

/** The deploy axes in play (#59 unify, issue scope: "header line showing
 * env=<LOOM_ENV>, tier=<LOOM_TIER>, target=Floci"). `env` is chant's own
 * concept and already surfaces elsewhere (`cfg.env`/`currentEnv`); `tier` and
 * `target` here are read straight from the served project's process
 * environment — loomster's own `LOOM_TIER` convention and the literal
 * `AWS_ENDPOINT_URL` override (Floci's tell), not something behold defines or
 * names itself. Deliberately generic and substrate-name-free (behold has zero
 * per-substrate logic, per the epic): this surfaces the raw endpoint URL, not
 * a hardcoded "Floci" label, and a project with neither var set (real AWS, or
 * a project that isn't loomster) reports neither field rather than guessing. */
function deployAxes(): { tier?: string; target?: string } {
  const axes: { tier?: string; target?: string } = {};
  if (process.env.LOOM_TIER) axes.tier = process.env.LOOM_TIER;
  if (process.env.AWS_ENDPOINT_URL) axes.target = process.env.AWS_ENDPOINT_URL;
  return axes;
}

/** M2 (#54): the tier picker's options. chant has no "enumerate valid tier
 * values" concept — `LOOM_TIER` is entirely the served project's own
 * convention (deployAxes() above), not something a graph query or
 * `chant.config.ts` declares the way `environments` does. loomster's valid
 * values are `light`, `production`, `production-ha` (the project this milestone
 * targets); locally only `light` is deployable on Floci — `production`* need
 * real-AWS naming params and degrade gracefully (a `tierNote`). A served project
 * that never sets `LOOM_TIER` just doesn't offer this picker (see `/api/project`,
 * gated on `deployAxes().tier` being set already). */
const TIER_OPTIONS = ["light", "production", "production-ha"];

/** M2 (#54): the target picker's options. Modelled as an array — today there
 * is at most one (the process's own `AWS_ENDPOINT_URL`, Floci locally, unset
 * against real AWS) — so M4's estate (several live targets) is a straight
 * extension of this shape, not a reshape. Empty when the project reports no
 * target at all, same gating as `deployAxes().target`. */
function deployTargets(): Array<{ name: string; endpoint: string }> {
  return process.env.AWS_ENDPOINT_URL ? [{ name: "default", endpoint: process.env.AWS_ENDPOINT_URL }] : [];
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
      // M3 (#54): the last known apply progress model, so a client that opens
      // (or reloads) mid-apply hydrates the structured wave/phase view instead
      // of starting blank — the `apply` SSE event (below) carries every update
      // after that. `status: "idle"` (initialApplyProgress) when nothing has
      // applied yet this session.
      applyProgress: runner.applyProgress,
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

  // Substrate readiness (M5, #54): is each substrate the project needs actually
  // running (Floci, k3d, GitLab CI, Forgejo)? Read-only detection.
  app.get("/api/substrates", async (c) => {
    return c.json({ substrates: await detectSubstrates(cfg.projectDir) });
  });

  // Bring up a substrate — run its local script (e.g. scripts/local/local-up.sh)
  // through the shared running-guard, streaming to the `op` channel; the strip
  // re-detects on the post-run `changed`. behold triggers; the script does it.
  app.post("/api/substrates/:name/up", async (c) => {
    const name = c.req.param("name");
    const sub = (await detectSubstrates(cfg.projectDir)).find((s) => s.name === name);
    if (!sub) return c.json({ error: `unknown substrate "${name}"` }, 404);
    if (!sub.bringUp) return c.json({ error: `no bring-up available for "${name}"` }, 400);
    const { label, cmd, args } = sub.bringUp;
    if (!runner.bringUp(`bring up ${sub.label}`, cmd, args, cfg.projectDir)) {
      return c.json({ error: `busy — ${runner.running} is running` }, 409);
    }
    return c.json({ started: true, name, ran: label });
  });

  // Reset the local emulator (Floci #16 recovery): tear it down + boot it clean,
  // so a subsequent apply lands on an empty emulator (all creates, no fixed-name
  // collisions) instead of re-applying deployed stacks — which the emulator
  // can't do idempotently (github.com/lex00/floci/issues/16). Runs the project's
  // own local-down + local-up through the shared guard; behold triggers, the
  // scripts do the work. Gated on those scripts existing (a local/Floci project).
  app.post("/api/local/reset", (c) => {
    const down = join(cfg.projectDir, "scripts/local/local-down.sh");
    const up = join(cfg.projectDir, "scripts/local/local-up.sh");
    if (!existsSync(down) || !existsSync(up)) {
      return c.json({ error: "no local-down.sh / local-up.sh in scripts/local — reset is only for local emulator projects" }, 400);
    }
    // One guarded op: down then up. `&&` — a failed teardown shouldn't leave a
    // half-booted emulator; the stream shows both scripts' output.
    if (!runner.bringUp("reset local emulator", "bash", ["-c", "bash scripts/local/local-down.sh && bash scripts/local/local-up.sh"], cfg.projectDir)) {
      return c.json({ error: `busy — ${runner.running} is running` }, 409);
    }
    return c.json({ started: true, ran: "local-down + local-up" });
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
    const axes = deployAxes();
    return c.json({
      projectDir: cfg.projectDir,
      environments,
      lexicons,
      currentEnv: cfg.env ?? null,
      // M2 (#54): tier/target lens picker options. Gated the same way `axes`
      // itself is — offered only when the launch env already showed the axis
      // is in play for this project (see TIER_OPTIONS / deployTargets()).
      ...(axes.tier ? { tiers: TIER_OPTIONS } : {}),
      targets: deployTargets(),
      ...axes,
    });
  });

  app.get("/api/graph", async (c) => {
    const url = new URL(c.req.url);
    const opts = optsFromQuery(url);
    try {
      // Component-DAG mode (M1.0, #56): the SPA's mode toggle. `chant graph
      // --components` projects one node per component (dependsOn edges,
      // groups.byWave) instead of the AWS entity graph — a generic chant CLI
      // switch, not loomster-specific. Multi-estate composition doesn't support
      // it yet, so it's ignored there.
      const components = url.searchParams.get("components") === "1";
      // Multi-estate (#31): graph each project and compose into one IR (namespaced
      // ids, per-project boundary boxes, cross-stack edges). Single project → as-is.
      const multi = cfg.projectDirs && cfg.projectDirs.length > 1;
      let ir: GraphIR;
      let mode: "component-status" | undefined;
      let metaEnv = cfg.env ?? null;
      if (multi) {
        ir = await composeEstate(cfg.projectDirs!, opts);
      } else if (components) {
        // The tier/target lenses (M2, #54): `opts.tier`/`opts.target` (from
        // ?tier=/?target=) ride along inside `opts` — componentGraphIr threads
        // them into the chant shell-out's env (chant.ts envOverridesFor), so a
        // picked tier re-evaluates the tier-conditioned source (loomster's
        // components branch on `namingParams.tier`) and a picked target
        // re-points AWS_ENDPOINT_URL. A failure here (e.g. a tier whose source
        // needs params this environment doesn't have) is caught below and
        // turned into a `tierNote`, not a broken view.
        ir = await componentGraphIr(cfg.projectDir, opts);
        // M1.1 (#57), palette hardened M2 (#54): live per-component AWS
        // status, joined by component name onto the component-DAG nodes —
        // the epic's "observe" step. A distinct data path from the entity
        // overlay below (`chant graph --live --overlay`, the source-anchored
        // overlay — chant #821, shipped 0.18.31) — never used for components,
        // by design: the epic keeps this component-level facet single-
        // substrate AWS, distinct from the entity-level overlay. `chant
        // components status <env> --live --json` observes each component's
        // own CFN stack (docs/roadmap/m1-cli-notes.md Q2). Only runs when an
        // env is picked — with no env this stays the M1.0 source-only
        // component DAG.
        const env = opts.env ?? cfg.env;
        if (env) {
          const rows = await componentStatus(cfg.projectDir, env, opts);
          ir = joinComponentStatus(ir, rows);
          mode = "component-status";
          metaEnv = env;
        }
      } else {
        ir = await graphIr(cfg.projectDir, opts);
      }
      // Multi-estate (#31/M4): box each composed project's nodes via `groups.
      // byStack` (pinhole's composeStacks per-project grouping) — see
      // render.ts's doc comment for why this is an explicit opt-in rather than
      // auto-detected the way the component DAG's `byWave` is.
      const { svg } = renderGraph(ir, multi ? { boxes: "byStack" } : {});
      return c.json({
        ir,
        svg,
        meta: {
          projectDir: cfg.projectDir,
          env: metaEnv,
          // The picked tier/target (M2, #54), echoed back so the SPA can keep
          // its header's axes display in sync with what it's actually looking
          // at, not just the launch-time value. null when neither was picked.
          tier: opts.tier ?? null,
          target: opts.target ?? null,
          ...(multi ? { estate: cfg.projectDirs!.length } : {}),
          ...(!multi && components ? { components: true } : {}),
          ...(mode ? { mode } : {}),
        },
      });
    } catch (err) {
      return errorResponse(c, opts, err);
    }
  });

  // CI projection facet (M1.2, #58): loomster's GitLab CI is the SAME
  // component DAG projected — waves = stages, components = jobs, `dependsOn` =
  // `needs:`. Read-only, derived from `chant build --components --generate
  // gitlab`, keyed by component name — the same join key as the component DAG
  // (#56) and live status (#57) — so the SPA hangs it off whichever node the
  // user clicks. The whole pipeline is small (well under the CLI's 64KB
  // pipe-truncation limit), so fetch it once rather than shelling out per node.
  app.get("/api/ci", async (c) => {
    const opts = optsFromQuery(new URL(c.req.url));
    const env = opts.env ?? cfg.env;
    try {
      const { stages, jobs } = await ciPipeline(cfg.projectDir, { ...tierTargetOpts(opts), ...(env ? { env } : {}) });
      return c.json({ stages, jobs });
    } catch (err) {
      return errorResponse(c, opts, err);
    }
  });

  // Resources facet (#59 unify): a best-effort, honest slice of the DoD's
  // "its stack, and its resources" clause — see docs/roadmap/m1-cli-notes.md
  // Q2/Q3 for the fuller writeup of what this does and doesn't cover.
  //
  // What it does NOT do: return the literal CFN stack (name/ARN/status).
  // `chant graph --format ir`'s `groups.byStack` reads like exactly that —
  // its own doc comment calls it "stackName -> nodeIds" — but verified live
  // against loomster/Floci (chant 0.18.28) it groups by *lexicon*
  // (`{ aws: [...], docker: [...] }`), not by CloudFormation stack; chant's
  // own comment marks true per-stack grouping as future work ("a stack is a
  // lexicon partition today; #513 phase 2 regroups by nested child-project").
  // Reconstructing the CFN stack name ourselves from Q2's naming formula
  // (`<ownership.stack>-<env>-<instance>-<component>`) was considered and
  // rejected: componentStatus() deliberately avoids exactly this
  // (src/chant.ts), and shelling `aws cloudformation describe-stack-resources`
  // directly would break "behold has zero per-substrate logic".
  //
  // What it DOES do: the entity graph (source, or `chant graph --live
  // --overlay` — the same call `/api/overlay` already makes — with `env` set)
  // carries each resource's declaring file in `sourceLoc.file` (e.g.
  // "src/loom-agents/agents.ts"). loomster follows a one-directory-per-
  // component convention — the same one `chant.ts`'s `graphPath()` already
  // leans on ("prefer a src/ subdir") — so grouping resources by their
  // top-level `src/<dir>/` segment recovers exactly the per-component
  // resource set, with no AWS shell-out and no stack-name reconstruction.
  // It's a convention match, not a chant-native fact — a project that
  // doesn't lay out one top-level dir per component would get nothing back.
  //
  // UPDATE (M4): the multi-stack `describeResources` gap the paragraph above
  // used to describe is fixed. Earlier the aws lexicon's `describeResources`
  // queried CFN for one stack literally named after the env ("local"), which
  // doesn't exist on loomster's one-stack-per-component layout, so every
  // resource classified `accent` (pending/unmatched) despite being live.
  // chant 0.18.31 fixed this alongside #821 (the same release this facet's
  // `--live --overlay` call now gets the real source-anchored overlay from) —
  // verified against loomster/Floci: `chant graph src --live --overlay --env
  // local --format ir` now returns 132 nodes / 65 edges, most `good`
  // (managed) with real `physicalId` values (e.g. a live IAM role's actual
  // name), not all `accent`. So this facet's `physicalId`/`ownership` fields
  // are live today, not just wired for a future fix.
  app.get("/api/resources", async (c) => {
    const opts = optsFromQuery(new URL(c.req.url));
    const env = opts.env ?? cfg.env;
    try {
      const [ir, known] = await Promise.all([
        graphIr(
          cfg.projectDir,
          env ? { live: true, overlay: true, env, ...tierTargetOpts(opts) } : tierTargetOpts(opts),
        ),
        knownComponents(cfg.projectDir, opts),
      ]);
      return c.json({ byComponent: resourcesByComponent(ir, known) });
    } catch (err) {
      return errorResponse(c, opts, err);
    }
  });

  // Reconcile facet (M2, #54 — the dial's middle step): the pending change set
  // for the selected target, summarized per component. Read-only, and never
  // behold's basis for a mutation — that's chant Ops, M3. `chant lifecycle plan
  // <env> --live --json` is chant's own typed create/update/delete/adopt/noop
  // classification (src/chant.ts `lifecyclePlan`); this route correlates each
  // entry to a component (src/reconcile.ts `summarizePlan`, the same
  // source-location key #59's `/api/resources` uses — src/resources.ts
  // `resourcesByComponent`) and counts. The entity graph fetched for that
  // correlation mirrors `/api/resources`'s own call shape (`live:true,
  // overlay:true`) so both facets see the same source-location map.
  app.get("/api/reconcile", async (c) => {
    const opts = optsFromQuery(new URL(c.req.url));
    const env = opts.env ?? cfg.env;
    if (!env) {
      return c.json({ error: "reconcile needs an environment — pick one, or start behold with --env <name>" }, 400);
    }
    try {
      const [plan, ir, known] = await Promise.all([
        lifecyclePlan(cfg.projectDir, env, opts),
        graphIr(cfg.projectDir, { live: true, overlay: true, env, ...tierTargetOpts(opts) }),
        knownComponents(cfg.projectDir, opts),
      ]);
      return c.json(summarizePlan(plan, resourcesByComponent(ir, known), nonResourceEntities(ir)));
    } catch (err) {
      return errorResponse(c, opts, err);
    }
  });

  // Live / overlay — the drift-coloured graph (chant #821, shipped in chant
  // 0.18.31). `chant graph --live --overlay` defaults to the source-anchored
  // overlay: declared edges (the cross-substrate topology) kept, live status
  // joined per node (managed/foreign/pending). Needs cloud creds + an
  // environment. This is the ENTITY-level live view (one node per resource) —
  // distinct from the M1–M3 component view (`/api/graph?components=1`, one
  // node per component). The SPA's load() routes here whenever an env is
  // picked and components mode is off (web/app.js).
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
      // Reclassify wiring/examples so they don't read as "pending" over a done
      // deploy (see reclassifyOverlay): Parameters take their deployed
      // component's status, src/examples/ nodes go neutral + `_byo`.
      const ir = reclassifyOverlay(await graphIr(cfg.projectDir, opts));
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
    // Same wiring/examples reclassification the /api/overlay view gets, so a
    // manual refresh of the infra graph reads consistently (env → overlay).
    if (env) reclassifyOverlay(result.ir);
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

  // Apply (M3, #54 — the dial's write step): trigger `chant run <component>
  // --components --env <env> --progress-json` under the SAME running-guard as
  // Sync/Adopt/rollback (one delegated write at a time — 409 if something else
  // is running, exactly like /api/rollback above). This is a REAL write —
  // behold was read-only through M2; chant's local executor does the actual
  // deploy, behold only shells the command and streams what it reports.
  // `?component=` is a component name or `all` (defaults to `all`); `?env=`
  // falls back to the launch `--env`. Structured progress streams as `apply`
  // SSE events (src/apply.ts's NDJSON→state reducer, wired in
  // src/op-runner.ts's `apply()`); raw log lines still reach the existing `op`
  // now-line channel as a fallback for anything progress-json doesn't cover.
  app.post("/api/apply", async (c) => {
    const url = new URL(c.req.url);
    const env = url.searchParams.get("env") ?? cfg.env;
    if (!env) {
      return c.json({ error: "apply needs an environment — pick one, or start behold with --env <name>" }, 400);
    }
    const component = url.searchParams.get("component") || "all";
    const force = url.searchParams.get("force") === "1";
    // Guard against re-applying an already-deployed stack. On a local emulator
    // that can't re-apply idempotently (Floci #16), a second apply re-creates
    // fixed-name resources ("... already exists") and rolls the stack back — so
    // a blind "apply all" over a green deploy silently breaks loom-db/frontend.
    // A component with any live stack (good/warn/accent — not "neutral") is
    // already deployed; refuse to (re)apply it and point at Reset, which reboots
    // + redeploys clean. `?force=1` overrides. Best-effort: a status hiccup
    // shouldn't block a legitimate fresh apply, so on error we fall through.
    if (!force) {
      try {
        const rows = await componentStatus(cfg.projectDir, env);
        const deployed = rows.filter((r) => componentStatusColor(r) !== "neutral").map((r) => r.component);
        const blocked = component === "all" ? deployed : deployed.includes(component) ? [component] : [];
        if (blocked.length) {
          const who = component === "all" ? `${blocked.length} component(s) are` : `"${component}" is`;
          return c.json(
            {
              error: `${who} already deployed — re-applying collides on the local emulator (Floci #16, github.com/lex00/floci/issues/16). Use Reset (reboots + redeploys clean), or retry with ?force=1.`,
              blocked,
            },
            409,
          );
        }
      } catch {
        /* couldn't check live status — don't block a legitimate fresh apply */
      }
    }
    if (!runner.apply(component, env)) {
      return c.json({ error: `busy — ${runner.running} is running` }, 409);
    }
    return c.json({ started: true, component, env });
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
  // Clean shutdown on both Ctrl-C (SIGINT) and `kill` (SIGTERM) — otherwise a
  // `kill`ed instance leaves its emulator container running, which the next launch
  // silently reuses (a stale-state trap). Guard against double-fire.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWatch();
    stopPoll();
    // Local mode (#46): tear the emulator(s) down so nothing is left running.
    // Best-effort — never block shutdown on a docker error.
    const done = cfg.local && cfg.emulators && cfg.emulators.length
      ? emulatorDown(cfg.projectDir).catch((err) =>
          process.stderr.write(`emulator down: ${err instanceof Error ? err.message : String(err)}\n`))
      : Promise.resolve();
    void done.finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
      // Deliberately do NOT tear the emulator down here: on a port clash another
      // behold is already serving and likely sharing this same (idempotently
      // reused) emulator — tearing it down would break the running instance.
      process.stderr.write(
        `behold: port ${cfg.port} is already in use — another behold is probably running there.\n` +
          `  Stop it (\`lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN\` to find it), or pass --port <n>.\n`,
      );
    } else {
      process.stderr.write(`behold: server error: ${err.message}\n`);
    }
    process.exit(1);
  });
}
