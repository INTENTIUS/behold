/**
 * The choudoufu member's live half (#370, M2 of #366): what the account holds
 * under the estate tag, and what a plan would do about it, as colour on the
 * cards M1 drew.
 *
 * Two reads per member, both under the ambient read-only role, both in the
 * member's directory with no `-estate` flag (the `live` block names it, and
 * `-estate` beside one is refused):
 *
 *  - `live-ls -json .` — every resource the account holds under the estate's
 *    tag (the Resource Groups Tagging API's index plus an IAM pass), each with
 *    its ARN, type and decoded address; and `gaps[]`, the declared instances
 *    the listing cannot see, named by the rung that explains it.
 *  - `live-plan -json` — `bound[]` (declared instances matched to a live
 *    object, with how), `omissions[]` (declared instances the plan left out,
 *    with a reason), `unowned[]` (a live object at a declared identity that is
 *    not ours: adoptable, or belonging to another estate), `diagnostics[]`.
 *
 * The palette is the one behold already paints, `good | warn | accent |
 * neutral`, mapped from three vocabularies choudoufu deliberately did not
 * unify (`bound[].source`, `gaps[].rung`, the ten omission reasons) — the
 * table in `paintChoudoufu`. Nothing new is invented: a bound instance is
 * `good` whatever bound it (marker versus derived tracks the tagging index's
 * lag, not the estate), an unowned object is the drift case, an absent one is
 * pending, and everything the tool could not answer is `neutral`.
 *
 * Join on the decoded `address`, never the raw `tofu-address` tag (which
 * escapes `[0]` as `:0`). The document conventions differ and are handled
 * here: `live-check` and `live-ls` always print their arrays, `live-plan`'s
 * three sections may be `null`, `gaps` was `omitempty` before choudoufu#966.
 *
 * behold does not run `choudoufu init` in a served project (#366's decision):
 * a member whose rungs came from the built-in table serves with the caveat on
 * its cards and a doctor warn, and the live half paints it the same — bound
 * is bound whichever table classified the type.
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
  stripAnsiLines,
  type Captured,
  type ChoudoufuRefusal,
  type LiveCheckDocument,
} from "./choudoufu-member.ts";
import type { MemberVia } from "./member-ir.ts";
import type { MemberKindSpec } from "./member-kind.ts";

// ---------------------------------------------------------------------------
// The documents.
// ---------------------------------------------------------------------------

/** `bound[].source`, pinned (choudoufu `views/live_plan.go`). */
export const BOUND_SOURCES = ["marker", "record", "derived", "cache"] as const;
/** `gaps[].rung`, pinned (choudoufu `views/live_ls.go`): two words, one of
 * them a second spelling of live-check's `record-only`. */
export const GAP_RUNGS = ["record", "declaration-carried"] as const;
/** `omissions[].reason`, pinned (choudoufu `internal/live/projection/result.go`).
 * `UNREADABLE` and `INCOMPLETE_BLOCK` are documented as unreachable from a
 * plan document and painted anyway, so a document that carries one is not a
 * crash. */
export const OMISSION_REASONS = [
  "NEEDS_DISCOVERY",
  "PARENT_UNAVAILABLE",
  "ABSENT",
  "FAILED",
  "CYCLE",
  "UNOWNED",
  "UNREADABLE",
  "INCOMPLETE_BLOCK",
  "SUPERSEDED",
  "LISTED_NOT_IMPORTABLE",
] as const;

export interface LiveLsItem {
  id: string;
  type: string;
  address?: string;
  slot?: string;
  declared: boolean;
  source: string;
  tags: Record<string, string>;
}

export interface LiveLsGap {
  address: string;
  type: string;
  rung: string;
  detail: string;
}

export interface LiveLsDocument {
  estate: string;
  region?: string;
  consistent: boolean;
  stabilized: boolean;
  attempts: number;
  config_dir?: string;
  schemas?: string;
  items: LiveLsItem[];
  gaps?: LiveLsGap[] | null;
  gaps_skipped?: string;
}

