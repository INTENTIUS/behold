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
 * - a bare Terraform folder is read with `chant workspace search` too, at a
 *   scratch workspace of one member (behold#925, src/terraform-member.ts):
 *   the member is named what behold names the folder's box, and its directory
 *   is the scratch project behold graphs the folder through. chant composes
 *   the `<member>/<id>` ids the cards carry, so behold prefixes nothing here
 *   either. The workspace is written under the OS temp directory, never in
 *   the served folder.
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
 * behold#922: `plan` runs the search at the plan depth, chant's terraform
 * lexicon reading a saved plan of each root (`CHANT_TERRAFORM_OBSERVE=plan`
 * with `--live --env`, INTENTIUS/chant#4358), so `attr:planAction=replace`
 * answers what a change would do. A bare Terraform folder's scratch project
 * declares no environments, so without an env it takes the placeholder the
 * plan read on the cards uses (src/terraform-plan.ts `PLAN_READ_ENV`). A plan
 * is now, so it never goes with a snapshot. `countBy` (`kind`, `module`,
 * `attr:<name>`) is chant's `--count-by`: the document is the counts branch,
 * each group with its ids (INTENTIUS/chant#4360, #4382), and the page lights
 * each group's cards and labels the group with its count.
 *
 * What is drawn from the document ({@link drawnOf}) is a projection of it,
 * not a join: the ids chant matched, the hop ends and edges on their paths
 * (a capability's from its `because` hops too),
 * the rows a live read could not observe, and whether the answer is a
 * failure. The page and `behold shot` both draw from it.
 */
import { CAPABILITIES_CHANT_FLOOR, SEARCH_CONTRACT_CHANT_FLOOR, SEARCH_TERRAFORM_WORKSPACE_CHANT_FLOOR, floorFor, floorRefusal } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { checkQuery, checkSnapshot, isEnvName } from "../web/view-url.js";
import { WORKSPACE_NAME } from "./terraform-member.ts";
import { checkCountBy } from "../web/view-url.js";
import { PLAN_READ_ENV, TERRAFORM_OBSERVE_ENV } from "./terraform-plan.ts";
import { WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

/** What a view asks search for. */
export interface SearchAsk {
  q: string;
  env?: string | null;
  snapshot?: string | null;
  /** `--show`: a comma list of attributes to carry on each row. */
  show?: string | null;
  /** behold#922: `--count-by`: `kind`, `module` or `attr:<name>`. */
  countBy?: string | null;
  /** behold#922: search at the plan depth (`CHANT_TERRAFORM_OBSERVE=plan`, `--live --env`). */
  plan?: boolean;
}

/** Where behold runs the search, and with which chant. */
export type SearchTarget =
  | { kind: "workspace"; root: string; chant: string | undefined }
  | { kind: "project"; dir: string; chant: string | undefined }
  /** A bare Terraform folder: `root` is its one-member scratch workspace (behold#925). */
  | { kind: "terraform"; dir: string; root: string; chant: string | undefined }
  | { kind: "refused"; refusal: WorkspaceRefusal };

/** A request that can't be sent to chant, with the reason. */
export class SearchAskError extends Error {
  constructor(readonly refusal: WorkspaceRefusal) {
    super(refusal.error);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Check what a request asks for, the way the URL's `q` and `snapshot` are checked. */
export function checkAsk(raw: { q?: string | null; env?: string | null; snapshot?: string | null; show?: string | null; countBy?: string | null; plan?: string | boolean | null }): SearchAsk {
  const q = checkQuery(raw.q ?? null);
  if (!q.ok) throw new SearchAskError({ error: `q was refused: ${q.reason}.`, code: "bad-request", remedy: "Pass q, a query in chant's search grammar." });
  const cb = checkCountBy(raw.countBy ?? null);
  if (!cb.ok) throw new SearchAskError({ error: `countBy was refused: ${cb.reason}.`, code: "bad-request", remedy: "Pass countBy=kind, countBy=module or countBy=attr:<name>." });
  const plan = raw.plan === true || raw.plan === "1" || raw.plan === "true";
  if (raw.plan !== undefined && raw.plan !== null && raw.plan !== "" && !plan && raw.plan !== false && raw.plan !== "0" && raw.plan !== "false") {
    throw new SearchAskError({ error: `plan is 1 or 0, not ${JSON.stringify(String(raw.plan).slice(0, 40))}.`, code: "bad-request", remedy: "Pass plan=1 for the plan depth, or leave it out." });
  }
  // With countBy, no query counts the whole graph (chant's own rule): "what's in here?".
  if (!q.value && !cb.value) throw new SearchAskError({ error: "there is no query to search for.", code: "bad-request", remedy: "Pass q, a query in chant's search grammar (https://intentius.io/chant/cli/search/), or countBy to count the whole graph." });
  const env = raw.env ? raw.env.trim() : null;
  if (env !== null && !isEnvName(env)) throw new SearchAskError({ error: `${JSON.stringify(env)} isn't an env name.`, code: "bad-request", remedy: "Pass one of the project's environments as env." });
  const snap = checkSnapshot(raw.snapshot ?? null);
  if (!snap.ok) throw new SearchAskError({ error: `snapshot was refused: ${snap.reason}.`, code: "bad-request", remedy: "Pass latest, or a snapshot ref chant lists." });
  if (snap.value && !env) throw new SearchAskError({ error: "a snapshot is of an env, and no env was named.", code: "bad-request", remedy: "Pass env with snapshot." });
  if (snap.value && plan) throw new SearchAskError({ error: "plan and snapshot were both asked: a plan is read now, and a snapshot replays what was recorded.", code: "bad-request", remedy: "Drop snapshot to read the plan, or drop plan to replay the snapshot." });
  const show = raw.show ? raw.show.trim() : null;
  if (show !== null && !/^[A-Za-z0-9_.:@/-]+(,[A-Za-z0-9_.:@/-]+)*$/.test(show)) {
    throw new SearchAskError({ error: `show is a comma list of attribute names, not ${JSON.stringify(show.slice(0, 80))}.`, code: "bad-request", remedy: "Pass show=a,b." });
  }
  return { q: q.value ?? "", ...(env ? { env } : {}), ...(snap.value ? { snapshot: snap.value } : {}), ...(show ? { show } : {}), ...(cb.value ? { countBy: cb.value } : {}), ...(plan ? { plan: true } : {}) };
}

/**
 * The flags one search takes, then `--` and the query: the mode follows the
 * view, and `--explain` is always on. The reader adds `--json` before the `--`.
 */
export function searchArgs(ask: SearchAsk): string[] {
  const mode = ask.plan
    ? ["--live", "--env", ask.env ?? PLAN_READ_ENV]
    : ask.env
      ? ask.snapshot
        ? ["--snapshot", ask.snapshot, "--env", ask.env]
        : ["--live", "--env", ask.env]
      : [];
  return [...mode, "--explain", ...(ask.show ? ["--show", ask.show] : []), ...(ask.countBy ? ["--count-by", ask.countBy] : []), "--", ask.q];
}

/** behold#922: the environment one search runs with: the plan depth when the view asks for the plan. */
export function searchEnv(ask: SearchAsk): Record<string, string> | undefined {
  return ask.plan ? { [TERRAFORM_OBSERVE_ENV]: "plan" } : undefined;
}

/**
 * behold#922: a plan without an env, on a target that isn't a bare Terraform
 * folder: a chant project's own environments are its to name, so behold
 * doesn't make one up for it.
 */
export function planRefusal(target: SearchTarget, ask: SearchAsk): WorkspaceRefusal | undefined {
  if (!ask.plan || ask.env || target.kind === "terraform" || target.kind === "refused") return undefined;
  return {
    error: "plan reads each Terraform root live at the plan depth, and no env was named.",
    code: "plan-env",
    remedy: "Pass env, one of the project's environments, with plan.",
  };
}

/** The refusal for a chant below the search floor, or undefined when it meets it. */
export function searchFloorRefusal(target: SearchTarget): WorkspaceRefusal | undefined {
  if (target.kind === "refused") return undefined;
  const f = floorFor("search");
  if (!meetsFloor(target.chant, SEARCH_CONTRACT_CHANT_FLOOR)) return floorRefusal(f, target.chant);
  if (target.kind === "terraform" && !meetsFloor(target.chant, SEARCH_TERRAFORM_WORKSPACE_CHANT_FLOOR)) return floorRefusal(floorFor("search over a Terraform folder"), target.chant);
  return undefined;
}

/**
 * Run one search, through the reader. One chant call. The document comes
 * back as chant printed it, a refused query or a failed live read included;
 * a chant below the floor, or a target behold can't search, is a refusal.
 */
export async function runSearch(
  target: SearchTarget,
  ask: SearchAsk,
  reader: (root: string, env?: Record<string, string>) => WorkspaceReader,
): Promise<{ ok: true; document: WorkspaceDocument } | { ok: false; refusal: WorkspaceRefusal }> {
  if (target.kind === "refused") return { ok: false, refusal: target.refusal };
  const tooOld = searchFloorRefusal(target);
  if (tooOld) return { ok: false, refusal: tooOld };
  const noEnv = planRefusal(target, ask);
  if (noEnv) return { ok: false, refusal: noEnv };
  const env = searchEnv(ask);
  try {
    if (target.kind === "workspace" || target.kind === "terraform") return { ok: true, document: await reader(target.root, env).read("search", searchArgs(ask)) };
    return { ok: true, document: await reader(target.dir, env).readProjectSearch(searchArgs(ask)) };
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
  /**
   * behold#922: a `--count-by` answer, chant's groups in chant's order, each
   * with the ids chant listed for it (INTENTIUS/chant#4382), or `ids: null`
   * from a chant that lists none (then nothing is lit for the group, and the
   * line says so). Absent for a row answer.
   */
  counts?: { by: string; total: number; groups: Array<{ group: string; count: number; ids: string[] | null }> };
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
  // behold#922: a counts answer lights each group's ids; it carries no rows.
  if (Array.isArray(doc.groups)) {
    const groups = doc.groups
      .filter((g): g is Record<string, unknown> => isRecord(g) && typeof g.group === "string" && typeof g.count === "number")
      .map((g) => ({ group: g.group as string, count: g.count as number, ids: Array.isArray(g.ids) ? g.ids.filter((x): x is string => typeof x === "string") : null }));
    for (const g of groups) for (const id of g.ids ?? []) lit.add(id);
    out.counts = { by: str(doc.countBy) ?? "", total: typeof doc.total === "number" ? doc.total : groups.reduce((n, g) => n + g.count, 0), groups };
  }
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
 * probes. `memberOf` is the name a lone dir's box is drawn under, and
 * `terraformWorkspace` writes the one-member scratch workspace a bare
 * Terraform folder is searched at (behold#925).
 */
export function searchTarget(o: {
  workspace: { root: string; chant: string } | undefined;
  dirs: readonly string[];
  kindOf: (dir: string) => string | undefined;
  chantOf: (dir: string) => string | undefined;
  memberOf: (dir: string) => string;
  terraformWorkspace: (dir: string, member: string) => { root: string; chant: string | undefined };
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
    const member = o.memberOf(dir);
    if (!WORKSPACE_NAME.test(member)) {
      return {
        kind: "refused",
        refusal: {
          error: `this folder is drawn as the member ${JSON.stringify(member)}, which isn't a workspace member name chant accepts (${WORKSPACE_NAME.source}), so chant can't search it under the ids its cards carry.`,
          code: "search-member-name",
          remedy: "Serve it from a directory whose name is lowercase letters, digits and dashes, or declare it in a chant.workspace.json and serve that root.",
        },
      };
    }
    const ws = o.terraformWorkspace(dir, member);
    return { kind: "terraform", dir, root: ws.root, chant: ws.chant };
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
 * behold#926: the capability catalog of the estate a search would ask, as
 * chant printed it (`chant search --capabilities --json`, chant#4375). The
 * same target as a search: `chant workspace search --capabilities` at a
 * declared workspace's root, and at a bare Terraform folder's
 * one-member scratch workspace (#925), plain `chant search --capabilities` in
 * one project's directory. One chant
 * call, through the reader, behind {@link CAPABILITIES_CHANT_FLOOR}.
 */
export async function runCapabilities(target: SearchTarget, reader: (root: string) => WorkspaceReader): Promise<{ ok: true; document: WorkspaceDocument } | { ok: false; refusal: WorkspaceRefusal }> {
  if (target.kind === "refused") return { ok: false, refusal: target.refusal };
  if (!meetsFloor(target.chant, CAPABILITIES_CHANT_FLOOR)) return { ok: false, refusal: floorRefusal(floorFor("capability catalog"), target.chant) };
  try {
    // #925: a bare Terraform folder is its one-member scratch workspace, asked like a declared one.
    if (target.kind === "workspace" || target.kind === "terraform") return { ok: true, document: await reader(target.root).readCapabilities("workspace") };
    return { ok: true, document: await reader(target.dir).readCapabilities("project") };
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

/** behold#978: how many searches a --public serve runs at once; the rest are answered 503 at once. */
export const PUBLIC_SEARCHES_IN_FLIGHT = 4;

/** behold#978: how long a capabilities document read from a checkout whose commit can't be read is kept. */
export const CAPABILITIES_UNCOMMITTED_TTL_MS = 30_000;

type CapabilitiesRead = Awaited<ReturnType<typeof runCapabilities>>;

/**
 * behold#978: {@link runCapabilities}, kept per checkout and commit. The
 * catalog is what the checkout's chant and lexicons declare, so it changes
 * only when the checkout moves: one entry per checkout, replaced when its
 * commit (or its chant) changes. A checkout whose commit can't be read keeps
 * its entry for {@link CAPABILITIES_UNCOMMITTED_TTL_MS}. Reads in flight are
 * shared; a refusal or a document with an `error` is never kept.
 */
export function cachedCapabilities(seams: { commitOf: (dir: string) => string | undefined; now?: () => number }): (
  target: SearchTarget,
  reader: (root: string) => WorkspaceReader,
) => Promise<CapabilitiesRead> {
  const now = seams.now ?? Date.now;
  const entries = new Map<string, { stamp: string; committed: boolean; at: number; read: Promise<CapabilitiesRead> }>();
  return (target, reader) => {
    if (target.kind === "refused") return runCapabilities(target, reader);
    // The checkout is the folder served; a Terraform folder's scratch workspace is derived from it.
    const checkout = target.kind === "workspace" ? target.root : target.dir;
    const commit = seams.commitOf(checkout);
    const stamp = `${target.kind}|${"root" in target ? target.root : ""}|${target.chant ?? ""}|${commit ?? ""}`;
    const t = now();
    for (const [k, e] of entries) if (!e.committed && t - e.at >= CAPABILITIES_UNCOMMITTED_TTL_MS) entries.delete(k);
    const hit = entries.get(checkout);
    if (hit && hit.stamp === stamp) return hit.read;
    const read = runCapabilities(target, reader);
    const entry = { stamp, committed: !!commit, at: t, read };
    entries.set(checkout, entry);
    const drop = (): void => { if (entries.get(checkout) === entry) entries.delete(checkout); };
    read.then((r) => { if (!r.ok || "error" in r.document) drop(); }, drop);
    return read;
  };
}
