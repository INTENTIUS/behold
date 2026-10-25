/**
 * The plan read on a stock Terraform root, through chant (#910).
 *
 * chant's terraform lexicon reads a saved plan as a third observation depth
 * (INTENTIUS/chant#4358): `terraform plan -input=false -lock=false -out=<tmp>`
 * then `terraform show -json` over it, with the plan file under the OS temp
 * directory and removed afterwards. Each present `resource` or `data` block
 * comes back carrying `planAction`, `planActions`, `planActionReason`,
 * `planReplacePaths`, `planAfterUnknown`, `planChanges`, `planDrift`,
 * `planDriftAction` and `planRelevantAttributes`, with every value the plan
 * marks sensitive (and every copy of one) already replaced by `(sensitive)`.
 *
 * behold takes that read the way the terraform member already takes the
 * configuration: behold's own chant over the scratch project
 * (src/terraform-member.ts), here as
 *
 *     CHANT_TERRAFORM_OBSERVE=plan chant graph . --live --overlay --env behold-plan --format ir --detail 3
 *
 * `--detail 3` because chant thins list and object attributes below it, and
 * the replace paths and the changes are exactly those. The environment name
 * is a placeholder: the scratch config declares no environments, and a stock
 * root's read does not depend on one. The variable is the lexicon's own
 * one-run override, so the scratch config stays the same bytes for the source
 * read and the plan read.
 *
 * Which read answered each root comes from the IR's `rootReads`
 * (INTENTIUS/chant#4452), never from chant's note text (behold#995), and
 * every card in a root carries its root's answer. A chant that puts no
 * `rootReads` on the IR reports no root, and its cards carry no answer. A
 * card in a root that fell back is never shown as "no changes": it says the
 * plan was not read and which read answered instead.
 *
 * Only plan facts leave this module. The plan IR also carries each block's
 * declared attributes (its HCL `source` among them); none of that is copied
 * onto a card or into a response from here.
 *
 * Opt-in, like #404's plan read for a choudoufu member: `plan` refreshes every
 * resource in the root against its providers, so only a request that asks for
 * it (`?plan=1`) runs one.
 *
 * A choudoufu live root is not read here: its re-check reads ownership and
 * the plan through chant's live+plan read together (INTENTIUS/chant#4371),
 * in src/choudoufu-chant-read.ts (#924).
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import { stripAnsi } from "./ansi.ts";
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import { TERRAFORM_LEXICON } from "./terraform-lens.ts";
import { resolvedVersion, TERRAFORM_LEXICON_PKG, terraformMemberScan, terraformReaderState, writeTerraformScratchProject } from "./terraform-member.ts";

/** Why the plan was not read for a member at all: no reader (`terraform-lexicon`),
 * a chant or lexicon below the floor (`chant-too-old`), or chant failing
 * outright (`terraform-plan`). */
export interface PlanRefusal {
  error: string;
  code: string;
  remedy: string;
}

/** The read's name in src/chant-floors.ts. */
export const TERRAFORM_PLAN_READ = "plan read on a Terraform root";

/** The lexicon's one-run override of every root's observation depth (chant#4358). */
export const TERRAFORM_OBSERVE_ENV = "CHANT_TERRAFORM_OBSERVE";

/** The placeholder environment `graph --live` requires. The scratch config declares none. */
export const PLAN_READ_ENV = "behold-plan";

/** The argv, pinned so a test can assert it. */
export const terraformPlanArgs = (): string[] => ["graph", ".", "--live", "--overlay", "--env", PLAN_READ_ENV, "--format", "ir", "--detail", "3"];

/** Which read answered a root: the plan, the state read it fell back to, or none. */
export type PlanAnswer = "plan" | "state" | "none";

export interface PlanRootAnswer {
  root: string;
  answered: PlanAnswer;
  /** The root's `rootReads` reason, when chant gave one. */
  reason?: string;
  /** chant's note for the root, verbatim. */
  note: string;
}

