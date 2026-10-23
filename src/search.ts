/**
 * behold#913: `q`, a chant search query drawn over the graph.
 *
 * chant answers and behold draws (the read-contract ruling on behold#908).
 * Every search goes through the workspace reader (src/workspace-reader.ts):
 *
 * - a declared workspace is read with `chant workspace search` at its root
 *   (INTENTIUS/chant#4374), which runs each member under its own chant and
 *   gives every row and hop end the `<member>/<id>` id `workspace graph`
 *   gives the same node. behold does no fan-out and no id prefixing of its
 *   own: a member chant didn't search is listed in the document with its
 *   reason code, and behold says so in a "not searched" line;
 * - a single chant project is read with plain `chant search --json` in its
 *   directory, which prints the same contract 1 document without `members`;
 * - a bare Terraform folder is read with plain `chant search --json` in the
 *   scratch project behold already graphs it through (src/terraform-member.ts),
 *   where `chant graph` runs too.
 *
 * behold never parses the grammar. The query is checked the way
 * `web/view-url.js` `checkQuery` checks it, and goes to chant as one argv
 * element after `--`, so a query that starts with `->` stays a query.
 *
 * The mode follows the view: no env is the declared source, an env is a live
 * read of it (`--live --env`), and an env with a snapshot replays that
 * recorded snapshot (`--snapshot <ref> --env`). `--explain` is always passed,
 * for the near-misses and the universe count a "no matches" view draws.
 *
 * What is drawn from the document ({@link drawnOf}) is a projection of it,
 * not a join: the ids chant matched, the hop ends and edges on their paths
 * (a capability's from its `because` hops too),
 * the rows a live read could not observe, and whether the answer is a
 * failure. The page and `behold shot` both draw from it.
 */
