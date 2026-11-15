/**
 * Read a folder that has no workspace declaration through chant (behold#1079).
 *
 * `chant workspace graph <dir> --discover` (INTENTIUS/chant#5095) finds the
 * members of a directory by the kinds' probes and reads them as a declared
 * workspace is read, in one document: `members`, the composed `nodes` and
 * `edges`, and `discovered[]`, one entry per directory a kind claims with
 * what became of it (`member`, `tie`, `module`, `inside-member`). behold
 * reads that document through the read contract (src/workspace-reader.ts),
 * turns it into the same `Workspace` a declaration would give, and hands each
 * member its part of the one document, so the estate code composes it as it
 * composes a declared workspace.
 *
 * WHEN. Only a chant at `WORKSPACE_DISCOVER_CHANT_FLOOR` takes the flag, so
 * below it nothing here runs and a folder is read as it always was. Above it,
 * the question is whether chant's read is worth what it costs, and it is a
 * slower read. Measured on the `infra/` tree of a 55-member Kubernetes
 * project checkout (52 Terraform roots, 2 CloudFormation templates, 1 plain
 * manifests directory), 2026-11-15:
 *
 *     behold's Terraform reader        3.5 s cold, 72 ms reread (one chant, one scratch project)
 *     chant --discover, cold           44.4 s (one reader per member, 55 members)
 *     chant --discover, member cache   6.8 s warm
 *
 * behold's reader runs one chant over one generated project that names every
 * root, where `--discover` runs a reader per member. So the default policy
 * (`auto`) uses `--discover` for a folder behold's own readers cannot draw, and
 * keeps its own for one they can:
 *
 *  - no member kind claims the folder (a Kubernetes or Helm tree): discover;
 *  - a Terraform or choudoufu folder with no Kubernetes or Helm file in it:
 *    behold's own reader, as before;
 *  - one that holds both (mixed): discover, since the own reader would leave
 *    the Kubernetes half out of the picture;
 *  - a chant project: its own read, always.
 *
 * `BEHOLD_DISCOVER` overrides it: `always` (every folder chant is new enough
 * for, a chant project excepted), `never` (today's reads), `auto` (the above).
 *
 * This module is pure of the server and keeps one small cache of its own: the
 * document, since one folder read is one chant call however many members ask
 * for their part of it.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveChant, envOverridesFor, type GraphOptions } from "./chant.ts";
import { WORKSPACE_DISCOVER_CHANT_FLOOR, floorMet, floorRefusal, floorFor } from "./chant-floors.ts";
import { memberKindOf } from "./member-kind.ts";
import { memberSourceStamp } from "./member-source.ts";
import type { MemberVia } from "./member-ir.ts";
import {
  hasDeclaration,
  memberIrFromGraphDocument,
  workspaceGraphTakes,
  type DiscoveredDir,
  type Workspace,
  type WorkspaceMember,
} from "./workspace.ts";
import { contractRefusal, rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader } from "./workspace-reader.ts";

export type DiscoverPolicy = "auto" | "always" | "never";

/** `BEHOLD_DISCOVER`: `auto` (the default, and what any other value means), `always` or `never`. */
export function discoverPolicy(env: Record<string, string | undefined> = process.env): DiscoverPolicy {
  const v = env.BEHOLD_DISCOVER?.trim().toLowerCase();
  return v === "always" || v === "never" ? v : "auto";
}

const SKIP_DIRS = new Set(["node_modules", "dist"]);
/** How many directory entries the Kubernetes scan looks at before it gives up. A bound on a probe that must stay cheap, not a tuning knob. */
const SCAN_ENTRIES = 20_000;
const MARKER_NAMES = new Set(["Chart.yaml", "Chart.yml", "kustomization.yaml", "kustomization.yml", "Kustomization"]);

