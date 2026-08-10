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
import { Hono, type Context, type Next } from "hono";
import { resolveSubstrateTargets } from "./targets.ts";
import { loadKubeconfig, resolveK8sTarget, type K8sTarget } from "./k8s-target.ts";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { listRecents, addRecent } from "./recents.ts";
import type { GraphIR } from "@intentius/chant";
import {
  graphIr,
  clusterRootGraphIr,
  componentGraphIr,
  componentStatus,
  ciPipeline,
  ciForgeFor,
  type CiForge,
  lifecyclePlan,
  lifecycleDiffLive,
  runChantRaw,
  graphPath,
  ChantCliError,
  classifyChantFailure,
  type GraphOptions,
  type ChantFailure,
} from "./chant.ts";
import { mergeClusterRoot, runningK3dClusters } from "./cluster-root.ts";
import { synthesizeHelmReleases, discoverReleaseUnits } from "./helm-releases.ts";
import { ghReady, pickWorkflow, dispatchAndFollow, joinCiProgress } from "./gh-run.ts";
import { joinComponentStatus, componentStatusColor } from "./component-status.ts";
import { reclassifyOverlay, pruneImports, attachRuntimeContainment, pruneRuntimeChildren } from "./overlay.ts";
import { addValueMatchEdges } from "./value-match.ts";
import { addK8sDeclaredEdges } from "./k8s-edges.ts";
import { applyHelmArtifacts } from "./helm-artifacts.ts";
import { addClusterAnchorEdges } from "./cluster-anchor.ts";
import { projectTopology } from "./logical.ts";
import { addCompositeDepsCounted } from "./composite-deps.ts";
import { notesFor, tierMismatchNote, namespaceMismatchNote, type Zoom } from "./zoom-notes.ts";
import { resourcesByComponent, nonResourceEntities } from "./resources.ts";
import { summarizePlan } from "./reconcile.ts";
import { renderGraph, renderArchitecture, renderBanded } from "./render.ts";
import { readCarveReport, carveReportToIr, carveNote } from "./carve-lens.ts";
import { discoverEstateOps } from "./ops.ts";
import { LIVE_IMPORT_LEXICONS } from "./adopt.ts";
import { detectProject, loadBeholdConfig } from "./project.ts";
import { nodeDiff, nodeObserved, nodeFieldDrift, type LiveDiffJson } from "./diff.ts";
import { classifyObservedHealth } from "./health.ts";
import { OpRunner } from "./op-runner.ts";
import { detectSubstrates, projectLexicons } from "./substrates.ts";
import { pickAutoSyncOps, suspendedByRollback, type AutoSyncMode } from "./autosync.ts";
import { sourceCommits, openRollbackBranches } from "./history.ts";
import { composeEstate, composeEstateOverlay } from "./estate.ts";
import { Broadcaster, watchSource } from "./events.ts";
import { startDriftPoll } from "./poll.ts";
import { FrameBuffer } from "./frames.ts";
import { renderLanes } from "./lanes.ts";
import {
  applyLayoutToSvg,
  layoutPath,
  lensFromQuery,
  normalizeLens,
  readLayoutFile,
  readLens,
  writeLens,
  LayoutTooLarge,
  MAX_BODY_BYTES,
  unwritableReason,
} from "./layout.ts";
import { emulatorUp, emulatorDown, mergedEnv, type EmulatorInfo } from "./emulator.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

/** One captured-stdout exec, for the odd read-only shell-out (git branch). */
const execFileP = async (cmd: string, args: string[]): Promise<string> =>
  (await promisify(execFile)(cmd, args, { encoding: "utf8", timeout: 10_000 })).stdout;

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
  /** Preview mode (v0.1.0): a locked-down Loom-on-Floci demo. Hides + gates the
   * git/PR write ops (rollback, adopt/sync/generic Ops), scopes the substrate
   * strip to Docker+Floci, and tells the SPA to hide those controls. Local
   * deploy (apply/reset/bring-up/approve) and all reads stay on. */
  previewMode?: boolean;
  /** Carve mode (#252, M1 of #230): the path of a `chant carve advise --json`
   * peelability report to render instead of a chant project. Mutually exclusive
   * with everything project-shaped — the report IS the estate here, so no chant
   * is shelled, no source is watched and no live state exists. See
   * `carveRoutes` below. */
  carveReport?: string;
  /** #228: may this server write the hand-layout sidecar (`.behold/layout.json`
   * in the served project)? Default true for a live `serve`. `runExport` sets
   * it false: a static capture reads the sidecar (to bake it into the snapshot
   * SVGs) and must never write one — the bundle it produces has no backend at
   * all. The other two "no" answers are computed, not configured: preview mode,
   * and a project directory that isn't writable. */
  layoutWrites?: boolean;
  /** #195: called by POST /api/project/open after the cfg has been re-pointed
   * at a switched project — startServer uses it to re-aim the source watcher,
   * stop the (launch-scoped) drift poll, and capture a fresh baseline frame.
   * Absent in contexts with no long-lived side machinery (tests, export). */
  onProjectSwitch?: (dir: string) => void;
  port: number;
}

/** `tierEnvVar` is the served project's `.behold.json`-declared tier env var
 * name (#70, `loadBeholdConfig` — server.ts computes it once per `createApp`,
 * see `beholdConfig` below), threaded onto `opts.tierEnvVar` so a picked
 * `?tier=` can reach `envOverridesFor` (chant.ts) with a real var name to set.
 * Undefined when the project declares no tiers — `?tier=` is then parsed but
 * never makes it into a spawn's env (no name to set it under). */
function optsFromQuery(url: URL, tierEnvVar?: string, projectDir?: string): GraphOptions {
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
  // The stack picker (#76, follow-up to #71): `?stack=` names one of the
  // served project's declared `stacks[]` entries — chant.ts's `graphPath`
  // resolves it to that stack's own source tree, same shape as `?env=`
  // above. A project declaring no `stacks[]` ignores this entirely.
  const stack = q.get("stack");
  if (stack) opts.stack = stack;
  // The tier/target lenses (M2, #54): `?tier=` overrides the project's tier
  // env var (#70), `?target=` overrides AWS_ENDPOINT_URL, for this request's
  // chant shell-outs (see chant.ts `envOverridesFor`) — neither is a chant CLI
  // flag.
  const tier = q.get("tier");
  if (tier) opts.tier = tier;
  if (tierEnvVar) opts.tierEnvVar = tierEnvVar;
  const target = q.get("target");
  if (target) {
    opts.target = target;
    // The multi-substrate override table (#99). `envOverridesFor`'s fallback
    // writes only AWS_ENDPOINT_URL, and nothing ever populated
    // `substrateTargets` — so a picked `?target=` on an azure/gcp/fly estate
    // was display-only (#74). With the table present, the chosen endpoint is
    // applied to EVERY declared substrate's own var, which is #99's design.
    if (projectDir) opts.substrateTargets = resolveSubstrateTargets(projectLexicons(projectDir));
  }
  return opts;
}

/** Just the tier/target lens overrides out of a parsed `GraphOptions` — for
 * threading into a chant call that wants a DIFFERENT env/live/overlay shape
 * than the query's own (e.g. `/api/resources`, `/api/reconcile`, which force
 * `live`/`overlay` themselves) but should still honour the picked lens.
 * Carries `tierEnvVar` along with `tier` — dropping it here would silently
 * strip the var name `envOverridesFor` needs to apply the picked tier. */
