/**
 * The demo catalog (#209) — `demos.json`, shipped in the npm package beside
 * dist/. `behold demo --list` prints it; `behold demo <name>` loads an entry:
 * bundled (copied out of the tarball) or git (shallow-cloned). The registry
 * is data so growing the catalog (fountain #210, flux-estate #211) is a JSON
 * entry, not CLI surgery.
 */
import { readFileSync, existsSync, cpSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";

/**
 * #254: serve this demo as a carve walkthrough rather than a chant project —
 * `behold carve`'s mode, plus the estate context the stepper acts on. Every
 * path is relative to the copied demo root, and the copy is the only thing the
 * walkthrough's two write actions may touch (src/carve-actions.ts).
 */
export interface DemoCarve {
  /** The committed `carve advise --report` output, served if a fresh run fails. */
  report: string;
  /** The Terraform estate the advisor reads (`legacy-tf`). */
  from: string;
  /** The `.tfstate` that makes `carve advise`/`carve emit` work offline. */
  state?: string;
  /** The chant project whose own chant + lexicon run the steps (`app`). */
  project: string;
  /** Where emitted source and bridge proposals land. Must sit INSIDE `project`
   * — the emitted source imports the lexicon, and Node resolves that from
   * where the file sits, not from the cwd. */
  out: string;
}

export interface DemoServe {
  /** Serve with --local (boot the project's own emulators). */
  local?: boolean;
  /** Serve with --env <name> (the live overlay). */
  env?: string;
  /** #211: serve these subdirectories of the target as a composed estate
   * (`serve a b c…`) instead of the target itself. First is the primary. */
  dirs?: string[];
  /** #254: serve the carve walkthrough instead of a project graph. */
  carve?: DemoCarve;
}

export interface DemoEntry {
  name: string;
  description: string;
  source: "bundled" | "git";
  /** bundled: the directory inside the package to copy out. */
  dir?: string;
  /** git: the public repo to shallow-clone. */
  repo?: string;
  /** Binaries that must be on PATH before this demo can run. */
  requires: string[];
  /** Optional post-install shell command, run in the target (posix shell). */
  setup?: string;
  serve: DemoServe;
}

/** Read + validate the registry. A malformed entry is dropped (a registry
 * typo must never break `behold demo` wholesale); a missing/corrupt file
 * reads as an empty catalog. */
export function loadDemoRegistry(pkgRoot: string): DemoEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(pkgRoot, "demos.json"), "utf8"));
  } catch {
    return [];
  }
  const list = (raw as { demos?: unknown })?.demos;
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is DemoEntry => {
    const d = e as DemoEntry;
    if (!d || typeof d.name !== "string" || !d.name || typeof d.description !== "string") return false;
    if (d.source === "bundled") {
      if (typeof d.dir !== "string" || !d.dir) return false;
    } else if (d.source === "git") {
      if (typeof d.repo !== "string" || !d.repo) return false;
    } else {
      return false;
    }
    if (!Array.isArray(d.requires) || d.requires.some((r) => typeof r !== "string")) return false;
    if (!d.serve || typeof d.serve !== "object") return false;
    if (d.serve.dirs !== undefined && (!Array.isArray(d.serve.dirs) || d.serve.dirs.some((x) => typeof x !== "string") || !d.serve.dirs.length))
      return false;
    // #254: a carve entry names four relative paths, and a missing one would
    // mean a walkthrough whose Emit step has nowhere to write — drop the entry
    // rather than serve a half-wired demo. Every path stays relative: it is
    // joined onto the COPY, and an absolute one there would escape it.
    if (d.serve.carve !== undefined) {
      const c = d.serve.carve as Partial<DemoCarve> | null;
      const rel = (v: unknown): boolean => typeof v === "string" && !!v && !v.startsWith("/") && !v.split("/").includes("..");
      if (!c || typeof c !== "object") return false;
      if (!rel(c.report) || !rel(c.from) || !rel(c.project) || !rel(c.out)) return false;
      if (c.state !== undefined && !rel(c.state)) return false;
      // The emitted source imports the project's lexicon; Node resolves that
      // from the file's own directory upward, so an output dir outside the
      // project would never lint.
      if (!`${c.out}/`.startsWith(`${c.project}/`)) return false;
    }
    return true;
  });
}

/** Which of an entry's required binaries are NOT on PATH. `git` is an
 * implicit requirement of every git-sourced entry. */
export function missingRequirements(entry: DemoEntry): string[] {
  const bins = entry.source === "git" && !entry.requires.includes("git") ? [...entry.requires, "git"] : entry.requires;
  const finder = process.platform === "win32" ? "where" : "which";
  return bins.filter((bin) => spawnSync(finder, [bin], { stdio: "ignore" }).status !== 0);
}

