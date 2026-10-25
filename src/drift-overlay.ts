/**
 * behold#995 (B2): cards coloured from chant's drift document.
 *
 * `chant workspace drift --member <name>` (INTENTIUS/chant, behold#995's
 * chant half) reads one member with the engine that owns it and prints one
 * drift document (`drift: "v1"`, chant#4451) with the read contract's head.
 * It goes through the workspace reader (`read("drift", driftArgs(ask))`,
 * src/workspace-reader.ts) like every other workspace read. This module
 * reads that document, finds each record's card, and paints it through the
 * one `(status, read)` table (src/drift-tone.ts). Which engine wrote a
 * record is never consulted.
 *
 * ## Which card a record lands on
 *
 * A record names its graph node with the change set's rule (`graphNodeFor`):
 * `<member>/<id>` as `workspace graph` names it, and for an instance of a
 * `count`/`for_each` block the instance node with `instanceOf` the block. A
 * chant member and a stock Terraform member draw chant's ids, so `node` is
 * the card.
 *
 * A choudoufu member does not. behold draws its cards from choudoufu's
 * roster, `<member>/<instance address>`, and keeps those ids because saved
 * layouts are keyed on them (#465), while chant names the same blocks
 * `<member>/<root>/<block path>`. Decision (B3 follow-up, recorded on
 * behold#995): keep behold's card ids, and map chant's node ids onto them
 * with ONE alias table built from chant's graph for that member
 * ({@link choudoufuCardAliases}). Both the change-set overlay
 * (src/change-set-overlay.ts) and drift records use it. A node the table
 * knows lands on the card whose address the record or entry carries, when
 * that address is an instance of the node's block; a node the table does
 * not know lands nowhere and is listed, never guessed at.
 */
import type { GraphIR } from "@intentius/chant";
import { decomposeAddress } from "./choudoufu-refs.ts";
import { decodeDriftLine, type DriftRecord } from "./drift-line.ts";
import { toneFor } from "./drift-tone.ts";
import { instanceParentOf } from "./instance-cards.ts";
import type { Workspace, WorkspaceMember } from "./workspace.ts";
import { driftArgs, WorkspaceReadError, type WorkspaceReader } from "./workspace-reader.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What behold makes of a drift document: its records, checked line by line as the stream's are, or chant's error. */
export interface DriftRead {
  records: DriftRecord[];
  /** chant's `error` on a read that could not run. */
  error?: { code: string; message: string };
  /** Records behold could not read, with why. They paint nothing. */
  skipped: string[];
}

/** Read a drift document. Each record is checked by the stream's decoder (src/drift-line.ts), so both paths accept the same records. */
export function driftDocumentOf(doc: Record<string, unknown>): DriftRead {
  const skipped: string[] = [];
  const records: DriftRecord[] = [];
  for (const r of Array.isArray(doc.records) ? doc.records : []) {
    try {
      const line = decodeDriftLine(JSON.stringify({ ...(isRecord(r) ? r : {}), type: "drift-record" }));
      if (line.type === "drift-record") {
        const { type: _type, ...record } = line;
        records.push(record);
      }
    } catch (e) {
      skipped.push((e as Error).message);
    }
  }
  const error = isRecord(doc.error) && typeof doc.error.code === "string" ? { code: doc.error.code, message: String(doc.error.message ?? doc.error.code) } : undefined;
  return { records, ...(error ? { error } : {}), skipped };
}

// ── the alias table ─────────────────────────────────────────────────────────

/** chant's node ids for one choudoufu member, each with the block path its cards' addresses decompose to. */
export interface CardAliases {
  member: string;
  /** Composed chant node id (`<member>/<root>/<block path>`, or an instance node) to the block path (`module.a/aws_x.y`). */
  blocks: Map<string, string>;
}

