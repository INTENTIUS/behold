/**
 * The choudoufu member's attribute drift (#404): what a plan would change on a
 * resource the estate already owns.
 *
 * #370's live half answers OWNERSHIP — `live-ls -json` and `live-plan -json`
 * say which declared instances are bound, unowned, omitted or invisible, and
 * neither of them ever compares an attribute VALUE. So a resource whose tag was
 * retagged out of band stays green: its markers are intact, and ownership is
 * all the two documents were asked about. #404 is the other half of the
 * question a person asks the terminal — "would a plan change anything?"
 *
 * ## The source, and why this one
 *
 * Two candidates were measured against a real floci estate (the workbench's
 * `choudoufu-cohort-iam-ecr`, 6 resources, applied clean, one IAM role tag
 * added out of band with `aws iam tag-role`), choudoufu v0.16.0:
 *
 *  - `choudoufu plan -json` — NOT OpenTofu's `planned_change`/`resource_drift`
 *    UI stream. On 0.16.0 the flag prints choudoufu's OWN ownership document:
 *    a single pretty-printed object of `{estate, choudoufu_version,
 *    upstream_version, bound, omissions, unowned, adoptable, swept,
 *    diagnostics}` — the same shape `live-plan -json` prints, and the shape
 *    src/choudoufu-live.ts already reads. It carries no attribute values at
 *    all: with the out-of-band tag in place, the string `drifted` (the tag's
 *    own key) appeared nowhere in the document. It cannot answer #404.
 *  - `choudoufu plan -out=<file>` then `choudoufu show -json <file>` — the
 *    stock OpenTofu plan document, `format_version` 1.2, with
 *    `resource_changes[].change.{actions,before,after}` carrying the full
 *    attribute maps on both sides. On the same estate it named the changed
 *    attribute and both its values.
 *
 * So the second one, and the exact argv is pinned here (both spawns in the
 * member's directory, through `captureChoudoufu` so a test seam covers them):
 *
 *     choudoufu plan -input=false -out=<tmp>/plan.tfplan
 *     choudoufu show -json <tmp>/plan.tfplan
 *
 * `<tmp>` is a fresh `mkdtemp` under the OS temp directory and is removed on
 * the way out — NEVER a path inside the served member. behold's write surface
 * is `.behold/layout.json` and nothing else (AGENTS.md, "Invariant"), and a
 * plan file dropped in someone's estate would be a write into their source.
 * `-input=false` so a spawn can never sit waiting on a prompt nobody can see.
 *
 * ## What counts as attribute drift
 *
 * A change is attribute drift only when the plan has BOTH a `before` and an
 * `after` object for the resource — an `update`, or a replace
 * (`["delete","create"]`), where two states of the same live object can
 * actually be compared. A planned `create` has `before: null`: there is no
 * live object whose attributes could have drifted, and #404 says so directly —
 * an unowned resource's planned create is not attribute drift, it is the
 * ownership verdict the overlay already paints. A planned `delete` has
 * `after: null` and is a removal, not a value that moved. `no-op` is the clean
 * case.
 *
 * Values marked sensitive by the provider (`before_sensitive` /
 * `after_sensitive`) are reported as changed by NAME and their values are
 * replaced with `(sensitive)`. behold shows truth, but it has no business
 * printing a secret into an inspect pane because a plan happened to read one.
 * An attribute the plan cannot know until apply (`after_unknown`) reports its
 * after side as `(known after apply)`, which is OpenTofu's own phrase.
 *
 * Provider-computed twins (`tags` and `tags_all`) are both reported. They are
 * both in the document and both in the terminal's own output; a skip-list of
 * "internal" attribute names would differ per provider and guessing it is
 * worse than showing what the plan says.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureChoudoufu, ChoudoufuReadError, stripAnsiLines, type Captured, type ChoudoufuRefusal } from "./choudoufu-member.ts";
import type { Runner } from "./choudoufu-live.ts";

// ---------------------------------------------------------------------------
// The document.
// ---------------------------------------------------------------------------

/** One entry of the plan document's `resource_changes[]`, shallowly — the
 * fields read here. */
export interface PlanResourceChange {
  address: string;
  mode?: string;
  type?: string;
  name?: string;
  change: {
    actions: string[];
    before?: unknown;
    after?: unknown;
    after_unknown?: unknown;
    before_sensitive?: unknown;
    after_sensitive?: unknown;
  };
}

