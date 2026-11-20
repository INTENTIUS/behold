/**
 * The choudoufu member's live half (#370, M2 of #366): who owns each declared
 * instance, and what a plan would do about it, as colour on the cards M1 drew.
 *
 * One chant read answers it (behold#1227, src/choudoufu-chant-read.ts):
 * `chant graph --live --overlay` over the member's reader project, which reads
 * the root with `choudoufu live-plan -json`, `live-graph` and `live-ls -json`
 * and puts the verdict on each instance node, `facts.ownership`, with the rows
 * behind it, `facts.ownershipRows` (INTENTIUS/chant#5333, #5402). The roster
 * still comes from `live-check -json`, offline, because its instance ids are
 * the cards' and its rungs are choudoufu's own; src/choudoufu-ownership.ts
 * paints it from chant's facts. A re-check with plan (`opts.plan`, #924) is the
 * same read at the plan depth.
 *
 * The palette is the one behold already paints, `good | warn | accent |
 * neutral`, through the `(status, read)` table (src/drift-tone.ts), read
 * `ownership`. A bound instance is `good` whatever bound it (marker versus
 * derived is how the plan found the object, not who owns it; the card's
 * identity mark shows it), an unowned or foreign object is the drift case,
 * an absent one is pending, and everything the read could not answer is
 * `neutral` with the reason.
 *
 * behold does not run `choudoufu init` in a served project (#366's decision):
 * a member whose rungs came from the built-in table serves with the caveat on
 * its cards and a doctor warn, and the live half paints it the same.
 */
import type { GraphIR } from "@intentius/chant";
import type { GraphOptions } from "./chant.ts";
import {
  CHOUDOUFU_LEXICON,
  captureChoudoufu,
  ChoudoufuReadError,
  choudoufuVersion,
  isChoudoufuEstate,
  liveCheckToIr,
  readLiveCheck,
  type Captured,
  type LiveCheckDocument,
} from "./choudoufu-member.ts";
import { paintChoudoufuOwnership } from "./choudoufu-ownership.ts";
import { addIntraEstateEdges, lexiconStamp } from "./choudoufu-refs.ts";
import type { MemberVia } from "./member-ir.ts";
// Imported when a read needs it: the chant read reaches the member-kind
// registry through src/terraform-member.ts, which registers this module's spec.
import type { ChoudoufuChantAnswer, PlanResourceDrift } from "./choudoufu-chant-read.ts";
import { resolve } from "node:path";
import type { MemberKindSpec } from "./member-kind.ts";

/**
 * The account-inventory opt-in (#412, M1 of #410).
 *
 * `adoptable[]` is empty on any run that did not ask the account-inventory
 * question, and behold spawns `live-plan` without asking. choudoufu's own
 * `live-plan -help` states the switch and the cost: "-adoption-only … asks the
 * estate-wide sweep which live resources carry no ownership marker at all, a
 * question bounded by the account rather than by the estate, so it costs more
 * than an ordinary plan rather than less. Set TOFU_LIVE_COLLECT_UNCLAIMED=1 to
 * ask it on an ordinary plan, or 0 to skip it here."
 *
 * The env var and not the flag, for two reasons. `-adoption-only` suppresses
 * the resource diff, and the overlay needs `bound`/`omissions`/`unowned` as
 * much as it needs this. And behold already has a way to hand a choudoufu spawn
 * an environment that is not the process's — `serve.spawnEnv`, fed through
 * `setChoudoufuSpawnEnv` (src/choudoufu-member.ts) — so the opt-in rides a seam
 * that exists rather than a new argv behold would have to decide when to add.
 *
 * OFF BY DEFAULT, and it has to be: the sweep is bounded by the account rather
 * than the estate, and behold polls. Nothing about an ordinary serve changes.
 */
export const ADOPTION_SWEEP_VAR = "TOFU_LIVE_COLLECT_UNCLAIMED";

/** Did this environment ask for the sweep? `1` asks, `0` and absent do not —
 * choudoufu's own spelling, not a truthiness test of behold's invention. */
export function adoptionSweepRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ADOPTION_SWEEP_VAR] === "1";
}

// ---------------------------------------------------------------------------
// The second signal: attribute drift (#404).
// ---------------------------------------------------------------------------

/**
 * What a card wears when the plan would change a resource the estate owns.
 * `_`-prefixed, so it is a signal the SPA reads and not an inspect row.
 */
export interface PlanDriftMark {
  /** The plan's own verb(s) for this address: `["update"]`, or a replace. */
  actions: string[];
  /** The changed attribute NAMES, for the card's glyph and its tooltip. The
   * values live in `/api/diff`, which is where a pane can afford them. */
  attributes: string[];
}