/** The root segment chant names a member's blocks under, from the nodes' own `root`, else the first id's head. */
function rootOf(ir: Pick<GraphIR, "nodes">): string | undefined {
  for (const n of ir.nodes) {
    const root = (n.attrs as Record<string, unknown> | undefined)?.root;
    if (typeof root === "string" && root) return root;
  }
  const first = ir.nodes[0]?.id;
  return first?.includes("/") ? first.slice(0, first.indexOf("/")) : undefined;
}

/** A trailing instance key (`[0]`, `["a"]`). */
const TRAILING_KEY = /\[(?:\d+|"(?:[^"\\]|\\.)*")\]$/;

/**
 * The alias table for a choudoufu member, from chant's graph of it (the
 * member's own IR, ids `<root>/<block path>`, as src/choudoufu-workspace.ts
 * `memberBlockGraph` reads it). A C4 instance node maps to its block's path.
 */
export function choudoufuCardAliases(member: string, blocks: Pick<GraphIR, "nodes">): CardAliases {
  const root = rootOf(blocks);
  const out = new Map<string, string>();
  for (const n of blocks.nodes) {
    let id = n.id;
    const parent = instanceParentOf(n);
    if (parent) id = id.replace(TRAILING_KEY, "");
    const path = root && id.startsWith(`${root}/`) ? id.slice(root.length + 1) : id;
    out.set(`${member}/${n.id}`, path.replace(/~\d+$/, ""));
  }
  return { member, blocks: out };
}

/**
 * The card a chant node and an instance address land on in a choudoufu
 * member: `<member>/<address>`, when the table knows the node and the
 * address is an instance of its block. Undefined otherwise.
 */
export function cardIdFor(aliases: CardAliases, node: string | null | undefined, address: string): string | undefined {
  if (!node) return undefined;
  const block = aliases.blocks.get(node);
  if (block === undefined) return undefined;
  return decomposeAddress(address).blockPath === block ? `${aliases.member}/${address}` : undefined;
}

// ── the paint ───────────────────────────────────────────────────────────────

/** chant's rollup order (`DRIFT_INSTANCE_ROLLUP`): when two records land on one card, the earlier status decides. */
const ROLLUP = ["not-observed", "drifted", "missing", "unclaimed", "undeclared", "pending", "in-sync", "recorded", "runtime"];
const rank = (status: string): number => {
  const i = ROLLUP.indexOf(status);
  return i === -1 ? -1 : i; // an unknown status ranks first: behold does not know it, so it shows that
};

/** What a painted card carries from its record, as `attrs._drift`. */
export interface CardDrift {
  status: string;
  read: string;
  label: string;
  reason?: string;
  engineCode?: string;
  fellBackFrom?: string;
  unknown?: true;
  observedAt: string;
}

export interface DriftPaint {
  painted: number;
  /** Records no card is drawn for: `<address> (<node>)`. */
  unplaced: string[];
}

/**
 * Paint one member's records onto `ir` in place: `_status` from the table,
 * `_drift` with the record's words, `_unobserved` on a not-observed record.
 * `aliases` is the member's table when it is a choudoufu member.
 */
export function paintDrift(ir: Pick<GraphIR, "nodes">, member: string, records: readonly DriftRecord[], aliases?: CardAliases): DriftPaint {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const chosen = new Map<string, DriftRecord>();
  const unplaced: string[] = [];
  for (const r of records) {
    const candidates = aliases
      ? [cardIdFor(aliases, r.node, r.address), `${member}/${r.address}`]
      : [r.node ?? undefined, r.instanceOf, `${member}/${r.address}`];
    const id = candidates.find((c): c is string => !!c && byId.has(c));
    if (!id) {
      unplaced.push(`${r.address} (${r.node ?? "no node"})`);
      continue;
    }
    const prior = chosen.get(id);
    if (!prior || rank(r.status) < rank(prior.status)) chosen.set(id, r);
  }
  for (const [id, r] of chosen) {
    const n = byId.get(id)!;
    const tone = toneFor(r);
    const drift: CardDrift = {
      status: r.status,
      read: r.read,
      label: tone.label,
      observedAt: r.observedAt,
      ...(r.unobserved ? { reason: r.unobserved.reason } : {}),
      ...(r.evidence.engineCode ? { engineCode: r.evidence.engineCode } : {}),
      ...(r.fellBackFrom ? { fellBackFrom: r.fellBackFrom } : {}),
      ...(tone.unknown ? { unknown: true as const } : {}),
    };
    n.attrs = {
      ...n.attrs,
      _status: tone.tone,
      _drift: drift,
      ...(r.status === "not-observed" ? { _unobserved: r.unobserved?.detail ?? tone.label } : {}),
    };
    if (r.ownership?.verdict === "owned" || r.ownership?.verdict === "foreign") (n as { ownership?: string }).ownership = r.ownership.verdict;
  }
  return { painted: chosen.size, unplaced };
}