export interface LivePlanBound {
  addr: string;
  type: string;
  identity?: string;
  identity_values?: Record<string, string>;
  source: string;
}

export interface LivePlanOmission {
  addr: string;
  reason: string;
  detail: string;
}

/** Two shapes: adoptable (`adopt_tofu_*`) and belongs-elsewhere (`tofu_estate`). */
export interface LivePlanUnowned {
  addr: string;
  type: string;
  identity: string;
  tofu_estate?: string;
  adopt_tofu_estate?: string;
  adopt_tofu_address?: string;
}

export interface LivePlanDiagnostic {
  severity: string;
  summary: string;
  detail?: string;
}

export interface LivePlanDocument {
  estate: string;
  choudoufu_version: string;
  upstream_version: string;
  bound?: LivePlanBound[] | null;
  omissions?: LivePlanOmission[] | null;
  unowned?: LivePlanUnowned[] | null;
  /** choudoufu#962: live objects the sweep found for declarations that
   * declare no identity. Empty unless the run asked the account-inventory
   * question; `swept` says whether it did. Carried, not painted, in M2. */
  adoptable?: unknown[] | null;
  swept?: string[] | null;
  diagnostics?: LivePlanDiagnostic[] | null;
}

export type LiveLsParse = { ok: true; doc: LiveLsDocument } | { ok: false; refusal: ChoudoufuRefusal };
export type LivePlanParse = { ok: true; doc: LivePlanDocument } | { ok: false; refusal: ChoudoufuRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (error: string, remedy: string): { ok: false; refusal: ChoudoufuRefusal } => ({ ok: false, refusal: { error, code: "choudoufu-live-check", remedy } });
const CREDS = "Give behold the ambient read-only AWS credentials the estate's `live-ls` and `live-plan` need (AWS_PROFILE, or AWS_ENDPOINT_URL for an emulator), then reload.";

/** What a failed spawn said, as one line: choudoufu's own `Error:` line when
 * there is one. */
function said(run: Captured, fallback: string): string {
  const lines = stripAnsiLines(run.stderr);
  return lines.find((l) => /^Error:/.test(l)) ?? lines[0] ?? fallback;
}

/** Validate `live-ls -json` output. Shallow: the fields painted, plus the
 * `schemas` key that marks a document new enough to trust. */
export function parseLiveLs(run: Captured, dir: string): LiveLsParse {
  if (run.code === 127) return refuse("choudoufu is not on PATH.", "Install choudoufu and put it on PATH.");
  const text = run.stdout.trim();
  if (!text) return refuse(`choudoufu live-ls could not list ${dir}: ${said(run, `exit ${run.code}`)}`, CREDS);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse(`choudoufu live-ls printed something that is not JSON in ${dir}: ${said(run, "unparseable stdout")}`, CREDS);
  }
  if (!isRecord(json) || typeof json.estate !== "string" || !Array.isArray(json.items)) {
    return refuse("That is not a live-ls document — no `estate` and `items`.", CREDS);
  }
  if (typeof json.schemas !== "string") {
    return refuse("This live-ls document carries no `schemas` field: it was written by a choudoufu older than 0.16.0.", "Upgrade choudoufu to 0.16.0 or newer.");
  }
  return { ok: true, doc: json as unknown as LiveLsDocument };
}

/** Validate `live-plan -json` output. A document whose `diagnostics[]` carry
 * an error is still a document; the caller decides what an error means. */
export function parseLivePlan(run: Captured, dir: string): LivePlanParse {
  if (run.code === 127) return refuse("choudoufu is not on PATH.", "Install choudoufu and put it on PATH.");
  const text = run.stdout.trim();
  if (!text) return refuse(`choudoufu live-plan could not plan ${dir}: ${said(run, `exit ${run.code}`)}`, CREDS);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse(`choudoufu live-plan printed something that is not JSON in ${dir}: ${said(run, "unparseable stdout")}`, CREDS);
  }
  if (!isRecord(json) || typeof json.estate !== "string" || !("bound" in json)) {
    return refuse("That is not a live-plan document — no `estate` and `bound`.", CREDS);
  }
  return { ok: true, doc: json as unknown as LivePlanDocument };
}

