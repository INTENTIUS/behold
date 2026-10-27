/**
 * behold#1027: where the graph pane finds its documents. Every read here is a
 * read: files, `git ls-tree` / `git show` on chant's snapshot ref, and one
 * engine command that makes no cloud call. Nothing is written.
 *
 *  - chant's IR for chant members: the caller hands it in (the serve's own
 *    estate read, src/estate.ts), so no member is graphed twice.
 *  - engine graph documents (chant#4520 section 3): `engine-graph.json`
 *    beside a member (the file chant's pulumi lexicon reads, chant#4520
 *    section 4), any `*.json` under `<dir>/.behold/graph/`, and, for a
 *    choudoufu member, `choudoufu live-graph -json .` when the choudoufu on
 *    PATH has it (choudoufu#2275's build). Without `-from-plan` it prints
 *    configuration nodes and block edges and reads no cloud. A choudoufu
 *    without the command is a note, not a failure. plunge's `plunge graph
 *    --json --stack <stack>` reads the stack's record store, which may be a
 *    cloud bucket, so behold does not run it here: a plunge member's
 *    document is read from its `engine-graph.json`.
 *  - index versions (chant#4519's store keys, behold#1025): the latest
 *    version under each scope path, from the project's `local` store
 *    (`.chant/store/index/`), from the `git-ref` store (`_index/` on
 *    `refs/chant/snapshots`), and from behold's per-user index store
 *    (behold#1025 Q4, where `behold index` writes with no project).
 *  - cloud listings (behold#1029's `ListingResult`) dropped under
 *    `.behold/graph/` load as they are, before chant types them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { ListingResult } from "../cloud-lister/types.ts";
import { isEngineGraphDocument, isIndexDocument, isListingResult, type EngineGraphDocument, type IndexDocument } from "./types.ts";

export type FoundDocument =
  | { kind: "engine"; doc: EngineGraphDocument; from: string; member?: string }
  | { kind: "index"; doc: IndexDocument; from: string; version: string }
  | { kind: "listing"; doc: ListingResult; from: string };

export interface Found {
  documents: FoundDocument[];
  notes: string[];
}

/** An engine graph document beside a member. */
export const ENGINE_GRAPH_FILE = "engine-graph.json";
/** A directory of documents a person or a script drops in. */
export const GRAPH_DROP_DIR = join(".behold", "graph");
/** The project-relative root of chant's `local` index store. */
export const LOCAL_INDEX_DIR = join(".chant", "store", "index");
/** chant#4519's default ref, and the index prefix on it. */
export const SNAPSHOT_REF = "refs/chant/snapshots";
export const GIT_INDEX_DIR = "_index";

/** behold#1025 Q4: the per-user index store. */
export function userIndexDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.BEHOLD_INDEX_DIR) return env.BEHOLD_INDEX_DIR;
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "behold", "index");
}

const VERSION_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** One file, classified. A file that is none of the three shapes is a note. */
export function classifyDocument(value: unknown, from: string, o: { member?: string; version?: string } = {}): FoundDocument | string {
  if (isEngineGraphDocument(value)) return { kind: "engine", doc: value, from, ...(o.member !== undefined ? { member: o.member } : {}) };
  if (isIndexDocument(value)) return { kind: "index", doc: value, from, version: o.version ?? basename(from) };
  if (isListingResult(value)) return { kind: "listing", doc: value, from };
  return `${from} is not an engine graph document, an index version or a cloud listing; skipped`;
}

function fromFile(path: string, found: Found, o: { member?: string; version?: string } = {}): void {
  let v: unknown;
  try {
    v = readJson(path);
  } catch (e) {
    found.notes.push(`${path} could not be read as JSON: ${(e as Error).message}`);
    return;
  }
  const d = classifyDocument(v, path, o);
  if (typeof d === "string") found.notes.push(d);
  else found.documents.push(d);
}

/** `engine-graph.json` beside a member, and every JSON file under its `.behold/graph/`. */
export function findEngineFiles(dir: string, member: string | undefined, found: Found): void {
  const beside = join(dir, ENGINE_GRAPH_FILE);
  if (existsSync(beside)) fromFile(beside, found, member !== undefined ? { member } : {});
  const drop = join(dir, GRAPH_DROP_DIR);
  if (!existsSync(drop)) return;
  for (const f of readdirSync(drop).sort()) if (f.endsWith(".json")) fromFile(join(drop, f), found, member !== undefined ? { member } : {});
}