function tierTargetOpts(opts: GraphOptions): Pick<GraphOptions, "tier" | "tierEnvVar" | "target"> {
  const out: Pick<GraphOptions, "tier" | "tierEnvVar" | "target"> = {};
  if (opts.tier) out.tier = opts.tier;
  if (opts.tierEnvVar) out.tierEnvVar = opts.tierEnvVar;
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

/** Precondition-failure codes a read route's structured error can carry (#72):
 * chant.ts's `ChantFailureCode` (lint gate / not-installed / generic eval —
 * classified from chant's own stderr), plus "tier" — a non-default tier that
 * needed parameters this host doesn't have, generalized below from what used
 * to be a one-off `tierErrorNote`/`tierNote` bolted onto a plain error. */
export type RouteErrorCode = ChantFailure["code"] | "tier" | "no-project" | "carve-report";

/** A read route's structured, typed error body (#72): a machine `code`, a
 * human `error` message, and a suggested `remedy` — what web/app.js's
 * `renderPreconditionError` turns into the entry/error screen instead of a
 * blank canvas or a raw stack trace. */
export interface RouteError {
  error: string;
  code: RouteErrorCode;
  remedy: string;
}

/** The "tier" failure (M2, #54, generalizing the old `tierErrorNote`) — a
 * non-default tier tripped chant's lint/eval gate. A production-only tier
 * commonly needs real credentials or a different target this host lacks, and
 * that trips the SAME gate a genuinely broken project would; the remedy here
 * isn't "edit the source", it's "pick a different tier or supply creds".
 * Deliberately substrate-name-free (no "Floci"/"loomster" literal) — behold
 * has zero per-substrate logic; this explains the SHAPE of the problem, not a
 * specific project's story. Exported for testing. */
export function tierFailure(tier: string, message: string): RouteError {
  return {
    code: "tier",
    error: `chant couldn't evaluate the "${tier}" tier here: ${message}`,
    remedy:
      `A non-default tier (e.g. a production-only one) can need parameters — real ` +
      `credentials, a different target — this environment doesn't have. Pick a ` +
      `different tier to see its graph.`,
  };
}

/** A read route's structured, typed error response (#72). `ChantCliError`
 * (chant.ts) already classified a non-zero chant exit — lint gate /
 * not-installed / generic eval — at throw time (`err.failure`); anything else
 * that reaches a route's catch (a JSON.parse failure, a rejection that isn't
 * chant's own) gets the same best-effort classification straight off its
 * message text (`classifyChantFailure`), so every route that calls this gets
 * a `code`, not just chant's own failures.
 *
 * A picked, non-default tier (M2, #54) always reports as "tier" instead of
 * whatever chant-side code the underlying failure classified as — see
 * `tierFailure`. A "not-installed" failure stays itself even under a picked
 * tier: that failure is about the project not being there at all, which has
 * nothing to do with which tier was asked for. */
/** The package version, read from package.json beside dist/ (or src/ in dev).
 * "unknown" rather than a throw if the file is somehow unreadable — a version
 * string is never worth failing a route over. */
export function beholdVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** #193: the first-contact dead end. `behold preview` in a directory that
 * isn't a chant project at all used to serve a blank graph with zero
 * explanation — chant happily emits an empty graph for an empty directory.
 * When the base entity graph comes back with no nodes AND the project has no
 * chant.config.ts, say what's actually wrong instead of drawing nothing.
 * A chant.config.ts project whose graph is legitimately empty is NOT an
 * error — it renders (with the #131 note), same as always. */
function noProjectError(projectDir: string): RouteError {
  return {
    code: "no-project",
    error: `${projectDir} doesn't look like a chant project — no chant.config.ts here, and the graph came back empty.`,
    remedy:
      "Run behold from inside a chant project (or pass its path: behold preview <dir>). " +
      "No project yet? `behold demo` serves a bundled working example against a local emulator (needs Docker).",
  };
}

function errorResponse(c: Context, opts: GraphOptions, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const failure = err instanceof ChantCliError ? err.failure : classifyChantFailure(message);
  const routeError: RouteError =
    opts.tier && failure.code !== "not-installed"
      ? tierFailure(opts.tier, failure.message)
      : { error: failure.message, code: failure.code, remedy: failure.remedy };
  return c.json(routeError, 500);
}

/** The deploy axes in play (#59 unify, issue scope: "header line showing
 * env=<LOOM_ENV>, tier=<LOOM_TIER>, target=Floci"). `env` is chant's own
 * concept and already surfaces elsewhere (`cfg.env`/`currentEnv`); `target`
 * here is read straight from the served project's process environment — the
 * literal `AWS_ENDPOINT_URL` override (Floci's tell), not something behold
 * defines or names itself. `tier` is read from the *served project's own*
 * env var, named by `.behold.json`'s `tiers.envVar` (#70) — `tierEnvVar` is
 * undefined for a project that declares no tiers, so `tier` stays unset
 * rather than guessing a name. Deliberately generic and substrate-name-free
 * (behold has zero per-substrate logic, per the epic): this surfaces the raw
 * endpoint URL, not a hardcoded "Floci" label. */
function deployAxes(
  tierEnvVar: string | undefined,
  lexicons: readonly string[] = [],
  k8sTarget?: K8sTarget,
): { tier?: string; target?: string } {
  const axes: { tier?: string; target?: string } = {};
  if (tierEnvVar && process.env[tierEnvVar]) axes.tier = process.env[tierEnvVar];
  // The k8s substrate's apiserver rides alongside the endpoint-variable
  // substrates (#106). It is resolved from the kubeconfig rather than an
  // ambient variable, and it is REPORTED, not overridable — chant binds it
  // from `k8s.profiles.<env>.context`, so a picker entry would be a lie.
  const targets = [...resolveSubstrateTargets(lexicons), ...(k8sTarget ? [k8sTarget] : [])];
  // One substrate reads exactly as it did before — a bare endpoint. Several are
  // labelled, because "target=http://localhost:4566" would name one of them and
  // silently speak for the rest (#99).
  if (targets.length === 1) axes.target = targets[0].endpoint;
  else if (targets.length > 1) axes.target = targets.map((t) => `${t.label}=${t.endpoint}`).join(" ");
  return axes;
}

/** M2 (#54): the target picker's options. Modelled as an array — today there
 * is at most one (the process's own `AWS_ENDPOINT_URL`, Floci locally, unset
 * against real AWS) — so M4's estate (several live targets) is a straight
 * extension of this shape, not a reshape. Empty when the project reports no
 * target at all, same gating as `deployAxes().target`. */
function deployTargets(
  lexicons: readonly string[] = [],
  k8sTarget?: K8sTarget,
): Array<{ name: string; endpoint: string }> {
  // One entry per substrate that has an endpoint, where this used to report a
  // single "default" belonging to whichever substrate owned AWS_ENDPOINT_URL.
  return [...resolveSubstrateTargets(lexicons), ...(k8sTarget ? [k8sTarget] : [])].map((t) => ({
    name: t.label,
    endpoint: t.endpoint,
  }));
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

/**
 * Carve mode's routes (#252, M1 of #230) — behold pointed at a `chant carve
 * advise --json` peelability report instead of at a chant project.
 *
 * The report is the whole estate: there is no source to watch, no environment
 * to observe, no chant to shell. These are registered FIRST, so Hono's
 * in-order matching gives them `/api/graph` and `/api/project` ahead of the
 * project-shaped handlers below — which is the entire trick that lets the
 * existing SPA render a carve graph with (almost) no client change: it asks
 * `/api/graph` for `{ir, svg, meta}` and gets exactly that, bands riding
 * `attrs._status` on the drift palette it already paints everywhere.
 *
 * The file is re-read per request rather than parsed once at boot, so a
 * regenerated report shows up on reload — and so a report that goes bad
 * answers with #193's structured `{error, code, remedy}` (422) instead of a
 * blank graph. `behold carve` also validates once up front, so a bad path is
 * refused in the terminal before a server ever starts.
 */
function carveRoutes(app: Hono, reportPath: string): void {
  const load = () => readCarveReport(reportPath, (p) => readFileSync(p, "utf8"));

  // The raw report, for agents (#230's M4 workflow reads this to confirm a
  // band before running `carve emit`). Verbatim — behold adds nothing to it.
  app.get("/api/carve", (c) => {
    const parsed = load();
    return parsed.ok ? c.json(parsed.report) : c.json(parsed.refusal, 422);
  });

  app.get("/api/graph", (c) => {
    const parsed = load();
    if (!parsed.ok) return c.json(parsed.refusal, 422);
    const ir = carveReportToIr(parsed.report);
    // A ranking, not a topology — `renderBanded` stacks the bands and grid-wraps
    // each one, because dagre lays an edgeless graph out along a single row (see
    // its doc comment for the numbers).
    const { svg } = renderBanded(ir);
    return c.json({
      ir,
      svg,
      meta: {
        projectDir: reportPath,
        env: null,
        tier: null,
        target: null,
        carve: true,
        note: carveNote(parsed.report, ir),
      },
    });
  });

  app.get("/api/project", (c) => {
    const parsed = load();
    return c.json({
      projectDir: reportPath,
      recents: [],
      // No envs, tiers, stacks or targets: a peelability report is a static
      // analysis of foreign Terraform, so every picker that would imply a live
      // axis stays empty and the SPA renders none of them.
      environments: [],
      lexicons: ["terraform"],
      currentEnv: null,
      targets: [],
      carve: parsed.ok
        ? {
            report: reportPath,
            from: parsed.report.from ?? null,
            count: parsed.report.count ?? parsed.report.resources.length,
            bands: parsed.report.bands ?? {},
          }
        : { report: reportPath },
    });
  });

  // A static report has no substrates to probe and no git history that means
  // anything (the file may sit anywhere). Answer empty instead of running a
  // Docker probe and a `git log` for a picture that cannot use either.
  app.get("/api/substrates", (c) => c.json({ substrates: [] }));
  app.get("/api/history", (c) => c.json({ commits: [] }));
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

  // Carve mode (#252) claims /api/graph, /api/project and friends before the
  // project-shaped handlers are registered — see carveRoutes.
  if (cfg.carveReport) carveRoutes(app, cfg.carveReport);

  // behold's own project-root config (#70) — `.behold.json`'s `tiers` block,
  // if any (src/project.ts `loadBeholdConfig`). Read once at app creation
  // (like `cfg.projectDir` itself): unlike `chant.config.ts`'s environments/
  // lexicons (re-read per `/api/project` call so editing them needs no
  // restart), this is deploy metadata behold treats as static for the life of
  // the server. Threads `tierEnvVar` into every `optsFromQuery` call below so
  // a picked `?tier=` reaches `envOverridesFor` (chant.ts) with a real var
  // name, and gates the `/api/project` tier picker + `deployAxes()`'s current-
  // tier read.
  // `let`, not `const` (#195): a project switch re-reads the new project's
  // .behold.json — its tier axis is per-project state like everything else.
  let beholdConfig = loadBeholdConfig(cfg.projectDir);
  let tierEnvVar = beholdConfig.tiers?.envVar;

  // The kube context chant binds for an environment (`k8s.profiles.<env>.
  // context`, falling back to the kubeconfig's current-context — the same
  // resolution `/api/project` reports as `k8sBinding`). Used as the
  // multi-cluster tiebreak for anchoring/logical projection (cluster-anchor.ts
  // `boundManagedCluster`) — read per call because both the profiles and the
  // kubeconfig can change under a running server. Never throws: no k8s
  // lexicon, no kubectl, no kubeconfig all resolve to undefined, which every
  // consumer treats as "no opinion".
  const boundK8sContext = async (env: string | undefined): Promise<string | undefined> => {
    try {
      const { lexicons, k8sProfiles } = await detectProject(cfg.projectDir);
      if (!lexicons.includes("k8s")) return undefined;
      return resolveK8sTarget(k8sProfiles, env ?? cfg.env, await loadKubeconfig())?.label;
    } catch {
      return undefined;
    }
  };

  // The bases an estate's `sourceLoc.file` can be relative to (#224). chant
  // reports each member's files against that member's own graph root, so the
  // kustomize lens (src/logical-kustomize.ts — it probes for a kustomization
  // file on disk) needs every member's graph path AND project root, not just
  // the primary's. Probing a base that belongs to a different member is
  // harmless: a miss is a directory that isn't there.
  //
  // The kube binding is the other half of that threading, and it is
  // deliberately NOT per-member: `boundK8sContext` resolves the PRIMARY
  // project's `k8s.profiles.<env>.context` and every estate consumer
  // (addClusterAnchorEdges since #103, the logical lens's cluster-box
  // tiebreak) gets that one answer. An estate is served against one cluster —
  // that is what makes it an estate rather than three projects — and a
  // per-member binding would mint one cluster box per member and split the
  // very picture composition exists to join. A member bound elsewhere is a
  // real case, and the honest place to fix it is per-project env targeting
  // (the M4 report's open question), not a fan-out here.
  const estateSourceRoots = async (opts: GraphOptions): Promise<string[]> =>
    (await Promise.all((cfg.projectDirs ?? []).map(async (dir) => [await graphPath(dir, opts), dir]))).flat();

  app.get("/healthz", (c) => c.json({ ok: true, projectDir: cfg.projectDir, env: cfg.env ?? null, frames: frames.size }));

  // Deployment lanes (#5): the captured keyframes as a per-substrate filmstrip.
  app.get("/api/frames", (c) => c.json({ frames: frames.summaries() }));

  // The lanes page: the graph morphing between keyframes (pinhole #81), a playhead
  // filmstrip below. Needs ≥2 distinct frames — edit the source or wait for a poll.
  app.get("/lanes", (c) => {
    const all = frames.all();
    if (all.length < 2) {
      // #198: themed like everything else — the persisted behold.theme applies
      // via the SPA's own /theme.js; the hexes are pre-boot fallbacks only.
      return c.html(
        `<!doctype html><meta charset=utf-8>` +
          `<script type="module">import { initTheme } from "/theme.js"; initTheme();</script>` +
          `<body style="font:14px system-ui;background:var(--bg,#1e1e2e);color:var(--muted,#777a8c);padding:2rem">` +
          `<h3 style="color:var(--fg,#cdd6f4)">deployment lanes</h3><p>${all.length} frame(s) captured — need at least two to scrub.</p>` +
          `<p>Frames accrue when the estate moves: hit <b style="color:var(--fg,#cdd6f4)">↻ Refresh</b> (captures the current live state), run a <b style="color:var(--fg,#cdd6f4)">Sync</b>/Adopt, edit the source, or serve with <code>--poll</code> against a moving environment. Then reload.</p>` +
          `<p><a href="/" style="color:var(--pending,#58a6ff);text-decoration:none">← back to the graph</a></p></body>`,
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
    // Preview: committed Ops (Sync/Adopt/generic) are git/PR or unscoped writes —
    // not part of the locked-down Loom-on-Floci demo. Local deploy goes via
    // /api/apply instead. (The SPA also hides these controls; this is the guard.)
    if (cfg.previewMode) return c.json({ error: "disabled in preview mode" }, 403);
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
    return c.json({ substrates: await detectSubstrates(cfg.projectDir, cfg.previewMode, await boundK8sContext(cfg.env)) });
  });

  // Bring up a substrate — run its local script (e.g. scripts/local/local-up.sh)
  // through the shared running-guard, streaming to the `op` channel; the strip
  // re-detects on the post-run `changed`. behold triggers; the script does it.
  app.post("/api/substrates/:name/up", async (c) => {
    const name = c.req.param("name");
    const sub = (await detectSubstrates(cfg.projectDir, cfg.previewMode)).find((s) => s.name === name);
    if (!sub) return c.json({ error: `unknown substrate "${name}"` }, 404);
    if (!sub.bringUp) return c.json({ error: `no bring-up available for "${name}"` }, 400);
    const { label, cmd, args } = sub.bringUp;
    // A forge substrate's "bring-up" IS a pipeline run (#163), and behold
    // knows the pipeline's structure (`/api/ci`'s stages/jobs, each job
    // correlated to its component) — so it runs with apply-shaped progress on
    // the dial instead of only a raw log tail. A pipeline that can't be
    // parsed (generation failed, older chant) degrades to the plain bring-up.
    const PIPELINE_FORGES: Record<string, CiForge> = { "gitlab-ci": "gitlab", forgejo: "forgejo" };
    const forge = PIPELINE_FORGES[name];
    if (forge) {
      const parsed = await ciPipeline(cfg.projectDir, { env: cfg.env }, forge).catch(() => undefined);
      if (parsed && parsed.jobs.length > 0) {
        if (!runner.pipeline(`${sub.label} pipeline`, cmd, args, cfg.projectDir, parsed)) {
          return c.json({ error: `busy — ${runner.running} is running` }, 409);
        }
        return c.json({ started: true, name, ran: label, pipeline: { stages: parsed.stages.length, jobs: parsed.jobs.length } });
      }
    }
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
    const { environments, lexicons, stacks, k8sProfiles } = await detectProject(cfg.projectDir);
    // #106: the k8s half's apiserver is dynamic (Floci allocates a port per EKS
    // cluster), so it is resolved from the kubeconfig on each read rather than
    // assumed. Only for a project that declares the lexicon — no kubectl call
    // for an aws-only project.
    const k8sTarget = lexicons.includes("k8s")
      ? resolveK8sTarget(k8sProfiles, cfg.env, await loadKubeconfig())
      : undefined;
    const axes = deployAxes(tierEnvVar, lexicons, k8sTarget);
    return c.json({
      projectDir: cfg.projectDir,
      // #195: the full estate composition (multi-project serves) and the
      // switcher's recents, so the SPA's project section can show what's
      // loaded and offer where to go. Recents exclude nothing here — the SPA
      // filters out the currently-loaded dir itself.
      ...(cfg.projectDirs && cfg.projectDirs.length > 1 ? { projectDirs: cfg.projectDirs } : {}),
      recents: listRecents().map((r) => r.dir),
      environments,
      // #191: the cluster each k8s env is bound to (`k8s.profiles.<env>.
      // context`) — the SPA's env picker shows it (`home → home-cloud`) so a
      // wrong-cluster pick is visible BEFORE the read, not after (the failure
      // chant#1100 exists to prevent, and the one behind #192's red herring).
      ...(k8sProfiles
        ? { k8sContexts: Object.fromEntries(Object.entries(k8sProfiles).flatMap(([e, p]) => (p.context ? [[e, p.context]] : []))) }
        : {}),
      lexicons,
      currentEnv: cfg.env ?? null,
      // v0.1.0 preview: the SPA hides git/PR ops + arbitrary-project affordances.
      ...(cfg.previewMode ? { previewMode: true } : {}),
      // The tier picker's options (M2 #54, sourced #70): gated on the served
      // project's `.behold.json` declaring a `tiers` block at all — NOT on
      // whether its env var happens to be set in behold's own launch env
      // (that's `axes.tier`, the *current* value, below). No `.behold.json` (or
      // no `tiers` key) → no `tiers` field → the SPA's picker doesn't render
      // and the graph loads with no tier selected (web/app.js `initPickers`).
      ...(beholdConfig.tiers ? { tiers: beholdConfig.tiers.values } : {}),
      // The stack picker's options (#76, follow-up to #71): gated exactly like
      // `tiers` above — only present when `chant.config.ts` declares `stacks[]`
      // at all, so a single-stack/sourceDir-only/legacy project's SPA renders no
      // picker (web/app.js `initPickers` mirrors the `info.tiers` gate). Just
      // the names — `graphPath` (chant.ts) resolves a picked name to its `src`
      // server-side; the SPA never needs the path.
      ...(stacks?.length ? { stacks: stacks.map((s) => s.name) } : {}),
      targets: deployTargets(lexicons, k8sTarget),
      // Where the k8s binding came from, so the SPA never implies behold chose
      // it (#106). Absent for a project with no k8s lexicon or no resolvable
      // context.
      ...(k8sTarget ? { k8sBinding: { context: k8sTarget.label, endpoint: k8sTarget.endpoint, source: k8sTarget.source } } : {}),
      ...axes,
    });
  });

  // #195: switch the served project in place. Everything per-project the
  // routes read lives on `cfg` (read at request time), the runner (retarget),
  // or the two `let`s above — the long-lived machinery (source watcher, drift
  // poll, baseline frame) re-aims through cfg.onProjectSwitch, which
  // startServer installs. The SPA reloads itself after a switch, so every
  // client-side cache starts clean. Locked in preview mode — the demo's
  // "no arbitrary-project switching" contract. The JSON body (not a query
  // param) is deliberate: cross-origin JSON POSTs preflight, so a hostile
  // page can't blind-fire a switch at localhost.
  app.post("/api/project/open", async (c) => {
    if (cfg.previewMode) return c.json({ error: "switching projects is locked in preview mode" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { dir?: string };
    const dir = typeof body.dir === "string" && body.dir.trim() ? resolve(body.dir.trim()) : "";
    if (!dir || !existsSync(dir)) return c.json({ error: `no such directory: ${dir || "(no dir given)"}` }, 400);
    if (!existsSync(join(dir, "chant.config.ts"))) {
      return c.json({ error: `${dir} doesn't look like a chant project — no chant.config.ts` }, 400);
    }
    addRecent(cfg.projectDir); // the project being left stays reachable
    cfg.projectDir = dir;
    cfg.projectDirs = undefined; // a switch targets one project, not an estate
    cfg.env = undefined; // the new project's envs differ — the SPA re-seeds from /api/project
    beholdConfig = loadBeholdConfig(dir);
    tierEnvVar = beholdConfig.tiers?.envVar;
    runner.retarget(dir);
    addRecent(dir);
    cfg.onProjectSwitch?.(dir);
    broadcaster.emit("changed");
    return c.json({ ok: true, projectDir: dir });
  });

  // #195: pop the OS file manager at a project's directory — the "where IS
  // this?" affordance beside the project name. Allowlisted to the served
  // estate + validated recents; never an arbitrary path from the browser.
  app.post("/api/project/reveal", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { dir?: string };
    const dir = typeof body.dir === "string" && body.dir.trim() ? resolve(body.dir.trim()) : cfg.projectDir;
    const known = new Set([cfg.projectDir, ...(cfg.projectDirs ?? []), ...listRecents().map((r) => r.dir)]);
    if (!known.has(dir)) return c.json({ error: "not a served or recent project directory" }, 400);
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try {
      await execFileP(opener, [dir]);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // --- The hand-layout sidecar (#228) -------------------------------------
  // behold's FIRST write into a served project, and the boundary is drawn
  // tightly on purpose (src/layout.ts carries the full statement of it):
  //
  //   * ONE file, `<projectDir>/.behold/layout.json`, path built from
  //     `cfg.projectDir` + two constants. No path, prefix or segment from the
  //     request reaches the filesystem — a lens key off the wire is slugged and
  //     used only as a JSON object key.
  //   * The invariant is untouched. behold still never mutates the cloud and
  //     never mutates your chant source; authority stays in the committed
  //     source and the executor (AGENTS.md). A layout sidecar is workspace
  //     metadata about how you want the picture arranged — per-user state, the
  //     category `.behold.json` (config, tracked) is deliberately NOT in.
  //   * Four ways to be told no, all polite: preview mode, an export capture,
  //     a project directory that isn't writable, and the size caps.
  //
  // The client keeps its own localStorage tier and merges local OVER server
  // (web/layout-store.js `mergeLayouts`), so this is share-and-export, never a
  // remote authority over the browser you're looking at.
  const layoutWriteBlock = (): string | null => {
    if (cfg.previewMode) return "the layout sidecar is read-only in preview mode";
    // #252: carve mode's `projectDir` is wherever the report file happens to
    // sit — a Downloads folder, someone's Terraform repo. There is no project
    // there to keep a hand layout in, and dropping `.behold/` into a stranger's
    // directory is not a thing to do quietly.
    if (cfg.carveReport) return "a carve report isn't a project — there's nowhere to keep a hand layout";
    if (cfg.layoutWrites === false) return "a static export captures a snapshot — it doesn't write to the project";
    return unwritableReason(cfg.projectDir);
  };

  app.get("/api/layout", (c) => {
    const block = layoutWriteBlock();
    const shared = { path: layoutPath(cfg.projectDir), writable: !block, ...(block ? { reason: block } : {}) };
    const raw = new URL(c.req.url).searchParams.get("lens");
    // No `?lens=` → the whole file, which is how you'd inspect or diff one.
    if (raw === null) return c.json({ ...shared, lenses: readLayoutFile(cfg.projectDir).lenses });
    const lens = normalizeLens(raw);
    if (!lens) return c.json({ error: `not a lens key: ${raw}`, code: "bad-layout" }, 400);
    return c.json({ ...shared, lens, deltas: readLens(cfg.projectDir, lens) });
  });

  app.post("/api/layout", async (c) => {
    const block = layoutWriteBlock();
    if (block) return c.json({ error: block, code: "read-only" }, 403);
    // A JSON body, not a form or a query param — cross-origin JSON POSTs
    // preflight, so a hostile page can't blind-fire a write at localhost. Same
    // reasoning as /api/project/open.
    if (!(c.req.header("content-type") ?? "").includes("application/json")) {
      return c.json({ error: "send application/json", code: "bad-layout" }, 415);
    }
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return c.json({ error: `a layout body is capped at ${MAX_BODY_BYTES} bytes`, code: "too-large" }, 413);
    const text = await c.req.text().catch(() => "");
    if (text.length > MAX_BODY_BYTES) return c.json({ error: `a layout body is capped at ${MAX_BODY_BYTES} bytes`, code: "too-large" }, 413);
    let body: { lens?: unknown; deltas?: unknown };
    try {
      body = JSON.parse(text || "null") as { lens?: unknown; deltas?: unknown };
    } catch {
      return c.json({ error: "body must be JSON", code: "bad-layout" }, 400);
    }
    const lens = normalizeLens(body?.lens);
    if (!lens) return c.json({ error: "body needs a `lens` key (the zoom stop, plus +radial / +stack-<name>)", code: "bad-layout" }, 400);
    if (!body?.deltas || typeof body.deltas !== "object" || Array.isArray(body.deltas)) {
      return c.json({ error: "body needs `deltas`: {<node id>: {dx,dy,dw,dh}}", code: "bad-layout" }, 400);
    }
    try {
      // Echoes what was STORED, not what was sent: zeroes and junk are pruned
      // on the way in, and the client should see the truth on disk.
      const stored = writeLens(cfg.projectDir, lens, body.deltas);
      return c.json({ ok: true, lens: stored.lens, deltas: stored.deltas, count: Object.keys(stored.deltas).length, path: layoutPath(cfg.projectDir) });
    } catch (err) {
      if (err instanceof LayoutTooLarge) return c.json({ error: err.message, code: "too-large" }, 413);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // `?layout=1` on a graph/overlay read bakes the sidecar's translate deltas
  // into the SVG before it goes out (src/layout.ts `applyLayoutToSvg`) — that
  // is what makes `behold export` and a static snapshot honour a hand layout.
  //
  // Opt-IN rather than always-on, which is the one design decision here worth
  // stating: the live SPA owns the interactive layer and needs dagre's own
  // coordinates as the base its drags are deltas FROM. Bake by default and the
  // client's own pass would land the same offset a second time. So the SPA
  // never asks, `runExport` always does, and a scripted `curl` decides.
  //
  // Registered as middleware ahead of both routes so the six render paths that
  // return an `svg` (source, components, logical, estate, overlay, runtime)
  // don't each grow a branch.
  const bakeHandLayout = async (c: Context, next: Next): Promise<void> => {
    await next();
    const url = new URL(c.req.url);
    if (url.searchParams.get("layout") !== "1") return;
    const res = c.res;
    if (!res || res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("json")) return;
    const lens = lensFromQuery(url.searchParams);
    const deltas = readLens(cfg.projectDir, lens);
    if (!Object.keys(deltas).length) return;
    let body: { svg?: unknown; meta?: Record<string, unknown> };
    try {
      body = (await res.clone().json()) as { svg?: unknown; meta?: Record<string, unknown> };
    } catch {
      return; // not a body we understand — leave it exactly as the route wrote it
    }
    if (typeof body.svg !== "string") return;
    const { svg, applied } = applyLayoutToSvg(body.svg, deltas);
    if (!applied) return;
    c.res = c.json({ ...body, svg, meta: { ...(body.meta ?? {}), layout: { lens, applied } } });
  };
  app.use("/api/graph", bakeHandLayout);
  app.use("/api/overlay", bakeHandLayout);

  // #193: the API's front door, for agents. Everything the SPA can see is
  // plain JSON over these routes — this index makes them discoverable without
  // reading source. Shapes and the read/act loop: AGENTS.md (shipped in the
  // npm package, linked from the docs).
  app.get("/api", (c) =>
    c.json({
      name: "behold",
      version: beholdVersion(),
      agentsGuide: "https://github.com/INTENTIUS/behold/blob/main/AGENTS.md",
      routes: [
        { method: "GET", path: "/api", desc: "this index" },
        { method: "GET", path: "/api/project", desc: "project info: dir, recents, environments, tiers, targets, stacks, preview lock" },
        { method: "POST", path: "/api/project/open", desc: "switch the served project: JSON body {dir} (validated; preview-locked)" },
        { method: "POST", path: "/api/project/reveal", desc: "open the OS file manager at a served/recent project dir: JSON body {dir?}" },
        { method: "GET", path: "/api/graph", desc: "the graph {ir, svg, meta} — params: detail=0..3, components=1, logical=1, env, stack, tier, target, lens, up=1, down=1, radial=1, layout=1" },
        ...(cfg.carveReport
          ? [{ method: "GET", path: "/api/carve", desc: "carve mode: the raw `chant carve advise --json` peelability report this server is rendering" }]
          : []),
        { method: "GET", path: "/api/overlay", desc: "live drift overlay for ?env= — same shape/params as /api/graph, plus runtime=1" },
        { method: "GET", path: "/api/layout", desc: "hand-layout sidecar (.behold/layout.json): ?lens=<key> → {lens, deltas, writable}; no lens → every lens" },
        { method: "POST", path: "/api/layout", desc: "store one lens's deltas: JSON body {lens, deltas: {<node id>: {dx,dy,dw,dh}}} (the only file behold writes in your project)" },
        { method: "GET", path: "/api/diff", desc: "per-node live diff for ?env= — {env, nodes: {<id>: {observed, diff, health, fieldDrift}}}" },
        { method: "GET", path: "/api/reconcile", desc: "pending-change summary for ?env=" },
        { method: "GET", path: "/api/resources", desc: "component → declared resources" },
        { method: "GET", path: "/api/ci", desc: "generated CI pipeline projection {stages, jobs, forge}" },
        { method: "GET", path: "/api/substrates", desc: "substrate readiness {substrates: [{name, label, status, detail, bringUp?}]}" },
        { method: "GET", path: "/api/ops", desc: "committed Ops + adopt lexicons + apply progress" },
        { method: "GET", path: "/api/history", desc: "recent source commits (rollback targets)" },
        { method: "GET", path: "/api/frames", desc: "captured lanes frames" },
        { method: "GET", path: "/api/events", desc: "SSE: changed / op / apply / pr" },
        { method: "POST", path: "/api/refresh", desc: "re-observe live now (?env=) — returns the fresh graph" },
        { method: "POST", path: "/api/apply", desc: "delegated apply: ?env=&component=<name|all> (guarded, preview-locked)" },
        { method: "POST", path: "/api/ops/:name/run", desc: "run a committed Op (delegated write)" },
        { method: "POST", path: "/api/ops/:name/signal/:gate", desc: "approve an Op's gate" },
        { method: "POST", path: "/api/rollback", desc: "open a rollback PR: ?to=<sha>" },
        { method: "POST", path: "/api/substrates/:name/up", desc: "bring a substrate up" },
        { method: "POST", path: "/api/local/reset", desc: "reset the local emulator" },
        { method: "POST", path: "/api/ci/dispatch", desc: "dispatch the GitHub Actions pipeline via the operator's gh" },
      ],
    }),
  );

  app.get("/api/graph", async (c) => {
    const url = new URL(c.req.url);
    const opts = optsFromQuery(url, tierEnvVar, cfg.projectDir);
    try {
      // Component-DAG mode (M1.0, #56): the SPA's mode toggle. `chant graph
      // --components` projects one node per component (dependsOn edges,
      // groups.byWave) instead of the AWS entity graph — a generic chant CLI
      // switch, not loomster-specific. Multi-estate composition doesn't support
      // it yet, so it's ignored there.
      const components = url.searchParams.get("components") === "1";
      // Logical/architecture lens (#63): re-project the entity graph into a
      // traditional AWS diagram — nested region/VPC/subnet ⊃ component boxes,
      // one headline card per composite. A behold-side projection over the rich
      // (detail 3) IR — it needs the full attrs, so it ignores the detail knob.
      // Entity graph only (not the component DAG, not multi-estate compose).
      const logical = url.searchParams.get("logical") === "1";
      // Multi-estate (#31): graph each project and compose into one IR (namespaced
      // ids, per-project boundary boxes, cross-stack edges). Single project → as-is.
      const multi = cfg.projectDirs && cfg.projectDirs.length > 1;
      let ir: GraphIR;
      let mode: "component-status" | undefined;
      let metaEnv = cfg.env ?? null;
      if (multi) {
        // The logical lens reads full attrs (metadata.namespace, spec fields),
        // so an estate asked for it composes at detail 3 — the same thing the
        // single-project logical branch does with its own graphIr call (#224).
        ir = await composeEstate(cfg.projectDirs!, logical ? { ...opts, detail: 3 } : opts);
        // #188: the edge-derivation passes are the k8s half's ONLY edge
        // source (chant's IR carries no k8s edges at all — src/k8s-edges.ts),
        // and they ran only on the single-project branch below — so an
        // 11-project k8s estate composed to a node cloud with FEWER edges
        // than serving any one project alone. All three passes join on
        // attribute values (namespace/name, literal value equality) — never
        // on node ids — so composeStacks' stack-prefixed ids pass through
        // them unchanged, and a join that spans two composed projects is
        // exactly the cross-stack edge a GitOps estate needs (a control-plane
        // Kustomization sourceRef-ing an app project's GitRepository).
        ir = addValueMatchEdges(ir);
        ir = addK8sDeclaredEdges(ir);
        const estateContext = await boundK8sContext(metaEnv ?? undefined);
        ir = addClusterAnchorEdges(ir, estateContext);
        // #224: the logical lens over the COMPOSED IR. Every projection joins
        // on attribute values, never node ids, so composeStacks' prefixed ids
        // pass through exactly as the edge passes above do — and the k8s lens
        // is the one an estate needs most, since a GitOps estate splits the
        // namespace declarations (control-plane) from the objects that live in
        // them (the app projects), and only the composed picture has both.
        if (logical) {
          const logicalBefore = ir.nodes.length;
          const { ir: projected, byContainer } = projectTopology(ir, metaEnv ?? undefined, estateContext, await estateSourceRoots(opts));
          const { svg } = renderArchitecture(projected, byContainer);
          const logicalNote = notesFor("logical", projected, undefined, logicalBefore);
          return c.json({
            ir: projected,
            svg,
            byContainer,
            meta: {
              projectDir: cfg.projectDir,
              env: metaEnv,
              tier: opts.tier ?? null,
              target: opts.target ?? null,
              mode: "logical",
              estate: cfg.projectDirs!.length,
              ...(logicalNote ? { note: logicalNote } : {}),
            },
          });
        }
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
        // The last pipeline run of this session, on the DAG (#164): a plain
        // `ci` attr per component (pinhole's default card template prints it —
        // the chip is free) + `_ciJob` for the inspect panel. No pipeline has
        // run → no-op.
        ir = joinCiProgress(ir, runner.applyProgress);
      } else if (logical) {
        // Logical lens: pull the rich entity graph (detail 3 — the projection
        // reads full attrs to resolve VPC/subnet/component containment), recover
        // value-wired edges, then re-project into nested boxes and paint with
        // pinhole's architecture layout. Returns here (distinct render path).
        // The `cluster/` build root merges in first (the estates declare their
        // k3d cluster there, outside sourceDir — see clusterRootGraphIr), so
        // the cluster box is the declared node, not the `cluster <env>`
        // fallback.
        const raw = mergeClusterRoot(await graphIr(cfg.projectDir, { ...opts, detail: 3 }), await clusterRootGraphIr(cfg.projectDir, opts));
        const base = addK8sDeclaredEdges(addValueMatchEdges(raw));
        // #102: the lens follows the substrate — AWS nests region/VPC/subnet,
        // Azure nests resource group/VNet/subnet. `metaEnv` names the resource
        // group on Azure, which ARM never declares as a resource.
        // The kustomize lens probes relative to whatever base sourceLoc was
        // reported against — root-relative here, project-relative on the live
        // path — so hand it both (see projectKustomizeLogical's doc).
        const { ir: projected, byContainer } = projectTopology(base, metaEnv ?? undefined, await boundK8sContext(metaEnv ?? undefined), [await graphPath(cfg.projectDir, opts), cfg.projectDir]);
        const { svg } = renderArchitecture(projected, byContainer);
        // `byContainer` rides along (behold#100): the nesting IS the projection's
        // primary output, and until now it was only observable by reading the
        // rendered SVG, which is not something an acceptance run can assert on.
        // The SPA ignores it and paints the svg as before.
        const logicalNote = notesFor("logical", projected, undefined, base.nodes.length);
        return c.json({ ir: projected, svg, byContainer, meta: { projectDir: cfg.projectDir, env: metaEnv, tier: opts.tier ?? null, target: opts.target ?? null, mode: "logical", ...(logicalNote ? { note: logicalNote } : {}) } });
      } else {
        // The `cluster/` build root merges in (see the logical branch above).
        ir = mergeClusterRoot(await graphIr(cfg.projectDir, opts), await clusterRootGraphIr(cfg.projectDir, opts));
        // Entity graph below the ATTRIBUTES tier: hide cross-stack import
        // handles (value plumbing, not resources — see pruneImports). Component
        // graphs have no imports, so this only touches the infra view.
        if ((opts.detail ?? 2) < 3) ir = pruneImports(ir);
        // Connect resources wired by a literal name/ARN value the symbolic-ref
        // graph misses (see addValueMatchEdges).
        ir = addValueMatchEdges(ir);
      // Kubernetes declared-attribute joins (#143) — selector / ingress backend /
      // scaleTargetRef. chant's IR carries no k8s edges at all, so this is the
      // k8s half's only edge source, exactly as value-match is azure's.
      ir = addK8sDeclaredEdges(ir);
        // Anchor a mixed-substrate estate (#103): the k8s half carries no
        // reference to the managed cluster it runs on, so without this it
        // renders as loose nodes beside the cloud graph rather than one estate.
        ir = addClusterAnchorEdges(ir, await boundK8sContext(metaEnv ?? undefined));
      }
      // COMPOSITES (level 1) on the SOURCE view too (#138): the overlay branch
      // below has joined the component DAG's dependsOn edges since #84, but a
      // source-only serve (no env) rendered the tier with no component edges at
      // all — same join, same honest zero when nothing maps.
      let srcCompositeEdgesAttached: number | undefined;
      if (!multi && !components && opts.detail === 1) {
        try {
          const dag = await componentGraphIr(cfg.projectDir, tierTargetOpts(opts));
          const counted = addCompositeDepsCounted(ir, dag);
          ir = counted.ir;
          srcCompositeEdgesAttached = counted.attached;
        } catch {
          srcCompositeEdgesAttached = 0;
        }
      }
      // #193: an empty base entity graph from a directory with no
      // chant.config.ts is the "you pointed behold at nothing" shape — a
      // structured error (rendered as the SPA's precondition card), never a
      // silent blank canvas. Guarded to the plain single-project entity graph:
      // components/logical emptiness has its own client handling (#182), a
      // lens can legitimately filter to nothing, and a chant.config.ts
      // project that declares no entities yet renders empty honestly.
      if (!multi && !components && !logical && !opts.lens && ir.nodes.length === 0 && !existsSync(join(cfg.projectDir, "chant.config.ts"))) {
        return c.json(noProjectError(cfg.projectDir), 404);
      }
      // Multi-estate (#31/M4): box each composed project's nodes via `groups.
      // byStack` (pinhole's composeStacks per-project grouping) — see
      // render.ts's doc comment for why this is an explicit opt-in rather than
      // auto-detected the way the component DAG's `byWave` is.
      const radial = new URL(c.req.url).searchParams.get("radial") === "1";
      const { svg } = renderGraph(ir, multi ? { boxes: "byStack" } : { radial });
      // #131: a level that renders empty, or as the level below, says which.
      // Multi-estate composition has its own shape and is left alone.
      const srcZoom: Zoom = components
        ? "components"
        : logical
          ? "logical"
          : opts.detail === 1
            ? "composites"
            : opts.detail === 3
              ? "attributes"
              : "resources";
      // #190: a lens the estate branch can't apply must say so — the multi
      // branch wins the if/else chain, so ?components=1 used to return the
      // plain composed entity graph as a silent 200 (no mode, no note): the
      // picker looked applied and wasn't. The SPA's statusbar renders it
      // (#131). #224 taught the estate the logical lens (it returns above,
      // with mode: "logical"), so this is down to `components` — which is a
      // chant projection of one project's own component DAG, not a pass over
      // the composed IR, and genuinely has nothing to run here.
      const estateLensNote = multi && components
        ? "the components lens doesn't apply to a composed estate yet — showing the composed entity graph"
        : undefined;
      const srcNote = multi ? estateLensNote : notesFor(srcZoom, ir, srcCompositeEdgesAttached);
      return c.json({
        ir,
        svg,
        meta: {
          projectDir: cfg.projectDir,
          env: metaEnv,
          ...(srcNote ? { note: srcNote } : {}),
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
    const opts = optsFromQuery(new URL(c.req.url), tierEnvVar, cfg.projectDir);
    const env = opts.env ?? cfg.env;
    // Which forge, if any — behold asked for `gitlab` unconditionally, which is
    // wrong two ways. A project declaring no forge lexicon has no pipeline to
    // generate, and chant said so with `Lexicon "gitlab" does not support
    // generate mode` — a 500 per lens for a facet that does not apply, and one
    // `errorResponse` then re-attributed to the picked tier, so a
    // KubeMicroVM estate reported "chant couldn't evaluate the prod-ha tier"
    // about a CI pipeline it never had. A project on GitHub got asked for
    // GitLab, which is the same bug where a pipeline does exist.
    const { lexicons } = await detectProject(cfg.projectDir);
    const forge = ciForgeFor(lexicons);
    // Absent, not failed. The SPA reads `j.jobs || []` and omits the CI section
    // when it is empty, which is exactly right for a project without a forge —
    // so this is the answer it already knows how to render, arrived at without
    // a subprocess or an error.
    if (!forge) return c.json({ stages: [], jobs: [], forge: null });
    try {
      const { stages, jobs } = await ciPipeline(
        cfg.projectDir,
        { ...tierTargetOpts(opts), ...(env ? { env } : {}) },
        forge,
      );
      return c.json({ stages, jobs, forge });
    } catch (err) {
      return errorResponse(c, opts, err);
    }
  });

  // Trigger GitHub Actions and follow the run (#164, the second slice of #61).
  // Delegation, not credentials: the dispatch and every poll run through the
  // OPERATOR'S own `gh` login — behold refuses honestly when gh is missing or
  // unauthenticated, before anything is attempted. The dispatched workflow is
  // chosen by job-id overlap with the generated pipeline and must declare
  // workflow_dispatch; the follow polls `gh run view --json` (structured — no
  // log guessing, unlike the local runner's classifier) and renders on the
  // dial exactly like #163's local pipeline.
  app.post("/api/ci/dispatch", async (c) => {
    const ready = await ghReady();
    if (!ready.ok) return c.json({ error: ready.reason }, 400);
    const pipeline = await ciPipeline(cfg.projectDir, cfg.env ? { env: cfg.env } : {}, "github").catch(() => undefined);
    if (!pipeline || pipeline.jobs.length === 0) {
      return c.json({ error: "no generated GitHub pipeline — `chant build --components --generate github` produced no jobs" }, 400);
    }
    const workflow = pickWorkflow(cfg.projectDir, pipeline);
    if (!workflow) {
      return c.json({ error: "no committed workflow_dispatch workflow whose jobs match the generated pipeline — commit one (or add `workflow_dispatch:` to its `on:` block)" }, 400);
    }
    // The ref the run builds: the project's current branch. Detached/unreadable
    // falls back to the default-branch convention rather than failing the
    // gesture over a rev-parse.
    const ref = await execFileP("git", ["-C", cfg.projectDir, "branch", "--show-current"])
      .then((out) => out.trim() || "main")
      .catch(() => "main");
    const started = runner.track(`GitHub Actions ${workflow.file}`, (io) =>
      dispatchAndFollow(workflow, pipeline, ref, { onLine: io.line, onProgress: io.progress }),
    );
    if (!started) return c.json({ error: `busy — ${runner.running} is running` }, 409);
    return c.json({ started: true, workflow: workflow.file, ref, jobs: pipeline.jobs.length });
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
    const opts = optsFromQuery(new URL(c.req.url), tierEnvVar, cfg.projectDir);
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
    const opts = optsFromQuery(new URL(c.req.url), tierEnvVar, cfg.projectDir);
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
    const query = optsFromQuery(new URL(c.req.url), tierEnvVar, cfg.projectDir);
    const env = query.env ?? cfg.env;
    if (!env) {
      return c.json({ error: "overlay needs an environment — pick one, or start behold with --env <name>" }, 400);
    }
    const logical = new URL(c.req.url).searchParams.get("logical") === "1";
    // #261: hoisted so both the estate and single-project branches below share
    // one reading of the flag — the estate branch used to re-derive it inline
    // and the single-project branch didn't read it until after its `graphIr`
    // call had already gone out at the wrong detail.
    const runtime = new URL(c.req.url).searchParams.get("runtime") === "1";
    try {
      // #189: the estate-wide overlay. The single-project pipeline below only
      // ever observed the primary, so an N-project estate was coloured 1/N —
      // the pitch ("your whole estate, coloured by drift") minus the estate.
      // Overlay each project concurrently and compose: a project whose live
      // observe fails degrades to its source graph painted unobserved (#1089
      // tri-state — never silently dropped, never blanking the estate), and
      // the note reports coverage. The first slice skipped the single-project
      // extras; #224 brought the runtime tier and the logical lens across (the
      // helm artifact join and the cluster-root merge are still primary-only —
      // both are per-project reads, not passes over the composed IR).
      if (cfg.projectDirs && cfg.projectDirs.length > 1) {
        // The logical lens needs the rich attrs, exactly as on the
        // single-project path below (`logical ? { detail: 3 }`). The runtime
        // tier needs them too (#261): its whole subject is the Flux
        // sourceRef/dependsOn reconcile-ordering edges `addK8sDeclaredEdges`
        // derives below from `spec`, and chant only carries `spec` at detail
        // 3 — an unqualified `?runtime=1` used to compose at chant's default
        // detail 2, where the derivation had nothing to read and the view
        // rendered edgeless.
        const detail = logical || runtime ? 3 : query.detail;
        const est = await composeEstateOverlay(cfg.projectDirs, { ...tierTargetOpts(query), detail, env }, reclassifyOverlay);
        if (est.dropped.length === est.total) {
          return c.json({ error: `no project in the estate could be graphed — ${est.dropped.map((d) => `${d.name}: ${d.reason}`).join("; ")}` }, 500);
        }
        // The runtime tier (#86) on an estate (#224): the same two calls the
        // single-project branch below makes. `attachRuntimeContainment` reads
        // each node's `runtimeOwner` (chant#1180) and nests it under its
        // declared owner — composition keeps that intact because
        // `namespaceRuntimeOwners` (src/estate.ts) re-points the field at the
        // owner's composed id first. Without `?runtime=1` the children are
        // pruned as before: a tier you cannot dial away is not a tier.
        //
        // `est.ir` is pinhole's `GraphIR` (composeStacks' return) — the same
        // IR chant's type describes, minus the index signature on `groups`
        // that these passes read through, so it is named as chant's here.
        const composed = est.ir as GraphIR;
        let ir = runtime ? attachRuntimeContainment(composed) : pruneRuntimeChildren(composed);
        if ((detail ?? 2) < 3) ir = pruneImports(ir);
        // Same passes as /api/graph's estate branch (#188) — the k8s half's
        // only edge source, and the cross-stack joins the estate exists for.
        ir = addValueMatchEdges(ir);
        ir = addK8sDeclaredEdges(ir);
        const boundContext = await boundK8sContext(env);
        ir = addClusterAnchorEdges(ir, boundContext);
        const coverNote =
          est.unobserved.length || est.dropped.length
            ? `live observe covered ${est.observed} of ${est.total} projects — ` +
              [
                ...est.unobserved.map((u) => `${u.name}: ${u.reason} (painted unobserved)`),
                ...est.dropped.map((d) => `${d.name}: dropped (${d.reason})`),
              ].join("; ")
            : undefined;
        // The logical lens over the composed, drift-coloured IR (#224) — same
        // projection and same render path as the single-project branch below,
        // so each surviving card keeps its overlay colour inside its namespace
        // box. See /api/graph's estate branch for why the composed ids are
        // safe here and estateSourceRoots for the env/binding choice.
        if (logical) {
          const logicalBefore = ir.nodes.length;
          const { ir: projected, byContainer } = projectTopology(ir, env, boundContext, await estateSourceRoots(query));
          const { svg } = renderArchitecture(projected, byContainer);
          const note = [notesFor("logical", projected, undefined, logicalBefore), coverNote, namespaceMismatchNote(projected.nodes)]
            .filter(Boolean)
            .join(" · ");
          return c.json({
            ir: projected,
            svg,
            byContainer,
            meta: { projectDir: cfg.projectDir, env, mode: "logical", estate: est.total, ...(note ? { note } : {}) },
          });
        }
        // One box per node: pinhole's `layoutIr` parents a node to a single
        // group (concept.d.ts), so the runtime tier trades the per-project
        // boundary boxes for the owner-containment ones it was asked for —
        // the same boxes the single-project runtime view draws, which is the
        // point of asking for the tier. Every other estate view keeps
        // `byStack`.
        const { svg } = renderGraph(ir, { boxes: runtime ? "byContainer" : "byStack" });
        const note = [coverNote, namespaceMismatchNote(ir.nodes), runtime ? notesFor("runtime", ir, undefined, undefined, detail) : undefined]
          .filter(Boolean)
          .join(" · ");
        return c.json({
          ir,
          svg,
          meta: { projectDir: cfg.projectDir, env, mode: "overlay", estate: est.total, ...(note ? { note } : {}) },
        });
      }
      // #261: `runtime` forces detail 3 exactly as `logical` does, and for the
      // same reason — see the estate branch above's comment. Before this, the
      // single-project runtime view had the identical bug: `?runtime=1` alone
      // composed at chant's default detail 2, so a GitOps project's own
      // sourceRef/dependsOn edges never made it into the IR either.
      const opts: GraphOptions = { ...query, live: true, overlay: true, env, ...(logical || runtime ? { detail: 3 } : {}) };
      // Reclassify wiring/examples so they don't read as "pending" over a done
      // deploy (see reclassifyOverlay): Parameters take their deployed
      // component's status, src/examples/ nodes go neutral + `_byo`.
      let ir = reclassifyOverlay(await graphIr(cfg.projectDir, opts));
      const boundContext = await boundK8sContext(env);
      // The `cluster/` build root merges in — the estates declare their k3d
      // cluster there, outside sourceDir (see clusterRootGraphIr) — painted
      // from the k3d probe: running reads `good`, declared-but-absent
      // `accent`, probe unavailable stays unpainted.
      ir = mergeClusterRoot(ir, await clusterRootGraphIr(cfg.projectDir, query), await runningK3dClusters());
      // behold#146 — artifact presence for the helm half. A release is an
      // artifact, not a resource, so the overlay's classification never
      // touches Helm::Chart nodes; the one chant read that observes releases
      // is `lifecycle diff --live --json` (observedArtifacts, chant#1516).
      // Joined by declared chart name; a read failure paints neutral
      // (unobserved ≠ absent). A release matching no declared chart used to
      // be dropped entirely — right for a chart-authoring project, but a
      // deploy-step estate (kubemicrovm-ops) declares NO chart nodes and
      // installs its releases as component helm-upgrade units, so its helm
      // half was invisible on every zoom. Those synthesize as Helm::Release
      // nodes instead: component-owned ones good/warn by helm status, the
      // rest warn (foreign) — see src/helm-releases.ts.
      const declaresHelm = await detectProject(cfg.projectDir)
        .then((p) => p.lexicons.includes("helm"))
        .catch(() => false);
      if (declaresHelm || ir.nodes.some((n) => n.lexicon === "helm" && n.kind === "Helm::Chart")) {
        const observed = await lifecycleDiffLive(cfg.projectDir, env, query)
          .then((d) => d.lexicons?.helm?.observedArtifacts)
          .catch(() => undefined);
        applyHelmArtifacts(ir, observed);
        synthesizeHelmReleases(ir, observed, discoverReleaseUnits(cfg.projectDir));
      }
      // Runtime tier (#86, chant#1180/#1077): nest each live, undeclared,
      // owner-chain-resolved node (a Pod its Deployment's controller created)
      // under its declared owner in `groups.byContainer` — a no-op on a
      // substrate with no owner chain. `renderGraph`'s `boxes: "byContainer"`
      // opt-in below draws it as a titled boundary box.
      // The runtime tier (#86): `?runtime=1` descends below the declaration
      // boundary and nests each owner-referenced child under its declared
      // parent. Every other tier stops where your source stops — a Pod is noise
      // in a composites view, and a layer you cannot dial away is not a tier.
      ir = runtime ? attachRuntimeContainment(ir) : pruneRuntimeChildren(ir);
      // Logical/architecture lens (#63): re-project the live overlay into nested
      // region/VPC/subnet ⊃ component boxes, keeping each surviving node's drift
      // colour. Short-circuits the detail-tier pruning/composite plumbing below.
      if (logical) {
        // Counted before the projection, so the note can say what was dropped
        // rather than only that the result is empty (#133's reading).
        const logicalBefore = ir.nodes.length;
        // Same as /api/graph's logical branch: the kustomize lens probes both
        // sourceLoc bases (the live path reports project-relative files).
        const { ir: projected, byContainer } = projectTopology(addK8sDeclaredEdges(addValueMatchEdges(ir)), env, boundContext, [await graphPath(cfg.projectDir, opts), cfg.projectDir]);
        const { svg } = renderArchitecture(projected, byContainer);
        // See /api/graph's logical branch — `byContainer` is carried for the
        // same reason (behold#100). The wrong-tier note (#158) joins here too:
        // the logical view collapses to near-empty at a wrong tier exactly as
        // the detail tiers do, and until now only they said why.
        const logicalTierNote = tierMismatchNote(projected, beholdConfig.tiers, query.tier);
        const logicalNote = [logicalTierNote, notesFor("logical", projected, undefined, logicalBefore)].filter(Boolean).join(" · ");
        return c.json({ ir: projected, svg, byContainer, meta: { projectDir: cfg.projectDir, env, mode: "logical", ...(logicalNote ? { note: logicalNote } : {}) } });
      }
      // Below the ATTRIBUTES tier, hide cross-stack import handles — they're
      // value plumbing, not resources, and float off to the side (see
      // pruneImports). They resurface at detail 3.
      if ((query.detail ?? 2) < 3) ir = pruneImports(ir);
      // Connect resources wired by a literal name/ARN value (e.g. an RDS
      // instance's DBSubnetGroupName) that the symbolic-ref graph misses.
      ir = addValueMatchEdges(ir);
      // Kubernetes declared-attribute joins (#143) — selector / ingress backend /
      // scaleTargetRef. chant's IR carries no k8s edges at all, so this is the
      // k8s half's only edge source, exactly as value-match is azure's.
      ir = addK8sDeclaredEdges(ir);
      // Cross-substrate anchoring (#103) — same pass as the source graph above,
      // so the live overlay shows the cluster ⊃ namespace ⊃ workload hierarchy
      // rather than dropping the k8s half into the void. The overlay is
      // source-anchored, so this is the same derivation, not a live-only one.
      ir = addClusterAnchorEdges(ir, boundContext);
      // At COMPOSITES (level 1), composites only wired via import sinks (now
      // pruned) so they'd all float — overlay the authoritative component
      // dependsOn graph so they read as a dependency graph (see addCompositeDeps).
      // #131: the catch used to be the whole story — no component DAG meant
      // this level silently rendered as `resources`, and the picker looked
      // stuck. It still degrades to the level below, because that is the
      // honest fallback, but now it says so (see zoomNote below). `attached`
      // distinguishes "mapped nothing" from "was never asked", which the
      // finished IR cannot: an estate can have zero edges either way (#84).
      let compositeEdgesAttached: number | undefined;
      if (query.detail === 1) {
        try {
          const dag = await componentGraphIr(cfg.projectDir, { env, ...tierTargetOpts(query) });
          // The whole DAG, not just its edges (#138): the component nodes'
          // `liveNames` ownership is what maps a component to its node on a
          // pure-lexicon estate, where the kebab-kind heuristic maps nothing.
          const counted = addCompositeDepsCounted(ir, dag);
          ir = counted.ir;
          compositeEdgesAttached = counted.attached;
        } catch {
          /* component DAG unavailable — leave composites as-is, and say so */
          compositeEdgesAttached = 0;
        }
      }
      // `boxes: "byContainer"` (#86) is a no-op unless attachRuntimeContainment
      // populated it above — same "harmless when absent" contract as byStack.
      const { svg } = renderGraph(ir, { boxes: "byContainer", radial: new URL(c.req.url).searchParams.get("radial") === "1" });
      const zoom: Zoom = runtime
        ? "runtime"
        : query.detail === 1
          ? "composites"
          : query.detail === 3
            ? "attributes"
            : "resources";
      // The wrong-tier trap (see tierMismatchNote): joined ahead of the zoom
      // note so "you may be viewing the wrong tier" outranks "this tier is
      // empty" — the first explains the second.
      const tierNote = tierMismatchNote(ir, beholdConfig.tiers, query.tier);
      // #192: the namespace-mismatch signature — all-pending namespaced k8s
      // objects over a resolving cluster read the OPPOSITE of the truth
      // without this aside. Ahead of the zoom notes: it explains the colours,
      // which outranks describing the shape.
      const nsNote = namespaceMismatchNote(ir.nodes);
      // #261: the effective detail this view actually fetched at (opts.detail
      // — 3 whenever runtime/logical forced it, else whatever the query
      // asked for, chant's own default of 2 when neither said anything) —
      // so edgelessNote can tell a real edgeless estate from a detail tier
      // that never had the attrs to derive edges from in the first place.
      const zoomNotes = notesFor(zoom, ir, compositeEdgesAttached, undefined, opts.detail ?? 2);
      const note = [tierNote, nsNote, zoomNotes].filter(Boolean).join(" · ");
      return c.json({ ir, svg, meta: { projectDir: cfg.projectDir, env, mode: "overlay", ...(note ? { note } : {}) } });
    } catch (err) {
      // #72: the same structured {error, code, remedy} the other read routes
      // return — this is in fact where a picked tier's creds gate USUALLY
      // surfaces (an env pick routes the SPA's load() here, not /api/graph).
      return errorResponse(c, query, err);
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
    // Same cluster-root merge + helm join the /api/overlay view gets — a
    // Refresh pressed while looking at the helm half used to silently drop
    // its artifact status (and the declared k3d cluster) from the picture it
    // returned.
    mergeClusterRoot(result.ir, await clusterRootGraphIr(cfg.projectDir), env ? await runningK3dClusters() : undefined);
    if (env) {
      const declaresHelm = await detectProject(cfg.projectDir)
        .then((p) => p.lexicons.includes("helm"))
        .catch(() => false);
      if (declaresHelm || result.ir.nodes.some((n) => n.lexicon === "helm" && n.kind === "Helm::Chart")) {
        const observed = await lifecycleDiffLive(cfg.projectDir, env)
          .then((d) => d.lexicons?.helm?.observedArtifacts)
          .catch(() => undefined);
        applyHelmArtifacts(result.ir, observed);
        synthesizeHelmReleases(result.ir, observed, discoverReleaseUnits(cfg.projectDir));
      }
    }
    // Same runtime-tier gate the /api/overlay view applies (#86, #144): the
    // Pods appear only at the runtime zoom, so a Refresh pressed from any other
    // tier doesn't paint children that tier just excluded.
    if (env) {
      if (new URL(c.req.url).searchParams.get("runtime") === "1") attachRuntimeContainment(result.ir);
      else pruneRuntimeChildren(result.ir);
    }
    // And the same import-handle pruning below ATTRIBUTES tier + value-matched edges.
    if ((optsFromQuery(new URL(c.req.url)).detail ?? 2) < 3) pruneImports(result.ir);
    addValueMatchEdges(result.ir);
    addK8sDeclaredEdges(result.ir);
    addClusterAnchorEdges(result.ir, await boundK8sContext(env));
    const { svg } = renderGraph(result.ir, { boxes: "byContainer" });
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
  // Bulk per-node live state (#27/#30): ONE `chant lifecycle diff --live` sliced
  // for every node, so the inspect pane can show observed state + drift without a
  // per-node query. The SPA fetches this once (cached), and a static export
  // captures it once per env (vs one snapshot per node). Same slice functions as
  // the single-node route below.
  app.get("/api/diff", async (c) => {
    const env = optsFromQuery(new URL(c.req.url)).env ?? cfg.env;
    if (!env) return c.json({ error: "diff needs an environment — pick one, or start with --env" }, 400);
    const { code, stdout, stderr } = await runChantRaw(["lifecycle", "diff", env, "--live", "--json"], cfg.projectDir);
    if (code !== 0) return c.json({ error: stderr.trim() || `diff exited ${code}` }, 500);
    let parsed: LiveDiffJson;
    try {
      parsed = JSON.parse(stdout) as LiveDiffJson;
    } catch {
      return c.json({ error: "diff output was not JSON — chant may predate --live --json (needs 0.18.7+)" }, 500);
    }
    // Every node the diff mentions — observed keys + each category list.
    const ids = new Set<string>();
    for (const lex of Object.values(parsed.lexicons ?? {})) {
      for (const k of Object.keys(lex.observed ?? {})) ids.add(k);
      const r = lex.resources;
      if (!r) continue;
      for (const arr of [r.missing, r.orphan, r.disappeared, r.newlyObserved, r.unchanged]) for (const n of arr ?? []) ids.add(n);
      for (const d of r.driftedSinceSnapshot ?? []) ids.add(d.name);
      // chant#1168 (#1089): declared entities chant couldn't read live state
      // for — additive and absent from an older chant's diff. Included here
      // so the inspect panel's bulk fetch (`/api/diff`) carries them too.
      for (const u of r.unobserved ?? []) ids.add(u.name);
      // chant#1180 (#1077): runtime children are already covered by the
      // `lex.observed` keys loop above (chant's `describeResources` reports
      // them the same as any other resource it found) — this is just the
      // explicit, self-documenting record of that, matching the style of the
      // unobserved line above rather than leaving it implicit.
      for (const rc of r.runtimeChildren ?? []) ids.add(rc.name);
    }
    const nodes: Record<
      string,
      { observed: unknown; diff: unknown; health: string; healthDetail?: string; fieldDrift: unknown }
    > = {};
    for (const id of ids) {
      const observed = nodeObserved(parsed, id);
      // #226: kind-aware for the GitOps controllers (the Argo health/sync pair,
      // the Flux `Ready` condition), the status-string heuristic for the rest.
      const verdict = classifyObservedHealth(observed);
      nodes[id] = {
        observed,
        diff: nodeDiff(parsed, id),
        health: verdict.health,
        ...(verdict.detail ? { healthDetail: verdict.detail } : {}),
        // Field-level (per-manager) drift (#87, chant#1181) — null when no
        // lexicon in this diff carries a `deep` section at all.
        fieldDrift: nodeFieldDrift(parsed, id),
      };
    }
    return c.json({ env, nodes });
  });

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
    // drift (a node can be managed yet degraded). #226: read off the
    // controller's own conditions for the Argo/Flux kinds, whose verdict the
    // status-string heuristic could only get right by luck; `healthDetail`
    // carries the reason it read (`Ready=False (BuildFailed)`).
    const verdict = classifyObservedHealth(observed);
    return c.json({
      node,
      env,
      diff: nodeDiff(parsed, node),
      observed,
      health: verdict.health,
      ...(verdict.detail ? { healthDetail: verdict.detail } : {}),
      // Field-level (per-manager) drift (#87, chant#1181) — null when no
      // lexicon in this diff carries a `deep` section at all.
      fieldDrift: nodeFieldDrift(parsed, node),
    });
  });

  // Source history (#28): recent commits, offered as rollback targets.
  app.get("/api/history", async (c) => c.json({ commits: await sourceCommits(cfg.projectDir) }));

  // Rollback (#28): open a PR restoring source to a chosen revision, via chant's
  // delegated `lifecycle rollback` (chant #873). Never a direct cloud write — the
  // PR is reviewed and a gated Sync applies it. Streams like an op; the PR URL
  // surfaces on the `pr` event.
  app.post("/api/rollback", (c) => {
    // Preview: rollback opens a source-revert PR — no git repo behind the demo.
    if (cfg.previewMode) return c.json({ error: "disabled in preview mode" }, 403);
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
    //
    // The guard exists FOR Floci, so it fires only when applies would actually
    // hit it: an aws-lexicon project with AWS_ENDPOINT_URL pointed at the
    // emulator. On a k8s/helm estate a re-apply is the normal sync gesture
    // (server-side apply and `helm upgrade` are idempotent), and this guard
    // used to 409 it with an error naming an emulator the project doesn't use.
    const flociTargeted =
      !!process.env.AWS_ENDPOINT_URL &&
      (await detectProject(cfg.projectDir)
        .then((p) => p.lexicons.includes("aws"))
        .catch(() => false));
    if (!force && flociTargeted) {
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

  // #209: every served chant project registers as a recent at boot — the
  // panel's switcher (and the demo catalog's "switch between loaded demos"
  // story) fills itself from actual use, not just from explicit switches.
  // startServer only (never createApp): tests build apps without touching
  // the operator's real ~/.behold/recents.json.
  for (const dir of cfg.projectDirs ?? [cfg.projectDir]) {
    if (existsSync(join(dir, "chant.config.ts"))) addRecent(dir);
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
  const onPollDrift = (movedLexicons: string[]): void => {
    onEstateChange();
    if (autoSync === "off") return;
    void routeAutoSync(movedLexicons);
  };

  // Route a drift event to the Op that owns each substrate that moved (#117).
  // Async only for the rollback interlock's git read, which is why onPollDrift
  // fires it and does not await: the re-render above must not wait on git.
  const routeAutoSync = async (movedLexicons: string[]): Promise<void> => {
    const suspended =
      autoSync === "pull-request"
        ? suspendedByRollback(await openRollbackBranches(cfg.projectDir, cfg.env), movedLexicons)
        : new Set<string>();
    const { picks, declined } = pickAutoSyncOps(
      autoSync,
      discoverEstateOps(cfg.projectDirs ?? [cfg.projectDir]),
      runner.running,
      movedLexicons,
      suspended,
    );
    // Say why nothing happened. A self-heal loop that declines silently is
    // indistinguishable from one that is broken.
    for (const d of declined) {
      broadcaster.emit("op", `⟳ auto-sync (${autoSync}) declined ${d.lexicon}: ${d.reason}`);
    }
    // One delegated write at a time — the existing guard, unchanged. Two
    // substrates drifting in the same tick do not race: the first trigger takes
    // the runner and the second is refused and says so.
    //
    // It is NOT retried on the next tick. `startDriftPoll` advances its baseline
    // whether or not a trigger started, so a substrate whose Op was refused
    // waits until it drifts again. That is the loop's pre-existing behaviour —
    // the single-Op version dropped the same event just as silently, and the
    // only change here is that it is now visible on the now-line. Making the
    // refusal re-queue means holding drift state across ticks, which is a
    // different design than the one #105 specified.
    for (const { op, lexicons } of picks) {
      const scope = lexicons.join("+");
      if (runner.trigger(op.name, op.env, op.dir)) {
        broadcaster.emit("op", `⟳ auto-sync (${autoSync}) ${scope} → ${op.name}`);
      } else {
        broadcaster.emit("op", `⟳ auto-sync (${autoSync}) ${scope} → ${op.name} waiting — ${runner.running} is running`);
      }
    }
  };

  // Watch the served project's source (the dev loop) and, with an env + --poll,
  // poll live drift (#4) — the latter also drives auto-sync. `let` (#195): a
  // project switch re-aims the watcher and stops the poll.
  // Carve mode (#252) has no chant project behind it: nothing to watch, nothing
  // to poll, and no baseline frame to capture (`captureFrame` shells `chant
  // graph`, which would fail once a second on a directory that isn't a project).
  const carve = !!cfg.carveReport;
  let stopWatch = carve ? () => {} : watchSource(cfg.projectDir, onEstateChange);
  let stopPoll =
    !carve && cfg.env && cfg.pollSecs
      ? startDriftPoll({
          intervalMs: cfg.pollSecs * 1000,
          query: () => graphIr(cfg.projectDir, { live: true, overlay: true, env: cfg.env }),
          onChange: onPollDrift,
          onError: (err) => process.stderr.write(`poll: ${err instanceof Error ? err.message : String(err)}\n`),
        })
      : () => {};
  // #195: POST /api/project/open re-pointed cfg/runner/tier state; this is the
  // long-lived machinery's half. The drift poll is launch-scoped (its --env
  // belongs to the launched project) so it stops rather than re-aims — a
  // fresh `behold serve --env --poll` is the way to poll the new project.
  cfg.onProjectSwitch = (dir) => {
    stopWatch();
    stopWatch = watchSource(dir, onEstateChange);
    stopPoll();
    stopPoll = () => {};
    process.stdout.write(`  switched → ${dir}\n`);
    void capture(); // baseline keyframe for the new project
  };
  if (!carve) void capture(); // baseline keyframe at startup
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
    if (carve) {
      process.stdout.write(
        `behold → http://localhost:${info.port}\n` +
          `  carve report: ${cfg.carveReport}\n` +
          `  green = carve now, amber = boundary work, grey = leave in Terraform.\n` +
          `  Read-only advisory: behold emits nothing and touches no Terraform. Ctrl-C to stop.\n`,
      );
      return;
    }
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
