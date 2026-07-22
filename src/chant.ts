/**
 * Shell-out to the `chant` CLI for graph data. behold is a *reader*: it never
 * mutates. It shells `chant graph` for the infra graph IR and node positions,
 * exactly the deterministic, lint-gated data pinhole consumes — behold adds the
 * server, the live/overlay acquisition, and (later) the temporal + action layers
 * around it.
 *
 * Bin resolution mirrors pinhole/src/chant.ts: resolve `@intentius/chant`'s bin
 * as seen from the served project (so the project's own chant is used), falling
 * back to behold's own dependency.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { GraphIR, Layout, ComponentStatusRow } from "@intentius/chant";
import { detectProject } from "./project.ts";
// Runtime import (not type-only): chant's own hand-rolled YAML parser, reused
// rather than behold growing a second one or regex-scraping generated YAML
// (M1.2 spike note, #58). `build`'s esbuild invocation deliberately does NOT
// externalize `@intentius/chant` (unlike hono/pinhole) so this small,
// dependency-free module (~9KB, no imports of its own) inlines into
// dist/cli.js — `@intentius/chant` ships this subpath as raw TypeScript
// (package.json `exports["./yaml"]` has no compiled-JS condition), which a
// plain `node dist/cli.js` cannot import unbundled (Node refuses to
// type-strip files under node_modules).
import { parseYAML } from "@intentius/chant/yaml";

/** Graph options passed through to chant so IR and layout node sets align. */
export interface GraphOptions {
  detail?: number;
  lens?: string;
  up?: boolean;
  down?: boolean;
  /** Environment: chant re-evaluates env-aware source for this name. */
  env?: string;
  /** Live acquisition — `chant graph --live --env <env>`. Requires cloud creds
   * + provider CLIs on the host (why behold is a Node service, not an edge fn). */
  live?: boolean;
  /** Overlay the declared graph on the provisioned one (managed/foreign/pending).
   * Since chant 0.18.31, `--overlay` defaults to the source-anchored overlay
   * (chant #821, `sourceOverlayGraphs`) — declared edges are the canvas, so
   * cross-substrate topology survives; live status/ownership join per node by
   * id. See src/overlay.ts. */
  overlay?: boolean;
  /** The tier lens (M2, #54): overrides `LOOM_TIER` for this shell-out so chant
   * re-evaluates the served project's tier-conditioned source (loomster's
   * components branch on `namingParams.tier`). NOT a chant CLI flag — chant has
   * no `--tier` concept; this is the served project's own env convention, the
   * same one `deployAxes()` (server.ts) already reads statically. Threaded as a
   * per-request spawn env override (`envOverridesFor`), never a `process.env`
   * mutation, so concurrent requests on different tiers never race. */
  tier?: string;
  /** The target lens (M2, #54): overrides `AWS_ENDPOINT_URL` for this shell-out
   * — the literal Floci/AWS endpoint tell `deployAxes()` already reads. Not a
   * chant CLI flag either. Modelled the same way as `tier` even though there is
   * at most one target today, so M4's estate (several live targets) is a
   * straightforward extension of this seam, not a reshape. */
  target?: string;
}

/** Env overrides for the tier/target lenses (M2, #54): `tier`/`target` above are
 * NOT chant CLI flags (`graphFlags` never emits them) — they're the served
 * project's own env conventions (`LOOM_TIER`, `AWS_ENDPOINT_URL`), threaded
 * straight into the spawned chant process's env so it re-evaluates for the
 * picked lens. Returns undefined when neither is set, so callers can skip the
 * spawn's `env` override entirely (equivalent to inheriting `process.env`
 * as-is). Pure; exported for testing. */
export function envOverridesFor(opts: GraphOptions): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};
  if (opts.tier) overrides.LOOM_TIER = opts.tier;
  if (opts.target) overrides.AWS_ENDPOINT_URL = opts.target;
  return Object.keys(overrides).length ? overrides : undefined;
}

