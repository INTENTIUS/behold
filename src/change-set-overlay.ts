/**
 * #681: a waiting gate's change set, drawn on the graph as a preview.
 *
 * A gate that binds a stored change set (a pull request's, or a release
 * planned for an environment, chant#4045) names it in `workspace status`
 * (`changeSet`, chant#4022). `chant change-set show <digest> --member <name>
 * --json` prints the stored document, and each entry carries `node`, the
 * graph node id `chant workspace graph` uses (`<member>/<id>`), which is the
 * id behold draws a card under. So the overlay is that document keyed by
 * node, with nothing behold works out for itself: the entries chant could not
 * place on a node (`node: null`, such as a delete of a block the planning
 * commit no longer declares) are kept and listed beside the graph.
 *
 * Both reads go through the read contract (src/workspace-reader.ts), and the
 * route checks the floors in src/chant-floors.ts before spawning either. The
 * gate comes from a fresh status read, never from the page, so the overlay
 * names the commit, run and gate chant recorded for that change set.
 */
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import type { Workspace } from "./workspace.ts";
import { gatesFromStatus, type WorkspaceGate } from "./workspace-gates.ts";
import { rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

/** The reads the overlay makes, by their names in src/chant-floors.ts: status carries the gate's `changeSet`, and the change set itself. */
export const OVERLAY_READS = ["promotion order", "change set"] as const;

/** How the graph colours an entry. `change` is an update or a replace; `delete` is a delete or a forget (chant stops managing the object). */
export type ChangeBucket = "create" | "change" | "delete";

/** The actions that change something, by bucket. `no-op` and `read` change nothing and are counted, not drawn. */
export const BUCKET_OF: Record<string, ChangeBucket> = { create: "create", update: "change", replace: "change", delete: "delete", forget: "delete" };
/** Which bucket wins on a card with entries in several: the one that destroys most. */
const STRENGTH: Record<ChangeBucket, number> = { create: 1, change: 2, delete: 3 };

export interface OverlayAttribute {
  path: string;
  before?: unknown;
  after?: unknown;
  unknown?: true;
  sensitive?: true;
  forcesReplacement?: true;
}

export interface OverlayEntry {
  member: string;
  address: string;
  type: string;
  action: string;
  bucket: ChangeBucket;
  /** The graph node chant mapped the entry to, or null when the graph holds none for it. */
  node: string | null;
  disruption: string | null;
  deposed: string | null;
  attributes: OverlayAttribute[];
}

export interface OverlayNode {
  bucket: ChangeBucket;
  /** Entries on this node, per action. */
  actions: Record<string, number>;
}

export interface ChangeSetOverlay {
  /** The gate the change set belongs to, as status recorded it. */
  gate: { key: string; member: string; op: string; gate: string; env: string | null; gitSha: string | null; runId: string | null; releaseDigest: string | null; approve: string };
  digest: string;
  /** Set on a release gate's change set (chant#4045): the release and environment it was planned for. */
  planned: { releaseDigest: string; environment: string } | null;
  /** The graph chant mapped the entries onto: which member's, read at which commit. Null when chant read none, so no entry has a node. */
  graph: { member: string | null; at: string | null } | null;
  /** The entries that change something, in chant's order. */
  entries: OverlayEntry[];
  /** Entries that change nothing (`no-op`, `read`), counted. */
  unchanged: number;
  nodes: Record<string, OverlayNode>;
  counts: Record<ChangeBucket, number>;
  /** Members that failed to plan, or planned with holes: the picture leaves out what they would change. */
  gaps: { member: string; status: string; error: string | null; holes: { address: string; reason: string }[] }[];
  read: { at: string };
}

export type OverlayRead = { ok: true; overlay: ChangeSetOverlay } | { ok: false; refusal: WorkspaceRefusal; status?: number };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The first floor of the overlay's reads the project's chant does not meet, as the pane's refusal. */
export function overlayFloorRefusal(version: string | undefined): WorkspaceRefusal | undefined {
  for (const read of OVERLAY_READS) {
    const f = floorFor(read);
    if (!floorMet(f, version)) return floorRefusal(f, version);
  }
  return undefined;
}

function attributeOf(a: Record<string, unknown>): OverlayAttribute {
  const out: OverlayAttribute = { path: String(a.path ?? "") };
  if (a.sensitive === true) out.sensitive = true;
  else {
    if ("before" in a) out.before = a.before;
    if ("after" in a) out.after = a.after;
  }
  if (a.unknown === true) out.unknown = true;
  if (a.forcesReplacement === true) out.forcesReplacement = true;
  return out;
}

/** Why a change-set-show document gives no change set, or undefined when it gives one. */
export function showRefusal(doc: WorkspaceDocument, digest: string, member: string): WorkspaceRefusal | undefined {
  const shown = `chant change-set show ${digest} --member ${member}`;
  if (isRecord(doc.error)) {
    return { error: `${shown}: ${String(doc.error.message ?? doc.error.code)}`, code: String(doc.error.code ?? "change-set-show"), remedy: `Run \`${shown}\` in the workspace root to see what chant says.` };
  }
  if (isRecord(doc.reason)) {
    return { error: `${shown}: ${String(doc.reason.message ?? doc.reason.code)}`, code: String(doc.reason.code ?? "change-set-show"), remedy: "The stored file is not the change set its digest names, so behold draws nothing from it." };
  }
  if (!isRecord(doc.changeSet)) {
    return { error: `chant has no change set stored under ${digest} for ${member}.`, code: "no-change-set", remedy: "A pull-request or release gate stores the change set it binds; fetch chant/lifecycle if it was stored elsewhere." };
  }
  if (doc.changeSet.digest !== digest) {
    return { error: `${shown} printed the change set ${String(doc.changeSet.digest)}, not ${digest}.`, code: "change-set-digest", remedy: `Run \`${shown}\` to see what chant says.` };
  }
  return undefined;
}

/** The overlay of one gate's change set: the document `change-set show` printed, keyed by graph node. Pure. */
export function overlayFrom(gate: Omit<WorkspaceGate, "dir">, doc: WorkspaceDocument, at: Date): ChangeSetOverlay {
  const cs = isRecord(doc.changeSet) ? doc.changeSet : {};
  const entries: OverlayEntry[] = [];
  let unchanged = 0;
  for (const e of arr(cs.entries)) {
    if (!isRecord(e) || typeof e.address !== "string") continue;
    const action = String(e.action ?? "");
    const bucket = BUCKET_OF[action];
    if (!bucket) {
      unchanged++;
      continue;
    }
    entries.push({
      member: String(e.member ?? ""),
      address: e.address,
      type: String(e.type ?? ""),
      action,
      bucket,
      node: str(e.node),
      disruption: str(e.disruption),
      deposed: str(e.deposed),
      attributes: arr(e.attributes).filter(isRecord).map(attributeOf),
    });
  }
  const nodes: Record<string, OverlayNode> = {};
  const counts: Record<ChangeBucket, number> = { create: 0, change: 0, delete: 0 };
  for (const e of entries) {
    counts[e.bucket]++;
    if (!e.node) continue;
    const n = (nodes[e.node] ??= { bucket: e.bucket, actions: {} });
    if (STRENGTH[e.bucket] > STRENGTH[n.bucket]) n.bucket = e.bucket;
    n.actions[e.action] = (n.actions[e.action] ?? 0) + 1;
  }
  const gaps = arr(cs.members)
    .filter(isRecord)
    .map((m) => ({
      member: String(m.member ?? ""),
      status: String(m.status ?? ""),
      error: str(m.error),
      holes: arr(m.holes)
        .filter(isRecord)
        .map((h) => ({ address: String(h.address ?? ""), reason: String(h.reason ?? "") })),
    }))
    .filter((m) => m.status !== "planned" || m.holes.length > 0);
  const graph = isRecord(cs.graph) ? { member: str(cs.graph.member), at: str(cs.graph.at) } : null;
  const planned = str(cs.releaseDigest) && str(cs.environment) ? { releaseDigest: str(cs.releaseDigest)!, environment: str(cs.environment)! } : null;
  return {
    gate: {
      key: gate.key,
      member: gate.member,
      op: gate.op,
      gate: gate.gate,
      env: gate.env,
      gitSha: gate.gitSha ?? null,
      runId: gate.runId ?? null,
      releaseDigest: gate.releaseDigest ?? null,
      approve: gate.approve,
    },
    digest: String(cs.digest ?? ""),
    planned,
    graph,
    entries,
    unchanged,
    nodes,
    counts,
    gaps,
    read: { at: at.toISOString() },
  };
}

async function attempt(read: () => Promise<WorkspaceDocument>): Promise<WorkspaceDocument | WorkspaceRefusal> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof WorkspaceReadError) return e.refusal;
    throw e;
  }
}
const isRefusal = (v: WorkspaceDocument | WorkspaceRefusal): v is WorkspaceRefusal => typeof v.error === "string" && typeof v.code === "string";

