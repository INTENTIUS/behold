/**
 * A choudoufu member's re-check with plan, through chant (#924).
 *
 * "Re-check live with plan" (`?plan=1`) asks two questions of a member: who
 * owns each declared instance, and what a plan would change on the ones the
 * estate owns. Both come from ONE chant read here:
 *
 *     CHANT_TERRAFORM_OBSERVE=plan CHANT_TERRAFORM_LIVE_PLAN_DIR=<tmp> \
 *       chant graph . --live --overlay --env behold-plan --format ir --detail 3
 *
 * over the member's generated reader project (the `chdf` scratch project of
 * src/terraform-member.ts, `binary: "choudoufu"`, one root that is the member
 * itself, the same project #402's prediction reads). chant's terraform lexicon
 * reads a live root at the plan depth as two reads one after the other
 * (INTENTIUS/chant#4371): `choudoufu live-plan -json` for ownership, then
 * `choudoufu plan -input=false -lock=false -out=<its tmp>` and `show -json` for
 * the attributes, merged on the blocks `live-plan` bound. The plan file lives
 * under the OS temp directory and the root is left as it was
 * (INTENTIUS/chant#4379).
 *
 * The ownership paint stays behold's (src/choudoufu-live.ts `verdictFor`),
 * because it reads `live-plan`'s rows themselves: each instance's omission
 * reason and detail, `identity_values`, an adoptable row's matched arguments.
 * chant's overlay keeps one verdict per block and drops those. So chant hands
 * back the document its verdicts came from: `CHANT_TERRAFORM_LIVE_PLAN_DIR`
 * (INTENTIUS/chant#4383) names a directory behold made under the OS temp
 * directory, chant writes `<root>.live-plan.json` there, and behold paints
 * from it and removes the directory. One `live-plan` per re-check per member,
 * and the plan facts sit on the same verdicts the card shows (before #924 a
 * re-check ran behold's own `live-plan` and then a `choudoufu plan` beside it,
 * and ownership could come from a different read than the plan's).
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
 * If chant's plan read fails, `live-plan` alone answered: ownership is painted
 * from the handed document, no plan facts are cached, and the answer says why.
 * If chant's `live-plan` fails, no document is handed back and the member is
 * not observed, as when behold's own `live-plan` failed.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { GraphIR, IRNode } from "@intentius/chant";
import { stripAnsi } from "./ansi.ts";
import { CHOUDOUFU_PLAN_CHANT_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { choudoufuSpawnOverride, ChoudoufuReadError } from "./choudoufu-member.ts";
import { parseLivePlan, type LivePlanDocument } from "./choudoufu-live.ts";
import { resolvedVersion, TERRAFORM_LEXICON_PKG, terraformReaderState, writeTerraformScratchProject } from "./terraform-member.ts";
import { PLAN_READ_ENV, TERRAFORM_OBSERVE_ENV } from "./terraform-plan.ts";

/** The member's source stamp, the key its cached change set is stored under (src/member-ir.ts). */
export { memberSourceStamp } from "./member-ir.ts";

/** chant's variable for the directory a live root's `live-plan` document is handed to (INTENTIUS/chant#4383). */
export const LIVE_PLAN_DIR_ENV = "CHANT_TERRAFORM_LIVE_PLAN_DIR";

/** The argv, pinned so a test can assert it. */
export const choudoufuChantArgs = (): string[] => ["graph", ".", "--live", "--overlay", "--env", PLAN_READ_ENV, "--format", "ir", "--detail", "3"];

