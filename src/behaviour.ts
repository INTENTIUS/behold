/**
 * The behaviour overlay (#398, M1 of #397) — what an estate costs and where it
 * runs out of headroom, as a fact per entity on `/api/overlay`.
 *
 * The contract is not behold's. It is pinned in the "The behaviour block,
 * proposed" comment on INTENTIUS/behold#398 (chant #2356 is the other half),
 * and this module implements it byte for byte in field names. A behavioural
 * engine — the lexicon's, never behold's — states, at a traffic level it names
 * itself, a cost per hour, the headroom left on cpu and latency, an expected
 * error rate, a resilience verdict under a named failure, an optional
 * right-size hint, and the provenance of all of it.
 *
 * The invariant #397 exists to protect: **behold never calls an engine**,
 * never holds its key, and produces no figure of its own. It reads what the
 * lexicon handed it, validates the shape, and does exactly one piece of
 * arithmetic — a sum of engine figures, labelled as a sum (`meta.behaviour.
 * sum`, never `total`, which is the word reserved for a figure the engine
 * itself stated). A missing engine is a refusal printed in the engine's own
 * words; it is never a locally faked number.
 *
 * ## The two sources, and their priority
 *
 *  1. **`attrs._behaviour` on an overlay IR node** — the channel every other
 *     live fact rides on (`_status`, `_release`, `_carve`, `_renderDrift`;
 *     src/overlay.ts documents the family). `chant graph --live --overlay`
 *     puts it there, keyed by the entity id the drift overlay already keys.
 *     Graph-level facts ride beside it on `meta._behaviour`.
 *  2. **`behaviour.<env>.json` at a member's root** — the same shapes as a
 *     document, `{ meta, entities: { <address>: block } }`. Read ONLY when no
 *     node in that member's slice carries `_behaviour`, and only on the
 *     overlay: `/api/graph` is the source graph and a prediction of a live
 *     account has no business on it. Entity keys are the member's own
 *     addresses, as a lexicon writes them; behold prefixes them with the
 *     member name to reach the composed id (`<member>/<address>`).
 *
 * A member with neither draws no behaviour modes at all, and the meta says so
 * in one line naming both places it looked. That is an absence, not a refusal:
 * nothing was configured, so nothing refused.
 *
 * ## Why the block stays on the node
 *
 * #398 leaves the payload shape to the implementation: the block on the node
 * as today, or a second top-level `behaviour: { [id]: block }` map beside the
 * IR. It stays on the node, and the map is deliberately NOT emitted.
 *
 * The SPA walks `ir.nodes` once per render and reads `attrs._status` off each
 * node to colour it (web/app.js). A colour-by-cost mode is that same walk
 * reading `attrs._behaviour.cost.perHour` — no join, no second index, no way
 * for the two to fall out of step. A top-level map would make every node
 * lookup a join against a second structure keyed by an id the node already
 * carries, which is a join the drift overlay never needed and the reason
 * `_status` is a node attr in the first place. The estate scale a colour-by
 * mode needs (min/max over the entities that carry a figure) comes out of the
 * same single pass.
 *
 * So: one channel, one reader, whichever source filled it. `meta.behaviour` is
 * the graph-level half — engine, version, the traffic level, the sums, the
 * refusal, the diagnostics — and it is the only thing the response gains
 * beside the node attr.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The shapes. Field names are the #398 comment's, exactly.
// ---------------------------------------------------------------------------

/** The stated traffic level a prediction is for — a string the engine names,
 * echoed verbatim. behold never picks a default one; there isn't one. */
export interface BehaviourAt {
  traffic: string;
}

export interface BehaviourCost {
  perHour: number;
  currency: string;
}

/** Fraction of capacity still free, 0..1. A missing axis is ABSENT, not 0 —
 * "the engine did not report cpu" and "there is no cpu left" are opposite
 * claims and must not render alike. */
export interface BehaviourHeadroom {
  cpu?: number;
  latency?: number;
}

