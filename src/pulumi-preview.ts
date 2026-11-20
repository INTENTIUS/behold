/**
 * The plan read on a Pulumi member, through chant (behold#1227).
 *
 * chant's pulumi lexicon reads a member one step past its stack export at the
 * preview depth (INTENTIUS/chant#5332): `pulumi preview --json --show-sames`,
 * or `plunge preview` for a member on plunge, read as an observation. Each
 * node gets the attributes the terraform plan depth writes (`planAction`,
 * `planActions`, `planActionReason`, `planReplacePaths`, `planAfterUnknown`,
 * `planChanges`), with secrets, credential-like keys and a Kubernetes
 * Secret's data already left out by chant. A resource the export does not
 * hold is a node of its own, which is every resource of a stack with no
 * export. behold asks for it through the workspace contract, as every Pulumi
 * read goes:
 *
 *     CHANT_PULUMI_OBSERVE=preview chant workspace graph <root> --member <m> \
 *       --live --overlay --env behold-plan --detail 3
 *
 * The plan read on a Terraform root (src/terraform-plan.ts) is the same
 * request, `?plan=1`, and the same card rows: the facts are read with the
 * same `planFactsOf` and land on `attrs._plan`. Which read answered is the
 * member's `rootReads` entry, `pulumi.members.<member>`: `depth: "preview"`
 * alone is the preview, and `fellBackTo` with a `reason` says why it was not.
 * A card in a member that fell back says the plan was not read and which read
 * answered instead, never "no changes".
 *
 * Opt-in like the Terraform read: a preview asks every provider about every
 * resource, so only a request that asks (`?plan=1`) runs one. Nothing is
 * written in the member; chant runs no install and no update.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import { PULUMI_LEXICON } from "./pulumi-card.ts";
import { PLAN_READ_ENV, planFactsOf, rootReadReasonWords, rootReadsOf, type MemberPlanAnswer, type PlanAnswer, type PlanCardFacts, type PlanRefusal, type PlanRootAnswer } from "./terraform-plan.ts";
import { memberIrFromGraphDocument, workspaceGraphArgs, type WorkspaceMember } from "./workspace.ts";
import type { WorkspaceDocument } from "./workspace-reader.ts";

/** The read's name in src/chant-floors.ts. */
export const PULUMI_PREVIEW_READ = "plan read on a Pulumi member";

/** The lexicon's one-run override of a member's observation depth (chant#5332). */
export const PULUMI_OBSERVE_ENV = "CHANT_PULUMI_OBSERVE";

/** The argv after `chant`'s `workspace graph`, pinned so a test can assert it. */
export const pulumiPreviewArgs = (root: string, member: string): string[] =>
  workspaceGraphArgs(root, member, { live: true, overlay: true, env: PLAN_READ_ENV, detail: 3 });

/** What one member's preview gave. Ids are the member's own, as its source read names its nodes. */
export interface PulumiPreviewRead {
  roots: PlanRootAnswer[];
  cards: Record<string, PlanCardFacts>;
  /** Every node the read drew, those the export holds and those only the preview names. */
  nodes: IRNode[];
}

export type PulumiPreviewResult = { ok: true; read: PulumiPreviewRead } | { ok: false; refusal: PlanRefusal };

const ROOT = "pulumi.members.";