/** The first 4 KB of a file, or "" when it cannot be read. */
function head(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4096);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Does `dir` hold a Kubernetes or Helm file: a Chart.yaml, a kustomization, or
 * a YAML file whose top level has an `apiVersion` and a `kind`? Sync and
 * read-only, no YAML parsed. The walk skips `node_modules`, `dist` and
 * directories whose names start with a dot, as chant's own discovery does, and
 * stops at the first hit or after {@link SCAN_ENTRIES} entries.
 */
export function hasKubernetesFiles(dir: string): boolean {
  let seen = 0;
  const walk = (at: string): boolean => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return false;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      if (++seen > SCAN_ENTRIES) return false;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) subdirs.push(join(at, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      if (MARKER_NAMES.has(e.name)) return true;
      if (/\.ya?ml$/.test(e.name)) {
        const text = head(join(at, e.name));
        if (/^apiVersion:\s*\S/m.test(text) && /^kind:\s*\S/m.test(text)) return true;
      }
    }
    return subdirs.some(walk);
  };
  return walk(resolve(dir));
}

/** Does the chant behold would run for `dir` take `--discover`? A chant whose version is not known does not: an unknown version is not evidence of a new one, and a flag it rejects is a failed read. */
export function chantDiscovers(dir: string, version: string | undefined = resolveChant(dir).version): boolean {
  return version !== undefined && floorMet(floorFor("a folder with no declaration, by its kinds' probes"), version);
}

/**
 * Is `dir` read through `chant workspace graph --discover`? The module header
 * says why the rule is the one it is. A directory with a declaration is read
 * as a declared workspace and never here, and a folder is never discovered by
 * a chant below the floor.
 */
export function discoverApplies(dir: string, env: Record<string, string | undefined> = process.env, version?: string): boolean {
  const policy = discoverPolicy(env);
  if (policy === "never") return false;
  const abs = resolve(dir);
  try {
    if (!statSync(abs).isDirectory()) return false;
  } catch {
    return false;
  }
  if (hasDeclaration(abs)) return false;
  if (!chantDiscovers(abs, version ?? resolveChant(abs).version)) return false;
  const own = memberKindOf(abs);
  if (own === "chant") return false;
  if (policy === "always") return true;
  return own === undefined || hasKubernetesFiles(abs);
}

/** The folder behold serves or reads when it is alone: `discoverApplies` over a list of one path. */
export function discoverAppliesToList(dirs: readonly string[], env?: Record<string, string | undefined>): boolean {
  return dirs.length === 1 && discoverApplies(dirs[0], env);
}

