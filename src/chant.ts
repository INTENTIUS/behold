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
import { targetEnvOverrides, type SubstrateTarget } from "./targets.ts";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
import { carveStatusArgs, type CarveStatusJson } from "./carve-manifest.ts";
import { dropForeignDeclarations } from "./foreign.ts";

/** Graph options passed through to chant so IR and layout node sets align. */
export interface GraphOptions {
  /**
   * The substrates in play and the ambient variable each one's read path
   * honours (#99). When present, a chosen `target` is applied to every one of
   * them rather than only to `AWS_ENDPOINT_URL` — which is how a mixed-substrate
   * project reaches floci-az as well as Floci. Absent for a caller that has not
   * resolved them, which keeps the pre-#99 single-variable behaviour.
   */
  substrateTargets?: readonly SubstrateTarget[];
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
  /** The tier lens (M2, #54): overrides the served project's own tier env var
   * for this shell-out so chant re-evaluates its tier-conditioned source
   * (loomster's components branch on `namingParams.tier`, read from
   * `LOOM_TIER`). NOT a chant CLI flag — chant has no `--tier` concept; this is
   * the served project's own env convention, named by `.behold.json`'s
   * `tiers.envVar` (#70, `tierEnvVar` below — src/project.ts
   * `loadBeholdConfig`), the same one `deployAxes()` (server.ts) already reads.
   * Threaded as a per-request spawn env override (`envOverridesFor`), never a
   * `process.env` mutation, so concurrent requests on different tiers never
   * race. */
  tier?: string;
  /** The env var name `tier` above overrides (#70) — sourced from the served
   * project's `.behold.json` (`tiers.envVar`), never hardcoded. Undefined when
   * the project declares no tiers, in which case `tier` (if somehow set) is
   * never threaded into the shell-out's env: there's no var name to set it
   * under. */
  tierEnvVar?: string;
  /** The target lens (M2, #54): overrides `AWS_ENDPOINT_URL` for this shell-out
   * — the literal Floci/AWS endpoint tell `deployAxes()` already reads. Not a
   * chant CLI flag either. Modelled the same way as `tier` even though there is
   * at most one target today, so M4's estate (several live targets) is a
   * straightforward extension of this seam, not a reshape. */
  target?: string;
  /** The stack picker (#76, follow-up to #71): names one of the served
   * project's declared `stacks[]` entries (`src/project.ts` `StackInfo`) — a
   * multi-stack project's independently-deployed CloudFormation stacks, each
   * built from its own source tree. NOT a chant CLI flag — `graphPath` (below)
   * resolves it to that stack's `src` and passes THAT as `chant graph`'s
   * source positional, same as it already does for a single-stack project's
   * `sourceDir`. Undefined (or a name matching no declared stack) resolves to
   * the first declared stack — the picker's default — rather than erroring;
   * a project declaring no `stacks[]` at all ignores this option entirely. */
  stack?: string;
  /** Where to READ entities that declare no `metadata.namespace` — chant's
   * `--namespace <ns>` (chant#1629, chant 0.44.5). A DEFAULT, not a rewrite:
   * an object declaring its own namespace is still read from the one it
   * declares, and a lexicon with no namespace-like scope ignores it.
   *
   * Never parsed off a request (`optsFromQuery` has no `?namespace=`) — a
   * viewer picking where to look would just be guessing. It is DERIVED, per
   * member project, from the estate's own declared
   * `Kustomization.spec.targetNamespace`: see src/estate.ts's
   * `estateNamespaceScopes` (#221). A chant predating the flag rejects it
   * outright ("Unknown flag", chant#1127), which is why that join gates on the
   * member's own resolved chant version rather than sending it hopefully. */
  namespace?: string;
}

/** Env overrides for the tier/target lenses (M2, #54): `tier`/`target` above are
 * NOT chant CLI flags (`graphFlags` never emits them) — they're the served
 * project's own env conventions, threaded straight into the spawned chant
 * process's env so it re-evaluates for the picked lens. `tier`'s var name comes
 * from `tierEnvVar` (#70, sourced from `.behold.json` — never hardcoded); a
 * `tier` with no `tierEnvVar` is dropped, since there's no var name to set it
 * under. `target` still maps to the literal `AWS_ENDPOINT_URL` (Floci/AWS
 * endpoint tell — out of #70's scope). Returns undefined when neither ends up
 * set, so callers can skip the spawn's `env` override entirely (equivalent to
 * inheriting `process.env` as-is). Pure; exported for testing. */
export function envOverridesFor(opts: GraphOptions): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};
  if (opts.tier && opts.tierEnvVar) overrides[opts.tierEnvVar] = opts.tier;
  if (opts.substrateTargets?.length) {
    // Each substrate gets its own endpoint, or all of them get the chosen one:
    // `target` stays a single global override rather than a control per
    // substrate (#99), so a single-substrate project behaves exactly as before.
    Object.assign(overrides, targetEnvOverrides(opts.substrateTargets, opts.target));
  } else if (opts.target) {
    overrides.AWS_ENDPOINT_URL = opts.target;
  }
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
  // #221 / chant#1629 — only meaningful alongside `--live` (it scopes the
  // read, not the build), and only ever set by the estate namespace join.
  if (opts.namespace) flags.push("--namespace", opts.namespace);
  return flags;
}