// ── the read ────────────────────────────────────────────────────────────────

/** The member kinds `workspace drift` reads, and the ones painted from it on every overlay. */
export const DRIFT_KINDS = ["chant", "terraform", "choudoufu", "pulumi"] as const;
/**
 * The kinds the overlay paints from the drift record without being asked:
 * the ones with no live half of their own (a Terraform root, a Pulumi stack,
 * #429). A chant or choudoufu member already has a live read on every
 * overlay, coloured through the same table (src/drift-tone.ts); `?drift=1`
 * paints those from the record too, at the cost of a second live read.
 */
export const DRIFT_DEFAULT_KINDS = ["terraform", "pulumi"] as const;

export interface MemberDrift {
  member: string;
  kind: string;
  painted: number;
  unplaced: string[];
  /** chant's error, or the reader's refusal, when the read gave no records. */
  error?: { code: string; message: string };
}

export interface WorkspaceDriftDeps {
  reader: WorkspaceReader;
  /** chant's block graph for a choudoufu member, for its alias table (src/choudoufu-workspace.ts `memberBlockGraph`). */
  blockGraph: (member: WorkspaceMember) => Promise<Pick<GraphIR, "nodes">>;
}

/**
 * Read `workspace drift --member <name>` for each member of `kinds` and paint
 * its records onto `ir` (composed ids). One read per member, through the
 * workspace reader. A chant member is asked with `--env`, and with `plan`
 * every member that has a plan read (terraform, choudoufu) is asked for it.
 */
export async function paintWorkspaceDrift(
  ir: Pick<GraphIR, "nodes">,
  ws: Pick<Workspace, "members">,
  opts: { env?: string; plan?: boolean; kinds: readonly string[] },
  deps: WorkspaceDriftDeps,
): Promise<MemberDrift[]> {
  const members = ws.members.filter((m) => !m.reason && opts.kinds.includes(m.kind));
  return Promise.all(
    members.map(async (m): Promise<MemberDrift> => {
      const ask = {
        member: m.name,
        ...(m.kind === "chant" && opts.env ? { env: opts.env } : {}),
        ...(opts.plan && (m.kind === "terraform" || m.kind === "choudoufu") ? { read: "plan" } : {}),
      };
      let read: DriftRead;
      try {
        read = driftDocumentOf(await deps.reader.read("drift", driftArgs(ask)));
      } catch (e) {
        if (e instanceof WorkspaceReadError) return { member: m.name, kind: m.kind, painted: 0, unplaced: [], error: { code: e.refusal.code, message: e.refusal.error } };
        throw e;
      }
      let aliases: CardAliases | undefined;
      if (m.kind === "choudoufu") {
        try {
          aliases = choudoufuCardAliases(m.name, await deps.blockGraph(m));
        } catch {
          aliases = { member: m.name, blocks: new Map() };
        }
      }
      const paint = paintDrift(ir, m.name, read.records, aliases);
      return { member: m.name, kind: m.kind, ...paint, ...(read.error ? { error: read.error } : {}) };
    }),
  );
}