/** `choudoufu show -json <planfile>`, shallowly. */
export interface PlanShowDocument {
  format_version: string;
  terraform_version?: string;
  resource_changes?: PlanResourceChange[] | null;
  errored?: boolean;
}

export type PlanShowParse = { ok: true; doc: PlanShowDocument } | { ok: false; refusal: ChoudoufuRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `ChoudoufuRefusal.code` is the one discriminator the SPA's precondition
 * card and doctor render, and it stays `choudoufu-live-check` for every
 * choudoufu refusal — src/choudoufu-moves.ts does the same for a move. The
 * plan read is not a new kind of precondition failure (it is the same missing
 * binary and the same missing credentials), so it does not earn a new code. */
const refuse = (error: string, remedy: string): { ok: false; refusal: ChoudoufuRefusal } => ({ ok: false, refusal: { error, code: "choudoufu-live-check", remedy } });

const CREDS =
  "Give behold the ambient read-only AWS credentials the estate's `plan` needs (AWS_PROFILE, or AWS_ENDPOINT_URL for an emulator), then re-check live with plan.";

/** What a failed spawn said, as one line — `said` in src/choudoufu-live.ts. */
function said(run: Captured, fallback: string): string {
  const lines = stripAnsiLines(run.stderr);
  return lines.find((l) => /^Error:/.test(l)) ?? lines[0] ?? fallback;
}

/** Validate `choudoufu show -json` output. Shallow, like the live half's
 * parsers: `format_version` and `resource_changes` are what is read. */
export function parsePlanShow(run: Captured, dir: string): PlanShowParse {
  if (run.code === 127) return refuse("choudoufu is not on PATH.", "Install choudoufu and put it on PATH.");
  const text = run.stdout.trim();
  if (!text) return refuse(`choudoufu show could not read the plan for ${dir}: ${said(run, `exit ${run.code}`)}`, CREDS);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse(`choudoufu show printed something that is not JSON for ${dir}: ${said(run, "unparseable stdout")}`, CREDS);
  }
  if (!isRecord(json) || typeof json.format_version !== "string") {
    return refuse("That is not a plan document — no `format_version`.", CREDS);
  }
  if (json.resource_changes !== undefined && json.resource_changes !== null && !Array.isArray(json.resource_changes)) {
    return refuse("That plan document's `resource_changes` is not a list.", CREDS);
  }
  return { ok: true, doc: json as unknown as PlanShowDocument };
}

// ---------------------------------------------------------------------------
// The change set.
// ---------------------------------------------------------------------------

/** One attribute the plan would change, in the shape the inspect pane's `diff`
 * section already renders (`{path, oldValue, newValue}`, web/app.js
 * `renderDiff` — the pair prints as `before → after`). */
export interface PlanAttributeChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

/** The plan's verdict for one address: what it would do, and which attributes
 * differ. Only addresses with a non-empty `changes` reach the paint. */
export interface PlanResourceDrift {
  address: string;
  actions: string[];
  changes: PlanAttributeChange[];
}

/** OpenTofu's own phrase for a value the plan cannot know yet. */
export const KNOWN_AFTER_APPLY = "(known after apply)";
/** What stands in for a value the provider marked sensitive. */
export const SENSITIVE = "(sensitive)";

/** `after_unknown` / `*_sensitive` are parallel trees of booleans. Only the
 * top-level attribute flag is read: an attribute is redacted or unknown as a
 * whole, which is what the pane prints one row per. */
const flagged = (tree: unknown, key: string): boolean => {
  if (tree === true) return true;
  if (!isRecord(tree)) return false;
  const v = tree[key];
  return v === true || (isRecord(v) && Object.values(v).some((x) => x === true)) || (Array.isArray(v) && v.some((x) => x === true));
};

/** Deep structural equality, enough for plan attribute values (JSON scalars,
 * objects and arrays — no cycles, no class instances). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  }
  return false;
}

/**
 * The attribute drift in a plan document, by address.
 *
 * Only an entry whose change has BOTH sides is considered — see the module
 * header. An entry that has both sides but no differing attribute (a `no-op`)
 * yields no drift and is left out entirely, so "in the map" means "the plan
 * would change this".
 */