// ---------------------------------------------------------------------------
// The paint.
// ---------------------------------------------------------------------------

/** What the live half says about one address, in the pane's own words. Every
 * key is a plain attr (an inspect row) except `_status`, which is the paint. */
export interface LiveVerdict {
  _status: "good" | "warn" | "accent" | "neutral";
  _unobserved?: string;
  physicalId?: string;
  ownership?: "owned" | "foreign";
  attrs: Record<string, unknown>;
}

const REASON_TONE: Record<string, LiveVerdict["_status"]> = {
  UNOWNED: "warn",
  ABSENT: "accent",
  NEEDS_DISCOVERY: "neutral",
  PARENT_UNAVAILABLE: "neutral",
  LISTED_NOT_IMPORTABLE: "neutral",
  FAILED: "neutral",
  CYCLE: "neutral",
  SUPERSEDED: "neutral",
  UNREADABLE: "neutral",
  INCOMPLETE_BLOCK: "neutral",
};

/** The reasons whose `neutral` is "looked and could not answer" — carried as
 * `_unobserved` so the cover note and the pane say so — as opposed to the
 * ones whose rung already said why. */
const UNOBSERVED_REASONS = new Set(["FAILED", "CYCLE", "SUPERSEDED", "UNREADABLE", "INCOMPLETE_BLOCK"]);

const BOUND_WORDS: Record<string, string> = {
  marker: "by its marker (the estate-wide tag sweep)",
  derived: "by derived identity (the name the configuration states)",
  record: "from the estate's record store",
  cache: "from the local state cache",
};

/**
 * The verdict for one declared address, from the plan and the listing. The
 * plan decides first (it is the claim about ownership); the listing adds
 * the live id and the gap detail. Undefined for an address neither document
 * mentions, which the caller paints `neutral` with a reason.
 */
export function verdictFor(address: string, ls: LiveLsDocument | undefined, plan: LivePlanDocument | undefined): LiveVerdict | undefined {
  const bound = plan?.bound?.find((b) => b.addr === address);
  const item = ls?.items.find((i) => i.address === address);
  const gap = ls?.gaps?.find((g) => g.address === address);
  const omission = plan?.omissions?.find((o) => o.addr === address);
  const unowned = plan?.unowned?.find((u) => u.addr === address);
  const listing = gap ? { listing: gap.detail } : {};
  if (bound) {
    const id = bound.identity || item?.id;
    return {
      _status: "good",
      ...(id ? { physicalId: id } : {}),
      ownership: "owned",
      attrs: { bound: BOUND_WORDS[bound.source] ?? bound.source, ...(bound.identity_values ? { identity: bound.identity_values } : {}), ...listing },
    };
  }
  if (omission) {
    const tone = REASON_TONE[omission.reason] ?? "neutral";
    const base: Record<string, unknown> = { omission: omission.reason, detail: omission.detail, ...listing };
    if (omission.reason === "UNOWNED" && unowned) {
      if (unowned.adopt_tofu_estate) {
        return {
          _status: "warn",
          physicalId: unowned.identity,
          ownership: "foreign",
          attrs: { ...base, adopt: { "tofu-estate": unowned.adopt_tofu_estate, "tofu-address": unowned.adopt_tofu_address } },
        };
      }
      return {
        _status: "warn",
        physicalId: unowned.identity,
        ownership: "foreign",
        attrs: { ...base, ...(unowned.tofu_estate ? { ownedBy: unowned.tofu_estate } : {}) },
      };
    }
    return {
      _status: tone,
      ...(UNOBSERVED_REASONS.has(omission.reason) ? { _unobserved: omission.detail } : {}),
      attrs: base,
    };
  }
  if (gap) return { _status: "neutral", attrs: { listing: gap.detail } };
  if (item) {
    // Listed under the estate's tag and not in the plan's document at all —
    // the plan did not consider it, which is a fact worth a row, not a colour
    // the plan never gave.
    return { _status: "neutral", _unobserved: "listed under the estate's tag but absent from live-plan's document", physicalId: item.id, ownership: "owned", attrs: {} };
  }
  return undefined;
}

