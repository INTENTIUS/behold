/**
 * The demo catalog (#209) — `demos.json`, shipped in the npm package beside
 * dist/. `behold demo --list` prints it; `behold demo <name>` loads an entry:
 * bundled (copied out of the tarball) or git (shallow-cloned). The registry
 * is data so growing the catalog (fountain #210, flux-estate #211) is a JSON
 * entry, not CLI surgery.
 *
 * #388 adds the second catalog and the third source. `workbench.json`, read
 * beside `demos.json` and NOT in the npm `files` list, is a checkout's own
 * catalog: the internal estates behold is developed against, named by relative
 * path from the file that lists them (`../choudoufu`, `../waterpark`), so the
 * file is committed and reproducible and an entry nobody has checked out is
 * unsatisfiable exactly as a missing binary is. `BEHOLD_WORKBENCH=<file>`
 * names a catalog somewhere else. A `local` entry serves a directory on this
 * machine: copied to `behold-demos/<name>` (the bundled semantics — it's
 * yours, edit it), served where it is (`inPlace`), or rendered into an empty
 * target by its own `setup` when it names no path at all.
 */
import { readFileSync, existsSync, cpSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** #372: environment the served estate's choudoufu spawns get — the scratch
   * emulator the demo's setup booted, and the dummy credentials it accepts.
   * Applied through `setChoudoufuSpawnEnv`, never `process.env`. */
  spawnEnv?: Record<string, string>;
}

/** Which catalog file an entry came from (#388): `demos.json`, shipped in the
 * package, or `workbench.json`, this checkout's own. */
export type DemoCatalog = "demos" | "workbench";

export interface DemoEntry {
  name: string;
  description: string;
  source: "bundled" | "git" | "local";
  /** bundled: the directory inside the package to copy out. */
  dir?: string;
  /** git: the public repo to shallow-clone. */
  repo?: string;
  /** local (#388): the directory on this machine, relative to the directory
   * of the catalog file that named it (the intentius checkouts are siblings,
   * so `../choudoufu` is what a workbench entry writes) or absolute. Optional:
   * an entry with no `path` and a `setup` is a GENERATOR entry, whose setup
   * renders the estate into the empty target — estate-gen, terralith-gen. */
  path?: string;
  /** local (#388): serve `path` where it is, no copy. Default false, which is
   * the bundled semantics: copy to `behold-demos/<name>` first, because
   * anything whose setup writes into the tree (`init`, `apply`, a rendered
   * generator) is copied or generated into the target, never run in a
   * checkout. An `inPlace` entry with a `setup` must say so in its
   * description — the setup is running in somebody's working copy. */
  inPlace?: boolean;
  /** Binaries that must be on PATH before this demo can run. */
  requires: string[];
  /** Optional post-install shell command, run in the target (posix shell). */
  setup?: string;
  serve: DemoServe;
  /** Which catalog listed this entry (#388). Stamped by `loadDemoRegistry`;
   * absent on an entry a test built by hand, which reads as `demos`. */
  catalog?: DemoCatalog;
  /** The directory of the catalog file that listed it — what `path` resolves
   * against, and what `setup` gets as `BEHOLD_WORKBENCH_DIR`. Stamped by
   * `loadDemoRegistry`. */
  catalogDir?: string;
}

/** Read + validate one catalog file, stamping every surviving entry with the
 * catalog it came from and the directory it was read from. A malformed entry
 * is dropped (a registry typo must never break `behold demo` wholesale); a
 * missing/corrupt file reads as an empty catalog. */
function readCatalog(file: string, catalog: DemoCatalog): DemoEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = (raw as { demos?: unknown })?.demos;
  if (!Array.isArray(list)) return [];
  const catalogDir = dirname(resolve(file));
  return list
    .filter((e): e is DemoEntry => validEntry(e))
    .map((e) => ({ ...e, catalog, catalogDir }));
}

