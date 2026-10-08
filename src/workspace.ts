/**
 * A declared chant workspace (#464, INTENTIUS/chant#2524 D11, D15).
 *
 * chant 0.81.0 gave a directory of many members a declaration of its own,
 * `chant.workspace.json`, and a versioned read contract over it: `chant
 * workspace ls --json` lists the members, `chant workspace graph` composes
 * them. ws-015 retires the member list behold kept in `.behold.json` in favour
 * of that declaration, and ws-019 keeps what behold did before for a
 * directory with no declaration: `behold serve a b c` is a loose, read-only
 * view composed by behold itself.
 *
 * This module is the declared half. It finds the declaration in the served
 * directory, asks the workspace's own chant for the member list, refuses a
 * document written to a contract it does not know, and records which member
 * each served directory is, so the estate code (src/estate.ts) can name a
 * member the way the declaration does and read it the way its kind says.
 *
 * Which chant answers (ws-021): the one the workspace root resolves, found by
 * `runChantRaw` from the root exactly as a project's own chant is. A root that
 * pins another chant has chant hand the command line to it. behold never
 * guesses a member list: an unreadable declaration is a refusal naming chant's
 * own code, not a fallback to probing directories.
 *
 * Only the served directory itself is checked for a declaration. Serving a
 * member directory serves that member, not the workspace around it; walking up
 * would turn `behold serve services/api` into something much larger than what
 * was asked for.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { envOverridesFor, resolveChant, type GraphOptions } from "./chant.ts";
import type { MemberVia } from "./member-ir.ts";
import { meetsFloor } from "./floor.ts";
import { setStampExclusions } from "./member-source.ts";
import {
  contractRefusal,
  rootReader,
  WORKSPACE_CHANT_FLOOR,
  WorkspaceReadError,
  type WorkspaceDocument,
  type WorkspaceReader,
  type WorkspaceRefusal,
} from "./workspace-reader.ts";

export { contractRefusal, WORKSPACE_CHANT_FLOOR, WORKSPACE_CONTRACT, type WorkspaceRefusal } from "./workspace-reader.ts";
export const LS_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/ls/v1/ls.schema.json";
export const GRAPH_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/graph/v1/graph.schema.json";

export const DECLARATION_FILES = ["chant.workspace.json", "chant.workspace.jsonc"] as const;

/** A member's reason code and chant's own words for it. */
export interface WorkspaceReason {
  code: string;
  message: string;
}

/** One member, as `chant workspace ls --json` lists it. */
export interface WorkspaceMember {
  name: string;
  /** Relative to the workspace root, `/`-separated; `"."` is the root member. */
  dir: string;
  kind: string;
  /** Absolute. */
  abs: string;
  /** Why chant can't read the member, or null when it can. */
  reason: WorkspaceReason | null;
  because: string | null;
}

export interface Workspace {
  name: string;
  /** Absolute workspace root. */
  root: string;
  /** The declaration file, relative to the root. */
  file: string;
  /** The chant version that wrote the listing. */
  chant: string;
  members: WorkspaceMember[];
}

export type WorkspaceRead = { ok: true; workspace: Workspace } | { ok: false; refusal: WorkspaceRefusal };

/** The declaration file in `dir`, or a refusal when both spellings exist. `undefined` when there is none. */
export function findDeclaration(dir: string): { file: string } | { ambiguous: true } | undefined {
  const found = DECLARATION_FILES.filter((f) => existsSync(join(dir, f)));
  if (found.length > 1) return { ambiguous: true };
  return found.length === 1 ? { file: found[0] } : undefined;
}

/** Whether `dir` holds a workspace declaration (either spelling, ambiguous included). */
export function hasDeclaration(dir: string): boolean {
  return findDeclaration(dir) !== undefined;
}

const refuse = (error: string, code: string, remedy: string): WorkspaceRead => ({ ok: false, refusal: { error, code, remedy } });

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validate a `chant workspace ls --json` document. Shallow, like every chant
 * document behold reads: the fields it uses, and the contract version, which
 * is the one check that must never be skipped. Fields it does not know are
 * ignored, as the contract asks of a reader.
 */
export function parseWorkspaceLs(text: string, root: string): WorkspaceRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return refuse(`chant workspace ls printed something that is not JSON for ${root}.`, "workspace-ls", "Run `chant workspace ls --json` in the workspace root to see what it says.");
  }
  if (!isRecord(doc)) return refuse("chant workspace ls printed JSON that is not an object.", "workspace-ls", "Run `chant workspace ls --json` in the workspace root.");
  return workspaceFromLs(doc, root);
}

