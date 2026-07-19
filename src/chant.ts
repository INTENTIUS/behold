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
import type { GraphIR, Layout } from "@intentius/chant";
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
   * Note: today's `--overlay` keeps *live* edges — the cross-substrate topology
   * needs chant's source-anchored overlay (chant #821). See src/overlay.ts. */
  overlay?: boolean;
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
 * a non-zero exit (only on a spawn failure) — a failing exit is data. */
export function runChantRaw(args: string[], projectDir?: string): Promise<ChantRun> {
  return new Promise((resolvePromise, reject) => {
    // Run in the project dir: `chant graph --live` reads the current working
    // directory (not the path arg), so the cwd must be the project for the live
    // and overlay paths to observe the right environment.
    const proc = spawn(chantBin(projectDir), args, {
      ...(projectDir ? { cwd: projectDir } : {}),
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

async function runChantJson<T>(args: string[], projectDir?: string): Promise<T> {
  const { code, stdout, stderr } = await runChantRaw(args, projectDir);
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

/** Graph the project's source. Prefer a `src/` subdir when present (the chant
 * convention) so sibling `ops/` (*.op.ts) aren't pulled into the infra graph. The
 * spawn cwd stays the project dir, which is what `--live` reads. */
function graphPath(projectDir: string): string {
  const src = join(projectDir, "src");
  return existsSync(src) ? src : projectDir;
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
export function graphIr(projectDir: string, opts: GraphOptions = {}): Promise<GraphIR> {
  return runChantJson<GraphIR>(graphArgs(graphPath(projectDir), "ir", opts, false), projectDir);
}

/** Node positions for a project (`chant graph --format layout`, dagre — no native dep). */
export function graphLayout(projectDir: string, opts: GraphOptions = {}): Promise<Layout> {
  return runChantJson<Layout>(graphArgs(graphPath(projectDir), "layout", opts, false), projectDir);
}

/** The component-DAG graph IR (`chant graph --components --format ir`): nodes are
 * components (not resources), edges are `dependsOn` (consumer → producer), and
 * `groups.byWave` are the parallel-safe deploy waves. Same shell-out shape as
 * `graphIr` — behold has no per-substrate logic; it paints whatever chant
 * returns. Requires a chant that ships the M1.0 component-DAG view (spike
 * "chant changes" #3); behold's own pinned `@intentius/chant` predates it, so
 * this only resolves against a served project's own (newer) chant. */
export function componentGraphIr(projectDir: string, opts: GraphOptions = {}): Promise<GraphIR> {
  return runChantJson<GraphIR>(graphArgs(graphPath(projectDir), "ir", opts, true), projectDir);
}

/** Node positions for the component DAG (`chant graph --components --format layout`). */
export function componentGraphLayout(projectDir: string, opts: GraphOptions = {}): Promise<Layout> {
  return runChantJson<Layout>(graphArgs(graphPath(projectDir), "layout", opts, true), projectDir);
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
  return runChantRaw(args, projectDir).then(({ code, stdout, stderr }) => {
    if (code !== 0) throw new Error(`chant ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
    return parseCiPipeline(stdout);
  });
}