function validEntry(e: unknown): e is DemoEntry {
  const d = e as DemoEntry;
  if (!d || typeof d.name !== "string" || !d.name || typeof d.description !== "string") return false;
  if (d.source === "bundled") {
    if (typeof d.dir !== "string" || !d.dir) return false;
  } else if (d.source === "git") {
    if (typeof d.repo !== "string" || !d.repo) return false;
  } else if (d.source === "local") {
    // #388: a path, or a setup that renders one into the empty target. An
    // entry with neither names nothing to serve, and `inPlace` with no path
    // has no place to serve in.
    if (d.path !== undefined && (typeof d.path !== "string" || !d.path)) return false;
    if (d.inPlace !== undefined && typeof d.inPlace !== "boolean") return false;
    if (!d.path && !d.setup) return false;
    if (d.inPlace && !d.path) return false;
  } else {
    return false;
  }
  if (!Array.isArray(d.requires) || d.requires.some((r) => typeof r !== "string")) return false;
  if (!d.serve || typeof d.serve !== "object") return false;
  if (d.serve.dirs !== undefined && (!Array.isArray(d.serve.dirs) || d.serve.dirs.some((x) => typeof x !== "string") || !d.serve.dirs.length)) return false;
  // #372: a spawn environment is a flat string map or nothing.
  if (
    d.serve.spawnEnv !== undefined &&
    (typeof d.serve.spawnEnv !== "object" || d.serve.spawnEnv === null || Array.isArray(d.serve.spawnEnv) || Object.values(d.serve.spawnEnv).some((v) => typeof v !== "string"))
  )
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
}

/**
 * The whole catalog: `demos.json`, then `workbench.json` beside it, then the
 * file `BEHOLD_WORKBENCH` names (#388). One registry, so `--list`, the panel
 * and `demo <name>` all read the same thing.
 *
 * A workbench name that collides with one already in the catalog is dropped
 * with a stderr line rather than shadowing it: `behold demo writes` must mean
 * the same demo in every checkout, and a silent override is how it would stop
 * meaning it.
 */
export function loadDemoRegistry(pkgRoot: string): DemoEntry[] {
  const merged = readCatalog(join(pkgRoot, "demos.json"), "demos");
  const seen = new Set(merged.map((e) => e.name));
  const named = process.env.BEHOLD_WORKBENCH;
  for (const e of [...readCatalog(join(pkgRoot, "workbench.json"), "workbench"), ...(named ? readCatalog(resolve(named), "workbench") : [])]) {
    if (seen.has(e.name)) {
      process.stderr.write(`behold: workbench entry "${e.name}" collides with a demo already in the catalog — dropped\n`);
      continue;
    }
    seen.add(e.name);
    merged.push(e);
  }
  return merged;
}

/** A `local` entry's directory, absolute: `path` as given when it is
 * absolute, else resolved against the catalog file's own directory — the
 * workbench names its siblings (`../choudoufu`), and a path relative to
 * whatever cwd behold was started in would mean a different estate per
 * terminal. Undefined for every other source, and for a generator entry
 * (no `path`), whose estate does not exist until its setup renders it. */
export function demoLocalPath(entry: DemoEntry): string | undefined {
  if (entry.source !== "local" || !entry.path) return undefined;
  return isAbsolute(entry.path) ? entry.path : resolve(entry.catalogDir ?? process.cwd(), entry.path);
}

/** Which of an entry's required binaries are NOT on PATH — plus, for a `local`
 * entry (#388), a `path` nobody has checked out. `git` is an implicit
 * requirement of every git-sourced entry. `choudoufu` is satisfied by a
 * `CHOUDOUFU_BIN` that names an existing file, since the build that carries
 * behold's floor is one somebody built from main, not one on PATH. */
export function missingRequirements(entry: DemoEntry): string[] {
  const bins = entry.source === "git" && !entry.requires.includes("git") ? [...entry.requires, "git"] : entry.requires;
  const finder = process.platform === "win32" ? "where" : "which";
  const missing = bins.filter((bin) => {
    if (bin === "choudoufu" && process.env.CHOUDOUFU_BIN && existsSync(process.env.CHOUDOUFU_BIN)) return false;
    return spawnSync(finder, [bin], { stdio: "ignore" }).status !== 0;
  });
  // An unchecked-out sibling reads exactly like a missing binary: the entry
  // stays in the listing, disabled, saying what is absent, and CI stays clean.
  const local = demoLocalPath(entry);
  if (local && !existsSync(local)) missing.push(`${entry.path} (not checked out)`);
  return missing;
}

/** Does loading this entry reach the network? A git entry is cloned, which is
 * the one demo step that leaves the machine — the CLI says so as it runs and
 * the panel's button (#268) says so BEFORE it runs. A bundled entry's copy is
 * local; its `setup` may still pull images, which the description carries. A
 * `local` entry is a directory already on this machine (#388), so it never
 * fetches either. */
export function fetchesFromNetwork(entry: DemoEntry): boolean {
  return entry.source === "git";
}

