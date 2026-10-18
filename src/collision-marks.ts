/**
 * #684: collision marks, the graph nodes two or more in-flight work items
 * touch.
 *
 * `chant workspace status <env> --json` carries `overlap` (chant#4025, chant
 * 0.124.29 and newer): the in-flight work items with a linked commit, and each
 * pair of them that changed the same file or that a waiting gate's change set
 * reaches at the same entry. An entry names its graph node (`<member>/<id>`),
 * which is what behold marks. A shared file has no node, so it goes in a side
 * list, as does a shared entry chant mapped to no node.
 *
 * `overlap` is absent from a chant older than 0.124.29 and `null` when the
 * workspace declares no work kind or chant could not read the records or the
 * history. Both are refusals here, worded apart. behold reads it through the
 * read contract (src/workspace-reader.ts), floor in src/chant-floors.ts
 * checked by the route before anything is spawned, and records, locks and
 * refuses nothing: chant reports, two people sort the overlap out.
 */
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import type { Workspace } from "./workspace.ts";
import { rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

export const COLLISION_READ = "work overlap";

/** An in-flight work item that collides with another. */
export interface CollisionItem {
  /** `<work kind>:<id>`, as a `Chant-Record` trailer names it. */
  item: string;
  /** The work record file, from the repository root. */
  path: string;
  state: string | null;
  commits: string[];
  /** The items it collides with, sorted; empty when it collides with none. */
  with: string[];
}

/** A graph node two or more items reach through one change-set entry. */
export interface CollisionNode {
  /** The graph node id, `<member>/<id>`. */
  node: string;
  /** The items colliding there, sorted. */
  items: string[];
  /** The entries behind it. */
  entries: { changeSet: string; member: string; address: string; source: string; items: string[] }[];
}

/** A shared entry chant mapped to no graph node. */
export interface CollisionUnplaced {
  items: string[];
  changeSet: string;
  member: string;
  address: string;
  source: string;
}

/** Files two items both changed: no node, so the side list. */
export interface CollisionFiles {
  items: [string, string];
  files: string[];
}

export interface Collisions {
  /** The graph nodes to mark, by node id. */
  nodes: CollisionNode[];
  files: CollisionFiles[];
  unplaced: CollisionUnplaced[];
  /** Every in-flight work item with a linked commit, sorted, each with the items it collides with (none for most). */
  items: CollisionItem[];
  changeSets: string[];
  /** Entries of those change sets chant could attribute to no item. */
  unattributed: number;
  read: { at: string };
}

export type CollisionsRead = { ok: true; collisions: Collisions } | { ok: false; refusal: WorkspaceRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The refusal when the project's chant is older than the overlap read's floor, else undefined. */
export function collisionsFloorRefusal(version: string | undefined): WorkspaceRefusal | undefined {
  const f = floorFor(COLLISION_READ);
  return floorMet(f, version) ? undefined : floorRefusal(f, version);
}

/** Why `overlap` gave nothing: absent (an older chant) or null (no work kind declared, or the read failed). */
export function overlapRefusal(status: WorkspaceDocument): WorkspaceRefusal | undefined {
  if (!("overlap" in status)) {
    return { error: "chant's workspace status carries no overlap.", code: "no-overlap", remedy: `Collision marks need chant ${floorFor(COLLISION_READ).floor} or newer in the project.` };
  }
  if (status.overlap === null || !isRecord(status.overlap)) {
    return {
      error: "chant reported no overlap: the workspace declares no work kind, or chant could not read the work records or the history.",
      code: "overlap-unavailable",
      remedy: "Declare a work record kind in chant.workspace.json, and run chant workspace status in the workspace root to see if it reads.",
    };
  }
  return undefined;
}

/** The collisions in a status document's `overlap`. Pure. Null when {@link overlapRefusal} refuses. */
export function collisionsFrom(status: WorkspaceDocument, at: Date): Collisions | null {
  if (overlapRefusal(status)) return null;
  const overlap = status.overlap as Record<string, unknown>;
  const details = new Map<string, { path: string; state: string | null; commits: string[] }>();
  for (const i of arr(overlap.items)) {
    if (!isRecord(i) || !str(i.item)) continue;
    details.set(String(i.item), { path: String(i.path ?? ""), state: str(i.state), commits: strs(i.commits) });
  }
  const nodes = new Map<string, CollisionNode>();
  const unplaced: CollisionUnplaced[] = [];
  const files: CollisionFiles[] = [];
  const withs = new Map<string, Set<string>>();
  for (const p of arr(overlap.pairs)) {
    if (!isRecord(p)) continue;
    const pair = strs(p.items).sort(byString);
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    for (const [x, y] of [[a, b], [b, a]]) withs.set(x, (withs.get(x) ?? new Set()).add(y));
    const shared = strs(p.files);
    if (shared.length) files.push({ items: [a, b], files: shared });
    for (const e of arr(p.addresses)) {
      if (!isRecord(e)) continue;
      const entry = { changeSet: String(e.changeSet ?? ""), member: String(e.member ?? ""), address: String(e.address ?? ""), source: String(e.source ?? ""), items: pair };
      const node = str(e.node);
      if (!node) {
        unplaced.push({ ...entry });
        continue;
      }
      const n = nodes.get(node) ?? { node, items: [], entries: [] };
      for (const i of pair) if (!n.items.includes(i)) n.items.push(i);
      if (!n.entries.some((x) => x.changeSet === entry.changeSet && x.address === entry.address && x.member === entry.member && x.items.join() === entry.items.join())) n.entries.push(entry);
      nodes.set(node, n);
    }
  }
  const names = new Set([...details.keys(), ...withs.keys()]);
  const items: CollisionItem[] = [...names].sort(byString).map((item) => ({ item, ...(details.get(item) ?? { path: "", state: null, commits: [] }), with: [...(withs.get(item) ?? [])].sort(byString) }));
  for (const n of nodes.values()) n.items.sort(byString);
  return {
    nodes: [...nodes.values()].sort((x, y) => byString(x.node, y.node)),
    files,
    unplaced,
    items,
    changeSets: strs(overlap.changeSets),
    unattributed: typeof overlap.unattributed === "number" ? overlap.unattributed : 0,
    read: { at: at.toISOString() },
  };
}

/** Read the collisions of a served workspace: one `status` read. The caller has checked {@link collisionsFloorRefusal}. */
export async function readCollisions(ws: Workspace, opts: { env: string; reader?: WorkspaceReader; now?: () => Date }): Promise<CollisionsRead> {
  const reader = opts.reader ?? rootReader(ws.root);
  let status: WorkspaceDocument;
  try {
    status = await reader.read("status", [opts.env]);
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
  const refusal = overlapRefusal(status);
  if (refusal) return { ok: false, refusal };
  return { ok: true, collisions: collisionsFrom(status, (opts.now ?? (() => new Date()))())! };
}