/** What a card carries from the plan read, as `attrs._plan`. */
export interface PlanCardFacts {
  /** Which read answered this card's root. Only `"plan"` carries plan facts. */
  source: PlanAnswer;
  /** Set when the source is not the plan: chant's note, saying why. */
  note?: string;
  /** behold#995: the root's `rootReads` reason (`no-credentials`, `plan-failed`, `needs-init`, ...), set when the plan did not answer. */
  readReason?: string;
  action?: string;
  actions?: Record<string, string[]>;
  reason?: string;
  replacePaths?: string[];
  /** Where each forcing value comes from: the block the configuration reads
   * it from, by the declared edge whose attribute is the replace path. */
  forcedFrom?: Array<{ path: string; from: string }>;
  afterUnknown?: string[];
  changes?: Array<{ path: string; before: unknown; after: unknown; instance?: string }>;
  drift?: Array<{ path: string; before: unknown; after: unknown; relevant?: boolean; instance?: string }>;
  driftAction?: string;
  relevant?: string[];
}

export interface TerraformPlanRead {
  /** One entry per root chant named a note for. */
  roots: PlanRootAnswer[];
  /** Keyed by the plan IR's node id, `<root>/<address>`. */
  cards: Record<string, PlanCardFacts>;
}

export type TerraformPlanResult = { ok: true; read: TerraformPlanRead } | { ok: false; refusal: PlanRefusal };

/**
 * The observation's per-root report, as chant puts it on the graph IR
 * (`GraphIR.rootReads`, INTENTIUS/chant#4452): keyed `terraform.roots.<root>`,
 * `depth` the read asked for, `fellBackTo` the one that answered when that
 * read failed, `reason` a machine-stable cause. Read here instead of chant's
 * notes (behold#995): rewording a note can no longer change what a card says.
 */
export interface RootRead {
  depth: string;
  fellBackTo?: "state" | "live" | "declared";
  reason?: string;
}

/** `rootReads` off an IR, when chant put it there (chant before #4452 does not). */
export function rootReadsOf(ir: unknown): Record<string, RootRead> {
  const reads = (ir as { rootReads?: unknown } | null)?.rootReads;
  if (!reads || typeof reads !== "object" || Array.isArray(reads)) return {};
  const out: Record<string, RootRead> = {};
  for (const [key, v] of Object.entries(reads as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || typeof (v as RootRead).depth !== "string") continue;
    out[key] = v as RootRead;
  }
  return out;
}

/** The roots chant reported, and which read answered each: `fellBackTo ?? depth`. */
export function planRootAnswers(ir: unknown): PlanRootAnswer[] {
  const out: PlanRootAnswer[] = [];
  for (const [key, rr] of Object.entries(rootReadsOf(ir))) {
    if (!key.startsWith("terraform.roots.")) continue;
    const root = key.slice("terraform.roots.".length);
    const read = rr.fellBackTo ?? rr.depth;
    const answered: PlanAnswer = read === "plan" ? "plan" : read === "state" ? "state" : "none";
    const why = rr.reason ? ` (${rr.reason})` : "";
    const words = rr.fellBackTo === undefined
      ? `the ${rr.depth} read answered`
      : rr.fellBackTo === "declared"
        ? `no read answered, declared only: the ${rr.depth} read failed${why}`
        : `the ${rr.depth} read failed${why}, so the ${rr.fellBackTo} read answered`;
    out.push({ root, answered, ...(rr.reason ? { reason: rr.reason } : {}), note: `${key}: ${words}` });
  }
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? (v as string[]) : undefined);
const entries = <T>(v: unknown): T[] | undefined => (Array.isArray(v) && v.length ? (v as T[]) : undefined);

/** The plan facts on one node of chant's plan IR, or undefined when it has none. */
export function planFactsOf(node: Pick<IRNode, "attrs">): PlanCardFacts | undefined {
  const a = node.attrs ?? {};
  if (typeof a.planAction !== "string") return undefined;
  const facts: PlanCardFacts = { source: "plan", action: a.planAction };
  if (a.planActions && typeof a.planActions === "object") facts.actions = a.planActions as Record<string, string[]>;
  if (typeof a.planActionReason === "string") facts.reason = a.planActionReason;
  const replace = strings(a.planReplacePaths);
  if (replace) facts.replacePaths = replace;
  const unknown = strings(a.planAfterUnknown);
  if (unknown) facts.afterUnknown = unknown;
  const changes = entries<NonNullable<PlanCardFacts["changes"]>[number]>(a.planChanges);
  if (changes) facts.changes = changes;
  const drift = entries<NonNullable<PlanCardFacts["drift"]>[number]>(a.planDrift);
  if (drift) facts.drift = drift;
  if (typeof a.planDriftAction === "string") facts.driftAction = a.planDriftAction;
  const relevant = strings(a.planRelevantAttributes);
  if (relevant) facts.relevant = relevant;
  return facts;
}