export type BehaviourVerdict = "survives" | "degrades" | "fails";

export interface BehaviourResilience {
  failure: string;
  verdict: BehaviourVerdict;
  note?: string;
}

export interface BehaviourRightSize {
  suggestion: string;
  reason?: string;
}

/** List prices versus a bill. `modeled` is the badge's default word. */
export type BehaviourBasis = "modeled" | "validated";

/** Per ENTITY, not per report: one estate can be priced by two engines. */
export interface BehaviourProvenance {
  engine: string;
  version: string;
  /** The engine's own stated tolerance, echoed verbatim ("±15%"). */
  tolerance: string;
  basis: BehaviourBasis;
}

/** One entity's block. Everything except `rightSize`, `resilience.note` and
 * either `headroom` axis is required when the block is present at all. */
export interface BehaviourBlock {
  at: BehaviourAt;
  cost: BehaviourCost;
  headroom: BehaviourHeadroom;
  errorRate: number;
  resilience: BehaviourResilience;
  rightSize?: BehaviourRightSize;
  provenance: BehaviourProvenance;
}

/** Present INSTEAD of engine/version/at/total when the engine is configured
 * but unreachable, or not configured at all. The words are the lexicon's, in
 * its own house style; behold prints them as they came. */
export interface BehaviourRefusal {
  reason: string;
  remedy: string;
}

/** `meta._behaviour` on the overlay IR / `meta` in the report document. */
export interface BehaviourReportMeta {
  engine?: string;
  version?: string;
  at?: BehaviourAt;
  /** An estate total the ENGINE stated. When present it outranks behold's own
   * sum, and behold emits no sum at all. */
  total?: BehaviourCost;
  refusal?: BehaviourRefusal;
}

/** `{ meta, entities }` — the lexicon's written report, and every fixture. */
export interface BehaviourReport {
  meta: BehaviourReportMeta;
  entities: Record<string, unknown>;
}

/** behold's own arithmetic over engine figures, labelled as arithmetic. */
export interface BehaviourSum {
  perHour: number;
  currency: string;
  /** Entities in scope that carried a cost figure. */
  priced: number;
  /** Entities in scope that carried none. */
  unpriced: number;
}

/** `meta.behaviour` on the `/api/overlay` payload. */
export interface BehaviourMeta {
  engine?: string;
  version?: string;
  at?: BehaviourAt;
  /** The engine's own estate total, when it stated one. */
  total?: BehaviourCost;
  refusal?: BehaviourRefusal;
  /** One line naming the two places behold looked and found nothing. Present
   * INSTEAD of everything else; not a refusal — nothing was configured. */
  absent?: string;
  /** behold's sum over the entity figures, when the engine stated no total. */
  sum?: BehaviourSum;
  /** The same sum per boundary box (`groups.byStack` — a member of an
   * estate), keyed by the box's own key. */
  boxes?: Record<string, BehaviourSum>;
  /** Everything behold dropped or could not reconcile, in the order it hit
   * them: a malformed block, two engines on one estate, mixed currencies. */
  diagnostics?: string[];
}

// ---------------------------------------------------------------------------
// Validation. A malformed block is DROPPED with a diagnostic, never partially
// rendered — half a block on a card is a figure without its provenance, which
// is the one thing #397 says may never appear.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A fraction the contract bounds at 0..1. Out of range is malformed, not
 * clamped: clamping would invent a figure, which is the whole prohibition. */
const frac = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined;
};

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/**
 * One entity block, validated against the #398 contract and REBUILT to it.
 *
 * Rebuilt rather than passed through: the block reaches a card and a badge, so
 * what the SPA sees should be exactly the contract's fields and nothing an
 * engine happened to append. A future field is a contract change, made here,
 * not a key that leaks through unvalidated.
 */
