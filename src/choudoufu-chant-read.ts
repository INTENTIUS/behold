/**
 * A choudoufu member's live read, through chant (#924, behold#1227).
 *
 * Who owns each declared instance, and on a re-check with plan what a plan
 * would change on the ones the estate owns, come from ONE chant read:
 *
 *     CHANT_TERRAFORM_LIVE_LISTING=1 [CHANT_TERRAFORM_OBSERVE=plan] \
 *       chant graph . --live --overlay --env behold-plan --format ir --detail 3
 *
 * over the member's generated reader project (the `chdf` scratch project of
 * src/terraform-member.ts, `binary: "choudoufu"`, one root that is the member
 * itself, the same project #402's prediction reads). chant's terraform lexicon
 * reads a live root with `choudoufu live-plan -json`, `live-graph`, and with
 * the listing variable `live-ls -json`; at the plan depth it then runs
 * `choudoufu plan -input=false -lock=false -out=<its tmp>` and `show -json`
 * and merges the attributes on the blocks `live-plan` bound
 * (INTENTIUS/chant#4371). The plan file lives under the OS temp directory and
 * the root is left as it was (INTENTIUS/chant#4379).
 *
 * Each instance node then carries `facts.ownership` and the rows behind it,
 * `facts.ownershipRows` (INTENTIUS/chant#5333, #5402): how the plan bound it,
 * the omission and its reason, the adoption, the listing's gaps and whether
 * the listing holds the object. src/choudoufu-ownership.ts paints the
 * member's roster from them; behold reads no `live-plan` or `live-ls`
 * document of its own.
 *
 * What a card takes from the plan (`planChanges` and `planActions` on each
 * bound block of chant's IR, sensitive values already `(sensitive)` on both
 * sides when either side is flagged, and every copy of one, such as
 * `tags_all`): attribute drift per instance, only for a change with both a
 * before and an after (an `update`, or a replace). A planned create is an
 * ownership fact the overlay already paints, and a delete is a removal. On a
 * live root drift is the planned `update` itself, the live value as `before`:
 * choudoufu rebuilds prior state from the account, so chant's `planDrift` is
 * empty there and is not read.
 *
 * Which reads answered is the IR's `rootReads` (chant#4452, behold#995), and
 * chant's note only for a chant that puts none on the IR (released up to
 * 0.124.52). If chant's plan read fails, the live read alone answered:
 * ownership is painted, no plan facts are cached, and the answer says why. If
 * chant's live read fails, the member is not observed.
 */