/** The file chant writes for a root: its name made safe for a file name (chant's `livePlanDocumentFile`). */
export const livePlanDocumentFile = (root: string): string => `${root.replace(/[^A-Za-z0-9._-]/g, "_")}.live-plan.json`;

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
  /** The `live-plan -json` document chant's verdicts came from. */
  plan: LivePlanDocument;
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
 * fake choudoufu with no chant to read through (the re-check paints from
 * behold's own `live-plan` and reads no plan); `undefined` is production. */
let depsOverride: ChoudoufuChantDeps | null | undefined;
export function setChoudoufuChantDeps(deps: ChoudoufuChantDeps | null | undefined): void {
  depsOverride = deps;
}

/**
 * Why this member's re-check cannot go through chant, or undefined when it
 * can: no chant seam (a test's fake choudoufu), no terraform lexicon, or a
 * chant or lexicon below {@link CHOUDOUFU_PLAN_CHANT_FLOOR}.
 */
export async function choudoufuChantUnavailable(deps: ChoudoufuChantDeps | null | undefined = depsOverride): Promise<string | undefined> {
  if (deps === null) return "no chant to read the plan through";
  const d = deps ?? {};
  const absent = d.readerAbsent ? d.readerAbsent() : terraformReaderState().refusal?.error;
  if (absent) return absent;
  const chant = d.chantVersion ? d.chantVersion() : (await import("./chant.ts")).resolveChant().version;
  if (!meetsFloor(chant, CHOUDOUFU_PLAN_CHANT_FLOOR)) return `the plan read on a choudoufu member needs chant ${CHOUDOUFU_PLAN_CHANT_FLOOR} or newer; behold has ${chant ?? "(unknown version)"}`;
  const lexicon = d.lexiconVersion ? d.lexiconVersion() : resolvedVersion(TERRAFORM_LEXICON_PKG);
  if (!meetsFloor(lexicon, CHOUDOUFU_PLAN_CHANT_FLOOR)) return `the plan read on a choudoufu member needs ${TERRAFORM_LEXICON_PKG} ${CHOUDOUFU_PLAN_CHANT_FLOOR} or newer; behold has ${lexicon ?? "(unknown version)"}`;
  return undefined;
}

/** chant's per-root note, after the `warning: [terraform] ` prefix: which reads answered. */
export function rootAnswerOf(stderr: string, root: string): { answered: ChoudoufuChantAnswer; note?: string } {
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

/** A node of chant's IR in the member's root, as the instance address choudoufu
 * knows it: `<root>/module.a/aws_x.y` -> `module.a.aws_x.y`. */
function blockAddressOf(n: Pick<IRNode, "id">, root: string): string | undefined {
  if (!n.id.startsWith(`${root}/`)) return undefined;
  return n.id
    .slice(root.length + 1)
    .replace(/~\d+$/, "")
    .split("/")
    .join(".");
}

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
 * Read one member's ownership document and plan through chant. Throws
 * `ChoudoufuReadError` when no `live-plan` answered (the caller paints the
 * member not observed); a plan read that failed is an answer of `live`.
 */
export async function readChoudoufuThroughChant(dir: string, deps: ChoudoufuChantDeps | undefined = depsOverride ?? undefined): Promise<ChoudoufuChantRead> {
  const root = choudoufuRootName(dir);
  const project = writeTerraformScratchProject(dir, { roots: [{ name: root, dir: "." }], skipped: [] }, undefined, "chdf");
  const handed = mkdtempSync(join(tmpdir(), "behold-choudoufu-live-plan-"));
  try {
    const env = { ...(choudoufuSpawnOverride() ?? {}), [TERRAFORM_OBSERVE_ENV]: "plan", [LIVE_PLAN_DIR_ENV]: handed };
    const run = deps?.run ?? (async (args: string[], cwd: string, e: Record<string, string>) => (await import("./chant.ts")).runChantRaw(args, cwd, e));
    const res = await run(choudoufuChantArgs(), project, env);
    const answer = rootAnswerOf(res.stderr, root);
    let text: string;
    try {
      text = readFileSync(join(handed, livePlanDocumentFile(root)), "utf8");
    } catch {
      const why = answer.note ?? stripAnsi(res.stderr).split("\n").find((l) => /error/i.test(l))?.trim() ?? `chant exited ${res.code} and handed back no live-plan document`;
      throw new ChoudoufuReadError(
        { error: `chant could not read ${dir} live: ${why}`, code: "choudoufu-live-check", remedy: "Give behold the ambient read-only AWS credentials the estate's `live-plan` and `plan` need (AWS_PROFILE, or AWS_ENDPOINT_URL for an emulator), then re-check live with plan." },
        dir,
      );
    }
    const parsed = parseLivePlan({ code: 0, stdout: text, stderr: "" }, dir);
    if (!parsed.ok) throw new ChoudoufuReadError(parsed.refusal, dir);
    let drift = new Map<string, PlanResourceDrift>();
    if (res.code === 0 && answer.answered === "live+plan") {
      try {
        drift = planDriftFromIr(JSON.parse(res.stdout) as GraphIR, root);
      } catch {
        return { plan: parsed.doc, answered: "live", note: `chant printed something that is not a graph for ${dir}; the plan was not read`, drift };
      }
      return { plan: parsed.doc, answered: "live+plan", ...(answer.note ? { note: answer.note } : {}), drift };
    }
    return { plan: parsed.doc, answered: "live", ...(answer.note ? { note: answer.note } : {}), drift };
  } finally {
    rmSync(handed, { recursive: true, force: true });
  }
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