/**
 * Mark the bound cards a plan would change. Mutates and returns `ir`.
 *
 * The ownership verdict stays the card's colour (#404's second bullet): this
 * only ADDS `_planDrift`, and never touches `_status`. A resource that is not
 * bound is skipped on purpose — an unowned object's planned create is an
 * ownership fact the overlay already paints, not an attribute that moved, and
 * `planDrift` drops creates for the same reason.
 *
 * Keyed by the COMPOSED id (`<member>/<address>`) when a member name is given,
 * because this runs over the composed estate IR at the route, not inside the
 * member's own read — the plan is opt-in per request and has no business in
 * `via.read`, which also answers `/api/graph`.
 */
export function paintPlanDrift(ir: GraphIR, drift: Map<string, { actions: string[]; changes: { path: string }[] }>, member?: string): number {
  if (!drift.size) return 0;
  let marked = 0;
  for (const n of ir.nodes) {
    if (n.lexicon !== CHOUDOUFU_LEXICON || n.attrs._status !== "good") continue;
    const address = member && n.id.startsWith(`${member}/`) ? n.id.slice(member.length + 1) : n.id;
    const d = drift.get(address);
    if (!d) continue;
    // chant names a change by its leaf path (`tags.drifted`); the card names
    // the attribute (`tags`), once.
    const mark: PlanDriftMark = { actions: d.actions, attributes: [...new Set(d.changes.map((c) => c.path.split(/[.[]/)[0]!))].sort() };
    n.attrs = { ...n.attrs, _planDrift: mark };
    marked++;
  }
  return marked;
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

/** A run of choudoufu, injectable. */
export type Runner = (args: string[], cwd: string) => Promise<Captured>;

/** What a live read of one member gives: the roster, and the roster painted from chant's facts. */
export interface ChoudoufuLiveRead {
  check: LiveCheckDocument;
  /** The roster with each card's ownership from chant's live read. */
  ir: GraphIR;
  /** The plan's attribute drift by instance address; empty unless a plan was read. */
  drift: Map<string, PlanResourceDrift>;
}

/**
 * Read a member live: the roster (offline, `live-check`), then chant's live
 * read of the root, at the plan depth when `opts.plan` asks. A roster refusal
 * or a chant that cannot read the member throws `ChoudoufuReadError`, and
 * `composeEstateOverlay` paints the member's source graph `neutral` with the
 * reason in its cover note, which is what "could not observe" looks like.
 */
export async function readChoudoufuLive(dir: string, opts: GraphOptions, run: Runner = captureChoudoufu): Promise<ChoudoufuLiveRead> {
  const chantRead = await import("./choudoufu-chant-read.ts");
  const check = await readLiveCheck(dir, run);
  if (!check.ok) throw new ChoudoufuReadError(check.refusal, dir);
  const unavailable = await chantRead.choudoufuChantUnavailable();
  if (unavailable) {
    if (opts.plan) planAnswers.set(resolve(dir), { answered: "live", note: `the member was not read: ${unavailable}` });
    throw new ChoudoufuReadError({ error: `${dir} was not read live: ${unavailable}`, code: "chant-too-old", remedy: "Upgrade the chant and terraform lexicon beside behold; `behold doctor` lists the floor." }, dir);
  }
  const stamp = chantRead.memberSourceStamp(dir);
  const r = await chantRead.readChoudoufuThroughChant(dir, { plan: !!opts.plan });
  if (opts.plan) {
    planAnswers.set(resolve(dir), { answered: r.answered, ...(r.note ? { note: r.note } : {}) });
    if (r.answered === "live+plan") chantRead.cacheChoudoufuPlan(resolve(dir), stamp, r.drift);
    // A re-check whose plan was not read must not leave an older change set standing as if it were this one.
    else chantRead.resetChoudoufuPlanCache(resolve(dir));
  }
  return { check: check.doc, ir: paintChoudoufuOwnership(liveCheckToIr(check.doc), r.ir, r.root, check.doc.estate), drift: r.drift };
}

/** What the last re-check with plan said for a member, by resolved directory:
 * which reads answered and, when the plan was not read, why (#924). */
const planAnswers = new Map<string, { answered: ChoudoufuChantAnswer; note?: string }>();
export function choudoufuPlanAnswer(dir: string): { answered: ChoudoufuChantAnswer; note?: string } | undefined {
  return planAnswers.get(resolve(dir));
}

/** The live read as an IR: the declared graph, painted. */
export async function choudoufuLiveIr(dir: string, opts: GraphOptions, run: Runner = captureChoudoufu): Promise<GraphIR> {
  return (await readChoudoufuLive(dir, opts, run)).ir;
}

/** How a choudoufu member is read (the `via` of its kind): the declared half
 * for a source read, the painted graph for a live one — and, on both, the
 * estate's own references (#393, src/choudoufu-refs.ts), which come from
 * chant's terraform lexicon over the same HCL and not from choudoufu at all.
 * The colour is the live half's; the topology is the same either way, which is
 * the rule /api/graph and /api/overlay are already held to. */
export const choudoufuVia: MemberVia = {
  tool: () => {
    const v = choudoufuVersion();
    // The lexicon is half of what answers this member now: installing it turns
    // an edgeless estate into one with 266 edges off byte-identical source, so
    // it has to be a different cache key or the estate serves the pre-install
    // IR until something else invalidates it (src/member-ir.ts, rule 3).
    return `choudoufu\0${v ? v.version || "dev" : "absent"}\0${lexiconStamp()}`;
  },
  read: async (dir: string, opts: GraphOptions): Promise<GraphIR> => {
    if (opts.live || opts.overlay) return addIntraEstateEdges(await choudoufuLiveIr(dir, opts), dir);
    const parsed = await readLiveCheck(dir);
    if (!parsed.ok) throw new ChoudoufuReadError(parsed.refusal, dir);
    return addIntraEstateEdges(liveCheckToIr(parsed.doc), dir);
  },
};

/** The kind, as src/member-kind.ts registers it. */
export const choudoufuSpec: MemberKindSpec = {
  kind: "choudoufu",
  probe: isChoudoufuEstate,
  expects: "an `estate.chdf.hcl` sidecar or a `live { estate = … }` block in a root *.tf file",
  via: choudoufuVia,
};

// ---------------------------------------------------------------------------
// The inspect pane's live state (#370): what `/api/diff` says for a choudoufu
// node, in the shape `renderObserved` already reads.
// ---------------------------------------------------------------------------

export interface DiffNode {
  observed: unknown;
  diff: unknown;
  health: string;
  healthDetail?: string;
  fieldDrift: unknown;
}

/** One `/api/diff` entry per card of a member's painted roster (behold#1227:
 * from chant's ownership facts), declared or marked-undeclared, keyed by the COMPOSED id (`<member>/<address>`) when
 * a member name is given, so the pane's lookup by node id lands. `health` is
 * the pane's own vocabulary: `healthy` for a bound instance, `degraded` for
 * an unowned object, `unknown` otherwise; `healthDetail` is the verdict's own
 * sentence.
 *
 * `diff` is null unless a plan was read for this member (#404, `plan=1`).
 * choudoufu has no snapshot to drift from, so there is no `driftedSinceSnapshot`
 * to report — but a plan document names the attributes that differ between the
 * live object and the configuration, and that is what the pane's `diff`
 * section renders: one row per attribute, `before → after`. The category is
 * `planned` rather than chant's `drifted`, because "drifted since snapshot" is
 * a claim about a baseline that does not exist here — see web/app.js's
 * DIFF_LABEL.
 *
 * `fieldDrift` stays null: it is the k8s managed-fields question (which
 * MANAGER owns a path), and a Terraform plan answers nothing about it. */
export function choudoufuDiffNodes(
  live: ChoudoufuLiveRead,
  member?: string,
  drift?: Map<string, { actions: string[]; changes: { path: string; oldValue: unknown; newValue: unknown }[] }>,
): Record<string, DiffNode> {
  const key = (address: string): string => (member ? `${member}/${address}` : address);
  const rung = new Map(live.check.instances.map((i) => [i.address, i.rung]));
  const out: Record<string, DiffNode> = {};
  for (const n of live.ir.nodes) {
    if (n.lexicon !== CHOUDOUFU_LEXICON || n.attrs.producer !== undefined) continue;
    const a = n.attrs as Record<string, unknown>;
    const status = (a._drift as { status?: string } | undefined)?.status;
    const observed = status !== undefined && status !== "not-observed";
    const health = a._status === "good" ? "healthy" : a._status === "warn" ? "degraded" : "unknown";
    const { _status: _s, _drift: _d, _unobserved: unobserved, _identity: _i, ...rows } = a;
    const detail =
      typeof a.marked === "string"
        ? a.marked
        : typeof a.bound === "string"
          ? `bound ${a.bound}${a.marker === "no marker on the object" ? "; no marker on the object" : ""}`
          : typeof a.omission === "string"
            ? `${a.omission}: ${String(a.detail ?? "")}`
            : typeof unobserved === "string"
              ? unobserved
              : typeof a.listing === "string"
                ? a.listing
                : undefined;
    const r = rung.get(n.id);
    out[key(n.id)] = {
      observed: observed
        ? {
            type: n.kind,
            ...(n.physicalId ? { physicalId: n.physicalId } : {}),
            ...(n.ownership ? { ownership: n.ownership } : {}),
            // #393 item 10: the verdict's own rows first (an UNOWNED instance
            // leads with the line that adopts it), and the rung, the one fact
            // that is true of the declaration whatever the account holds, last.
            attributes: { ...rows, ...(r ? { rung: r } : {}) },
          }
        : null,
      // #404: only for a BOUND instance, the same gate `paintPlanDrift`
      // applies, so the card's mark and the pane's rows can never disagree.
      diff: a._status === "good" && drift?.has(n.id) ? { category: "planned", changes: drift.get(n.id)!.changes } : null,
      health,
      ...(detail ? { healthDetail: detail } : {}),
      fieldDrift: null,
    };
  }
  return out;
}