/** Where a demo lands when the caller doesn't name a directory — absolute, so
 * the CLI and the panel route agree on "is this demo already loaded?".
 * `behold-demo` (the pre-catalog #193 default) is reused for the writes demo
 * when it exists, so an existing copy keeps working; everything else lands
 * under `behold-demos/<name>`. An `inPlace` entry (#388) has no target of its
 * own: it IS its path, which is what makes "already loaded" true for it and
 * keeps `behold-demos/` free of a copy nothing serves. */
export function demoTargetDir(entry: DemoEntry, cwd: string = process.cwd()): string {
  const inPlace = entry.inPlace ? demoLocalPath(entry) : undefined;
  if (inPlace) return inPlace;
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
  const local = demoLocalPath(entry);
  // #388: an in-place entry is served where it sits, so nothing below writes a
  // copy and `work` is the checkout itself. Everything else works in `target`.
  const inPlace = entry.source === "local" && entry.inPlace;
  const work = inPlace ? local! : target;
  if (inPlace) {
    if (!existsSync(work)) return { ok: false, error: `${entry.path} is not checked out (looked in ${work})` };
    say(`serving ${work} where it is — nothing copied`);
  } else if (!existsSync(target)) {
    if (entry.source === "bundled" || (entry.source === "local" && local)) {
      const from = entry.source === "bundled" ? join(pkgRoot, entry.dir!) : local!;
      if (!existsSync(from)) return { ok: false, error: entry.source === "bundled" ? `this install has no bundled ${entry.dir}` : `${entry.path} is not checked out (looked in ${from})` };
      say(`copying to ${target} (it's yours — edit it)`);
      // Skip only node_modules INSIDE the example. The filter must test the
      // path relative to the copied root: in an npm install the example
      // itself lives under node_modules/@intentius/behold/, so a bare
      // `src.includes("node_modules")` matched every file and copied nothing.
      try {
        cpSync(from, target, {
          recursive: true,
          filter: (src) => !relative(from, src).split(sep).includes("node_modules"),
        });
      } catch (err) {
        return { ok: false, error: `copy failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else if (entry.source === "local") {
      // #388's third decision: a generator IS a source. The entry names no
      // path; its setup renders the estate into a target that starts empty.
      say(`rendering into ${target} (empty — the setup writes the estate)`);
      try {
        mkdirSync(target, { recursive: true });
      } catch (err) {
        return { ok: false, error: `could not make ${target}: ${err instanceof Error ? err.message : String(err)}` };
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
  // #390: an in-place entry is somebody's working copy, and `npm install`
  // there would leave a node_modules and a package-lock.json in a checkout
  // behold was only asked to read. It is served exactly as it sits; a project
  // that is not installed says so on its own card, the way `behold serve` does.
  if (!inPlace && existsSync(join(work, "package.json")) && !existsSync(join(work, "node_modules"))) {
    say("npm install…");
    if ((await runStep("npm", ["install"], { cwd: work, shell: process.platform === "win32" })) !== 0) {
      return { ok: false, error: `npm install failed in ${work}` };
    }
  }
  if (entry.setup) {
    say(entry.setup);
    // #388: a workbench setup reaches its siblings through the catalog file's
    // own directory (`$BEHOLD_WORKBENCH_DIR/../choudoufu`), never through the
    // cwd behold happened to start in; the name is there so one script can
    // serve several entries and name its scratch after the right one.
    const env = {
      ...process.env,
      BEHOLD_DEMO_NAME: entry.name,
      ...(entry.catalogDir ? { BEHOLD_WORKBENCH_DIR: entry.catalogDir } : {}),
    };
    if ((await runStep(entry.setup, [], { cwd: work, shell: true, env })) !== 0) {
      return { ok: false, error: `setup failed (${entry.setup})` };
    }
  }
  // #211: an estate demo serves several member projects composed; the first
  // listed is the primary, same as `behold serve a b c…`.
  return { ok: true, serveDirs: entry.serve.dirs?.length ? entry.serve.dirs.map((d) => join(work, d)) : [work] };
}

/** One child process, output inherited (git/npm/setup narrate themselves into
 * behold's own terminal). Resolves to the exit code; a spawn error is a
 * non-zero code, never a rejection. */
function runStep(cmd: string, args: string[], opts: { cwd?: string; shell?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: opts.cwd, shell: opts.shell ?? false, env: opts.env });
    child.on("error", () => res(-1));
    child.on("close", (code) => res(code ?? 1));
  });
}
