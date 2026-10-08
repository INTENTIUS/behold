/**
 * #471: why a member or a node is the way it is, from
 * `chant workspace graph --intent <region> --json` under read contract 1.
 *
 * chant answers the question itself (#3034, chant 0.102.0): the document's
 * `why` walks git blame over the region to the commits that last wrote it,
 * from each commit to the agent runs behind it (by the runs' recorded hunks),
 * and ranks the decisions that govern the region (path, member, issue or
 * contract constraints, and the ones its commits and runs carried out). behold
 * draws that answer and computes no join of its own (ws-052): it looks each id
 * the answer names up in the same document's `nodes` for a title, a date or a
 * subject, and that is all.
 *
 * The region is a member's directory or a graph node id (`delivery/appService`),
 * which chant resolves to the file that declares the node. Both come from the
 * served workspace on the server, never as a path from the page.
 *
 * The read is slow on a large repository (tens of seconds on chant's own), so
 * it is made only when someone asks, and it runs as a scheduled read: it takes
 * a slot in behold's read budget, has its deadline, and is cancelled with the
 * request (src/chant.ts `isIntentRead`).
 */
import { rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";
import type { Workspace } from "./workspace.ts";

export const INTENT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/intent/v1/intent.schema.json";
/** The first chant whose intent document carries `why` (INTENTIUS/chant#3312). */
export const WHY_CHANT_FLOOR = "0.102.0";

/** How many commits the answer lists; the rest are counted. */
export const WHY_COMMITS_SHOWN = 8;

export interface WhyDecision {
  /** The record id, `fix-001`. */
  id: string;
  title: string | null;
  state: string | null;
  /** How the decision covers the region: carried, path, contract, issue, member, related. */
  relevance: string;
  current: boolean;
  closed: boolean;
  /** Current lines made as its own work. */
  lines: number;
  decidedBy: string | null;
  decidedOn: string | null;
  /** hud's review page for a proposed decision, when behold knows where hud is. */
  review: string | null;
}

export interface WhyCommit {
  sha: string;
  subject: string | null;
  date: string | null;
  author: string | null;
  pullRequest: number | null;
  /** The run the commit's Chant-Run trailer names, when it has one. */
  run: string | null;
}

export interface WhyRun {
  id: string;
  lines: number;
  commits: string[];
  /** The work item the run record names. */
  unit: string | null;
  by: string | null;
  harness: string | null;
  model: string | null;
  outcome: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Decision record ids the run carried out. */
  decisions: string[];
}

export interface WhyGap {
  code: string;
  message: string;
}

export interface WhyAnswer {
  /** The region chant read, as it names it (`region:delivery/src/app.ts`). */
  region: string;
  /** The file or directory chant resolved the region to. */
  path: string | null;
  /** `file` or `dir`. */
  type: string | null;
  /** The chant that wrote the document. */
  chant: string;
  /** False when that chant writes no `why`: older than {@link WHY_CHANT_FLOOR}. */
  answered: boolean;
  explained: boolean;
  decisions: WhyDecision[];
  runs: WhyRun[];
  commits: WhyCommit[];
  /** Every commit the answer stands on, of which {@link commits} lists the first few. */
  commitsTotal: number;
  /** Lines not committed yet, from blame spans with no commit. */
  uncommittedLines: number;
  gaps: WhyGap[];
}

export type WhyRead = { ok: true; why: WhyAnswer } | { ok: false; refusal: WorkspaceRefusal };

/** What a page may ask the why of: a member by name, or a node by its composed id. */
export interface WhyAsk {
  member?: string | null;
  node?: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
/** A node id's part after its `kind:` prefix: `record:decision/fix-001` is `fix-001` by its record field, `commit:<sha>`, `run:<id>`. */
const after = (id: string, prefix: string): string => (id.startsWith(prefix) ? id.slice(prefix.length) : id);

const refuse = (error: string, code: string, remedy: string): WhyRead => ({ ok: false, refusal: { error, code, remedy } });

/**
 * The region chant is asked about, from what the page named. A member is its
 * declared directory; a node is its id, which must sit inside a declared
 * member (`<member>/<id>`). Nothing the page sends reaches chant unchecked.
 */
export function whyRegion(ws: Workspace, ask: WhyAsk): { ok: true; region: string; member: string } | { ok: false; refusal: WorkspaceRefusal } {
  const node = ask.node ?? null;
  const name = ask.member ?? (node ? node.slice(0, node.indexOf("/")) : null);
  const member = name ? ws.members.find((m) => m.name === name) : undefined;
  if (!member) {
    return { ok: false, refusal: { error: name ? `${name} isn't a member of ${ws.name}.` : "Name a member or a node.", code: "why-member", remedy: "Pick a member's box or a card inside one." } };
  }
  if (node) {
    if (!node.startsWith(`${member.name}/`) || node.length <= member.name.length + 1 || /[\0\n]/.test(node)) {
      return { ok: false, refusal: { error: `${node} isn't a node of member ${member.name}.`, code: "why-node", remedy: "Pick a card inside the member." } };
    }
    return { ok: true, region: node, member: member.name };
  }
  return { ok: true, region: member.dir, member: member.name };
}

/** hud's review page for a decision, the address arugula's workspace block opens. */
export function hudReviewUrl(hud: string, record: string): string {
  return `${hud.replace(/\/+$/, "")}/decisions#${encodeURIComponent(record)}`;
}

/**
 * Draw the answer out of an intent document. `hud`, when set, links each
 * proposed decision to its review in hud.
 */
export function whyFromIntent(doc: WorkspaceDocument, hud: string | null = null): WhyRead {
  if (isRecord(doc.error)) {
    const code = String(doc.error.code ?? "unknown");
    return refuse(`chant couldn't read that region: ${code}: ${String(doc.error.message ?? "")}`, code, code === "intent-region-invalid" ? "chant reads a node's why from the file that declares it; a card behold added (a live-only or ops card) has none." : "Run `chant workspace graph --intent <region>` in the workspace root.");
  }
  const nodes = new Map<string, Record<string, unknown>>();
  for (const n of Array.isArray(doc.nodes) ? doc.nodes : []) if (isRecord(n) && typeof n.id === "string") nodes.set(n.id, n);
  const regionId = String(doc.region ?? "");
  const regionNode = nodes.get(regionId);
  const base = {
    region: regionId,
    path: str(regionNode?.path),
    type: str(regionNode?.type),
    chant: String(doc.chant ?? ""),
  };
  const why = doc.why;
  if (!isRecord(why)) {
    return { ok: true, why: { ...base, answered: false, explained: false, decisions: [], runs: [], commits: [], commitsTotal: 0, uncommittedLines: 0, gaps: [] } };
  }

  const decisions: WhyDecision[] = [];
  for (const d of Array.isArray(why.decisions) ? why.decisions : []) {
    if (!isRecord(d) || typeof d.decision !== "string") continue;
    const n = nodes.get(d.decision) ?? {};
    const id = str(n.record) ?? after(d.decision, "record:").replace(/^[^/]*\//, "");
    const state = str(n.state);
    decisions.push({
      id,
      title: str(n.title),
      state,
      relevance: String(d.relevance ?? ""),
      current: d.current === true,
      closed: d.closed === true,
      lines: num(d.lines),
      decidedBy: str(n.decided_by),
      decidedOn: str(n.decided_on),
      review: hud && state === "proposed" ? hudReviewUrl(hud, id) : null,
    });
  }

  const commitOf = (id: string): WhyCommit => {
    const n = nodes.get(id) ?? {};
    const joins = isRecord(n.joins) ? n.joins : {};
    return {
      sha: str(n.sha) ?? after(id, "commit:"),
      subject: str(n.subject),
      date: str(n.date),
      author: isRecord(n.author) ? str(n.author.name) : null,
      pullRequest: typeof n.pullRequest === "number" ? n.pullRequest : null,
      run: str(joins.run),
    };
  };

  const runs: WhyRun[] = [];
  for (const r of Array.isArray(why.runs) ? why.runs : []) {
    if (!isRecord(r) || typeof r.run !== "string") continue;
    const n = nodes.get(r.run) ?? {};
    const unit = isRecord(r.unit) ? str(r.unit.id) : null;
    runs.push({
      id: str(n.run) ?? after(r.run, "run:"),
      lines: num(r.lines),
      commits: strings(r.commits).map((c) => commitOf(c).sha),
      unit,
      by: str(n.by),
      harness: isRecord(n.harness) ? str(n.harness.name) : null,
      model: str(n.model),
      outcome: str(n.outcome),
      startedAt: str(n.startedAt),
      endedAt: str(n.endedAt),
      decisions: strings(r.decisions).map((d) => str(nodes.get(d)?.record) ?? after(d, "record:")),
    });
  }

  // The commits: for a file, the ones blame names, top to bottom; for a
  // directory chant blames nothing, and the commits are the history it walked,
  // newest first.
  const blame = (Array.isArray(why.blame) ? why.blame : []).filter(isRecord);
  let uncommittedLines = 0;
  const ids: string[] = [];
  for (const span of blame) {
    if (typeof span.commit === "string") {
      if (!ids.includes(span.commit)) ids.push(span.commit);
    } else {
      uncommittedLines += Math.max(0, num(span.end) - num(span.start) + 1);
    }
  }
  let commits: WhyCommit[];
  if (blame.length > 0) {
    commits = ids.map(commitOf);
  } else {
    commits = [...nodes.values()]
      .filter((n) => n.kind === "commit" && typeof n.id === "string")
      .map((n) => commitOf(n.id as string))
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  }

  return {
    ok: true,
    why: {
      ...base,
      answered: true,
      explained: why.explained === true,
      decisions,
      runs,
      commits: commits.slice(0, WHY_COMMITS_SHOWN),
      commitsTotal: commits.length,
      uncommittedLines,
      gaps: (Array.isArray(why.gaps) ? why.gaps : []).filter(isRecord).map((g) => ({ code: String(g.code ?? ""), message: String(g.message ?? "") })),
    },
  };
}

/** Ask the workspace's chant why `region` is the way it is, through the reader. */
export async function readWhy(ws: Workspace, region: string, hud: string | null = null, reader: WorkspaceReader = rootReader(ws.root)): Promise<WhyRead> {
  try {
    return whyFromIntent(await reader.read("graph --intent", [region]), hud);
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

/** A hud address behold will link to: http or https, nothing else. */
export function hudAddress(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}