import { basename } from "node:path";
import type { GraphIR, IRNode } from "@intentius/chant";
import { stripAnsi } from "./ansi.ts";
import { CHOUDOUFU_OWNERSHIP_ROWS_CHANT_FLOOR, CHOUDOUFU_OWNERSHIP_ROWS_TERRAFORM_LEXICON_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { choudoufuSpawnOverride, ChoudoufuReadError } from "./choudoufu-member.ts";
import { instanceAddressOf } from "./choudoufu-ownership.ts";
import { resolvedVersion, TERRAFORM_LEXICON_PKG, terraformReaderState, writeTerraformScratchProject } from "./terraform-member.ts";
import { hasRootReads, PLAN_READ_ENV, rootReadReasonWords, rootReadsOf, TERRAFORM_OBSERVE_ENV } from "./terraform-plan.ts";

/** The member's source stamp, the key its cached change set is stored under (src/member-ir.ts). */
export { memberSourceStamp } from "./member-ir.ts";

/** The terraform lexicon's switch that lists each live root with `live-ls` beside `live-plan` (INTENTIUS/chant#5402). */
export const LIVE_LISTING_ENV = "CHANT_TERRAFORM_LIVE_LISTING";

/** The argv, pinned so a test can assert it. */
export const choudoufuChantArgs = (): string[] => ["graph", ".", "--live", "--overlay", "--env", PLAN_READ_ENV, "--format", "ir", "--detail", "3"];

/** The member's root name in its reader project: its directory's name, as #402's prediction names it. */
export const choudoufuRootName = (dir: string): string => basename(dir);

/** One attribute the plan would change, in the shape the inspect pane's `diff`
 * section renders (`{path, oldValue, newValue}`, web/app.js `renderDiff`). */
export interface PlanAttributeChange {
  path: string;
  oldValue: unknown;
  newValue: unknown;
}

/** The plan's verdict for one instance address: what it would do, and which
 * attributes differ. Only instances with a non-empty `changes` are kept. */
export interface PlanResourceDrift {
  address: string;
  actions: string[];
  changes: PlanAttributeChange[];
}

/** Which reads answered the member: both, or `live-plan` alone. */
export type ChoudoufuChantAnswer = "live+plan" | "live";

export interface ChoudoufuChantRead {
  /** chant's graph of the member, ids `<root>/<block path>`, each instance node carrying `facts.ownership` and `facts.ownershipRows`. */
  ir: GraphIR;
  /** The root the ids are under. */
  root: string;
  answered: ChoudoufuChantAnswer;
  /** chant's note for the root, verbatim, when it gave one. */
  note?: string;
  /** Attribute drift by instance address; empty unless `answered` is `live+plan`. */
  drift: Map<string, PlanResourceDrift>;
}

/** How the read runs. Injectable: a test answers the spawn from recorded output. */
export interface ChoudoufuChantDeps {
  run?: (args: string[], projectDir: string, env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  chantVersion?: () => string | undefined;
  lexiconVersion?: () => string | undefined;
  /** Whether the terraform lexicon is installed beside behold. */
  readerAbsent?: () => string | undefined;
}

/** The test seam: `createApp` sets it beside `setChoudoufuRunner`. `null` is a
 * fake choudoufu with no chant to read through (the member's live read then
 * says why it was not observed); `undefined` is production. */
let depsOverride: ChoudoufuChantDeps | null | undefined;
export function setChoudoufuChantDeps(deps: ChoudoufuChantDeps | null | undefined): void {
  depsOverride = deps;
}

/**
 * Why this member's live read cannot go through chant, or undefined when it
 * can: no chant seam (a test's fake choudoufu), no terraform lexicon, or a
 * chant below {@link CHOUDOUFU_OWNERSHIP_ROWS_CHANT_FLOOR}, or a lexicon below
 * {@link CHOUDOUFU_OWNERSHIP_ROWS_TERRAFORM_LEXICON_FLOOR}.
 */
export async function choudoufuChantUnavailable(deps: ChoudoufuChantDeps | null | undefined = depsOverride): Promise<string | undefined> {
  if (deps === null) return "no chant to read the member through";
  const d = deps ?? {};
  const absent = d.readerAbsent ? d.readerAbsent() : terraformReaderState().refusal?.error;
  if (absent) return absent;
  const chant = d.chantVersion ? d.chantVersion() : (await import("./chant.ts")).resolveChant().version;
  if (!meetsFloor(chant, CHOUDOUFU_OWNERSHIP_ROWS_CHANT_FLOOR)) return `the live read of a choudoufu member needs chant ${CHOUDOUFU_OWNERSHIP_ROWS_CHANT_FLOOR} or newer; behold has ${chant ?? "(unknown version)"}`;
  const lexicon = d.lexiconVersion ? d.lexiconVersion() : resolvedVersion(TERRAFORM_LEXICON_PKG);
  if (!meetsFloor(lexicon, CHOUDOUFU_OWNERSHIP_ROWS_TERRAFORM_LEXICON_FLOOR)) return `the live read of a choudoufu member needs ${TERRAFORM_LEXICON_PKG} ${CHOUDOUFU_OWNERSHIP_ROWS_TERRAFORM_LEXICON_FLOOR} or newer; behold has ${lexicon ?? "(unknown version)"}`;
  return undefined;
}

/**
 * Which reads answered the member's root, from the IR's `rootReads`
 * (INTENTIUS/chant#4452), never from chant's note text (behold#995): both
 * when the root's report is `live+plan` and nothing fell back, `live-plan`
 * alone otherwise, a chant with no `rootReads` included. The note is built
 * from the report's own fields.
 */
export function rootAnswerOf(ir: unknown, root: string, stderr = ""): { answered: ChoudoufuChantAnswer; note?: string } {
  const key = `terraform.roots.${root}`;
  // A chant before chant#4452 puts no rootReads on the IR and says it in its note.
  if (!hasRootReads(ir)) return rootAnswerOfNotes(stderr, root);
  const rr = rootReadsOf(ir)[key];
  if (!rr) return { answered: "live" };
  if (rr.depth === "live+plan" && rr.fellBackTo === undefined) return { answered: "live+plan", note: `${key}: the plan read answered, beside the live read, which answered presence and ownership` };
  if (rr.depth === "live" && rr.fellBackTo === undefined) return { answered: "live" };
  const why = rr.reason ? ` (${rootReadReasonWords(rr.reason)})` : "";
  return {
    answered: "live",
    note: rr.fellBackTo === "declared" ? `${key}: no read answered${why}` : `${key}: the ${rr.depth} read failed${why}, so the live read alone answered; plan attributes are absent`,
  };
}

/** The fallback for a chant whose IR carries no `rootReads` (released up to 0.124.52): chant's note for the root. */
export function rootAnswerOfNotes(stderr: string, root: string): { answered: ChoudoufuChantAnswer; note?: string } {
  const prefix = `terraform.roots.${root}: `;
  for (const line of stripAnsi(stderr).split("\n")) {
    const at = line.indexOf(prefix);
    if (at === -1) continue;
    const rest = line.slice(at + prefix.length).trim();
    if (rest.startsWith("the plan read answered")) return { answered: "live+plan", note: `${prefix}${rest}` };
    if (rest.startsWith("the plan read failed") || rest.startsWith("no read answered")) return { answered: "live", note: `${prefix}${rest}` };
  }
  return { answered: "live" };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A node of chant's IR in the member's root, as the instance address choudoufu knows it (src/choudoufu-ownership.ts). */
const blockAddressOf = (n: Pick<IRNode, "id">, root: string): string | undefined => instanceAddressOf(n, root);

/** A change with both sides: an update, or a replace. Not a create, a delete, a read or a no-op. */
const comparable = (actions: string[]): boolean => actions.includes("update") || (actions.includes("delete") && actions.includes("create"));

/**
 * The attribute drift on chant's IR, by instance address. Pure; exported for
 * testing. A block whose plan touched one instance at its own address carries
 * changes with no `instance`; a block with several (count, for_each) tags each
 * change with the instance it belongs to (chant's `planAttributesFor`).
 */
export function planDriftFromIr(ir: Pick<GraphIR, "nodes">, root: string): Map<string, PlanResourceDrift> {
  const out = new Map<string, PlanResourceDrift>();
  for (const n of ir.nodes) {
    if (n.kind !== "Terraform::Resource") continue;
    const block = blockAddressOf(n, root);
    const a = n.attrs ?? {};
    if (!block || typeof a.planAction !== "string") continue;
    const actions = isRecord(a.planActions) ? (a.planActions as Record<string, unknown>) : { [block]: [a.planAction] };
    const changes = Array.isArray(a.planChanges) ? (a.planChanges as Array<{ path?: unknown; before?: unknown; after?: unknown; instance?: unknown }>) : [];
    for (const [instance, acts] of Object.entries(actions)) {
      if (!Array.isArray(acts) || !comparable(acts as string[])) continue;
      const mine = changes
        .filter((c) => typeof c.path === "string" && (typeof c.instance === "string" ? c.instance : block) === instance)
        .map((c) => ({ path: c.path as string, oldValue: c.before ?? null, newValue: c.after ?? null }));
      if (mine.length) out.set(instance, { address: instance, actions: acts as string[], changes: mine });
    }
  }
  return out;
}

/**
 * Read one member live through chant, at the plan depth when `plan` is set.
 * Throws `ChoudoufuReadError` when chant gave no graph (the caller paints the
 * member not observed); a plan read that failed is an answer of `live`.
 */
export async function readChoudoufuThroughChant(dir: string, opts: { plan?: boolean } = {}, deps: ChoudoufuChantDeps | undefined = depsOverride ?? undefined): Promise<ChoudoufuChantRead> {
  const root = choudoufuRootName(dir);
  const project = writeTerraformScratchProject(dir, { roots: [{ name: root, dir: "." }], skipped: [] }, undefined, "chdf");
  const env = { ...(choudoufuSpawnOverride() ?? {}), [LIVE_LISTING_ENV]: "1", ...(opts.plan ? { [TERRAFORM_OBSERVE_ENV]: "plan" } : {}) };
  const run = deps?.run ?? (async (args: string[], cwd: string, e: Record<string, string>) => (await import("./chant.ts")).runChantRaw(args, cwd, e));
  const res = await run(choudoufuChantArgs(), project, env);
  let ir: GraphIR | undefined;
  try {
    ir = res.code === 0 ? (JSON.parse(res.stdout) as GraphIR) : undefined;
  } catch {
    ir = undefined;
  }
  const answer = rootAnswerOf(ir, root, res.stderr);
  if (!ir || answer.note?.includes("no read answered")) {
    const why = answer.note ?? stripAnsi(res.stderr).split("\n").find((l) => /error/i.test(l))?.trim() ?? `chant exited ${res.code} and printed no graph`;
    throw new ChoudoufuReadError(
      { error: `chant could not read ${dir} live: ${why}`, code: "choudoufu-live-check", remedy: "Give behold the ambient read-only AWS credentials the estate's `live-plan` and `live-ls` need (AWS_PROFILE, or AWS_ENDPOINT_URL for an emulator), then reload." },
      dir,
    );
  }
  if (opts.plan && answer.answered === "live+plan") return { ir, root, answered: "live+plan", ...(answer.note ? { note: answer.note } : {}), drift: planDriftFromIr(ir, root) };
  return { ir, root, answered: "live", ...(answer.note ? { note: answer.note } : {}), drift: new Map() };
}

// ---------------------------------------------------------------------------
// The cache.
// ---------------------------------------------------------------------------

/**
 * The plan refreshes every resource in the estate, so its change set is
 * cached per member under the member's SOURCE stamp, the key half `memberIr`
 * uses (src/member-ir.ts): an edit to the configuration makes the stored
 * change set a statement about source that no longer exists, and a re-check
 * replaces it anyway.
 *
 * The stamp does not cover the account, which is the whole subject here. So a
 * cached entry is never served to a request that asked for a plan (`plan=1`
 * always re-reads, because "Re-check live" means re-check). It is served to
 * the reads that did not ask: an ordinary overlay reload after a re-check
 * shows the drift it found instead of dropping it, and pays no spawn.
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

/** Store a change set against the stamp the read was taken at. A member with no stamp caches nothing. */
export function cacheChoudoufuPlan(dir: string, stamp: string | undefined, drift: Map<string, PlanResourceDrift>): void {
  if (stamp === undefined) return;
  planCache.set(dir, { stamp, drift });
}
