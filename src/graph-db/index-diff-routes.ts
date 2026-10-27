/**
 * behold#1028: behold's half of the index diff. It loads two versions of one
 * index scope, calls the pure diff (./index-diff.ts, which can move into
 * chant unchanged), and hands the graph pane what to draw as an overlay.
 *
 * Where versions are read from, the same three stores the graph pane loads
 * (./sources.ts), every read a read:
 *
 *  - the project's `local` store, `.chant/store/index/`;
 *  - chant's `git-ref` store, `_index/` on `refs/chant/snapshots`
 *    (`git ls-tree` and `git show`, nothing else);
 *  - behold's per-user store (behold#1025 Q4), where `behold index` writes
 *    with no project.
 *
 * A version's path relative to its store's `index/` is
 * `<scopeKey>/<observedAt>-<digest12>.json` (chant#4519), so two versions of
 * one scope sit in one directory, and a pair from two directories is refused
 * by scope before either is read. The diff then compares the two stamps'
 * `scopeKey` again and refuses a mismatch by name.
 *
 * The coverage lookup is chant's `indexCoverageFor` (chant#4519, on chant's
 * integration/consolidation-graph, in no published chant yet), found at run
 * time under a specifier the type checker does not follow, as
 * src/behold-index.ts does. A chant without it gets the diff's own copy of
 * the rule, and the answer says which one ran (`coverageRule`).
 *
 * Routes, both GET and neither acts:
 *
 *   GET /api/graphdb/index-versions   every scope key with its versions, oldest first, and the store each is in
 *   GET /api/graphdb/index-diff       ?scope=&from=&to=: the diff of two versions and the overlay to draw.
 *                                     `from` and `to` are version names under `scope`, or full
 *                                     `<scopeKey>/<version>` refs. Defaults: the only scope there is, and
 *                                     its last two versions.
 *
 * The maintainer's emulator run (behold#1028 done-when 1; never run by an
 * agent): two `behold index aws` reads of one scope on the pinned floci with
 * a change between them (see the issue comment for the commands), then
 * `GET /api/graphdb/index-diff` shows one changed property.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { Context, Hono } from "hono";
import { coverageForFallback, diffIndexVersions, IndexScopeMismatch, NotAnIndexVersion, type CoverageLookup, type DiffDocument, type DiffNode, type IndexDiff } from "./index-diff.ts";
import { GIT_INDEX_DIR, LOCAL_INDEX_DIR, SNAPSHOT_REF, userIndexDir, type Git } from "./sources.ts";

const VERSION_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/;

export type IndexStoreName = "project-local" | "git-ref" | "user";

export interface IndexVersionRef {
  scopeKey: string;
  version: string;
  store: IndexStoreName;
  /** A file path, or `refs/chant/snapshots:_index/...`. */
  from: string;
}

export interface VersionReaders {
  projectDir: string;
  git?: Git;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const realGit: Git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(root, rel));
  } catch {
    return out;
  }
  for (const n of names.sort()) {
    const r = rel ? `${rel}/${n}` : n;
    try {
      if (statSync(join(root, r)).isDirectory()) out.push(...walk(root, r));
      else out.push(r);
    } catch {
      continue;
    }
  }
  return out;
}

function fromDir(root: string, store: IndexStoreName): IndexVersionRef[] {
  if (!existsSync(root)) return [];
  return walk(root)
    .filter((r) => VERSION_NAME.test(basename(r)))
    .map((r) => ({ scopeKey: dirname(r), version: basename(r), store, from: join(root, r) }));
}