/** Every file under `root`, relative, sorted. */
function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(root, rel));
  } catch {
    return out;
  }
  for (const n of names.sort()) {
    const r = rel ? join(rel, n) : n;
    let st;
    try {
      st = statSync(join(root, r));
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

/** The latest version under each scope path: version names sort in time order (chant#4519). */
export function latestVersions(paths: readonly string[]): string[] {
  const latest = new Map<string, string>();
  for (const p of paths) {
    const name = basename(p);
    if (!VERSION_NAME.test(name)) continue;
    const scope = dirname(p);
    const had = latest.get(scope);
    if (!had || basename(had) < name) latest.set(scope, p);
  }
  return [...latest.values()].sort();
}

/** A directory laid out as chant's `index` family (`<source>/<scope path>/<version>.json`). */
export function findIndexDir(root: string, found: Found): void {
  if (!existsSync(root)) return;
  for (const rel of latestVersions(walk(root))) fromFile(join(root, rel), found, { version: basename(rel) });
}

export type Git = (args: string[], cwd: string) => string;

const realGit: Git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

/** Index versions on chant's `git-ref` store: `_index/` on `refs/chant/snapshots`, read with ls-tree and show. */
export function findGitIndex(projectDir: string, found: Found, git: Git = realGit): void {
  let listing: string;
  try {
    listing = git(["ls-tree", "-r", "--name-only", SNAPSHOT_REF, "--", GIT_INDEX_DIR], projectDir);
  } catch {
    return; // no repository, or no ref: nothing indexed here
  }
  const paths = listing.split("\n").filter(Boolean);
  for (const p of latestVersions(paths)) {
    const from = `${SNAPSHOT_REF}:${p}`;
    let v: unknown;
    try {
      v = JSON.parse(git(["show", from], projectDir)) as unknown;
    } catch (e) {
      found.notes.push(`${from} could not be read: ${(e as Error).message}`);
      continue;
    }
    const d = classifyDocument(v, from, { version: basename(p) });
    if (typeof d === "string") found.notes.push(d);
    else found.documents.push(d);
  }
}

/** What running an engine answered. */
export interface EngineRun {
  code: number;
  stdout: string;
  stderr: string;
}

export type EngineRunner = (args: string[], cwd: string) => Promise<EngineRun>;

/** A usage error: the choudoufu on PATH predates `live-graph`. */
function unknownCommand(run: EngineRun): boolean {
  return run.code !== 0 && /unknown command|not a .* command|Usage: |flag provided but not defined/i.test(run.stderr + run.stdout);
}

/**
 * `choudoufu live-graph -json .` in a choudoufu member: configuration nodes
 * and block edges, no cloud read. Feature-detected: a choudoufu without the
 * command leaves a note and the member's chant IR stands alone.
 */
export async function readChoudoufuGraph(dir: string, member: string, run: EngineRunner, found: Found): Promise<void> {
  let r: EngineRun;
  try {
    r = await run(["live-graph", "-json", "."], dir);
  } catch (e) {
    found.notes.push(`${member}: choudoufu could not be run for its graph: ${(e as Error).message}`);
    return;
  }
  if (unknownCommand(r)) {
    found.notes.push(`${member}: this choudoufu has no live-graph (choudoufu#2275), so its engine facts are not loaded`);
    return;
  }
  if (r.code !== 0) {
    found.notes.push(`${member}: choudoufu live-graph exited ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`);
    return;
  }
  let v: unknown;
  try {
    v = JSON.parse(r.stdout) as unknown;
  } catch {
    found.notes.push(`${member}: choudoufu live-graph printed no JSON`);
    return;
  }
  const d = classifyDocument(v, `choudoufu live-graph -json (${dir})`, { member });
  if (typeof d === "string") found.notes.push(d);
  else found.documents.push(d);
}

export interface MemberRef {
  name: string;
  dir: string;
  kind: string;
}

export interface FindOptions {
  projectDir: string;
  members: readonly MemberRef[];
  choudoufu?: EngineRunner;
  git?: Git;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Every document the pane loads for one served project. */
export async function findDocuments(o: FindOptions): Promise<Found> {
  const found: Found = { documents: [], notes: [] };
  const single = o.members.length <= 1;
  const dirs = new Set<string>();
  for (const m of o.members) {
    dirs.add(m.dir);
    findEngineFiles(m.dir, single ? undefined : m.name, found);
    if (m.kind === "choudoufu" && o.choudoufu) await readChoudoufuGraph(m.dir, m.name, o.choudoufu, found);
  }
  if (!dirs.has(o.projectDir)) findEngineFiles(o.projectDir, undefined, found);
  findIndexDir(join(o.projectDir, LOCAL_INDEX_DIR), found);
  findGitIndex(o.projectDir, found, o.git);
  findIndexDir(userIndexDir(o.env, o.home), found);
  // The same index version from two stores loads once.
  const seen = new Set<string>();
  found.documents = found.documents.filter((d) => {
    if (d.kind !== "index") return true;
    const id = `${d.doc.stamp.scopeKey}/${d.version}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  for (const d of found.documents) if (d.kind !== "index" && d.from.startsWith(o.projectDir)) d.from = relative(o.projectDir, d.from) || d.from;
  return found;
}