/**
 * The workspace an `ls` document lists, or why behold can't use it. The
 * reader (src/workspace-reader.ts) has checked the contract already; this
 * checks it again for a document handed over straight, as a test does.
 */
export function workspaceFromLs(doc: WorkspaceDocument, root: string): WorkspaceRead {
  const contract = contractRefusal(doc, "ls");
  if (contract) return { ok: false, refusal: contract };
  if (isRecord(doc.error)) {
    const code = String(doc.error.code ?? "unknown");
    return refuse(`chant could not read the workspace declaration in ${root}: ${code}: ${String(doc.error.message ?? "")}`, code, "`chant workspace check` names the problem and where it is.");
  }
  const ws = doc.workspace;
  if (!isRecord(ws) || typeof ws.name !== "string" || !Array.isArray(doc.members)) {
    return refuse("That is not a workspace ls document: it has no `workspace` and `members`.", "workspace-ls", "Run `chant workspace ls --json` in the workspace root.");
  }
  const members: WorkspaceMember[] = [];
  for (const m of doc.members) {
    if (!isRecord(m) || typeof m.name !== "string" || typeof m.dir !== "string" || typeof m.kind !== "string") {
      return refuse("A member in the workspace ls document has no name, dir or kind.", "workspace-ls", "Run `chant workspace ls --json` in the workspace root.");
    }
    const reason = isRecord(m.reason) ? { code: String(m.reason.code), message: String(m.reason.message ?? "") } : null;
    members.push({
      name: m.name,
      dir: m.dir,
      kind: m.kind,
      abs: m.dir === "." ? resolve(root) : resolve(root, m.dir),
      reason,
      because: typeof m.because === "string" ? m.because : null,
    });
  }
  return {
    ok: true,
    workspace: { name: ws.name, root: resolve(root), file: typeof ws.file === "string" ? ws.file : "chant.workspace.json", chant: String(doc.chant ?? ""), members },
  };
}