/** The root a node of the plan IR belongs to: the lexicon's `root`, else the id's first segment. */
const rootOf = (n: Pick<IRNode, "id" | "attrs">): string | undefined =>
  typeof n.attrs?.root === "string" && n.attrs.root ? n.attrs.root : n.id.includes("/") ? n.id.slice(0, n.id.indexOf("/")) : undefined;

/** A resource or data block, the only blocks a plan has rows for. */
const isBlockWithRows = (n: Pick<IRNode, "kind" | "lexicon">): boolean =>
  n.lexicon === TERRAFORM_LEXICON && (n.kind === "Terraform::Resource" || n.kind === "Terraform::Data");

/** The top-level attribute a plan path names: `tags["a"]` and `input.name` -> `tags`, `input`. */
const topAttr = (path: string): string => path.split(/[.[]/)[0]!;

/**
 * Where each replace path's value comes from: the declared edges out of the
 * block whose attribute is that path (`terraform_data.replaced` ->
 * `var.generation` via `triggers_replace`). An address, without its root.
 */
function forcedFromOf(id: string, root: string | undefined, paths: string[], edges: GraphIR["edges"]): Array<{ path: string; from: string }> | undefined {
  const out: Array<{ path: string; from: string }> = [];
  for (const path of paths) {
    for (const e of edges ?? []) {
      const via = (e as { viaAttr?: unknown }).viaAttr;
      if (e.from !== id || typeof via !== "string" || topAttr(via) !== topAttr(path)) continue;
      const from = root && e.to.startsWith(`${root}/`) ? e.to.slice(root.length + 1) : e.to;
      if (!out.some((o) => o.path === path && o.from === from)) out.push({ path, from });
    }
  }
  return out.length ? out : undefined;
}

/** Turn chant's plan IR, with its `rootReads`, into the read. Pure; exported for testing. */
export function terraformPlanReadOf(ir: Pick<GraphIR, "nodes"> & Partial<Pick<GraphIR, "edges">>): TerraformPlanRead {
  const roots = planRootAnswers(ir);
  const byRoot = new Map(roots.map((r) => [r.root, r]));
  const cards: Record<string, PlanCardFacts> = {};
  for (const n of ir.nodes) {
    if (!isBlockWithRows(n)) continue;
    const root = rootOf(n);
    const answer = root ? byRoot.get(root) : undefined;
    if (answer?.answered === "plan") {
      const facts = planFactsOf(n);
      // A planned create reads absent, and chant puts its plan attributes on
      // the declared node all the same (chant#4372): `create`, and what stays
      // unknown until apply. A block with no plan attributes at all gets no
      // card facts rather than a guessed action.
      if (facts) {
        const from = facts.replacePaths ? forcedFromOf(n.id, root, facts.replacePaths, ir.edges ?? []) : undefined;
        cards[n.id] = from ? { ...facts, forcedFrom: from } : facts;
      }
    } else if (answer) {
      cards[n.id] = { source: answer.answered, note: answer.note, ...(answer.reason ? { readReason: answer.reason } : {}) };
    }
  }
  return { roots, cards };
}

/** The versions the read is made with: behold's own chant, which the scratch
 * project runs, and the lexicon beside it. Injectable for tests. */
export interface PlanReadDeps {
  chantVersion?: () => string | undefined;
  lexiconVersion?: () => string | undefined;
  run?: (args: string[], projectDir: string, env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Extra environment for chant's spawn, below the observe override. */
  spawnEnv?: Record<string, string>;
}

/** The refusal for a chant or lexicon below the read's floor, or undefined. */
export function planReadFloorRefusal(chant: string | undefined, lexicon: string | undefined): PlanRefusal | undefined {
  const f = floorFor(TERRAFORM_PLAN_READ);
  if (!floorMet(f, chant)) return floorRefusal(f, chant);
  if (!floorMet(f, lexicon)) {
    return {
      error: `The ${f.read} needs ${TERRAFORM_LEXICON_PKG} ${f.floor} or newer. behold has ${lexicon ?? "(unknown version)"}.`,
      code: "chant-too-old",
      remedy: `Upgrade ${TERRAFORM_LEXICON_PKG} to ${f.floor} or newer beside behold.`,
    };
  }
  return undefined;
}

/**
 * Read the plan for every stock root of one terraform member. A refusal (no
 * reader, a chant or lexicon below the floor, chant failing outright) comes
 * back as `{ ok: false }`; a root that could not be planned is not a refusal,
 * it is a root whose answer is `state` or `none`.
 */
export async function readTerraformPlan(dir: string, deps: PlanReadDeps = {}): Promise<TerraformPlanResult> {
  // The floor first: it needs no reader installed to answer, and a chant
  // below it is refused before anything is written or spawned. The scratch
  // project reaches chant through behold's own node_modules, so behold's
  // chant is the one that runs.
  const { resolveChant } = await import("./chant.ts");
  const chant = deps.chantVersion ? deps.chantVersion() : resolveChant().version;
  const lexicon = deps.lexiconVersion ? deps.lexiconVersion() : resolvedVersion(TERRAFORM_LEXICON_PKG);
  const refusal = planReadFloorRefusal(chant, lexicon);
  if (refusal) return { ok: false, refusal };
  const state = terraformReaderState();
  if (state.refusal) return { ok: false, refusal: state.refusal };
  const { scan, components } = terraformMemberScan(dir);
  if (!scan.roots.length) return { ok: true, read: { roots: [], cards: {} } };
  const project = writeTerraformScratchProject(dir, scan, undefined, "tf", components);
  const env = { ...deps.spawnEnv, [TERRAFORM_OBSERVE_ENV]: "plan" };
  const run = deps.run ?? (async (args: string[], cwd: string, e: Record<string, string>) => (await import("./chant.ts")).runChantRaw(args, cwd, e));
  const res = await run(terraformPlanArgs(), project, env);
  if (res.code !== 0) {
    const first = stripAnsi(res.stderr).split("\n").find((l) => /error/i.test(l)) ?? `exit ${res.code}`;
    return { ok: false, refusal: { error: `chant could not read the plan for ${dir}: ${first.trim()}`, code: "terraform-plan", remedy: "Run the same read by hand in the scratch project to see chant's whole message." } };
  }
  let ir: GraphIR;
  try {
    ir = JSON.parse(res.stdout) as GraphIR;
  } catch {
    return { ok: false, refusal: { error: `chant printed something that is not a graph for ${dir}.`, code: "terraform-plan", remedy: "Check the chant behold runs: `behold doctor`." } };
  }
  return { ok: true, read: terraformPlanReadOf(ir) };
}

/**
 * Put each card's plan facts on the graph as `attrs._plan`. `member` is the
 * composed member name the ids are prefixed with on an estate. Returns how
 * many cards were painted.
 */
export function paintTerraformPlan(ir: GraphIR, read: TerraformPlanRead, member?: string): number {
  let painted = 0;
  for (const n of ir.nodes) {
    if (n.lexicon !== TERRAFORM_LEXICON) continue;
    const key = member && n.id.startsWith(`${member}/`) ? n.id.slice(member.length + 1) : n.id;
    const facts = read.cards[key];
    if (!facts) continue;
    n.attrs = { ...n.attrs, _plan: facts };
    painted++;
  }
  return painted;
}

/** One member's answer, for `meta.plan` and `/api/terraform/plan`. */
export interface MemberPlanAnswer {
  member?: string;
  roots?: PlanRootAnswer[];
  refusal?: PlanRefusal;
}

/** The statusbar clause for a set of member answers. */
export function terraformPlanNote(answers: MemberPlanAnswer[]): string | undefined {
  if (!answers.length) return "plan: no stock Terraform root is served";
  const parts: string[] = [];
  for (const a of answers) {
    const who = a.member ? `${a.member}: ` : "";
    if (a.refusal) {
      parts.push(`${who}plan not read (${a.refusal.error})`);
      continue;
    }
    for (const r of a.roots ?? []) {
      parts.push(
        r.answered === "plan"
          ? `${who}${r.root} read from the plan`
          : r.answered === "state"
            ? `${who}${r.root} plan not read, the state read answered (${r.note.replace(/^terraform\.roots\.[^:]+: /, "")})`
            : `${who}${r.root} plan not read, nothing answered (${r.note.replace(/^terraform\.roots\.[^:]+: /, "")})`,
      );
    }
  }
  return parts.length ? `plan: ${parts.join("; ")}` : undefined;
}