import { CAPABILITIES_CHANT_FLOOR, SEARCH_CONTRACT_CHANT_FLOOR, SEARCH_TERRAFORM_ROOTS_CHANT_FLOOR, floorFor, floorRefusal } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { checkQuery, checkSnapshot, isEnvName } from "../web/view-url.js";
import { WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

/** What a view asks search for. */
export interface SearchAsk {
  q: string;
  env?: string | null;
  snapshot?: string | null;
  /** `--show`: a comma list of attributes to carry on each row. */
  show?: string | null;
}

/** Where behold runs the search, and with which chant. */
export type SearchTarget =
  | { kind: "workspace"; root: string; chant: string | undefined }
  | { kind: "project"; dir: string; chant: string | undefined }
  | { kind: "terraform"; dir: string; project: string; chant: string | undefined }
  | { kind: "refused"; refusal: WorkspaceRefusal };

/** A request that can't be sent to chant, with the reason. */
export class SearchAskError extends Error {
  constructor(readonly refusal: WorkspaceRefusal) {
    super(refusal.error);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Check what a request asks for, the way the URL's `q` and `snapshot` are checked. */
export function checkAsk(raw: { q?: string | null; env?: string | null; snapshot?: string | null; show?: string | null }): SearchAsk {
  const q = checkQuery(raw.q ?? null);
  if (!q.ok) throw new SearchAskError({ error: `q was refused: ${q.reason}.`, code: "bad-request", remedy: "Pass q, a query in chant's search grammar." });
  if (!q.value) throw new SearchAskError({ error: "there is no query to search for.", code: "bad-request", remedy: "Pass q, a query in chant's search grammar (https://intentius.io/chant/cli/search/)." });
  const env = raw.env ? raw.env.trim() : null;
  if (env !== null && !isEnvName(env)) throw new SearchAskError({ error: `${JSON.stringify(env)} isn't an env name.`, code: "bad-request", remedy: "Pass one of the project's environments as env." });
  const snap = checkSnapshot(raw.snapshot ?? null);
  if (!snap.ok) throw new SearchAskError({ error: `snapshot was refused: ${snap.reason}.`, code: "bad-request", remedy: "Pass latest, or a snapshot ref chant lists." });
  if (snap.value && !env) throw new SearchAskError({ error: "a snapshot is of an env, and no env was named.", code: "bad-request", remedy: "Pass env with snapshot." });
  const show = raw.show ? raw.show.trim() : null;
  if (show !== null && !/^[A-Za-z0-9_.:@/-]+(,[A-Za-z0-9_.:@/-]+)*$/.test(show)) {
    throw new SearchAskError({ error: `show is a comma list of attribute names, not ${JSON.stringify(show.slice(0, 80))}.`, code: "bad-request", remedy: "Pass show=a,b." });
  }
  return { q: q.value, ...(env ? { env } : {}), ...(snap.value ? { snapshot: snap.value } : {}), ...(show ? { show } : {}) };
}

/**
 * The flags one search takes, then `--` and the query: the mode follows the
 * view, and `--explain` is always on. The reader adds `--json` before the `--`.
 */
export function searchArgs(ask: SearchAsk): string[] {
  const mode = ask.env ? (ask.snapshot ? ["--snapshot", ask.snapshot, "--env", ask.env] : ["--live", "--env", ask.env]) : [];
  return [...mode, "--explain", ...(ask.show ? ["--show", ask.show] : []), "--", ask.q];
}

/** The refusal for a chant below the search floor, or undefined when it meets it. */
export function searchFloorRefusal(target: SearchTarget): WorkspaceRefusal | undefined {
  if (target.kind === "refused") return undefined;
  const f = floorFor("search");
  if (!meetsFloor(target.chant, SEARCH_CONTRACT_CHANT_FLOOR)) return floorRefusal(f, target.chant);
  if (target.kind === "terraform" && !meetsFloor(target.chant, SEARCH_TERRAFORM_ROOTS_CHANT_FLOOR)) return floorRefusal(floorFor("search over a Terraform folder"), target.chant);
  return undefined;
}

/**
 * Run one search, through the reader. One chant call. The document comes
 * back as chant printed it, a refused query or a failed live read included;
 * a chant below the floor, or a target behold can't search, is a refusal.
 */
export async function runSearch(target: SearchTarget, ask: SearchAsk, reader: (root: string) => WorkspaceReader): Promise<{ ok: true; document: WorkspaceDocument } | { ok: false; refusal: WorkspaceRefusal }> {
  if (target.kind === "refused") return { ok: false, refusal: target.refusal };
  const tooOld = searchFloorRefusal(target);
  if (tooOld) return { ok: false, refusal: tooOld };
  try {
    if (target.kind === "workspace") return { ok: true, document: await reader(target.root).read("search", searchArgs(ask)) };
    const dir = target.kind === "terraform" ? target.project : target.dir;
    return { ok: true, document: await reader(dir).readProjectSearch(searchArgs(ask)) };
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

/** One hop on a match's path, as chant prints it. */
export interface Hop {
  from: string;
  fromAttr?: string;
  to: string;
  toAttr?: string;
}

/** A member chant did not search, with chant's reason. */
export interface NotSearched {
  member: string;
  status: string;
  code: string | null;
  message: string | null;
}

/** What the page draws from a search document. */
export interface Drawn {
  /** The matched ids, in chant's order. */
  lit: string[];
  /** The ids on a match's path that aren't matches themselves. */
  onPath: string[];
  /** Every hop of every path, a `cap:` term's `because` hops included, each end on its card, deduplicated by its ends and attrs. */
  edges: Hop[];
  /** Matched ids a live read could not observe, with chant's reason. */
  unobserved: Record<string, string>;
  /** Up to 8 near-misses `--explain` names, with the term each fails. */
  nearMisses: Array<{ id: string; fails: string }>;
  /** chant's provenance line. */
  provenance: string | null;
  /** The answer is a failure, never an empty one: a refused query, a failed live read, or a member that failed. */
  failure: { kind: "query" | "live" | "refused"; code: string | null; message: string; hint?: string; lexicons?: string[] } | null;
  /** Members chant listed and did not search, never drawn as no matches. */
  notSearched: NotSearched[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * behold#926: every hop on one path. An edge term's route is the path's own
 * `hops`; a `cap:` term's (INTENTIUS/chant#4375) is also in `because`, one
 * entry per set the match relied on, each with the hops that proved it.
 * chant prints `because` flat, and this reads a `because` nested in an entry
 * too, at any depth.
 */
function pathHops(p: Record<string, unknown>, out: unknown[] = []): unknown[] {
  if (Array.isArray(p.hops)) out.push(...p.hops);
  for (const b of Array.isArray(p.because) ? p.because : []) if (isRecord(b)) pathHops(b, out);
  return out;
}

/**
 * The card a hop end is drawn on. A capability's hop can end on a node
 * inside a resource, `<id>#<attr>[n]...` (a security group's ingress rule, a
 * policy's statement); it is drawn on the resource that holds it.
 */
const cardOf = (id: string): string => {
  const i = id.indexOf("#");
  return i === -1 ? id : id.slice(0, i);
};

/** The drawing a search document asks for. A projection of chant's fields; it joins nothing. */
export function drawnOf(doc: WorkspaceDocument): Drawn {
  const out: Drawn = { lit: [], onPath: [], edges: [], unobserved: {}, nearMisses: [], provenance: null, failure: null, notSearched: [] };
  if (isRecord(doc.error)) {
    const e = doc.error;
    out.failure = {
      kind: "query",
      code: str(e.code) ?? null,
      message: str(e.message) ?? "chant refused the search",
      ...(str(e.hint) ? { hint: str(e.hint)! } : {}),
    };
    return out;
  }
  const lit = new Set<string>();
  const onPath = new Set<string>();
  const edges = new Map<string, Hop>();
  for (const m of Array.isArray(doc.matches) ? doc.matches : []) {
    if (!isRecord(m) || typeof m.id !== "string") continue;
    lit.add(m.id);
    if (typeof m.unobserved === "string") out.unobserved[m.id] = m.unobserved;
    for (const p of Array.isArray(m.paths) ? m.paths : []) {
      if (!isRecord(p)) continue;
      for (const h of pathHops(p)) {
        if (!isRecord(h) || typeof h.from !== "string" || typeof h.to !== "string") continue;
        const from = cardOf(h.from);
        const to = cardOf(h.to);
        onPath.add(from);
        onPath.add(to);
        // A hop into a node inside a resource (a security group's ingress rule) ends on its own card: nothing to draw.
        if (from === to) continue;
        const hop: Hop = { from, to, ...(str(h.fromAttr) ? { fromAttr: str(h.fromAttr)! } : {}), ...(str(h.toAttr) ? { toAttr: str(h.toAttr)! } : {}) };
        edges.set(`${hop.from}\u0000${hop.to}\u0000${hop.fromAttr ?? ""}\u0000${hop.toAttr ?? ""}`, hop);
      }
    }
  }
  out.lit = [...lit];
  out.onPath = [...onPath].filter((id) => !lit.has(id));
  out.edges = [...edges.values()];
  out.provenance = str(doc.provenance) ?? null;
  // The workspace form carries explain per member; the plain form at the top.
  const explains = [doc.explain, ...(Array.isArray(doc.members) ? doc.members.map((m) => (isRecord(m) ? m.explain : undefined)) : [])];
  for (const ex of explains) {
    if (!isRecord(ex) || !Array.isArray(ex.nearMisses)) continue;
    for (const n of ex.nearMisses) if (isRecord(n) && typeof n.id === "string" && typeof n.fails === "string") out.nearMisses.push({ id: n.id, fails: n.fails });
  }
  out.nearMisses = out.nearMisses.slice(0, 8);
  const live: string[] = [];
  if (Array.isArray(doc.liveFailures)) live.push(...doc.liveFailures.filter((x): x is string => typeof x === "string"));
  const provenances: string[] = [];
  for (const m of Array.isArray(doc.members) ? doc.members : []) {
    if (!isRecord(m) || typeof m.name !== "string") continue;
    if (Array.isArray(m.liveFailures)) live.push(...m.liveFailures.filter((x): x is string => typeof x === "string").map((x) => `${m.name}: ${x}`));
    if (m.status === "searched") {
      if (typeof m.provenance === "string") provenances.push(m.members === undefined ? `${m.name}: ${m.provenance}` : m.provenance);
      continue;
    }
    const reason = isRecord(m.reason) ? m.reason : {};
    out.notSearched.push({ member: m.name, status: str(m.status) ?? "failed", code: str(reason.code) ?? null, message: str(reason.message) ?? null });
  }
  if (out.provenance === null && provenances.length) out.provenance = provenances.join("; ");
  if (live.length) {
    out.failure = {
      kind: "live",
      code: "live-read-failed",
      message: `live read failed (${live.join("; ")}): ${Object.keys(out.unobserved).length}/${out.lit.length} rows unobserved. The rows shown are what the source declares.`,
      lexicons: live,
    };
  }
  return out;
}

/**
 * The search a served project gets. `workspace`: the served declared
 * workspace, when the served dirs are its members. `dirs`: the dirs served
 * (one, or a loose estate). `kindOf` and `chantOf` are the server's own
 * probes, and `terraformProject` the scratch project a bare Terraform folder
 * is graphed through.
 */
export function searchTarget(o: {
  workspace: { root: string; chant: string } | undefined;
  dirs: readonly string[];
  kindOf: (dir: string) => string | undefined;
  chantOf: (dir: string) => string | undefined;
  terraformProject: (dir: string) => { project: string; chant: string | undefined };
}): SearchTarget {
  if (o.workspace) return { kind: "workspace", root: o.workspace.root, chant: o.workspace.chant || o.chantOf(o.workspace.root) };
  if (o.dirs.length > 1) {
    return {
      kind: "refused",
      refusal: {
        error: "behold is serving a loose estate of several directories, which is not a declared workspace, so there is no one chant search to ask.",
        code: "search-estate",
        remedy: "Declare the members in a chant.workspace.json and serve its root: chant workspace search answers for every member. Or serve one project.",
      },
    };
  }
  const dir = o.dirs[0]!;
  const kind = o.kindOf(dir) ?? "chant";
  if (kind === "chant") return { kind: "project", dir, chant: o.chantOf(dir) };
  if (kind === "terraform") {
    const tf = o.terraformProject(dir);
    return { kind: "terraform", dir, project: tf.project, chant: tf.chant };
  }
  return {
    kind: "refused",
    refusal: {
      error: `a ${kind} project is not searched: chant search reads a chant project or a Terraform folder.`,
      code: "search-kind",
      remedy: "Serve a chant project, a Terraform folder, or a declared workspace (chant workspace search lists each member it can't search, with the reason).",
    },
  };
}

/**
 * The drawing with every id put in the namespace of the graph behold draws.
 * A bare Terraform folder is served as a one-member estate (#389), whose node
 * ids behold composes as `<name>/<id>` (src/estate.ts); chant's scratch
 * project knows nothing of that name, so its ids are put under it here. This
 * is behold naming its own composition, not a join of chant's members: a
 * declared workspace's ids come from chant already composed. chant's
 * document itself is never changed.
 */
export function drawnUnder(d: Drawn, prefix: string | undefined): Drawn {
  if (!prefix) return d;
  const p = (id: string): string => `${prefix}/${id}`;
  return {
    ...d,
    lit: d.lit.map(p),
    onPath: d.onPath.map(p),
    edges: d.edges.map((h) => ({ ...h, from: p(h.from), to: p(h.to) })),
    unobserved: Object.fromEntries(Object.entries(d.unobserved).map(([k, v]) => [p(k), v])),
    nearMisses: d.nearMisses.map((n) => ({ ...n, id: p(n.id) })),
  };
}


/**
 * behold#926: the capability catalog of the estate a search would ask, as
 * chant printed it (`chant search --capabilities --json`, chant#4375). The
 * same target as a search: `chant workspace search --capabilities` at a
 * declared workspace's root, plain `chant search --capabilities` in one
 * project's directory or a bare Terraform folder's scratch project. One chant
 * call, through the reader, behind {@link CAPABILITIES_CHANT_FLOOR}.
 */
export async function runCapabilities(target: SearchTarget, reader: (root: string) => WorkspaceReader): Promise<{ ok: true; document: WorkspaceDocument } | { ok: false; refusal: WorkspaceRefusal }> {
  if (target.kind === "refused") return { ok: false, refusal: target.refusal };
  if (!meetsFloor(target.chant, CAPABILITIES_CHANT_FLOOR)) return { ok: false, refusal: floorRefusal(floorFor("capability catalog"), target.chant) };
  try {
    if (target.kind === "workspace") return { ok: true, document: await reader(target.root).readCapabilities("workspace") };
    return { ok: true, document: await reader(target.kind === "terraform" ? target.project : target.dir).readCapabilities("project") };
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
}