/**
 * Paint the declared graph with the live half. Mutates and returns `ir`.
 * Every instance card gets a verdict; a data-source card (the declared read,
 * not a resource) stays uncoloured; a resource the listing holds under the
 * estate's tag that the roster does not declare becomes a new `warn` card —
 * marked for this estate, declared nowhere.
 */
export function paintChoudoufu(ir: GraphIR, ls: LiveLsDocument | undefined, plan: LivePlanDocument | undefined, estate?: string): GraphIR {
  const declared = new Set<string>();
  for (const n of ir.nodes) {
    if (n.lexicon !== CHOUDOUFU_LEXICON || isRecord(n.attrs.producer)) continue;
    declared.add(n.id);
    const v = verdictFor(n.id, ls, plan) ?? {
      _status: "neutral" as const,
      _unobserved: plan ? "not mentioned by live-plan or live-ls" : "no live-plan document for this estate",
      attrs: {},
    };
    n.attrs = { ...n.attrs, ...v.attrs, _status: v._status, ...(v._unobserved ? { _unobserved: v._unobserved } : {}) };
    if (v.physicalId) n.physicalId = v.physicalId;
    if (v.ownership) n.ownership = v.ownership;
  }
  for (const item of ls?.items ?? []) {
    if (!item.address || declared.has(item.address)) continue;
    declared.add(item.address);
    ir.nodes.push({
      id: item.address,
      kind: item.type,
      lexicon: CHOUDOUFU_LEXICON,
      physicalId: item.id,
      ownership: "owned",
      attrs: {
        ...(estate ? { estate } : {}),
        marked: "carries this estate's marker, declared nowhere in its configuration",
        ...(item.slot ? { slot: item.slot } : {}),
        _status: "warn",
      },
    });
  }
  return ir;
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

/** A run of choudoufu, injectable. */
export type Runner = (args: string[], cwd: string) => Promise<Captured>;

/** The three documents a live read of one member produces. */
export interface ChoudoufuLiveRead {
  check: LiveCheckDocument;
  ls: LiveLsDocument;
  plan: LivePlanDocument;
}

/**
 * Read a member live: the roster (offline), then the listing and the plan
 * against the account, concurrently. A refusal on any of the three throws
 * `ChoudoufuReadError`, and a plan whose diagnostics carry an error throws
 * with that error's summary — `composeEstateOverlay` catches either and
 * paints the member's source graph `neutral` with the reason in its cover
 * note, which is what "could not observe" should look like.
 */
export async function readChoudoufuLive(dir: string, opts: GraphOptions, run: Runner = captureChoudoufu): Promise<ChoudoufuLiveRead> {
  // The roster first, offline: `live-ls` reads no configuration and REQUIRES
  // `-estate=NAME` (it lists what the account holds under one tag, and has
  // nothing to derive the name from), and the name is on this document.
  // `live-plan` is the opposite: it reads the configuration and REFUSES
  // `-estate` beside a `live` block. The two then run together.
  const check = await readLiveCheck(dir, run);
  if (!check.ok) throw new ChoudoufuReadError(check.refusal, dir);
  const estate = check.doc.estate;
  if (!estate) {
    throw new ChoudoufuReadError(
      {
        error: `${dir} names no estate, so there is no estate tag to list the account under.`,
        code: "choudoufu-live-check",
        remedy: "Declare it — `estate = \"…\"` in an `estate.chdf.hcl` sidecar, or a `live { estate = … }` block in a root *.tf (choudoufu's `live-check` says what else the configuration needs) — then reload.",
      },
      dir,
    );
  }
  const [lsRun, planRun] = await Promise.all([
    run(["live-ls", `-estate=${estate}`, "-json", ...(opts.consistent ? ["-consistent"] : []), "."], dir),
    run(["live-plan", "-json"], dir),
  ]);
  const ls = parseLiveLs(lsRun, dir);
  if (!ls.ok) throw new ChoudoufuReadError(ls.refusal, dir);
  const plan = parseLivePlan(planRun, dir);
  if (!plan.ok) throw new ChoudoufuReadError(plan.refusal, dir);
  const error = plan.doc.diagnostics?.find((d) => d.severity === "error");
  if (error) {
    throw new ChoudoufuReadError({ error: `live-plan: ${error.summary}${error.detail ? ` — ${error.detail.split("\n")[0]}` : ""}`, code: "choudoufu-live-check", remedy: CREDS }, dir);
  }
  return { check: check.doc, ls: ls.doc, plan: plan.doc };
}

/** The live read as an IR: the declared graph, painted. */
export async function choudoufuLiveIr(dir: string, opts: GraphOptions, run: Runner = captureChoudoufu): Promise<GraphIR> {
  const { check, ls, plan } = await readChoudoufuLive(dir, opts, run);
  return paintChoudoufu(liveCheckToIr(check), ls, plan, check.estate);
}

/** How a choudoufu member is read (the `via` of its kind): the declared half
 * for a source read, the painted graph for a live one. */
export const choudoufuVia: MemberVia = {
  tool: () => {
    const v = choudoufuVersion();
    return `choudoufu\0${v ? v.version || "dev" : "absent"}`;
  },
  read: async (dir: string, opts: GraphOptions): Promise<GraphIR> => {
    if (opts.live || opts.overlay) return choudoufuLiveIr(dir, opts);
    const parsed = await readLiveCheck(dir);
    if (!parsed.ok) throw new ChoudoufuReadError(parsed.refusal, dir);
    return liveCheckToIr(parsed.doc);
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

/** One `/api/diff` entry per declared address and per marked-undeclared
 * resource of a member, keyed by the COMPOSED id (`<member>/<address>`) when
 * a member name is given, so the pane's lookup by node id lands. `health` is
 * the pane's own vocabulary: `healthy` for a bound instance, `degraded` for
 * an unowned object, `unknown` otherwise; `healthDetail` is the verdict's own
 * sentence. `diff` is null — choudoufu has no snapshot to drift from; the
 * plan IS the drift, and it is on the card. */
export function choudoufuDiffNodes(check: LiveCheckDocument, ls: LiveLsDocument, plan: LivePlanDocument, member?: string): Record<string, DiffNode> {
  const key = (address: string): string => (member ? `${member}/${address}` : address);
  const out: Record<string, DiffNode> = {};
  const seen = new Set<string>();
  for (const i of check.instances) {
    seen.add(i.address);
    const v = verdictFor(i.address, ls, plan);
    const health = !v ? "unknown" : v._status === "good" ? "healthy" : v._status === "warn" ? "degraded" : "unknown";
    const detail = !v
      ? "not mentioned by live-plan or live-ls"
      : typeof v.attrs.bound === "string"
        ? `bound ${v.attrs.bound}`
        : typeof v.attrs.omission === "string"
          ? `${v.attrs.omission}: ${String(v.attrs.detail ?? "")}`
          : (v._unobserved ?? (typeof v.attrs.listing === "string" ? v.attrs.listing : undefined));
    out[key(i.address)] = {
      observed: v
        ? {
            type: i.type,
            ...(v.physicalId ? { physicalId: v.physicalId } : {}),
            ...(v.ownership ? { ownership: v.ownership } : {}),
            attributes: { ...(i.rung ? { rung: i.rung } : {}), ...v.attrs },
          }
        : null,
      diff: null,
      health,
      ...(detail ? { healthDetail: detail } : {}),
      fieldDrift: null,
    };
  }
  for (const item of ls.items) {
    if (!item.address || seen.has(item.address)) continue;
    out[key(item.address)] = {
      observed: { type: item.type, physicalId: item.id, ownership: "owned", attributes: { tags: item.tags, ...(item.slot ? { slot: item.slot } : {}) } },
      diff: null,
      health: "degraded",
      healthDetail: "carries this estate's marker, declared nowhere in its configuration",
      fieldDrift: null,
    };
  }
  return out;
}