export function planDrift(doc: PlanShowDocument): Map<string, PlanResourceDrift> {
  const out = new Map<string, PlanResourceDrift>();
  for (const rc of doc.resource_changes ?? []) {
    if (!rc || typeof rc.address !== "string" || !isRecord(rc.change)) continue;
    const { actions, before, after } = rc.change;
    if (!Array.isArray(actions) || actions.every((a) => a === "no-op")) continue;
    // A create has no `before` and a delete has no `after`: neither is an
    // attribute that moved. #404's own example of what must NOT count.
    if (!isRecord(before) || !isRecord(after)) continue;
    const changes: PlanAttributeChange[] = [];
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const unknownAfter = flagged(rc.change.after_unknown, key);
      if (!unknownAfter && same(before[key], after[key])) continue;
      changes.push({
        path: key,
        oldValue: flagged(rc.change.before_sensitive, key) ? SENSITIVE : before[key],
        newValue: unknownAfter ? KNOWN_AFTER_APPLY : flagged(rc.change.after_sensitive, key) ? SENSITIVE : after[key],
      });
    }
    if (changes.length) out.set(rc.address, { address: rc.address, actions, changes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The read, and its cache.
// ---------------------------------------------------------------------------

/** The two spawns, pinned so a test can assert them (see the module header for
 * why this pair and not `plan -json`). */
export const planArgv = (out: string): { plan: string[]; show: string[] } => ({
  plan: ["plan", "-input=false", `-out=${out}`],
  show: ["show", "-json", out],
});

/**
 * Read one member's attribute drift: `plan -out` into a scratch directory of
 * behold's own, then `show -json` of what it wrote, then remove it.
 *
 * Throws `ChoudoufuReadError` on a refusal, the way `readChoudoufuLive` does —
 * the caller turns that into "the plan was not read" rather than blanking the
 * overlay, because the ownership half is still perfectly good.
 */
export async function readChoudoufuPlan(dir: string, run: Runner = captureChoudoufu): Promise<Map<string, PlanResourceDrift>> {
  const scratch = mkdtempSync(join(tmpdir(), "behold-choudoufu-plan-"));
  const file = join(scratch, "plan.tfplan");
  const argv = planArgv(file);
  try {
    const planRun = await run(argv.plan, dir);
    if (planRun.code === 127) throw new ChoudoufuReadError({ error: "choudoufu is not on PATH.", code: "choudoufu-live-check", remedy: "Install choudoufu and put it on PATH." }, dir);
    if (planRun.code !== 0) {
      throw new ChoudoufuReadError({ error: `choudoufu plan could not plan ${dir}: ${said(planRun, `exit ${planRun.code}`)}`, code: "choudoufu-live-check", remedy: CREDS }, dir);
    }
    const parsed = parsePlanShow(await run(argv.show, dir), dir);
    if (!parsed.ok) throw new ChoudoufuReadError(parsed.refusal, dir);
    return planDrift(parsed.doc);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The plan read is expensive — `plan` refreshes every resource in the estate,
 * which is a full pass over the account (#404's third bullet). So it is cached
 * per member under the member's SOURCE stamp, the same key half
 * `memberIr` uses (src/member-ir.ts): an edit to the configuration makes the
 * stored change set a statement about source that no longer exists, and a
 * `plan=1` read replaces it anyway.
 *
 * What the stamp deliberately does NOT cover is the account. The cloud moves
 * without touching a byte of source, which is the whole subject here — so a
 * cached entry is never served to a request that ASKED for a plan (`plan=1`
 * always re-reads, because "Re-check live" means re-check). It is served to
 * the reads that did not ask: an ordinary overlay reload after a refresh shows
 * the drift the refresh found instead of silently dropping it, and pays no
 * spawn to do it.
 */
interface PlanCacheEntry {
  stamp: string;
  drift: Map<string, PlanResourceDrift>;
}
const planCache = new Map<string, PlanCacheEntry>();

/** Drop the cached plan for one member, or all of them. */
export function resetChoudoufuPlanCache(dir?: string): void {
  if (dir === undefined) planCache.clear();
  else planCache.delete(dir);
}

/** The cached change set for a member whose source has not moved, if any. */
export function cachedChoudoufuPlan(dir: string, stamp: string | undefined): Map<string, PlanResourceDrift> | undefined {
  if (stamp === undefined) return undefined;
  const hit = planCache.get(dir);
  return hit && hit.stamp === stamp ? hit.drift : undefined;
}

/** Store a change set against the stamp the read was taken at. A member with
 * no stamp (unreadable, missing) caches nothing — the same rule `memberIr`
 * follows. */
export function cacheChoudoufuPlan(dir: string, stamp: string | undefined, drift: Map<string, PlanResourceDrift>): void {
  if (stamp === undefined) return;
  planCache.set(dir, { stamp, drift });
}
