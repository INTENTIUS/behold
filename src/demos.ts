/**
 * The demo catalog (#209) — `demos.json`, shipped in the npm package beside
 * dist/. `behold demo --list` prints it; `behold demo <name>` loads an entry:
 * bundled (copied out of the tarball) or git (shallow-cloned). The registry
 * is data so growing the catalog (fountain #210, flux-estate #211) is a JSON
 * entry, not CLI surgery.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
