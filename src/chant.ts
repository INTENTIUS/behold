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
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { GraphIR, Layout } from "@intentius/chant";

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
    const proc = spawn(chantBin(projectDir), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function runChantJson<T>(args: string[], projectDir?: string): Promise<T> {
  const { code, stdout, stderr } = await runChantRaw(args, projectDir);
  if (code !== 0) throw new Error(`chant ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  return JSON.parse(stdout) as T;
}

/** The infra graph IR for a project (`chant graph --format ir`). */
export function graphIr(projectDir: string, opts: GraphOptions = {}): Promise<GraphIR> {
  return runChantJson<GraphIR>(["graph", projectDir, "--format", "ir", ...graphFlags(opts)], projectDir);
}

/** Node positions for a project (`chant graph --format layout`, dagre — no native dep). */
export function graphLayout(projectDir: string, opts: GraphOptions = {}): Promise<Layout> {
  return runChantJson<Layout>(["graph", projectDir, "--format", "layout", ...graphFlags(opts)], projectDir);
}