/** Every index version in the three stores. The same version in two stores is listed once (the first store wins). */
export function listIndexVersions(o: VersionReaders): IndexVersionRef[] {
  const git = o.git ?? realGit;
  const all: IndexVersionRef[] = [...fromDir(join(o.projectDir, LOCAL_INDEX_DIR), "project-local")];
  try {
    const listing = git(["ls-tree", "-r", "--name-only", SNAPSHOT_REF, "--", GIT_INDEX_DIR], o.projectDir);
    for (const p of listing.split("\n").filter(Boolean)) {
      if (!VERSION_NAME.test(basename(p))) continue;
      all.push({ scopeKey: dirname(p).slice(GIT_INDEX_DIR.length + 1), version: basename(p), store: "git-ref", from: `${SNAPSHOT_REF}:${p}` });
    }
  } catch {
    // no repository, or no ref: nothing indexed there
  }
  all.push(...fromDir(userIndexDir(o.env, o.home), "user"));
  const seen = new Set<string>();
  return all
    .filter((v) => {
      const id = `${v.scopeKey}/${v.version}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => (a.scopeKey === b.scopeKey ? (a.version < b.version ? -1 : 1) : a.scopeKey < b.scopeKey ? -1 : 1));
}

/** One version's document. */
export function readIndexVersion(ref: IndexVersionRef, o: VersionReaders): DiffDocument {
  const text = ref.store === "git-ref" ? (o.git ?? realGit)(["show", ref.from], o.projectDir) : readFileSync(ref.from, "utf8");
  return JSON.parse(text) as DiffDocument;
}

let cachedCoverage: Promise<{ lookup: CoverageLookup; rule: "chant" | "behold-fallback" }> | undefined;

/** chant's `indexCoverageFor` when the installed chant has it (chant#4519), else the diff's copy of the rule. */
export function coverageLookup(): Promise<{ lookup: CoverageLookup; rule: "chant" | "behold-fallback" }> {
  cachedCoverage ??= (async () => {
    for (const specifier of ["@intentius/chant/lifecycle/index-document", "@intentius/chant"]) {
      const name: string = specifier;
      try {
        const mod = (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
        if (typeof mod.indexCoverageFor === "function") return { lookup: mod.indexCoverageFor as CoverageLookup, rule: "chant" as const };
      } catch {
        // not in this chant
      }
    }
    return { lookup: coverageForFallback, rule: "behold-fallback" as const };
  })();
  return cachedCoverage;
}

export type OverlayChange = "added" | "removed" | "changed" | "not-observed" | "same";

export interface OverlayDraw {
  nodes: Array<{ key: string; kind: string; name: string; change: OverlayChange; detail?: string }>;
  edges: Array<{ from: string; to: string; viaAttr?: string; change: Exclude<OverlayChange, "changed" | "same"> | "same" }>;
  /** Unchanged nodes left out of the drawing (only changed nodes and their neighbours are drawn). */
  omitted: number;
}

function nameOf(n: DiffNode): string {
  const a = n.attrs ?? {};
  for (const k of ["name", "Name", "BucketName", "QueueName", "RoleName", "FunctionName"]) if (typeof a[k] === "string") return a[k] as string;
  return n.nativeId || n.id.split("/").slice(4).join("/") || n.id;
}

/** What the pane draws: every node and edge the diff names, the unchanged neighbours of changed ones, each with its change. */
export function overlayFor(diff: IndexDiff, fromDoc: DiffDocument, toDoc: DiffDocument): OverlayDraw {
  const nodes = new Map<string, DiffNode>();
  for (const n of fromDoc.graph.nodes) nodes.set(n.id, n);
  for (const n of toDoc.graph.nodes) nodes.set(n.id, n);
  const change = new Map<string, { change: OverlayChange; detail?: string }>();
  for (const n of diff.nodes.added) change.set(n.key, { change: "added" });
  for (const n of diff.nodes.removed) change.set(n.key, { change: "removed" });
  for (const n of diff.nodes.changed) change.set(n.key, { change: "changed", detail: n.properties.map((p) => p.path).join(", ") });
  for (const n of diff.nodes.notObserved)
    change.set(n.key, { change: "not-observed", detail: `${n.side === "to" ? "not observed in the later read" : "not observed in the earlier read"}: ${n.listedType} in ${n.location} (${n.verdict})` });
  const edges: OverlayDraw["edges"] = [
    ...diff.edges.added.map((e) => ({ from: e.from, to: e.to, ...(e.viaAttr ? { viaAttr: e.viaAttr } : {}), change: "added" as const })),
    ...diff.edges.removed.map((e) => ({ from: e.from, to: e.to, ...(e.viaAttr ? { viaAttr: e.viaAttr } : {}), change: "removed" as const })),
    ...diff.edges.notObserved.map((e) => ({ from: e.from, to: e.to, ...(e.viaAttr ? { viaAttr: e.viaAttr } : {}), change: "not-observed" as const })),
  ];
  const drawn = new Set([...change.keys(), ...edges.flatMap((e) => [e.from, e.to])]);
  for (const e of toDoc.graph.edges) {
    if (change.has(e.from) || change.has(e.to)) {
      drawn.add(e.from);
      drawn.add(e.to);
      if (!edges.some((x) => x.from === e.from && x.to === e.to)) edges.push({ from: e.from, to: e.to, ...(e.viaAttr ? { viaAttr: e.viaAttr } : {}), change: "same" });
    }
  }
  const out: OverlayDraw["nodes"] = [];
  for (const key of [...drawn].sort()) {
    const n = nodes.get(key) ?? { id: key, kind: "" };
    const c = change.get(key) ?? { change: "same" as const };
    out.push({ key, kind: n.kind, name: nameOf(n), change: c.change, ...(c.detail ? { detail: c.detail } : {}) });
  }
  return { nodes: out, edges, omitted: nodes.size - out.length };
}

/** Why a pair could not be diffed. */
export class IndexDiffRefused extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 404 | 409,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Splits `<scopeKey>/<version>` or takes a bare version under `scope`. */
function refFor(arg: string, scope: string | undefined): { scopeKey: string | undefined; version: string } {
  const at = arg.lastIndexOf("/");
  if (at > 0 && VERSION_NAME.test(arg.slice(at + 1))) return { scopeKey: arg.slice(0, at), version: arg.slice(at + 1) };
  return { scopeKey: scope, version: arg };
}

export interface DiffAnswer {
  diff: IndexDiff;
  draw: OverlayDraw;
  coverageRule: "chant" | "behold-fallback";
  stores: { from: IndexStoreName; to: IndexStoreName };
}

/** Load the two versions the query names, diff them, and build the overlay. Throws {@link IndexDiffRefused}. */
export async function diffFromStores(q: { scope?: string; from?: string; to?: string }, o: VersionReaders): Promise<DiffAnswer> {
  const all = listIndexVersions(o);
  const scopes = [...new Set(all.map((v) => v.scopeKey))];
  const a = q.from ? refFor(q.from, q.scope) : undefined;
  const b = q.to ? refFor(q.to, q.scope) : undefined;
  if (a?.scopeKey && b?.scopeKey && a.scopeKey !== b.scopeKey) {
    const m = new IndexScopeMismatch(a.scopeKey, b.scopeKey);
    throw new IndexDiffRefused(m.message, m.code, 409, { fromScopeKey: a.scopeKey, toScopeKey: b.scopeKey });
  }
  const scope = q.scope ?? a?.scopeKey ?? b?.scopeKey ?? (scopes.length === 1 ? scopes[0] : undefined);
  if (!scope) {
    throw new IndexDiffRefused(
      scopes.length === 0 ? "no index versions in the project's store, chant's git-ref store or behold's per-user store; run `behold index <substrate>` twice" : "name a scope: there is more than one indexed scope",
      scopes.length === 0 ? "index-none" : "index-scope-needed",
      scopes.length === 0 ? 404 : 400,
      { scopes },
    );
  }
  if ((a?.scopeKey && a.scopeKey !== scope) || (b?.scopeKey && b.scopeKey !== scope)) {
    const other = a?.scopeKey && a.scopeKey !== scope ? a.scopeKey : b!.scopeKey!;
    const m = new IndexScopeMismatch(scope, other);
    throw new IndexDiffRefused(m.message, m.code, 409, { fromScopeKey: scope, toScopeKey: other });
  }
  const versions = all.filter((v) => v.scopeKey === scope);
  if (versions.length === 0) throw new IndexDiffRefused(`no index versions under ${scope}`, "index-scope-unknown", 404, { scopes });
  const pick = (name: string) => {
    const v = versions.find((x) => x.version === name);
    if (!v) throw new IndexDiffRefused(`no version ${name} under ${scope}`, "index-version-unknown", 404, { versions: versions.map((x) => x.version) });
    return v;
  };
  const toRef = b ? pick(b.version) : versions[versions.length - 1]!;
  let fromRef: IndexVersionRef;
  if (a) fromRef = pick(a.version);
  else {
    const earlier = versions.filter((v) => v.version < toRef.version);
    if (earlier.length === 0) throw new IndexDiffRefused(`${scope} has one version before ${toRef.version}; a diff needs two reads`, "index-one-version", 400, { versions: versions.map((x) => x.version) });
    fromRef = earlier[earlier.length - 1]!;
  }
  if (toRef.version === fromRef.version) throw new IndexDiffRefused(`from and to are the same version, ${toRef.version}; a diff needs two reads`, "index-same-version", 400, { versions: versions.map((x) => x.version) });
  let fromDoc: DiffDocument;
  let toDoc: DiffDocument;
  try {
    fromDoc = readIndexVersion(fromRef, o);
    toDoc = readIndexVersion(toRef, o);
  } catch (e) {
    throw new IndexDiffRefused(`an index version could not be read: ${(e as Error).message}`, "index-read-failed", 404);
  }
  const { lookup, rule } = await coverageLookup();
  let diff: IndexDiff;
  try {
    diff = diffIndexVersions(fromDoc, toDoc, { coverageFor: lookup, fromVersion: fromRef.version, toVersion: toRef.version });
  } catch (e) {
    if (e instanceof IndexScopeMismatch) throw new IndexDiffRefused(e.message, e.code, 409, { fromScopeKey: e.fromScopeKey, toScopeKey: e.toScopeKey });
    if (e instanceof NotAnIndexVersion) throw new IndexDiffRefused(e.message, e.code, 400);
    throw e;
  }
  return { diff, draw: overlayFor(diff, fromDoc, toDoc), coverageRule: rule, stores: { from: fromRef.store, to: toRef.store } };
}

export const INDEX_DIFF_ROUTES = [
  { method: "GET", path: "/api/graphdb/index-versions", desc: "behold#1028: every indexed scope key with its versions (oldest first) and the store each is in" },
  {
    method: "GET",
    path: "/api/graphdb/index-diff",
    desc: "behold#1028: what changed between two reads of one index scope (nodes, properties, edges; unobserved types are never removed) and the overlay to draw: ?scope=&from=&to=; a scope mismatch is refused by name (409)",
  },
] as const;

export interface IndexDiffDeps {
  projectDir: () => string;
  git?: Git;
  env?: NodeJS.ProcessEnv;
  home?: string;
  public?: boolean;
}

/** Mount the two routes. Both GET; neither acts. */
export function mountIndexDiff(app: Hono, deps: IndexDiffDeps): void {
  const readers = (): VersionReaders => ({ projectDir: deps.projectDir(), ...(deps.git ? { git: deps.git } : {}), ...(deps.env ? { env: deps.env } : {}), ...(deps.home ? { home: deps.home } : {}) });
  const refusePublic = (c: Context) =>
    deps.public ? c.json({ error: "a public view shows the declared source only, and index versions hold cloud ids", code: "public", remedy: "Serve without --public to diff index versions." }, 403) : undefined;

  app.get("/api/graphdb/index-versions", (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    const by = new Map<string, Array<{ version: string; store: IndexStoreName }>>();
    for (const v of listIndexVersions(readers())) by.set(v.scopeKey, [...(by.get(v.scopeKey) ?? []), { version: v.version, store: v.store }]);
    return c.json({ scopes: [...by].map(([scopeKey, versions]) => ({ scopeKey, versions })) });
  });

  app.get("/api/graphdb/index-diff", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    const q = { scope: c.req.query("scope") || undefined, from: c.req.query("from") || undefined, to: c.req.query("to") || undefined };
    try {
      return c.json(await diffFromStores(q, readers()));
    } catch (e) {
      if (e instanceof IndexDiffRefused) return c.json({ error: e.message, code: e.code, ...e.extra }, e.status);
      throw e;
    }
  });
}