export function validateBehaviourBlock(v: unknown): Validated<BehaviourBlock> {
  const b = rec(v);
  if (!b) return bad("not an object");

  const traffic = str(rec(b.at)?.traffic);
  if (!traffic) return bad("at.traffic missing — the engine must name the traffic level it priced");

  const cost = rec(b.cost);
  const perHour = num(cost?.perHour);
  const currency = str(cost?.currency);
  if (perHour === undefined) return bad("cost.perHour is not a finite number");
  if (perHour < 0) return bad("cost.perHour is negative");
  if (!currency) return bad("cost.currency missing");

  const headroom = rec(b.headroom);
  if (!headroom) return bad("headroom missing");
  const cpu = headroom.cpu === undefined ? undefined : frac(headroom.cpu);
  const latency = headroom.latency === undefined ? undefined : frac(headroom.latency);
  if (headroom.cpu !== undefined && cpu === undefined) return bad("headroom.cpu is not a fraction 0..1");
  if (headroom.latency !== undefined && latency === undefined) return bad("headroom.latency is not a fraction 0..1");
  if (cpu === undefined && latency === undefined) return bad("headroom carries neither cpu nor latency");

  const errorRate = frac(b.errorRate);
  if (errorRate === undefined) return bad("errorRate is not a fraction 0..1");

  const res = rec(b.resilience);
  const failure = str(res?.failure);
  const verdict = res?.verdict;
  if (!failure) return bad("resilience.failure missing — a verdict with no named failure says nothing");
  if (verdict !== "survives" && verdict !== "degrades" && verdict !== "fails") {
    return bad(`resilience.verdict ${JSON.stringify(verdict)} is not survives/degrades/fails`);
  }
  const note = str(res?.note);

  let rightSize: BehaviourRightSize | undefined;
  if (b.rightSize !== undefined) {
    const rs = rec(b.rightSize);
    const suggestion = str(rs?.suggestion);
    if (!suggestion) return bad("rightSize present without a suggestion");
    const reason = str(rs?.reason);
    rightSize = { suggestion, ...(reason ? { reason } : {}) };
  }

  const prov = rec(b.provenance);
  const engine = str(prov?.engine);
  const version = str(prov?.version);
  const tolerance = str(prov?.tolerance);
  const basis = prov?.basis;
  if (!engine) return bad("provenance.engine missing");
  if (!version) return bad("provenance.version missing");
  if (!tolerance) return bad("provenance.tolerance missing — a figure without a stated tolerance is not a prediction");
  if (basis !== "modeled" && basis !== "validated") return bad(`provenance.basis ${JSON.stringify(basis)} is not modeled/validated`);

  return {
    ok: true,
    value: {
      at: { traffic },
      cost: { perHour, currency },
      headroom: { ...(cpu !== undefined ? { cpu } : {}), ...(latency !== undefined ? { latency } : {}) },
      errorRate,
      resilience: { failure, verdict, ...(note ? { note } : {}) },
      ...(rightSize ? { rightSize } : {}),
      provenance: { engine, version, tolerance, basis },
    },
  };
}

/** The graph-level half. A refusal is validated on its own terms and short-
 * circuits everything else — that is what "present INSTEAD of" means. */
export function validateBehaviourMeta(v: unknown): Validated<BehaviourReportMeta> {
  const m = rec(v);
  if (!m) return bad("meta is not an object");

  if (m.refusal !== undefined) {
    const r = rec(m.refusal);
    const reason = str(r?.reason);
    const remedy = str(r?.remedy);
    if (!reason) return bad("refusal.reason missing");
    if (!remedy) return bad("refusal.remedy missing — a refusal that names no way forward is a dead end");
    return { ok: true, value: { refusal: { reason, remedy } } };
  }

  const engine = str(m.engine);
  const version = str(m.version);
  if (!engine) return bad("meta.engine missing");
  if (!version) return bad("meta.version missing");
  const traffic = str(rec(m.at)?.traffic);
  if (!traffic) return bad("meta.at.traffic missing");

  let total: BehaviourCost | undefined;
  if (m.total !== undefined) {
    const t = rec(m.total);
    const perHour = num(t?.perHour);
    const currency = str(t?.currency);
    if (perHour === undefined || !currency) return bad("meta.total is not {perHour, currency}");
    total = { perHour, currency };
  }
  return { ok: true, value: { engine, version, at: { traffic }, ...(total ? { total } : {}) } };
}