/** Does loading this entry reach the network? A git entry is cloned, which is
 * the one demo step that leaves the machine — the CLI says so as it runs and
 * the panel's button (#268) says so BEFORE it runs. A bundled entry's copy is
 * local; its `setup` may still pull images, which the description carries. */
export function fetchesFromNetwork(entry: DemoEntry): boolean {
  return entry.source === "git";
}

/** Where a demo lands when the caller doesn't name a directory — absolute, so
 * the CLI and the panel route agree on "is this demo already loaded?".
 * `behold-demo` (the pre-catalog #193 default) is reused for the writes demo
 * when it exists, so an existing copy keeps working; everything else lands
 * under `behold-demos/<name>`. */
export function demoTargetDir(entry: DemoEntry, cwd: string = process.cwd()): string {
  const legacy = resolve(cwd, "behold-demo");
  if (entry.name === "writes" && existsSync(legacy)) return legacy;
  return resolve(cwd, "behold-demos", entry.name);
}

export interface DemoLoadOptions {
  /** The behold package root — where `demos.json` and the bundled examples live. */
  pkgRoot: string;
  /** Absolute directory to load the demo into (`demoTargetDir`, or a CLI arg). */
  target: string;
  /** Progress narration, one line at a time (no trailing newline). */
  log?: (line: string) => void;
}

export type DemoLoadResult = { ok: true; serveDirs: string[] } | { ok: false; error: string };

/** Copy/clone → npm install → setup: everything between "a catalog entry" and
 * "a directory that can be served". Shared by `behold demo <name>` (cli.ts)
 * and POST /api/demos/open (#268) so the panel's one-click demo is the same
 * path as the terminal's, not a second implementation of it.
 *
 * Idempotent: an existing target is reused, an already-installed one skips npm
 * install. Never exits the process and never throws — a failure comes back as
 * `{ok: false, error}` for the caller to print (CLI) or return as JSON (route).
 * Async, unlike the spawnSync original: the route runs this inside a live
 * server, and a multi-minute `npm install` must not block the event loop. */
export async function loadDemo(entry: DemoEntry, opts: DemoLoadOptions): Promise<DemoLoadResult> {
  const { pkgRoot, target } = opts;
  const say = (line: string): void => opts.log?.(`behold demo ${entry.name} → ${line}`);
  if (!existsSync(target)) {
    if (entry.source === "bundled") {
      const bundled = join(pkgRoot, entry.dir!);
      if (!existsSync(bundled)) return { ok: false, error: `this install has no bundled ${entry.dir}` };
      say(`copying to ${target} (it's yours — edit it)`);
      // Skip only node_modules INSIDE the example. The filter must test the
      // path relative to the bundled root: in an npm install the example
      // itself lives under node_modules/@intentius/behold/, so a bare
      // `src.includes("node_modules")` matched every file and copied nothing.
      try {
        cpSync(bundled, target, {
          recursive: true,
          filter: (src) => !relative(bundled, src).split(sep).includes("node_modules"),
        });
      } catch (err) {
        return { ok: false, error: `copy failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else {
      say(`cloning ${entry.repo} to ${target}`);
      if ((await runStep("git", ["clone", "--depth", "1", entry.repo!, target])) !== 0) {
        return { ok: false, error: `clone of ${entry.repo} failed` };
      }
    }
  } else {
    say(`reusing ${target}`);
  }
  if (existsSync(join(target, "package.json")) && !existsSync(join(target, "node_modules"))) {
    say("npm install…");
    if ((await runStep("npm", ["install"], { cwd: target, shell: process.platform === "win32" })) !== 0) {
      return { ok: false, error: `npm install failed in ${target}` };
    }
  }
  if (entry.setup) {
    say(entry.setup);
    if ((await runStep(entry.setup, [], { cwd: target, shell: true })) !== 0) {
      return { ok: false, error: `setup failed (${entry.setup})` };
    }
  }
  // #211: an estate demo serves several member projects composed; the first
  // listed is the primary, same as `behold serve a b c…`.
  return { ok: true, serveDirs: entry.serve.dirs?.length ? entry.serve.dirs.map((d) => join(target, d)) : [target] };
}

/** One child process, output inherited (git/npm/setup narrate themselves into
 * behold's own terminal). Resolves to the exit code; a spawn error is a
 * non-zero code, never a rejection. */
function runStep(cmd: string, args: string[], opts: { cwd?: string; shell?: boolean } = {}): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: opts.cwd, shell: opts.shell ?? false });
    child.on("error", () => res(-1));
    child.on("close", (code) => res(code ?? 1));
  });
}