/**
 * Read the overlay of the gate `key` waiting in `env`: status for the gate
 * and the digest it binds, then the change set. The caller has checked
 * {@link overlayFloorRefusal}.
 */
export async function readChangeSetOverlay(ws: Workspace, opts: { key: string; env: string; reader?: WorkspaceReader; now?: () => Date }): Promise<OverlayRead> {
  const reader = opts.reader ?? rootReader(ws.root);
  const status = await attempt(() => reader.read("status", [opts.env]));
  if (isRefusal(status)) return { ok: false, refusal: status };
  const gates = gatesFromStatus(status, ws.root);
  if (!gates.ok) return { ok: false, refusal: gates.refusal };
  const found = gates.gates.find((g) => g.key === opts.key);
  if (!found) return { ok: false, status: 404, refusal: { error: `No gate ${opts.key} is waiting in ${opts.env}.`, code: "no-gate", remedy: "It may have been approved since the lane was read. Read the lane again." } };
  const { dir: _dir, ...gate } = found;
  if (!gate.changeSet) {
    return {
      ok: false,
      refusal: { error: `chant stored no change set for ${opts.key}.`, code: "no-change-set", remedy: "A component gate binds a lifecycle plan and stores none; a pull-request or release gate stores the change set it binds." },
    };
  }
  const shown = await attempt(() => reader.readChangeSet(gate.changeSet!, gate.member));
  if (isRefusal(shown)) return { ok: false, refusal: shown };
  const refused = showRefusal(shown, gate.changeSet, gate.member);
  if (refused) return { ok: false, refusal: refused };
  return { ok: true, overlay: overlayFrom(gate, shown, (opts.now ?? (() => new Date()))()) };
}