/** The whole document, shape-checked before either half is read. */
export function validateBehaviourReport(v: unknown): Validated<{ meta: BehaviourReportMeta; entities: Record<string, unknown> }> {
  const d = rec(v);
  if (!d) return bad("not an object");
  const meta = validateBehaviourMeta(d.meta);
  if (!meta.ok) return bad(meta.reason);
  const entities = rec(d.entities) ?? {};
  if (d.entities !== undefined && !rec(d.entities)) return bad("entities is not an object");
  return { ok: true, value: { meta: meta.value, entities } };
}

// ---------------------------------------------------------------------------
// The document on disk.
// ---------------------------------------------------------------------------

/** The report document a member's root may carry for an environment. One
 * name, derived from the env the overlay was asked for — so a `live` overlay
 * never reads a `staging` prediction. */
export const behaviourFileName = (env: string): string => `behaviour.${env}.json`;

/** How a file is read. Injected so tests (and a future non-fs source) do not
 * need a temp directory, exactly as `pathAlignment`'s `isDir` is injected. */
export type ReadFile = (path: string) => string | undefined;

const realRead: ReadFile = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined; // absent is an ordinary state, not an error
  }
};

// ---------------------------------------------------------------------------
// The pass.
// ---------------------------------------------------------------------------

interface Node {
  id: string;
  attrs?: Record<string, unknown>;
}

interface Ir {
  nodes: Node[];
  groups: { byStack?: Record<string, string[]> };
}

/** One served member, as the pass needs to see it. */
export interface BehaviourMember {
  /** The name `composeStacks` namespaces this member's ids under, and the
   * prefix an entity address in its report document gets. Undefined on a
   * single-project serve, where node ids are the member's own addresses. */
  name?: string;
  /** The member's root — where `behaviour.<env>.json` would sit. */
  dir: string;
  /** `meta._behaviour` as this member's own overlay read carried it. chant's
   * graph JSON may carry keys `GraphIR` does not declare, and composition
   * keeps nothing above nodes/edges/groups, so it is captured per member
   * before composition and handed here. */
  meta?: unknown;
}

/** How a member's blocks arrived, for the diagnostics and the absent line. */
type MemberSource = "attrs" | "document" | "none";

const BEHAVIOUR_ATTR = "_behaviour";

/** The node ids belonging to a member: composition namespaces every id
 * `<member>/<id>`, so a member's slice of a composed IR is exactly that
 * prefix (the same reading `withoutJoinedMembers` takes in src/estate.ts). */
const sliceOf = (nodes: Node[], name: string | undefined): Node[] =>
  name === undefined ? nodes : nodes.filter((n) => n.id.startsWith(`${name}/`));

/** Sums carry engine figures through addition and nothing else. Binary
 * floating point makes `0.0416 * 21` end in a tail of digits nobody stated,
 * so the sum is rounded back to six decimals — finer than any currency, and
 * enough that the arithmetic reads as the addition it is rather than as a
 * figure of behold's own with a spurious precision. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** The sum over a set of nodes: engine figures added, everything else counted.
 * Mixed currencies produce no sum at all — converting is the engine's job and
 * behold has no rate to convert with. */
function sumOver(nodes: Node[], onMixed: (currencies: string[]) => void): BehaviourSum | undefined {
  const currencies = new Set<string>();
  let perHour = 0;
  let priced = 0;
  let unpriced = 0;
  for (const n of nodes) {
    const b = n.attrs?.[BEHAVIOUR_ATTR] as BehaviourBlock | undefined;
    if (!b) {
      unpriced++;
      continue;
    }
    priced++;
    perHour += b.cost.perHour;
    currencies.add(b.cost.currency);
  }
  if (priced === 0) return undefined;
  if (currencies.size > 1) {
    onMixed([...currencies].sort());
    return undefined;
  }
  return { perHour: round6(perHour), currency: [...currencies][0], priced, unpriced };
}