/** The member's answer from its `rootReads`: the preview, or the read it fell back to and why. */
export function previewRootAnswers(ir: unknown): PlanRootAnswer[] {
  const out: PlanRootAnswer[] = [];
  for (const [key, rr] of Object.entries(rootReadsOf(ir))) {
    if (!key.startsWith(ROOT)) continue;
    const answered: PlanAnswer = rr.fellBackTo === undefined && rr.depth === "preview" ? "plan" : rr.fellBackTo === "state" ? "state" : "none";
    const why = rr.reason ? ` (${rootReadReasonWords(rr.reason)})` : "";
    const words =
      rr.fellBackTo === undefined
        ? `the ${rr.depth} read answered`
        : rr.fellBackTo === "declared"
          ? `no read answered, declared only: the ${rr.depth} read failed${why}`
          : `the ${rr.depth} read failed${why}, so the ${rr.fellBackTo} read answered`;
    out.push({ root: key.slice(ROOT.length), answered, ...(rr.reason ? { reason: rr.reason } : {}), note: `${key}: ${words}` });
  }
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

/** The words for reasons the preview adds to the ones a Terraform root gives. */
const PREVIEW_REASON_WORDS: Record<string, string> = {
  "needs-install": "the program's dependencies or a provider plugin are not installed",
  "no-stack": "no stack is selected",
  "no-binary": "the engine binary is not on PATH",
  "preview-failed": "the preview failed",
};

/** Turn chant's preview document for one member into the read. Pure; exported for testing. */
export function pulumiPreviewReadOf(doc: WorkspaceDocument, member: string): PulumiPreviewRead {
  const ir = memberIrFromGraphDocument(doc, member);
  const roots = previewRootAnswers(ir).map((r) => (r.reason && PREVIEW_REASON_WORDS[r.reason] ? { ...r, note: r.note.replace(`(${r.reason})`, `(${PREVIEW_REASON_WORDS[r.reason]})`) } : r));
  const answer = roots.find((r) => r.root === member);
  const cards: Record<string, PlanCardFacts> = {};
  for (const n of ir.nodes) {
    if (n.lexicon !== PULUMI_LEXICON) continue;
    if (answer?.answered === "plan") {
      const facts = planFactsOf(n);
      if (facts) cards[n.id] = facts;
    } else if (answer) {
      cards[n.id] = { source: answer.answered, note: answer.note, ...(answer.reason ? { readReason: answer.reason } : {}) };
    }
  }
  return { roots, cards, nodes: ir.nodes };
}

/** The versions and reader the read is made with. Injectable for tests. */
export interface PulumiPreviewDeps {
  chantVersion?: (root: string) => string | undefined;
  read?: (root: string, args: string[], env: Record<string, string>) => Promise<WorkspaceDocument>;
}

/** Read one declared Pulumi member's preview. A chant below the floor, or a read that fails outright, is a refusal. */
export async function readPulumiPreview(member: Pick<WorkspaceMember, "name">, root: string, deps: PulumiPreviewDeps = {}): Promise<PulumiPreviewResult> {
  const f = floorFor(PULUMI_PREVIEW_READ);
  const version = deps.chantVersion ? deps.chantVersion(root) : (await import("./chant.ts")).resolveChant(root).version;
  if (!floorMet(f, version)) return { ok: false, refusal: floorRefusal(f, version) };
  const read = deps.read ?? (async (r: string, a: string[], e: Record<string, string>) => (await import("./workspace-reader.ts")).rootReader(r, e).read("graph", a));
  try {
    const doc = await read(root, pulumiPreviewArgs(root, member.name), { [PULUMI_OBSERVE_ENV]: "preview" });
    return { ok: true, read: pulumiPreviewReadOf(doc, member.name) };
  } catch (err) {
    const first = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    return { ok: false, refusal: { error: `chant could not read the preview of ${member.name}: ${first}`, code: "pulumi-preview", remedy: "Run the same read by hand at the workspace root to see chant's whole message." } };
  }
}

/**
 * Put the preview on the composed graph: each card's facts as `attrs._plan`,
 * and each node only the preview names (a resource the next update creates,
 * every resource of a stack with no export) as a card of its own in the
 * member's box. `member` is the composed member name, absent when the member
 * is served alone. The colour chant gave a live node is not carried: this is
 * the source picture with the plan's rows on it. Returns how many cards were
 * painted or added.
 */
export function paintPulumiPreview(ir: GraphIR, read: PulumiPreviewRead, member?: string): number {
  const id = (own: string): string => (member ? `${member}/${own}` : own);
  const have = new Set(ir.nodes.map((n) => n.id));
  let painted = 0;
  for (const n of ir.nodes) {
    if (n.lexicon !== PULUMI_LEXICON) continue;
    const key = member && n.id.startsWith(`${member}/`) ? n.id.slice(member.length + 1) : n.id;
    const facts = read.cards[key];
    if (!facts) continue;
    n.attrs = { ...n.attrs, _plan: facts };
    painted++;
  }
  for (const n of read.nodes) {
    if (n.lexicon !== PULUMI_LEXICON || have.has(id(n.id)) || !read.cards[n.id]) continue;
    const { _status: _s, ...attrs } = (n.attrs ?? {}) as Record<string, unknown>;
    const component = (n as { component?: unknown }).component;
    ir.nodes.push({ ...n, id: id(n.id), ...(typeof component === "string" ? { component: id(component) } : {}), attrs: { ...attrs, _plan: read.cards[n.id] } } as IRNode);
    if (member) {
      const groups = ir.groups as Record<string, Record<string, string[]> | undefined>;
      const byStack = (groups.byStack ??= {});
      (byStack[member] ??= []).push(id(n.id));
    }
    painted++;
  }
  return painted;
}

/** One member's answer for `meta.plan` and `/api/terraform/plan`, in the Terraform read's shape. */
export function pulumiPlanAnswer(member: string | undefined, res: PulumiPreviewResult): MemberPlanAnswer {
  return res.ok ? { ...(member ? { member } : {}), roots: res.read.roots } : { ...(member ? { member } : {}), refusal: res.refusal };
}
