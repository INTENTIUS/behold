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
import { runChantRaw, resolveChant, type GraphOptions } from "./chant.ts";
import { meetsFloor } from "./floor.ts";

/** The read contract version behold reads (chant's `reference/workspace-read-contract`). */
export const WORKSPACE_CONTRACT = 1;
/** The first chant that writes contract 1. An older one has no `workspace` command at all. */
export const WORKSPACE_CHANT_FLOOR = "0.81.0";
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

/** Why behold will not serve a declared workspace, in the #193 refusal shape. */
export interface WorkspaceRefusal {
  error: string;
  code: string;
  remedy: string;
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

/**
 * The contract check every workspace document gets. A document with another
 * `contract` is refused whole: within a version fields are only added, and a
 * new version can change what a field means.
 */
export function contractRefusal(doc: Record<string, unknown>, command: "ls" | "graph"): WorkspaceRefusal | undefined {
  if (doc.contract === WORKSPACE_CONTRACT) return undefined;
  const said = doc.contract === undefined ? "no contract version" : `contract ${JSON.stringify(doc.contract)}`;
  return {
    error: `chant workspace ${command} wrote a document with ${said}; behold reads contract ${WORKSPACE_CONTRACT}.`,
    code: "workspace-contract",
    remedy:
      doc.contract === undefined
        ? `Upgrade the workspace's chant to ${WORKSPACE_CHANT_FLOOR} or newer.`
        : "Upgrade behold: this chant writes a newer workspace contract than it knows.",
  };
}

/** Ask the workspace's own chant for its member list. */
export async function readWorkspace(root: string): Promise<WorkspaceRead> {
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
  const run = await runChantRaw(["workspace", "ls", dir, "--json"], dir);
  if (!run.stdout.trim()) {
    return refuse(`chant workspace ls failed in ${dir} (exit ${run.code}): ${run.stderr.trim().split("\n").slice(-3).join(" ")}`, "workspace-ls", "Run `chant workspace ls` in the workspace root.");
  }
  return parseWorkspaceLs(run.stdout, dir);
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