/**
 * Read the behaviour block onto every entity that has one, and answer the
 * graph-level `meta.behaviour`.
 *
 * Mutates `ir.nodes` — a validated block replaces whatever `attrs._behaviour`
 * held, a malformed one is deleted, and a refusal deletes every one of them.
 * Returns the meta the route puts on the payload; always returns something,
 * because "nothing here is priced, and here is where I looked" is itself the
 * answer to the question the overlay asks.
 */
export function attachBehaviour(
  ir: Ir,
  members: readonly BehaviourMember[],
  env: string,
  readFile: ReadFile = realRead,
): BehaviourMeta {
  const diagnostics: string[] = [];
  const metas: { name: string; meta: BehaviourReportMeta }[] = [];
  const sources = new Map<string, MemberSource>();
  const looked: string[] = [];

  for (const m of members) {
    const label = m.name ?? "the project";
    const slice = sliceOf(ir.nodes, m.name);
    const inline = slice.filter((n) => n.attrs?.[BEHAVIOUR_ATTR] !== undefined);

    if (inline.length > 0) {
      // Source 1 wins outright: a member whose lexicon painted the nodes is
      // never second-guessed by a file someone left in its root.
      sources.set(label, "attrs");
      for (const n of inline) {
        const v = validateBehaviourBlock(n.attrs![BEHAVIOUR_ATTR]);
        if (v.ok) n.attrs![BEHAVIOUR_ATTR] = v.value;
        else {
          delete n.attrs![BEHAVIOUR_ATTR];
          diagnostics.push(`dropped the behaviour block on ${n.id}: ${v.reason}`);
        }
      }
      if (m.meta !== undefined) {
        const vm = validateBehaviourMeta(m.meta);
        if (vm.ok) metas.push({ name: label, meta: vm.value });
        else diagnostics.push(`${label}: dropped meta._behaviour — ${vm.reason}`);
      }
      continue;
    }

    // Source 2, and only now: no node of this member carries the attr.
    const file = behaviourFileName(env);
    looked.push(`${label}/${file}`);
    const raw = readFile(join(m.dir, file));
    if (raw === undefined) {
      sources.set(label, "none");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      sources.set(label, "none");
      diagnostics.push(`${label}: ${file} is not JSON — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const doc = validateBehaviourReport(parsed);
    if (!doc.ok) {
      sources.set(label, "none");
      diagnostics.push(`${label}: ${file} is not a behaviour report — ${doc.reason}`);
      continue;
    }
    sources.set(label, "document");
    metas.push({ name: label, meta: doc.value.meta });
    // Join by entity id. The file's keys are the member's OWN addresses, the
    // way a lexicon writes them; the composed id is `<member>/<address>`, so
    // behold adds the prefix rather than asking a lexicon to know what it was
    // composed as. A key naming no node is reported, never minted as a card.
    const byId = new Map(slice.map((n) => [n.id, n]));
    for (const [address, block] of Object.entries(doc.value.entities)) {
      const id = m.name === undefined ? address : `${m.name}/${address}`;
      const node = byId.get(id);
      if (!node) {
        diagnostics.push(`${label}: ${file} prices ${address}, which this overlay has no entity for`);
        continue;
      }
      const v = validateBehaviourBlock(block);
      if (!v.ok) {
        diagnostics.push(`dropped the behaviour block on ${id}: ${v.reason}`);
        continue;
      }
      node.attrs = { ...node.attrs, [BEHAVIOUR_ATTR]: v.value };
    }
  }

  // A refusal drops every behaviour-derived figure and colour — including any
  // that another member happily supplied, because the estate's answer is one
  // answer. The drift overlay is untouched: nothing above or below this line
  // reads or writes `_status`.
  const refused = metas.find((m) => m.meta.refusal);
  if (refused) {
    for (const n of ir.nodes) if (n.attrs?.[BEHAVIOUR_ATTR] !== undefined) delete n.attrs[BEHAVIOUR_ATTR];
    const others = metas.filter((m) => m.meta.refusal && m !== refused).map((m) => m.name);
    return {
      refusal: refused.meta.refusal!,
      ...(others.length ? { diagnostics: [`${others.join(", ")} refused too, in their own words`] } : {}),
    };
  }

  // Absent means nothing arrived from EITHER source: no graph-level statement
  // and not one entity block. A lexicon that paints nodes without stating a
  // `meta._behaviour` has still priced the estate — the badge on each figure is
  // that entity's own provenance, which is where the contract puts it.
  const anyBlock = ir.nodes.some((n) => n.attrs?.[BEHAVIOUR_ATTR] !== undefined);
  if (metas.length === 0 && !anyBlock) {
    const where = looked.length ? looked.join(", ") : `${behaviourFileName(env)} at each member's root`;
    return {
      absent: `no behaviour block: no node carries attrs._behaviour (what \`chant graph --live --overlay\` would paint from the lexicon's engine), and no report document at ${where}`,
      ...(diagnostics.length ? { diagnostics } : {}),
    };
  }

  // Provenance is per entity, so the graph-level engine is a summary of what
  // priced this estate, not an authority over it. When members disagree the
  // first is reported and the disagreement is named — every figure still
  // carries its own badge, which is the reason the contract puts provenance on
  // the entity in the first place.
  const first = metas[0]?.meta ?? {};
  const engines = [...new Set(metas.map((m) => `${m.meta.engine} ${m.meta.version}`))];
  if (engines.length > 1) diagnostics.push(`priced by ${engines.length} engines (${engines.join(", ")}) — every figure carries its own provenance`);
  const trafficLevels = [...new Set(metas.map((m) => m.meta.at?.traffic).filter((t): t is string => !!t))];
  if (trafficLevels.length > 1) diagnostics.push(`priced at ${trafficLevels.length} traffic levels (${trafficLevels.join("; ")}) — the sums add figures stated at different levels`);

  const meta: BehaviourMeta = {
    ...(first.engine ? { engine: first.engine } : {}),
    ...(first.version ? { version: first.version } : {}),
    ...(first.at ? { at: first.at } : {}),
  };

  // `total` is the ENGINE's word for an estate figure and only ever holds an
  // engine's own number; `sum` is behold's addition, named so nobody can mistake
  // one for the other. When the engine stated a total, behold adds nothing.
  const engineTotal = metas.map((m) => m.meta.total).find((t): t is BehaviourCost => !!t);
  if (engineTotal) {
    meta.total = engineTotal;
    if (metas.filter((m) => m.meta.total).length > 1) diagnostics.push("two members stated an estate total; the first is shown");
  } else {
    const sum = sumOver(ir.nodes, (cs) => diagnostics.push(`no estate sum: the figures are in ${cs.join(" and ")} and behold converts no currency`));
    if (sum) meta.sum = sum;
    const byStack = ir.groups.byStack;
    if (byStack) {
      const boxes: Record<string, BehaviourSum> = {};
      for (const [boxKey, ids] of Object.entries(byStack)) {
        const inBox = new Set(ids);
        const boxSum = sumOver(
          ir.nodes.filter((n) => inBox.has(n.id)),
          (cs) => diagnostics.push(`no sum for box ${boxKey}: the figures are in ${cs.join(" and ")} and behold converts no currency`),
        );
        if (boxSum) boxes[boxKey] = boxSum;
      }
      if (Object.keys(boxes).length) meta.boxes = boxes;
    }
  }

  const quiet = [...sources].filter(([, s]) => s === "none").map(([n]) => n);
  if (quiet.length) diagnostics.push(`no behaviour source for ${quiet.join(", ")} (no attrs._behaviour, no ${behaviourFileName(env)})`);

  if (diagnostics.length) meta.diagnostics = diagnostics;
  return meta;
}