/** Ask the workspace's own chant for its member list. */
export async function readWorkspace(root: string, reader: WorkspaceReader = rootReader(resolve(root))): Promise<WorkspaceRead> {
  const dir = resolve(root);
  const found = findDeclaration(dir);
  if (!found) return refuse(`${dir} has no chant.workspace.json.`, "declaration-missing", "`chant workspace init` proposes one.");
  if ("ambiguous" in found) {
    return refuse(`${dir} has both chant.workspace.json and chant.workspace.jsonc.`, "declaration-ambiguous", "Keep one of the two files.");
  }
  const chant = resolveChant(dir);
  if (chant.version && !meetsFloor(chant.version, WORKSPACE_CHANT_FLOOR)) {
    return refuse(
      `${dir} declares a chant workspace, and the chant behold would read it with is ${chant.version}; workspaces need ${WORKSPACE_CHANT_FLOOR} or newer.`,
      "workspace-chant-too-old",
      `Install @intentius/chant ${WORKSPACE_CHANT_FLOOR} or newer in the workspace root.`,
    );
  }
  try {
    return workspaceFromLs(await reader.read("ls", [dir]), dir);
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The served workspace. One per process, set when a declared root is served
// and cleared when the served project switches: the estate code asks it which
// member a directory is.
// ---------------------------------------------------------------------------

let served: Workspace | undefined;
const byDir = new Map<string, WorkspaceMember>();

export function setServedWorkspace(ws: Workspace | undefined): void {
  served = ws;
  byDir.clear();
  for (const m of ws?.members ?? []) byDir.set(m.abs, m);
  // A root member's source is the root minus every other member's directory.
  const root = ws?.members.find((m) => m.dir === ".");
  setStampExclusions(root && ws ? new Map([[root.abs, ws.members.filter((m) => m !== root).map((m) => m.abs)]]) : new Map());
}

export function servedWorkspace(): Workspace | undefined {
  return served;
}

/** The declared member `dir` is, when a workspace is served and declares it. */
export function workspaceMemberOf(dir: string): WorkspaceMember | undefined {
  return byDir.get(resolve(dir));
}

/**
 * Kinds whose members draw a box. `other` is a directory chant does not read
 * and a nested `workspace` is opaque to this one: both are listed, and draw
 * nothing.
 */
const UNDRAWN_KINDS = new Set(["other", "workspace"]);

/** The members behold reads: readable, and of a kind that draws a box. */
export function drawnMembers(ws: Workspace): WorkspaceMember[] {
  return ws.members.filter((m) => m.reason === null && !UNDRAWN_KINDS.has(m.kind));
}

/** The members chant says it cannot read, drawn as an unreadable box with the code's message. */
export function unreadableMembers(ws: Workspace): WorkspaceMember[] {
  return ws.members.filter((m) => m.reason !== null && !UNDRAWN_KINDS.has(m.kind));
}

/** The members listed and never drawn, with why. */
export function undrawnMembers(ws: Workspace): WorkspaceMember[] {
  return ws.members.filter((m) => UNDRAWN_KINDS.has(m.kind));
}

/**
 * The placeholder an unreadable member composes as: one node, so the member
 * has a box and the box says why it is empty. Not `_unobserved` — behold did
 * not look and fail, chant says the member cannot be read at all — and not
 * absent, which is the lie #464 asks behold not to tell.
 */
export function unreadableMemberIr(m: WorkspaceMember): GraphIR {
  return {
    nodes: [
      {
        id: "unreadable",
        kind: "UnreadableMember",
        lexicon: "workspace",
        attrs: {
          _status: "neutral",
          _unreadable: { code: m.reason?.code ?? "unknown", message: m.reason?.message ?? "" },
          dir: m.dir,
          kind: m.kind,
        },
      },
    ],
    edges: [],
    groups: {},
  } as unknown as GraphIR;
}

/** Graph options the workspace read carries today; anything else goes to the member's own `chant graph`. */
export function workspaceGraphTakes(opts: GraphOptions): boolean {
  return opts.detail === undefined && !opts.lens && !opts.up && !opts.down && !opts.namespace;
}

// ---------------------------------------------------------------------------
// Reading a declared member through the contract (#464, ws-018).
//
// `chant workspace graph --member <name>` composes that one member, read by
// its own toolchain, with ids `<member>/<id>` (ws-022). The estate code
// composes members itself (`composeStacks` over the member IRs, with behold's
// cache, pool and live fallbacks per member), so this takes the member's part
// back out of the document with the `<member>/` prefix removed:
// `composeStacks` puts the same prefix back under the same name, which is why
// a declared member is named what the declaration names it (see
// `estateMemberNames` in src/estate.ts).
// ---------------------------------------------------------------------------

/** A member chant says it could not read, carried as an error the estate code reports per member. */
export class WorkspaceMemberError extends Error {
  constructor(
    readonly member: string,
    readonly reason: WorkspaceReason,
  ) {
    super(`chant workspace graph could not read ${member}: ${reason.code}: ${reason.message}`);
  }
}

type Json = unknown;

function stripRefs(value: Json, prefix: string): Json {
  if (Array.isArray(value)) return value.map((v) => stripRefs(v, prefix));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === "$ref" && typeof v === "string" && v.startsWith(prefix) ? v.slice(prefix.length) : stripRefs(v, prefix);
  }
  return out;
}

/**
 * One member's IR out of a composed workspace graph document, ids back in the
 * member's own terms. Throws {@link WorkspaceMemberError} for a member the
 * document lists as failed or skipped, and an Error for a document behold
 * can't read at all.
 */
export function memberIrFromWorkspaceGraph(text: string, member: string): GraphIR {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("chant workspace graph printed something that is not JSON");
  }
  if (!isRecord(doc)) throw new Error("chant workspace graph printed JSON that is not an object");
  return memberIrFromGraphDocument(doc, member);
}