/** A resolved `@intentius/chant` install: where it lives, its bin, its declared
 * version (undefined when the manifest carries none). */
export interface ChantPackage {
  /** The package root — the directory holding its package.json. */
  root: string;
  /** Absolute path to the `chant` bin. */
  bin: string;
  version?: string;
}

/** Resolve a package as seen from `req` and walk up from the resolved entry to
 * its root, returning the manifest. Undefined when the package doesn't resolve.
 *
 * The walk is not decoration: chant and its lexicons ship raw TypeScript with
 * an `exports` map whose `./*` subpath rewrites to `./src/*.ts`, so
 * `resolve("<pkg>/package.json")` resolves to a file that doesn't exist. The
 * entry point is the only subpath that reliably resolves; the manifest has to
 * be found by walking to it. */
function packageManifestFrom(
  req: ReturnType<typeof createRequire>,
  name: string,
): { root: string; manifest: { name?: string; version?: string; bin?: { chant?: string } } } | undefined {
  let entry: string;
  try {
    entry = req.resolve(name);
  } catch {
    return undefined;
  }
  let dir = dirname(entry);
  for (;;) {
    try {
      const pkg = createRequire(import.meta.url)(join(dir, "package.json")) as { name?: string };
      if (pkg.name === name) return { root: dir, manifest: pkg };
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Resolve the `@intentius/chant` package as seen from `req`, walking up from
 * the resolved entry to the package root. Returns undefined if unresolvable. */
export function chantPackageFrom(req: ReturnType<typeof createRequire>): ChantPackage | undefined {
  const found = packageManifestFrom(req, "@intentius/chant");
  if (!found) return undefined;
  const { root, manifest } = found;
  return { root, bin: join(root, manifest.bin?.chant ?? "bin/chant"), ...(manifest.version ? { version: manifest.version } : {}) };
}

/** One declared lexicon and whether the project can actually load it. `pkg` is
 * the npm package a chant lexicon name maps to — `k8s` →
 * `@intentius/chant-lexicon-k8s`, the convention every lexicon follows. */
export interface LexiconResolution {
  lexicon: string;
  pkg: string;
  installed: boolean;
  version?: string;
}

/** The install state of a project's declared lexicons (#236), resolved from
 * the project the same way chant itself will resolve them at graph time — a
 * missing one is exactly what `classifyChantFailure` later reports as
 * "not-installed", said before a graph route has to. */
export function resolveLexicons(projectDir: string, lexicons: readonly string[]): LexiconResolution[] {
  const req = createRequire(join(resolve(projectDir), "noop.js"));
  return lexicons.map((lexicon) => {
    const pkg = `@intentius/chant-lexicon-${lexicon}`;
    const found = packageManifestFrom(req, pkg);
    return { lexicon, pkg, installed: !!found, ...(found?.manifest.version ? { version: found.manifest.version } : {}) };
  });
}

/** Resolve `@intentius/chant`'s bin path as seen from `req`. Returns undefined
 * if unresolvable. */
export function chantBinFrom(req: ReturnType<typeof createRequire>): string | undefined {
  return chantPackageFrom(req)?.bin;
}

/** Where the chant behold would shell for a project came from. `project` is the
 * intended case (the project decides its chant version); `behold` means the
 * project's own install is missing and behold fell back to its bundled chant,
 * which has none of the project's lexicons — the #1 first-touch failure (#236,
 * and `classifyChantFailure`'s "not-installed" arriving later, in a graph
 * route, is the symptom); `path` means neither resolved and the bare `chant`
 * on PATH (if any) is all that's left. */
export type ChantSource = "project" | "behold" | "path";

export interface ChantResolution extends Partial<ChantPackage> {
  source: ChantSource;
  bin: string;
}

/** The chant behold will actually shell for `projectDir` — the project's own
 * install first, then behold's bundled one, then a bare `chant` on PATH. The
 * resolution `runChantRaw` uses, exposed so `behold doctor` reports the same
 * answer the server acts on rather than probing separately (#236). */
export function resolveChant(projectDir?: string): ChantResolution {
  const own = chantPackageFrom(createRequire(import.meta.url));
  if (projectDir) {
    const fromProject = chantPackageFrom(createRequire(join(resolve(projectDir), "noop.js")));
    // Landing on behold's OWN install is the fallback, however it was reached.
    // Node resolution walks up parent directories, so a project nested under
    // behold's checkout (every bundled example is) resolves behold's chant
    // without having one of its own — reporting that as "the project's" would
    // make `behold doctor` confidently miss the missing install it exists to
    // catch. Comparing package roots, not requires, is what distinguishes them.
    if (fromProject) return { source: fromProject.root === own?.root ? "behold" : "project", ...fromProject };
  }
  if (own) return { source: "behold", ...own };
  return { source: "path", bin: "chant" };
}

/** behold's declared `@intentius/chant` floor — the caret range in its own
 * package.json reduced to the literal version (`^0.38.0` → `0.38.0`), the same
 * reading `scripts/typecheck-floor.sh` typechecks against. Undefined when the
 * manifest can't be read. */
export function chantFloor(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies?.["@intentius/chant"]?.replace(/^[^0-9]*/, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Does `version` meet `floor`? Numeric dotted compare, prerelease suffix
 * dropped (`0.44.3-rc.1` compares as `0.44.3` — an rc of the floor is close
 * enough to not warn about). Unparseable input answers `true`: an unknown
 * version is not evidence of an old one. Pure; exported for testing. */
export function meetsFloor(version: string | undefined, floor: string | undefined): boolean {
  if (!version || !floor) return true;
  const parts = (v: string): number[] => v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10));
  const a = parts(version);
  const b = parts(floor);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

function chantBin(projectDir?: string): string {
  return resolveChant(projectDir).bin;
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

// ---------------------------------------------------------------------------
// Precondition-failure classification (#72) — behold shells the served
// project's OWN chant, which routinely refuses on a project that isn't
// perfectly set up yet (the "open your own project" goal's whole premise, per
// the bundled-Loom-demo era never surfacing this). A non-zero exit used to
// just become a generic `Error` that /api/graph's `errorResponse` stringified
// into an opaque 500. This classifies chant's own stderr into the handful of
// preconditions the CLI itself gates on, so a route can hand back a machine
// code + a suggested remedy instead of a stack trace.
// ---------------------------------------------------------------------------

/** The precondition failures behold distinguishes (#72's "at least" list):
 *   - "lint": `chant graph`'s own lint gate — it refuses to emit a graph for
 *     source that doesn't pass `chant lint` (see chant's cli/handlers/
 *     graph.ts, "Refusing to emit graph: source has lint errors").
 *   - "not-installed": chant can't resolve a package the project's source
 *     imports (`Cannot find package`/`Cannot find module`) — either the
 *     project itself was never `npm install`ed, or it's missing generated
 *     types (`chant typegen`); either way behold's bin resolution
 *     (`chantBin` above) fell back to its own pinned chant, which has none of
 *     the served project's own lexicons.
 *   - "eval": anything else non-zero — a generic evaluation failure. Covers
 *     the tier/env-needs-creds case (server.ts generalizes this bucket
 *     further, folding in the picked tier for a friendlier remedy) and any
 *     other chant-side error this module doesn't special-case.
 */
export type ChantFailureCode = "lint" | "not-installed" | "eval";

/** A classified chant failure: the machine `code`, chant's own message
 * (ANSI-stripped, trimmed), and a suggested next step. */
export interface ChantFailure {
  code: ChantFailureCode;
  message: string;
  remedy: string;
}

// chant's own `formatError`/`formatWarning` (cli/format.ts) colour output
// whenever `!process.env.NO_COLOR && process.stdout.isTTY !== false` — a
// piped stream's `isTTY` is `undefined`, not `false`, so that check stays
// true for a spawned, non-interactive chant by default. Strip the escapes so
// neither the classification regexes nor the JSON/UI surfaced text carry raw
// control bytes.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI colour escapes from chant's stderr/stdout. Exported for testing. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Classify a failed chant shell-out's stderr into one of `ChantFailureCode`
 * (#72). Pattern-matches chant's own wording rather than an exit-code
 * convention — chant exits 1 for every failure class alike, so the message
 * text is the only signal. Never throws; a message that matches nothing
 * specific falls into the generic "eval" bucket. Pure; exported for testing. */
export function classifyChantFailure(stderr: string): ChantFailure {
  const clean = stripAnsi(stderr).trim();
  if (/refusing to emit graph: source has lint errors/i.test(clean)) {
    return {
      code: "lint",
      message: clean || "chant refused to emit the graph: the project has lint errors.",
      remedy: "Run `chant lint` in the project to see the errors, fix them, then reload.",
    };
  }
  if (/cannot find (package|module)\s+['"]/i.test(clean)) {
    return {
      code: "not-installed",
      message: clean || "chant could not resolve a package the project's source imports.",
      remedy: "Run `npm install && chant typegen` in the project directory, then reload.",
    };
  }
  return {
    code: "eval",
    message: clean || "chant failed to evaluate the project.",
    remedy: "Check the project's chant source and environment — see the message above for chant's own error.",
  };
}

/** Thrown by `runChantJson`/`ciPipeline` on a non-zero chant exit. `message`
 * stays the same "chant <args> exited <code>: <stderr>" text a plain `Error`
 * always carried here (so any existing `err instanceof Error ? err.message :
 * …` caller is unaffected); `failure` is the classification (#72) a route can
 * read straight off the caught error instead of re-parsing the message. */
export class ChantCliError extends Error {
  readonly failure: ChantFailure;
  constructor(args: string[], code: number, stderr: string) {
    super(`chant ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
    this.name = "ChantCliError";
    this.failure = classifyChantFailure(stderr);
  }
}

async function runChantJson<T>(args: string[], projectDir?: string, envOverride?: Record<string, string>): Promise<T> {
  const { code, stdout, stderr } = await runChantRaw(args, projectDir, envOverride);
  if (code !== 0) throw new ChantCliError(args, code, stderr);
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

/** Graph the project's source (#71, extended #76): honors `chant.config.ts`'s
 * `sourceDir` (via `detectProject`, `src/project.ts`) — the project's own
 * declared infra source dir, relative to the project root — instead of
 * guessing a hardcoded `src/` convention. Falls back to `legacyGraphPath`'s
 * `src/`-then-root heuristic when the config can't be read, or doesn't
 * declare `sourceDir`. loomster sets `sourceDir: "src"` explicitly, so it
 * resolves the same path either way — unaffected.
 *
 * Multi-stack (`stacks[]`, #76 — the stack picker's backing resolution): when
 * the project declares `stacks[]`, `sourceDir` is NOT consulted — a
 * multi-stack project's independently-deployed stacks are the whole point,
 * so this always resolves to one of THEM. `opts.stack`, when it names a
 * declared stack (the picker's selection, threaded from `?stack=` — see
 * `server.ts`'s `optsFromQuery`), resolves that stack's `src`; otherwise (no
 * selection, or a name matching no declared stack) it defaults to the FIRST
 * declared stack — the picker's default, same convention as the env/tier
 * lenses defaulting to "nothing picked yet" rather than erroring. A project
 * that declares no `stacks[]` at all ignores `opts.stack` entirely and keeps
 * today's `sourceDir`/legacy resolution — completely unaffected.
 *
 * `opts` is optional so `graphPath(dir)` (no lens) keeps working exactly as
 * before — every caller that doesn't care about the stack lens, and #71's
 * existing single-arg unit tests.
 *
 * The spawn cwd stays the project dir, which is what `--live` reads.
 * Exported for testing. */
export async function graphPath(projectDir: string, opts: GraphOptions = {}): Promise<string> {
  let info: Awaited<ReturnType<typeof detectProject>>;
  try {
    info = await detectProject(projectDir);
  } catch {
    // Config unreadable (unexpected — detectProject itself already falls
    // back internally) — use the legacy heuristic outright.
    return legacyGraphPath(projectDir);
  }

  if (info.stacks?.length) {
    const picked = opts.stack ? info.stacks.find((s) => s.name === opts.stack) : undefined;
    return resolve(projectDir, (picked ?? info.stacks[0]!).src);
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
 * resources. `opts` (including the stack picker, #76) threads through to
 * `graphPath` so a multi-stack project's picked stack resolves the right
 * source, same as the tier/target lenses already thread into `graphFlags`/
 * `envOverridesFor` below. */
export async function graphIr(projectDir: string, opts: GraphOptions = {}): Promise<GraphIR> {
  const src = await graphPath(projectDir, opts);
  const ir = await runChantJson<GraphIR>(graphArgs(src, "ir", opts, false), projectDir, envOverridesFor(opts));
  // chant#2058: chant joins Ops from the git root, so a project sharing a
  // repository with other chant projects graphs their Ops too. Dropped here,
  // at the one read every entity graph goes through, and named on the note.
  return dropForeignDeclarations(ir, projectDir);
}

/**
 * The graph IR of a project's `cluster/` build root, or undefined when the
 * project has none (or chant can't graph it).
 *
 * A k3d/floci-backed estate declares its local cluster as chant source — but
 * deliberately OUTSIDE `sourceDir`, as its own build root (`chant build
 * cluster`), so whole-project discovery never walks it (fountain-ops and
 * kubemicrovm-ops both follow this shape). That kept the cluster out of every
 * behold view: the k8s half rendered inside a synthetic `cluster <env>` box
 * while the estate's actual `K3d::Cluster` declaration existed two directories
 * away. This reads that root the same way the estates' own justfiles do.
 *
 * Failure is an ordinary state, not an error: most projects have no cluster
 * root, and a chant predating the k3d lexicon can't graph one. Both yield
 * undefined and the caller renders exactly what it rendered before.
 */
export async function clusterRootGraphIr(projectDir: string, opts: GraphOptions = {}): Promise<GraphIR | undefined> {
  if (!existsSync(join(projectDir, "cluster"))) return undefined;
  // Source graph only, always. `--live` ignores the path positional (verified
  // on kubemicrovm-ops: `graph cluster --live --overlay` returns the WHOLE
  // estate's live overlay, k3d node absent), so a live read here would
  // duplicate the main graph instead of scoping to the root. Status for the
  // declared cluster is painted by the caller from the k3d probe instead
  // (src/cluster-root.ts).
  const { live: _live, overlay: _overlay, env: _env, ...sourceOnly } = opts;
  try {
    return await runChantJson<GraphIR>(graphArgs("cluster", "ir", sourceOnly, false), projectDir, envOverridesFor(sourceOnly));
  } catch {
    return undefined;
  }
}

/** Node positions for a project (`chant graph --format layout`, dagre — no native dep). */
export async function graphLayout(projectDir: string, opts: GraphOptions = {}): Promise<Layout> {
  const src = await graphPath(projectDir, opts);
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
  const src = await graphPath(projectDir, opts);
  return runChantJson<GraphIR>(graphArgs(src, "ir", opts, true), projectDir, envOverridesFor(opts));
}

/** Node positions for the component DAG (`chant graph --components --format layout`). */
export async function componentGraphLayout(projectDir: string, opts: GraphOptions = {}): Promise<Layout> {
  const src = await graphPath(projectDir, opts);
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
  /** The environment the pipeline deploys — on the generated JSON since chant
   * 0.54.0 (chant#2046), where the workflow is also named for it
   * ({@link ciWorkflowName}). Absent from an older chant's output, in which
   * case two envs' pipelines are indistinguishable to any reader. */
  env?: string;
}

/** The `name:` chant 0.54.0 writes on a generated GitHub/Forgejo workflow —
 * `chant-components-<env>` — the identity behold's picker matches on
 * (chant#2046). Pure. */
export function ciWorkflowName(env: string): string {
  return `chant-components-${env}`;
}

/** The raw shape of `chant build --components --generate gitlab --format
 * json` (verified against loomster, M1.2 spike): `jobs` carries the graph
 * shape (stage/needs) per component, but not the script — that lives only in
 * the embedded, already-generated `yaml` (parsed out below). */
interface GitlabGenerateJson {
  stages: string[];
  jobs: Array<{ jobName: string; component: string; stage: string; needs: string[] }>;
  yaml: string;
  /** chant ≥ 0.54.0 (chant#2046). */
  env?: string;
}

/** The lexicons that can generate a component pipeline — chant's own list
 * ("GitLab, GitHub, and Forgejo are supported today", components/cli-support.ts),
 * and the names a project declares them under in `chant.config.ts`. */
export const CI_FORGES = ["gitlab", "github", "forgejo"] as const;
export type CiForge = (typeof CI_FORGES)[number];

/** The forge a project's CI facet should be generated for, or undefined when it
 * declares none.
 *
 * behold used to ask for `gitlab` unconditionally. A project that declares no
 * forge lexicon has nothing to generate from, so chant refused with `Lexicon
 * "gitlab" does not support generate mode` — a 500 per lens, for a facet that
 * simply does not apply. A project on GitHub got asked for GitLab, which is the
 * same mistake with a worse failure mode: it fails for a project that does have
 * a pipeline. Pure. */
export function ciForgeFor(lexicons: readonly string[]): CiForge | undefined {
  return CI_FORGES.find((forge) => lexicons.includes(forge));
}

/** Build the `chant build --components --generate <forge> --format json` argv.
 * `--format json` is the structured read (verified against loomster's chant
 * `--help`: "build: json (default) or yaml") — preferred over parsing the
 * plain YAML chant prints by default, which would need line-scraping to find
 * each job's stage/needs. Pure; exported for testing. */
export function ciPipelineArgs(opts: GraphOptions = {}, forge: CiForge = "gitlab"): string[] {
  const args = ["build", "--components", "--generate", forge, "--format", "json"];
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
  // chant#2046 put `env` on the generator's result; the CLI's `--format json`
  // printer drops it (only stages/jobs/yaml reach stdout — filed upstream), so
  // the env is read off the YAML chant 0.54 also writes it into: the
  // workflow's `name: chant-components-<env>`, or its `env.CHANT_ENV`.
  const fromJson = typeof parsed.env === "string" && parsed.env ? parsed.env : undefined;
  const env = fromJson ?? pipelineEnvFromYaml(doc);
  return { stages: parsed.stages, jobs, ...(env ? { env } : {}) };
}

/** The env a generated workflow document names (chant ≥ 0.54.0): the
 * `chant-components-<env>` name first, `env.CHANT_ENV` second. Pure. */
export function pipelineEnvFromYaml(doc: Record<string, unknown> | undefined): string | undefined {
  const name = doc?.name;
  if (typeof name === "string") {
    const m = /^chant-components-(.+)$/.exec(name);
    if (m) return m[1];
  }
  const env = doc?.env;
  if (env && typeof env === "object" && typeof (env as Record<string, unknown>).CHANT_ENV === "string") {
    return (env as Record<string, string>).CHANT_ENV;
  }
  return undefined;
}

/** The CI projection facet for a project's components: shells `chant build
 * --components --generate gitlab --format json` for the served project and
 * returns each component's {stage, needs, script} — read-only, joined onto
 * the component-DAG nodes (#56) by component name. Same shell-out shape as
 * `componentGraphIr`; requires a chant that ships generate mode (chant #563,
 * ships well before the M1.0 spike's 0.18.27 pin, so no extra version gate). */
export function ciPipeline(projectDir: string, opts: GraphOptions = {}, forge: CiForge = "gitlab"): Promise<CiPipeline> {
  const args = ciPipelineArgs(opts, forge);
  return runChantRaw(args, projectDir, envOverridesFor(opts)).then(({ code, stdout, stderr }) => {
    if (code !== 0) throw new ChantCliError(args, code, stderr);
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

/** Why chant could not read live state for a declared entity (chant#1168,
 * #1089's tri-state observation contract) — reproduced from chant's own
 * `UnobservedReason` (observation.ts). Total: `unobservedReason` below is
 * always one of these when set. */
export type UnobservedReason = "read-failed" | "no-credentials" | "no-binding" | "unsupported-kind" | "filtered";

/** Why an effect proposes a fire (chant#1832) — reproduced from chant's own
 * `EffectFireReason` (lifecycle/change-set.ts), same as `UnobservedReason`
 * above. Total: `effectReason` below is always one of these when set. */
export type EffectFireReason = "receipt-absent" | "receipt-stale" | "unresolved-input";

/** How much applying one pending change hurts (chant#1665, shipped chant 0.51)
 * — reproduced from chant's own `Disruption` (lifecycle/disruption.ts), same
 * as the two reasons above. Total: `disruption` below is always one of these
 * when set.
 *
 * - `in-place` — the provider mutates the existing resource. No new identity.
 * - `rolling` — the resource survives, its workload is replaced incrementally
 *   (a Deployment's pod template changing).
 * - `replace` — a new resource is built and the old one removed; the physical
 *   id changes.
 * - `destroy` — replacement that removes the old resource FIRST, so there is a
 *   window with nothing in it.
 * - `unknown` — nobody could say. chant's default and its ONLY fallback: no
 *   classifier, a classifier that stayed silent, threw, or answered off-
 *   vocabulary all land here, which is why there is no path to an accidental
 *   `in-place`. Read it as "unclassified", never as "probably fine" — behold
 *   must never paint it the way it paints `in-place`. */
export type Disruption = "in-place" | "rolling" | "replace" | "destroy" | "unknown";

/** One entity-level entry from `chant lifecycle plan` — chant's own
 * `ChangeSetEntry` (lifecycle/change-set.ts), reproduced here rather than
 * imported so this module doesn't reach past chant's public `@intentius/chant`
 * export surface for an internal lifecycle type. `name` is the chant entity
 * name — the same identifier the entity graph IR's node `id` uses, which is
 * how src/reconcile.ts correlates an entry to a component. That holds for a
 * DECLARED entity only: chant#1674 spelled out that on an undeclared live
 * resource (`adopt`, `delete`, `runtime`) `name` is the lexicon's live key and
 * joins to no IR node, so those rows land in `summarizePlan`'s uncorrelated
 * count by design. `physicalId` (also chant#1674) is the provider id for them
 * if behold ever wants to name them in the UI.
 *
 * `action: "unobserved"` (chant#1168, #1089) is additive — a chant predating
 * that fix never emits it, so every existing plan (and consumer) is
 * unaffected. It means chant could not read this declared entity's live
 * state: neither a proposal to create it nor evidence it's already in sync —
 * see `unobservedReason`/`unobservedDetail` for why, and src/reconcile.ts's
 * `summarizePlan` for how it's kept out of the pending-change count. Likewise
 * `evidence.observed` is additive: absent from an older chant's plan, and
 * `false` only alongside `action: "unobserved"` (a read that never happened,
 * not a confirmed absence).
 *
 * `action: "runtime"` (chant#1180, #1077) is the same kind of additive
 * widening: a live, undeclared resource whose owner-reference chain reaches a
 * declared entity — a Pod a declared Deployment's controller created, for
 * instance. Not drift, not an adopt/delete candidate: the runtime doing its
 * job. `runtimeOwner` names the declared entity it belongs to. A chant
 * predating #1180 never emits this action, so every existing plan is
 * unaffected; src/reconcile.ts's `summarizePlan` keeps it out of both the
 * pending-change count and the in-sync (`noop`) one — see chant#1180's own
 * note that behold's `LifecyclePlanEntry` union needed widening for this,
 * same as #1168's `"unobserved"` before it.
 *
 * `action: "effect"` (chant#1832) is the third such widening — an effect whose
 * receipt is absent, stale, or whose inputs could not resolve at plan time, so
 * the next apply fires it. Unlike `"unobserved"` and `"runtime"`, this one IS
 * pending work: applying the plan runs something. So `summarizePlan` leaves it
 * in the ordinary pending count rather than giving it a bucket, which matches
 * chant's own `ACTION_ORDER` (it sorts `effect` with create/update/delete, not
 * with the inert noop/runtime/unobserved tail). chant excludes it from the
 * GitLab MR widget only because that widget has three columns and no fourth to
 * put it in — not because a fire is a non-change.
 *
 * `disruption` (chant#1665, chant 0.51) is additive in the other direction: a
 * new FIELD rather than a new action, and only on `update` entries — every
 * other action carries its blast radius in the action itself. A chant
 * predating it never sets it, so an older plan reads exactly as it did
 * before. That backward compatibility is also the trap: absence means the
 * plan was never classified, NOT that the change is safe, so nothing
 * downstream may treat a missing `disruption` as `in-place` (src/reconcile.ts
 * counts only entries that carry a verdict; web/app.js tints only those). */
export interface LifecyclePlanEntry {
  name: string;
  type?: string;
  /** The lexicon whose observation produced this entry (chant#1674) — the
   * attribution that survives `lifecycle plan`'s merge of every lexicon's
   * change set into one `entries[]`. */
  lexicon?: string;
  /** Provider-assigned physical id (ARN, resource id, pod name) from the live
   * observation (chant#1674). The only stable handle on an `adopt`/`delete`/
   * `runtime` row, whose `name` joins to no IR node — see above. */
  physicalId?: string;
  action: "create" | "update" | "delete" | "adopt" | "noop" | "unobserved" | "runtime" | "effect";
  evidence: { declared: boolean; inSnapshot: boolean; live: boolean; observed?: boolean };
  deltas?: Array<{ path: string; oldValue: unknown; newValue: unknown }>;
  ownership: "owned" | "foreign" | "unknown";
  /** Why the entity could not be observed — set only when `action ===
   * "unobserved"`. */
  unobservedReason?: UnobservedReason;
  /** Human-readable backing for `unobservedReason` (the failing command, the
   * missing binding key, the unsupported kind). */
  unobservedDetail?: string;
  /** The declared entity this resource's owner-reference chain resolves to —
   * set only when `action === "runtime"` (chant#1180, #1077). */
  runtimeOwner?: string;
  /** The effect a receipt witnesses (chant#1832) — names what will fire on
   * `action === "effect"`, and keeps the attribution on a receipt's
   * `noop`/`unobserved` rows. */
  effect?: string;
  /** Why the effect fires — set only when `action === "effect"`. */
  effectReason?: EffectFireReason;
  /** Human-readable backing for `effectReason` (the digests that differ, the
   * unresolved path). */
  effectDetail?: string;
  /** What applying this change costs (chant#1665) — set only when `action ===
   * "update"`, and only by a chant that classifies. The verdict is the
   * owning lexicon's, never chant core's and never behold's. */
  disruption?: Disruption;
  /** The attribute paths that forced `disruption` — the create-only property
   * behind a `replace`, say. A subset of `deltas`' `path`s. */
  disruptionBecause?: string[];
  /** Human-readable backing for `disruption`: the spec knowledge behind the
   * call, or why there is none (an `unknown` says which). */
  disruptionDetail?: string;
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
// Artifact observation (behold#146) — the helm lens's live half. A Helm
// release is an artifact in chant's vocabulary, not a resource: it has no
// declared axis, so it never enters `graph --live --overlay`'s managed/
// foreign/pending classification. The one chant read that observes it is
// `lifecycle diff --live --json`, whose `lexicons.<name>.observedArtifacts`
// (chant#1516) carries what `listArtifacts` actually saw — status, chart,
// revision. behold joins those onto declared `Helm::Chart` nodes by chart
// name (src/helm-artifacts.ts) and never invents nodes for releases that
// match no declared chart.
// ---------------------------------------------------------------------------

/** One observed artifact from `lifecycle diff --live --json` — chant's own
 * `ArtifactMetadata` (lexicon.ts), reproduced here rather than imported, same
 * as `LifecyclePlanEntry` above. */
export interface LiveArtifactObservation {
  type?: string;
  physicalId?: string;
  status?: string;
  attributes?: Record<string, unknown>;
}

/** The slice of `chant lifecycle diff <env> --live --json` behold reads. */
export interface LifecycleDiffLive {
  environment?: string;
  lexicons?: Record<string, { observedArtifacts?: Record<string, LiveArtifactObservation> }>;
}

/** Build the `chant lifecycle diff <env> --live --json` argv. Pure; exported
 * for testing. */
export function lifecycleDiffArgs(env: string): string[] {
  return ["lifecycle", "diff", env, "--live", "--json"];
}

/** The live artifact observations for `env`, keyed `release/<ns>/<name>` for
 * helm. Read-only, like every shell-out here. A chant predating #1516 returns
 * no `observedArtifacts` — callers treat that as "not observed" (unobserved ≠
 * absent), never as "no releases". */
export function lifecycleDiffLive(projectDir: string, env: string, opts: GraphOptions = {}): Promise<LifecycleDiffLive> {
  return runChantJson<LifecycleDiffLive>(lifecycleDiffArgs(env), projectDir, envOverridesFor(opts));
}

// ---------------------------------------------------------------------------
// Helm render diff (#146's deferred half) — the release's DRIFT axis.
//
// #146 shipped the helm lens as artifact presence only, and said so: at the
// time `listArtifacts` was helm's only lifecycle hook, so "is this release
// installed" was the whole reachable verdict. chant 0.49 (chant#1249 offline,
// chant#1250 live; epic chant#1228 Phase 6) added a second hook, and 0.52.1 —
// what behold's root now pins — carries it:
//
//   chant helm renders --json
//     -> { records: HelmRenderRecord[], stability }
//        every HelmRender the project declares. `contentDigest` is present
//        ONLY on a pinned render (one with a declared capabilityProfile);
//        an unpinned render's bytes are a function of the local helm
//        binary's defaulted capabilities, so it has no content identity.
//
//   chant helm diff <content-digest> <env> --live --json
//     -> { contentDigest, environment, manifest, diff }
//        `manifest` is the stored RenderManifest (the provenance record:
//        inputDigest/valuesDigest/contentDigest, capabilityProfile, helmVersion,
//        chantVersion, renderedAt, sourceRef); `diff` is core's own
//        DeepDiffResult — the SAME shape and vocabulary the k8s deep drift
//        read produces, property by property.
//        Exits 1 with a stderr line when the store has never seen the digest,
//        rather than reporting a false clean diff.
//
// Both are ordinary shell-outs to the project-local chant, like every other
// read here — behold links no chant library and holds no cluster credentials.
// The command group is mounted by the helm lexicon's own plugin, so a project
// that does not install `@intentius/chant-lexicon-helm` has no `chant helm`
// at all: that read fails, and the lens stays exactly where #146 left it.
//
// The offline half (`chant helm diff <from> <to> --json`, render-to-render) is
// NOT wired here — see src/helm-drift.ts's header for why.
// ---------------------------------------------------------------------------

/** One `HelmRender` the project declares, as `chant helm renders --json`
 * reports it — chant's own `HelmRenderRecord` (lexicons/helm/src/render.ts),
 * reproduced rather than imported, same as `LiveArtifactObservation` above.
 * `contentDigest`/`inputDigest` are present only on a PINNED render. */
export interface HelmRenderRecord {
  /** The render's logical name — also the helm release name baked into the bytes. */
  name: string;
  chart: string;
  version?: string;
  capabilityProfile?: { name?: string; kubeVersion?: string; apiVersions?: string[] };
  inputDigest?: string;
  contentDigest?: string;
  coalescedValuesDigest?: string;
}

/** The `chant helm renders --json` payload. `stability` is the lexicon's own
 * render-stability report; behold reads only `records`, but the field is
 * carried so the shape stays honest about what the command returns. */
export interface HelmRendersReport {
  records?: HelmRenderRecord[];
  stability?: unknown;
}

/** `chant carve status --from <dir> --json` (chant#2038, chant ≥ 0.54.0): every
 * carve manifest under `from`, found by chant's own walk. A core command, so
 * any chant at the floor answers it — the project's own when it has one,
 * behold's bundled one otherwise. Shape: src/carve-manifest.ts `CarveStatusJson`. */
export function carveStatus(from: string, projectDir?: string): Promise<CarveStatusJson> {
  return runChantJson<CarveStatusJson>(carveStatusArgs(from), projectDir);
}

/** Build the `chant helm renders --json` argv. Pure; exported for testing. */
export function helmRendersArgs(): string[] {
  return ["helm", "renders", "--json"];
}

/** The HelmRender declarations of the project at `projectDir`. Rejects with a
 * `ChantCliError` when the project has no `chant helm` command group (the
 * helm lexicon is not installed) — callers treat that as "no render axis
 * here", never as "no renders". */
export function helmRenders(projectDir: string, opts: GraphOptions = {}): Promise<HelmRendersReport> {
  return runChantJson<HelmRendersReport>(helmRendersArgs(), projectDir, envOverridesFor(opts));
}

/** The stored `RenderManifest` for a pinned render — chant's own shape
 * (lexicons/helm/src/render-store.ts). Everything below `contentDigest` is
 * the provenance record: what was rendered, from which inputs, by which helm
 * and chant, against which cluster profile. */
export interface HelmRenderManifest {
  version?: number;
  chart: string;
  chartVersion: string | null;
  repo: string | null;
  releaseName: string;
  namespace: string | null;
  valuesDigest: string;
  inputDigest: string;
  capabilityProfile: { cluster: string; kubeVersion: string; apiVersions: string[] };
  contentDigest: string;
  /** Documents in the canonical stream, including any the index could not identify. */
  docCount: number;
  documents: { kind: string; apiVersion?: string; name: string; namespace: string | null; source?: string | null; digest: string }[];
  renderedAt: string;
  /** The helm binary that produced the bytes — what explains a digest mismatch between two machines. */
  helmVersion: string;
  chantVersion: string;
  /** Source ref/commit, when the render's caller supplied one. Never fabricated. */
  sourceRef: string | null;
  coalescedValuesDigest?: string | null;
}

/** One property difference between the pinned render and live. Core's own
 * `PropertyDrift` — the same rows the k8s deep-drift read produces, which is
 * why the UI can render them with the field-drift vocabulary it already has. */
export interface HelmPropertyDrift {
  path: string;
  kind: "changed" | "undeclared" | "absent";
  declared?: unknown;
  live?: unknown;
  owner?: string;
}

/** Core's `DeepDiffResult`, as `chant helm diff --live --json` carries it. */
export interface HelmRenderDiff {
  drifted: { name: string; type: string; changes: HelmPropertyDrift[] }[];
  accepted: { name: string; type: string; changes: HelmPropertyDrift[] }[];
  unchanged: string[];
  unobserved: { name: string; reason: string; detail?: string }[];
  undeclaredEntities: string[];
}

/** The `chant helm diff <digest> <env> --live --json` payload. */
export interface HelmRenderLiveDiff {
  contentDigest: string;
  environment: string;
  manifest: HelmRenderManifest;
  diff: HelmRenderDiff;
}

/** Build the `chant helm diff <content-digest> <env> --live --json` argv.
 * Pure; exported for testing. */
export function helmRenderDiffArgs(contentDigest: string, env: string): string[] {
  return ["helm", "diff", contentDigest, env, "--live", "--json"];
}

/** Diff one pinned render against the live cluster `env` binds to.
 *
 * Resolves `undefined` — never throws, never a partial object — on any
 * non-zero exit. The load-bearing case is chant's own refusal: a digest the
 * render store has never seen exits 1 rather than reporting a clean diff,
 * because an unpinned render was never persisted and has no stable bytes to
 * compare. `undefined` therefore means "not compared", and src/helm-drift.ts
 * must never let that reach the graph as "in sync". */
export async function helmRenderDiffLive(
  projectDir: string,
  contentDigest: string,
  env: string,
  opts: GraphOptions = {},
): Promise<HelmRenderLiveDiff | undefined> {
  const args = helmRenderDiffArgs(contentDigest, env);
  const { code, stdout } = await runChantRaw(args, projectDir, envOverridesFor(opts));
  if (code !== 0) return undefined;
  try {
    return JSON.parse(stdout) as HelmRenderLiveDiff;
  } catch {
    return undefined;
  }
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