/** A discovery chant refused or a document behold cannot read, with the words a pane shows. */
export class DiscoverError extends Error {
  constructor(readonly refusal: { error: string; code: string; remedy: string }) {
    super(refusal.error);
    this.name = "DiscoverError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The argv tail of one discovery read: the root, `--discover`, and the options the read carries. */
export function discoverArgs(root: string, opts: GraphOptions): string[] {
  const args = [root, "--discover"];
  if (opts.env) args.push("--env", opts.env);
  if (opts.live) args.push("--live");
  if (opts.overlay) args.push("--overlay");
  if (opts.traffic) args.push("--traffic", opts.traffic);
  if (opts.detail !== undefined) args.push("--detail", String(opts.detail));
  return args;
}

/** `discovered[]` out of a document, an entry at a time: one that is not an object with a string `dir` is dropped. A document without the field (a chant that is not at the floor) reads as none. */
export function discoveredOf(doc: WorkspaceDocument): DiscoveredDir[] {
  if (!Array.isArray(doc.discovered)) return [];
  const out: DiscoveredDir[] = [];
  for (const d of doc.discovered) {
    if (!isRecord(d) || typeof d.dir !== "string" || typeof d.outcome !== "string") continue;
    out.push({
      dir: d.dir,
      member: typeof d.member === "string" ? d.member : null,
      kind: typeof d.kind === "string" ? d.kind : null,
      outcome: d.outcome,
      claims: (Array.isArray(d.claims) ? d.claims : [])
        .filter(isRecord)
        .map((c) => ({ kind: String(c.kind), precedence: typeof c.precedence === "number" ? c.precedence : 0, source: String(c.source ?? "") })),
      note: typeof d.note === "string" ? d.note : null,
    });
  }
  return out;
}

/**
 * The `Workspace` a discovery document describes: its members (a failed or
 * skipped one carries chant's reason, so it is drawn as an unreadable box and
 * never missing), and `discovered`. The root is the directory discovered.
 */
export function workspaceOfDiscovery(root: string, doc: WorkspaceDocument): Workspace {
  const abs = resolve(root);
  const ws = isRecord(doc.workspace) ? doc.workspace : {};
  const members: WorkspaceMember[] = (Array.isArray(doc.members) ? doc.members : []).filter(isRecord).map((m) => {
    const reason = isRecord(m.reason) ? m.reason : undefined;
    const composed = m.status === "composed";
    return {
      name: String(m.name),
      dir: String(m.dir ?? "."),
      kind: String(m.kind ?? "other"),
      abs: resolve(abs, String(m.dir ?? ".")),
      reason: composed ? null : { code: String(reason?.code ?? m.status ?? "unknown"), message: String(reason?.message ?? "") },
      because: null,
    };
  });
  return {
    name: typeof ws.name === "string" ? ws.name : "discovered",
    root: abs,
    file: "",
    chant: typeof doc.chant === "string" ? doc.chant : "",
    members,
    discovered: discoveredOf(doc),
  };
}

/**
 * The line a discovery adds to the picture's note (behold#1079): the
 * directories two kinds claim and chant did not read, and how many others it
 * left out because they are modules some member calls or sit inside one.
 * Nothing when every claimed directory is a member.
 */
export function discoveredNote(discovered: readonly DiscoveredDir[]): { note?: string; noteShort?: string } {
  const ties = discovered.filter((d) => d.outcome === "tie");
  const left = discovered.filter((d) => d.outcome === "module" || d.outcome === "inside-member").length;
  const parts: string[] = [];
  const shorts: string[] = [];
  if (ties.length) {
    const named = ties.map((t) => `${t.dir} (${t.claims.slice(0, 3).map((c) => c.kind).join(", ")})`).join(", ");
    parts.push(`${ties.length} ${ties.length === 1 ? "directory is" : "directories are"} claimed by two kinds and not read: ${named}; name the kind in a chant.workspace.json to read ${ties.length === 1 ? "it" : "them"}`);
    shorts.push(`${ties.length} tied`);
  }
  if (left) {
    parts.push(`${left} ${left === 1 ? "directory is" : "directories are"} left out as a module a member calls or inside another member`);
    shorts.push(`${left} left out`);
  }
  return parts.length ? { note: parts.join("; "), noteShort: shorts.join(" · ") } : {};
}

// ---------------------------------------------------------------------------
// The one document. A folder's discovery is one chant call; its members each
// take their part of the answer. The answer is kept by the whole folder's
// stamp, since a module outside a member's directory is part of what that
// member reads, and by the chant that wrote it and the options that reached it.
// A live or overlay read is never kept: it observes an account.
// ---------------------------------------------------------------------------

const KEPT = 2;
const kept = new Map<string, { stamp: string; doc: WorkspaceDocument }>();
const inflight = new Map<string, Promise<WorkspaceDocument>>();

/** Drop what is kept, for tests. */
export function resetDiscoverCache(): void {
  kept.clear();
  inflight.clear();
}

const toolOf = (root: string): string => {
  const chant = resolveChant(root);
  return `${chant.bin}\0${chant.version ?? ""}`;
};

/** The options that reach a discovery, canonical, as part of the key. */
const keyOf = (root: string, opts: GraphOptions): string =>
  `${resolve(root)}\0${toolOf(root)}\0${JSON.stringify({ env: opts.env, live: opts.live, overlay: opts.overlay, traffic: opts.traffic, detail: opts.detail, spawn: envOverridesFor(opts) })}`;

/**
 * `chant workspace graph <root> --discover` as chant printed it, through the
 * read contract. Refuses a chant below the floor, a document of another
 * contract, and a document chant wrote as an error, each as a
 * {@link DiscoverError}. `reader` is for tests; the default is the root's own
 * chant, run from the root.
 */
export async function readDiscovered(root: string, opts: GraphOptions = {}, reader?: WorkspaceReader): Promise<WorkspaceDocument> {
  const abs = resolve(root);
  const version = resolveChant(abs).version;
  const floor = floorFor("a folder with no declaration, by its kinds' probes");
  if (!reader && !chantDiscovers(abs, version)) throw new DiscoverError(floorRefusal(floor, version));
  const cacheable = !opts.live && !opts.overlay && !reader;
  const key = keyOf(abs, opts);
  const stamp = cacheable ? memberSourceStamp(abs) : undefined;
  if (stamp !== undefined) {
    const hit = kept.get(key);
    if (hit && hit.stamp === stamp) return hit.doc;
    const pending = inflight.get(`${key}\0${stamp}`);
    if (pending) return pending;
  }
  const run = (async (): Promise<WorkspaceDocument> => {
    let doc: WorkspaceDocument;
    try {
      doc = await (reader ?? rootReader(abs, envOverridesFor(opts))).read("graph", discoverArgs(abs, opts));
    } catch (e) {
      if (e instanceof WorkspaceReadError) throw new DiscoverError(e.refusal);
      throw e;
    }
    const contract = contractRefusal(doc, "graph");
    if (contract) throw new DiscoverError(contract);
    if (isRecord(doc.error)) {
      throw new DiscoverError({ error: `chant workspace graph --discover: ${String(doc.error.code)}: ${String(doc.error.message ?? "")}`, code: String(doc.error.code ?? "discover-failed"), remedy: "Run the same command in the folder to see chant's own output." });
    }
    return doc;
  })();
  if (stamp === undefined) return run;
  const slot = `${key}\0${stamp}`;
  inflight.set(slot, run);
  try {
    const doc = await run;
    // A tree that moved while chant read it keeps nothing: the stamp taken first no longer describes the answer.
    if (memberSourceStamp(abs) === stamp) {
      kept.delete(key);
      kept.set(key, { stamp, doc });
      for (const oldest of kept.keys()) {
        if (kept.size <= KEPT) break;
        kept.delete(oldest);
      }
    }
    return doc;
  } finally {
    inflight.delete(slot);
  }
}

/** The discovered workspace of `root`: the document read, and the `Workspace` it describes. */
export async function discoverWorkspace(root: string, opts: GraphOptions = {}, reader?: WorkspaceReader): Promise<{ workspace: Workspace; doc: WorkspaceDocument }> {
  const doc = await readDiscovered(root, opts, reader);
  return { workspace: workspaceOfDiscovery(root, doc), doc };
}

/**
 * How a member of a discovered workspace is read: its part of the folder's one
 * document, through the contract. A lens, an `up`/`down` or a namespace goes to
 * `fallback`, the member's own `chant graph`, as it does for a declared member.
 * The tool stamp carries the folder's stamp, so an edit anywhere in the folder
 * (a module a member calls lives outside its directory) is a new key for
 * behold's member cache.
 */
export function discoveredVia(member: WorkspaceMember, ws: Workspace, fallback: MemberVia, reader?: WorkspaceReader): MemberVia {
  return {
    tool: (dir) => `discover\0${toolOf(ws.root)}\0${memberSourceStamp(ws.root) ?? ""}\0${fallback.tool(dir)}`,
    read: async (dir, opts) => {
      if (!workspaceGraphTakes(opts)) return fallback.read(dir, opts);
      return memberIrFromGraphDocument(await readDiscovered(ws.root, opts, reader), member.name);
    },
  };
}