/** {@link memberIrFromWorkspaceGraph} over a document the reader returned. */
export function memberIrFromGraphDocument(doc: WorkspaceDocument, member: string): GraphIR {
  const contract = contractRefusal(doc, "graph");
  if (contract) throw new Error(`${contract.error} ${contract.remedy}`);
  if (isRecord(doc.error)) throw new Error(`chant workspace graph: ${String(doc.error.code)}: ${String(doc.error.message ?? "")}`);
  const entry = Array.isArray(doc.members) ? doc.members.find((m) => isRecord(m) && m.name === member) : undefined;
  if (!isRecord(entry)) throw new Error(`chant workspace graph did not list member ${member}`);
  if (entry.status !== "composed") {
    const r = isRecord(entry.reason) ? entry.reason : {};
    throw new WorkspaceMemberError(member, { code: String(r.code ?? entry.status), message: String(r.message ?? "") });
  }
  const p = `${member}/`;
  const un = (id: unknown): string => (typeof id === "string" && id.startsWith(p) ? id.slice(p.length) : String(id));
  const mine = (x: unknown): x is Record<string, unknown> => isRecord(x) && x.member === member;

  const nodes = (Array.isArray(doc.nodes) ? doc.nodes : []).filter(mine).map((n) => {
    const { member: _m, ...rest } = n;
    const out: Record<string, unknown> = { ...rest, id: un(n.id), attrs: stripRefs(n.attrs ?? {}, p) };
    if (typeof n.compositeInstance === "string") out.compositeInstance = un(n.compositeInstance);
    if (typeof n.runtimeOwner === "string") out.runtimeOwner = un(n.runtimeOwner);
    return out;
  });
  const edges = (Array.isArray(doc.edges) ? doc.edges : []).filter(mine).map((e) => {
    const { member: _m, ...rest } = e;
    return { ...rest, from: un(e.from), to: un(e.to) };
  });
  const own = new Set(nodes.map((n) => n.id as string));
  const groups: Record<string, Record<string, string[]>> = {};
  if (isRecord(doc.groups)) {
    for (const [key, table] of Object.entries(doc.groups)) {
      if (key === "byMember" || !isRecord(table)) continue;
      // byStack, byContainer and byWave keys name things inside one member and
      // carry its prefix; byLexicon and byComposite keys are shared.
      const scoped = key === "byStack" || key === "byContainer" || key === "byWave";
      for (const [k, ids] of Object.entries(table)) {
        if (scoped && !k.startsWith(p)) continue;
        const members = (Array.isArray(ids) ? ids : []).map(un).filter((id) => own.has(id));
        if (members.length) (groups[key] ??= {})[scoped ? k.slice(p.length) : k] = members;
      }
    }
  }
  const exports = (Array.isArray(doc.exports) ? doc.exports : []).filter(mine).map((e) => {
    const { member: _m, ...rest } = e;
    return typeof e.node === "string" ? { ...rest, node: un(e.node) } : rest;
  });
  const imports = (Array.isArray(doc.imports) ? doc.imports : []).filter(mine).map((i) => {
    const { member: _m, ...rest } = i;
    return { ...rest, node: un(i.node) };
  });
  const ir: Record<string, unknown> = { version: 1, nodes, edges, groups, exports, imports };
  if (isRecord(entry.meta)) ir.meta = entry.meta;
  if (entry.pipeline !== undefined) ir.pipeline = entry.pipeline;
  if (isRecord(doc.derivedAttrs)) ir.derivedAttrs = doc.derivedAttrs;
  return ir as unknown as GraphIR;
}

/** The arguments one member's contract read passes `workspace graph`. */
export function workspaceGraphArgs(root: string, member: string, opts: GraphOptions): string[] {
  const args = [root, "--member", member];
  if (opts.env) args.push("--env", opts.env);
  if (opts.live) args.push("--live");
  if (opts.overlay) args.push("--overlay");
  if (opts.traffic) args.push("--traffic", opts.traffic);
  return args;
}

/** Kinds chant reads through `workspace graph`. choudoufu stays behold's own reader: see #464. */
export const CONTRACT_READ_KINDS = new Set(["chant", "terraform"]);

/**
 * How a declared member of a kind chant reads is read: through the contract,
 * by the workspace root's chant. `fallback` answers the reads the contract
 * does not carry (a lens, a detail level, a namespace-scoped live read), which
 * go to the member's own `chant graph` as they did before.
 */
export function workspaceVia(member: WorkspaceMember, root: string, fallback: MemberVia): MemberVia {
  return {
    tool: (dir) => {
      const chant = resolveChant(root);
      return `workspace\0${chant.bin}\0${chant.version ?? ""}\0${fallback.tool(dir)}`;
    },
    read: async (dir, opts) => {
      if (!workspaceGraphTakes(opts)) return fallback.read(dir, opts);
      const doc = await rootReader(root, envOverridesFor(opts)).read("graph", workspaceGraphArgs(root, member.name, opts));
      return memberIrFromGraphDocument(doc, member.name);
    },
  };
}