/** Build chant flags for a set of graph options. Pure; exported for testing. */
export function graphFlags(opts: GraphOptions): string[] {
  const flags: string[] = [];
  if (opts.detail !== undefined) flags.push("--detail", String(opts.detail));
  if (opts.lens) flags.push("--lens", opts.lens);
  if (opts.up) flags.push("--up");
  if (opts.down) flags.push("--down");
  if (opts.env) flags.push("--env", opts.env);
  if (opts.live) flags.push("--live");
  if (opts.overlay) flags.push("--overlay");
  return flags;
}

/** Resolve `@intentius/chant`'s bin path as seen from `req`, walking up from the
 * resolved entry to the package root. Returns undefined if unresolvable. */
export function chantBinFrom(req: ReturnType<typeof createRequire>): string | undefined {
  let entry: string;
  try {
    entry = req.resolve("@intentius/chant");
  } catch {
    return undefined;
  }
  let dir = dirname(entry);
  for (;;) {
    const manifest = join(dir, "package.json");
    try {
      const pkg = createRequire(import.meta.url)(manifest) as { name?: string; bin?: { chant?: string } };
      if (pkg.name === "@intentius/chant") return join(dir, pkg.bin?.chant ?? "bin/chant");
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function chantBin(projectDir?: string): string {
  if (projectDir) {
    const fromProject = chantBinFrom(createRequire(join(resolve(projectDir), "noop.js")));
    if (fromProject) return fromProject;
  }
  const own = chantBinFrom(createRequire(import.meta.url));
  if (own) return own;
  return "chant";
}

export interface ChantRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the chant bin, capturing stdout/stderr and the exit code. Never rejects on
 * a non-zero exit (only on a spawn failure) — a failing exit is data.
 * `envOverride` (M2, #54: the tier/target lenses' `envOverridesFor`) merges over
 * `process.env` for this one spawn only — never a global mutation, so a picked
 * lens on one request can't bleed into a concurrent request on another. */
export function runChantRaw(
  args: string[],
  projectDir?: string,
  envOverride?: Record<string, string>,
): Promise<ChantRun> {
  return new Promise((resolvePromise, reject) => {
    // Run in the project dir: `chant graph --live` reads the current working
    // directory (not the path arg), so the cwd must be the project for the live
    // and overlay paths to observe the right environment.
    const proc = spawn(chantBin(projectDir), args, {
      ...(projectDir ? { cwd: projectDir } : {}),
      ...(envOverride ? { env: { ...process.env, ...envOverride } } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Accumulate raw Buffer chunks and decode once at the end. Coercing each
    // chunk to a string as it arrives (`s += d`) corrupts a multi-byte UTF-8
    // character that straddles a chunk boundary — which for loomster's ~200KB
    // entity-graph IR reliably mangles the JSON near the 64KB highWaterMark and
    // makes `JSON.parse` throw. Concatenating bytes first avoids the split.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => outChunks.push(d));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    proc.on("error", reject);
    proc.on("close", (code) =>
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      }),
    );
  });
}

async function runChantJson<T>(args: string[], projectDir?: string, envOverride?: Record<string, string>): Promise<T> {
  const { code, stdout, stderr } = await runChantRaw(args, projectDir, envOverride);
  if (code !== 0) throw new Error(`chant ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  return JSON.parse(stdout) as T;
}

/** A running Op (`chant run <name>`), streaming its output line by line. */
export interface OpRun {
  pid: number;
  kill: () => void;
  done: Promise<number>;
}

/** Spawn `chant <args>` in the project and stream stdout+stderr per line to
 * `onLine` — used for `chant run <op>` (the delegated apply/reconcile), where the
 * phase output is the now-line. behold triggers; the executor does the work. */
export function runChantStream(args: string[], projectDir: string, onLine: (line: string) => void): OpRun {
  const proc = spawn(chantBin(projectDir), args, { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
  const feed = (buf: Buffer): void => {
    for (const line of String(buf).split(/\r?\n/)) if (line.trim()) onLine(line);
  };
  proc.stdout.on("data", feed);
  proc.stderr.on("data", feed);
  const done = new Promise<number>((res) => proc.on("close", (c) => res(c ?? 1)));
  return { pid: proc.pid ?? -1, kill: () => proc.kill(), done };
}

/** Spawn an arbitrary command in the project and stream stdout+stderr per line
 * to `onLine` — the substrate bring-up path (M5): `bash scripts/local/local-up.sh`
 * etc. run outside chant, but through the same guarded/streamed runner as an Op.
 * Same shape as `runChantStream` (an `OpRun`), just any command, not the chant
 * bin. A missing binary rejects `done` via the "error" path (code 127). */
export function runCommandStream(cmd: string, args: string[], cwd: string, onLine: (line: string) => void): OpRun {
  const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const feed = (buf: Buffer): void => {
    for (const line of String(buf).split(/\r?\n/)) if (line.trim()) onLine(line);
  };
  proc.stdout.on("data", feed);
  proc.stderr.on("data", feed);
  const done = new Promise<number>((res) => {
    proc.on("error", () => res(127)); // command not found / not executable
    proc.on("close", (c) => res(c ?? 1));
  });
  return { pid: proc.pid ?? -1, kill: () => proc.kill(), done };
}

/** Legacy heuristic: prefer a `src/` subdir when present (the chant
 * convention) so sibling `ops/` (*.op.ts) aren't pulled into the infra graph,
 * else the project root. Used by `graphPath()` only when the project's
 * `chant.config.ts` doesn't declare a `sourceDir` (or config can't be read at
 * all) — see `graphPath`. */
function legacyGraphPath(projectDir: string): string {
  const src = join(projectDir, "src");
  return existsSync(src) ? src : projectDir;
}

/** Project dirs already warned about an un-rendered `stacks[]` (#76, follow-up
 * to #71) — so a polled/repeated graph request doesn't spam stderr once per
 * call. Module-level: fine to leak for the process lifetime (one entry per
 * distinct served project). */
const warnedMultiStack = new Set<string>();

/** Graph the project's source (#71): honors `chant.config.ts`'s `sourceDir`
 * (via `detectProject`, `src/project.ts`) — the project's own declared infra
 * source dir, relative to the project root — instead of guessing a hardcoded
 * `src/` convention. Falls back to `legacyGraphPath`'s `src/`-then-root
 * heuristic when the config can't be read, or doesn't declare `sourceDir`.
 * loomster sets `sourceDir: "src"` explicitly, so it resolves the same path
 * either way — unaffected.
 *
 * Multi-stack (`stacks[]`) isn't rendered per-stack yet (#76, follow-up to
 * #71 — a bigger design question than this single-stack fix): when a project
 * declares `stacks[]`, this still resolves one source (`sourceDir` if also
 * set, else the legacy heuristic) but warns on stderr rather than silently
 * picking a stack with no explanation.
 *
 * The spawn cwd stays the project dir, which is what `--live` reads.
 * Exported for testing. */
export async function graphPath(projectDir: string): Promise<string> {
  let info: Awaited<ReturnType<typeof detectProject>>;
  try {
    info = await detectProject(projectDir);
  } catch {
    // Config unreadable (unexpected — detectProject itself already falls
    // back internally) — use the legacy heuristic outright.
    return legacyGraphPath(projectDir);
  }

  if (info.stacks?.length && !warnedMultiStack.has(projectDir)) {
    warnedMultiStack.add(projectDir);
    process.stderr.write(
      `behold: ${projectDir}'s chant.config.ts declares ${info.stacks.length} stack(s) in \`stacks[]\` — ` +
        "multi-stack graph rendering isn't supported yet (#76, follow-up to #71); " +
        `rendering ${info.sourceDir ? `sourceDir "${info.sourceDir}"` : "the single-source fallback"} only, not every stack.\n`,
    );
  }

  if (info.sourceDir) return resolve(projectDir, info.sourceDir);
  return legacyGraphPath(projectDir);
}

/** Build the `chant graph` argv for a view format. `components` switches the
 * projection from the AWS entity graph (all resources) to the component DAG
 * (one node per component, `groups.byWave` deploy waves, `dependsOn` edges) —
 * `--components` ahead of `--format`, matching the CLI contract the M1.0 spike
 * verified. Pure; exported for testing. */
export function graphArgs(src: string, format: "ir" | "layout", opts: GraphOptions, components: boolean): string[] {
  return ["graph", src, ...(components ? ["--components"] : []), "--format", format, ...graphFlags(opts)];
}

/** The infra graph IR for a project (`chant graph --format ir`) — nodes are AWS
 * resources. */
export async function graphIr(projectDir: string, opts: GraphOptions = {}): Promise<GraphIR> {
  const src = await graphPath(projectDir);
  return runChantJson<GraphIR>(graphArgs(src, "ir", opts, false), projectDir, envOverridesFor(opts));
}

/** Node positions for a project (`chant graph --format layout`, dagre — no native dep). */
export async function graphLayout(projectDir: string, opts: GraphOptions = {}): Promise<Layout> {
  const src = await graphPath(projectDir);
  return runChantJson<Layout>(graphArgs(src, "layout", opts, false), projectDir, envOverridesFor(opts));
}

/** The component-DAG graph IR (`chant graph --components --format ir`): nodes are
 * components (not resources), edges are `dependsOn` (consumer → producer), and
 * `groups.byWave` are the parallel-safe deploy waves. Same shell-out shape as
 * `graphIr` — behold has no per-substrate logic; it paints whatever chant
 * returns. Requires a chant that ships the M1.0 component-DAG view (spike
 * "chant changes" #3); behold's own pinned `@intentius/chant` predates it, so
 * this only resolves against a served project's own (newer) chant. */
export async function componentGraphIr(projectDir: string, opts: GraphOptions = {}): Promise<GraphIR> {
  const src = await graphPath(projectDir);
  return runChantJson<GraphIR>(graphArgs(src, "ir", opts, true), projectDir, envOverridesFor(opts));
}

/** Node positions for the component DAG (`chant graph --components --format layout`). */
export async function componentGraphLayout(projectDir: string, opts: GraphOptions = {}): Promise<Layout> {
  const src = await graphPath(projectDir);
  return runChantJson<Layout>(graphArgs(src, "layout", opts, true), projectDir, envOverridesFor(opts));
}

/** Build the `chant components status` argv (M1.1 spike, Q2): one row per
 * component, reconciling the release ledger against live AWS truth for
 * `env`. Always `--live --json` — behold has no offline/digest-only use for
 * this command, and `--json` is the only output this parses. Pure; exported
 * for testing. */
export function componentStatusArgs(env: string): string[] {
  return ["components", "status", env, "--live", "--json"];
}

/** Live per-component AWS status (`chant components status <env> --live
 * --json`): one row per component — `component` (the join key onto the
 * component-DAG IR, by name), `reconciliation` (reconciled|unrecorded|stale|
 * drifted|unknown) and a human-readable `detail`. Since chant 0.18.29 also
 * carries machine-readable `live` (boolean) and `stack` ({name,status,
 * healthy}, from `describeStackStatus`) — src/component-status.ts's palette
 * reads those instead of string-matching `detail`. Single-substrate AWS,
 * resolved internally by chant from each component's own CFN stack
 * (`loom-<env>-<instance>-<component>` on loomster) — behold does not shell
 * `aws` or reconstruct stack names itself. Deliberately NOT the cross-
 * substrate `chant graph --live --overlay` path (the source-anchored overlay,
 * chant #821, shipped 0.18.31 — see src/overlay.ts) — this stays a distinct,
 * single-substrate join by design (the epic keeps the component DAG's status
 * facet AWS-only), not a workaround for a chant gap. The output is a bare
 * JSON array (not wrapped in `{env, rows, ...}`) —
 * verified against loomster on Floci, chant 0.18.27. `opts` only matters for
 * its `tier`/`target` lens overrides (M2) — the rest of `GraphOptions` (env,
 * detail, lens…) doesn't apply to this command's argv, which takes `env` as
 * an explicit positional instead. */
export function componentStatus(projectDir: string, env: string, opts: GraphOptions = {}): Promise<ComponentStatusRow[]> {
  return runChantJson<ComponentStatusRow[]>(componentStatusArgs(env), projectDir, envOverridesFor(opts));
}

// ---------------------------------------------------------------------------
// CI projection facet (M1.2, #58) — loomster's GitLab CI is the SAME
// component DAG projected: waves = stages, components = jobs, `dependsOn` =
// `needs:`. `chant build --components --generate gitlab` synthesizes that
// pipeline; behold reads it read-only and hangs it off each component node
// by name — the same join key as the DAG (#56) and live status (#57). No
// graph-topology change: this is a per-node detail facet.
// ---------------------------------------------------------------------------

/** One GitLab CI job for a component. `stage` is the wave it runs in,
 * `needs` are the job names it waits on (mirrors `dependsOn`), `script` is
 * the shell line(s) the job runs — the `chant run --components <name> ...`
 * trigger, plus any `--seed-outputs`/`--dump-outputs` artifact threading
 * across `needs:` edges. Keyed by `component` (the join key). */
export interface CiJob {
  jobName: string;
  component: string;
  stage: string;
  needs: string[];
  script: string[];
}

export interface CiPipeline {
  stages: string[];
  jobs: CiJob[];
}

/** The raw shape of `chant build --components --generate gitlab --format
 * json` (verified against loomster, M1.2 spike): `jobs` carries the graph
 * shape (stage/needs) per component, but not the script — that lives only in
 * the embedded, already-generated `yaml` (parsed out below). */
interface GitlabGenerateJson {
  stages: string[];
  jobs: Array<{ jobName: string; component: string; stage: string; needs: string[] }>;
  yaml: string;
}

/** Build the `chant build --components --generate gitlab --format json` argv.
 * `--format json` is the structured read (verified against loomster's chant
 * `--help`: "build: json (default) or yaml") — preferred over parsing the
 * plain YAML chant prints by default, which would need line-scraping to find
 * each job's stage/needs. Pure; exported for testing. */
export function ciPipelineArgs(opts: GraphOptions = {}): string[] {
  const args = ["build", "--components", "--generate", "gitlab", "--format", "json"];
  if (opts.env) args.push("--env", opts.env);
  return args;
}

/** Parse `chant build --components --generate gitlab --format json`'s stdout
 * into per-job CI facets. The structured JSON's `jobs` array already gives
 * `stage`/`needs` per component with no parsing needed; only `script` (the
 * exact shell line(s) GitLab would run — the `chant run --components <name>`
 * trigger plus output-artifact threading) requires reading the embedded
 * `yaml`, which this does with chant's own YAML parser (not a regex scrape of
 * generated CI text). Pure; exported for testing against a fixture. */
export function parseCiPipeline(stdout: string): CiPipeline {
  const parsed = JSON.parse(stdout) as GitlabGenerateJson;
  const doc = parseYAML(parsed.yaml) as Record<string, Record<string, unknown>>;
  const jobs: CiJob[] = parsed.jobs.map((j) => {
    const props = doc[j.jobName];
    const script = Array.isArray(props?.script) ? (props.script as unknown[]).map(String) : [];
    return { ...j, script };
  });
  return { stages: parsed.stages, jobs };
}

/** The CI projection facet for a project's components: shells `chant build
 * --components --generate gitlab --format json` for the served project and
 * returns each component's {stage, needs, script} — read-only, joined onto
 * the component-DAG nodes (#56) by component name. Same shell-out shape as
 * `componentGraphIr`; requires a chant that ships generate mode (chant #563,
 * ships well before the M1.0 spike's 0.18.27 pin, so no extra version gate). */
export function ciPipeline(projectDir: string, opts: GraphOptions = {}): Promise<CiPipeline> {
  const args = ciPipelineArgs(opts);
  return runChantRaw(args, projectDir, envOverridesFor(opts)).then(({ code, stdout, stderr }) => {
    if (code !== 0) throw new Error(`chant ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
    return parseCiPipeline(stdout);
  });
}

// ---------------------------------------------------------------------------
// Reconcile facet (M2, epic #54's observe→reconcile→apply dial) — the
// pending change set for a target, read-only. `chant lifecycle plan <env>
// --live --json` promotes the live diff to chant's own typed create/update/
// delete/adopt/noop classification per entity (`ChangeSet`, chant's
// lifecycle/change-set.ts) — behold does no diffing of its own, just reads
// and correlates (src/reconcile.ts). `--live` is accepted by chant's global
// arg parser but inert for `plan` specifically: `lifecycle plan` always
// queries live (its `describeResources` call IS the live query) — passed
// anyway to match this milestone's documented command contract.
// ---------------------------------------------------------------------------

/** One entity-level entry from `chant lifecycle plan` — chant's own
 * `ChangeSetEntry` (lifecycle/change-set.ts), reproduced here rather than
 * imported so this module doesn't reach past chant's public `@intentius/chant`
 * export surface for an internal lifecycle type. `name` is the chant entity
 * name — the same identifier the entity graph IR's node `id` uses, which is
 * how src/reconcile.ts correlates an entry to a component. */
export interface LifecyclePlanEntry {
  name: string;
  type?: string;
  action: "create" | "update" | "delete" | "adopt" | "noop";
  evidence: { declared: boolean; inSnapshot: boolean; live: boolean };
  deltas?: Array<{ path: string; oldValue: unknown; newValue: unknown }>;
  ownership: "owned" | "foreign" | "unknown";
}

/** `chant lifecycle plan <env> --live --json`'s bare output shape — chant's
 * `ChangeSet`, `{env, entries}`, verified against loomster (~128 entity-level
 * entries across its 7 components). */
export interface LifecyclePlan {
  env: string;
  entries: LifecyclePlanEntry[];
}

/** Build the `chant lifecycle plan <env> --live --json` argv. Pure; exported
 * for testing. */
export function lifecyclePlanArgs(env: string): string[] {
  return ["lifecycle", "plan", env, "--live", "--json"];
}

/** The pending change set for `env` (M2 reconcile facet, src/reconcile.ts
 * does the per-component summary): entity-keyed create/update/delete/adopt/
 * noop entries straight from chant's own classification. Read-only — never
 * behold's basis for a mutation; that stays chant Ops (M3). `opts.tier`/
 * `opts.target` (M2 lenses) thread through as env overrides, same as every
 * other shell-out in this module; the rest of `GraphOptions` doesn't apply
 * (env is an explicit positional here, like `componentStatus`). */
export function lifecyclePlan(projectDir: string, env: string, opts: GraphOptions = {}): Promise<LifecyclePlan> {
  return runChantJson<LifecyclePlan>(lifecyclePlanArgs(env), projectDir, envOverridesFor(opts));
}

// ---------------------------------------------------------------------------
// Apply facet (M3, epic #54's observe→reconcile→apply dial) — behold's first
// delegated WRITE. `chant run <target> --components --env <env>
// --progress-json` (chant 0.18.30) deploys the named component (or every
// component, `target: "all"`) through chant's own interpret driver on the
// local executor, streaming one NDJSON `RunProgressEvent` per line while it
// runs (src/apply.ts parses that stream into a structured progress model;
// src/op-runner.ts's `apply()` runs the command itself, under the same
// running-guard as Sync/rollback). behold never applies itself — it shells
// this command and streams what chant reports.
// ---------------------------------------------------------------------------

/** Build the `chant run <target> --components --env <env> --progress-json`
 * argv. `target` is a component name or `"all"` — chant's own selector
 * convention for `run --components` (the generated CI script this same
 * module already parses, `parseCiPipeline`, runs the single-component form).
 * Pure; exported for testing. */
export function applyArgs(target: string, env: string): string[] {
  return ["run", target, "--components", "--env", env, "--progress-json"];
}
