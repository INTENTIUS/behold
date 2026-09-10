/**
 * Rendering a Terraform estate that chant read (#378, #379, #380, #382).
 *
 * chant's terraform lexicon (`@intentius/chant-lexicon-terraform`) reads the
 * HCL an estate already has and emits one entity per block, so a Terraform
 * estate reaches behold through the same `chant graph --format ir` every chant
 * member does. There is no `terraform` member kind and behold parses no HCL —
 * the same posture `src/carve-lens.ts` states for the carve report.
 *
 * What arrives needs three things done to it before it is a picture.
 *
 * **Every card has the same kind.** A node's `kind` is the ENTITY class
 * (`Terraform::Resource`, `Terraform::Data`, …), not the resource type. The
 * type a person reads by — `aws_s3_bucket`, `aws_iam_role` — is inside
 * `attrs.address`. pinhole resolves an icon from `kind` and titles a card from
 * it, so left alone an estate of buckets and roles draws as N identical cards
 * saying `Terraform::Resource`. `normalizeTerraformNodes` moves the type to
 * `kind` and keeps the block class in `attrs.block`, which is exactly the shape
 * a carve node already has (`carveReportToIr` sets `kind` from `tfTypeOf`), so
 * one presentation pack serves both producers.
 *
 * **Everything is in one box.** chant groups the whole lexicon under one
 * `byStack` entry, though every node id is already `<root>/<address>` and every
 * node carries `attrs.root`. A Terraform project's roots are its only grouping:
 * no stacks, no components, no waves. `groupTerraformByRoot` makes the roots
 * the boxes. chant#2266 asks for this upstream; when it lands this pass sees
 * the grouping already done and leaves it alone.
 *
 * **Most of it is not infrastructure.** 247 nodes for 43 resources on the
 * estate this was built against: 108 variables, 53 outputs, 14 `terraform`
 * blocks. The lexicon is right to read every block — the post-synth checks need
 * them — and it is the renderer's job to decide which are cards. That decision
 * is `CARD_BLOCKS` below and it is #382's whole content.
 *
 * No edges are invented here. A stock Terraform estate has none until
 * chant#2265 resolves a block's `"${…}"` references, and the one relationship
 * that looked derivable — a cross-root read by name — was measured and refused
 * (#381): both ends carry the same unresolved interpolation, so a match would
 * be a coincidence of variable naming. A data source says what it reads as a
 * row instead.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import { tfTypeOf } from "./carve-lens.ts";

/** The lexicon chant's terraform plugin stamps on every entity it emits. */
export const TERRAFORM_LEXICON = "terraform";

/** The HCL block a `Terraform::*` entity came from, lowercased. `attrs.block`
 * carries it once `normalizeTerraformNodes` has moved the resource type into
 * `kind`. */
export type TerraformBlock = "resource" | "data" | "module" | "output" | "variable" | "locals" | "provider" | "terraform";

const BLOCK_OF: Record<string, TerraformBlock> = {
  "Terraform::Resource": "resource",
  "Terraform::Data": "data",
  "Terraform::Module": "module",
  "Terraform::Output": "output",
  "Terraform::Variable": "variable",
  "Terraform::Locals": "locals",
  "Terraform::Provider": "provider",
  "Terraform::Terraform": "terraform",
};

/** Is this a node chant's terraform lexicon emitted (as opposed to a carve
 * node, which shares the lexicon but carries a score)? */
export function isTerraformEntity(node: Pick<IRNode, "kind" | "lexicon">): boolean {
  return node.lexicon === TERRAFORM_LEXICON && node.kind in BLOCK_OF;
}

/** Does this IR carry any of them? Every pass below is a no-op otherwise, and
 * this is the guard that keeps a chant or k8s estate byte-identical. */
export function hasTerraformEntities(ir: Pick<GraphIR, "nodes">): boolean {
  return ir.nodes.some(isTerraformEntity);
}

/**
 * #382 — which blocks are cards, at which zoom.
 *
 * The estate is the infrastructure: what is declared, what it reads, and what
 * it composes. Its interface — the outputs it publishes and the variables it
 * takes — is real but is a second question, and settings are not estate at all.
 *
 * Read against detail: 0-2 are the estate, 3 (the attributes tier, where chant
 * also starts carrying parsed bodies) adds the interface. Nothing is a card at
 * every tier just because it exists.
 */
export const CARD_BLOCKS: Record<"estate" | "interface", readonly TerraformBlock[]> = {
  estate: ["resource", "data", "module"],
  interface: ["output", "variable"],
};

/** Blocks that are never cards: settings, not estate. They stay in the IR — a
 * caller can still inspect them — and simply do not take space on the canvas. */
export const NEVER_CARDS: readonly TerraformBlock[] = ["terraform", "provider", "locals"];

/** The blocks drawn at `detail`. */
export function cardBlocksAt(detail: number | undefined): Set<TerraformBlock> {
  const blocks = new Set<TerraformBlock>(CARD_BLOCKS.estate);
  if ((detail ?? 2) >= 3) for (const b of CARD_BLOCKS.interface) blocks.add(b);
  return blocks;
}

/** `data.aws_iam_policy.boundary` → `aws_iam_policy`; `var.region` → `var`. */
function typeOfAddress(address: string, block: TerraformBlock): string {
  if (block === "data") {
    const parts = address.split(".");
    return parts.length >= 3 && parts[0] === "data" ? parts[1] : address;
  }
  if (block === "resource" || block === "module") return tfTypeOf(address, block === "module" ? "module" : undefined);
  return block;
}

/** The producer a data source reads, as declared — the interpolation left
 * unresolved, because resolving it means evaluating HCL (#381). Undefined when
 * the body carries no filter this can name. */
function readsOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  for (const key of ["name", "bucket", "arn", "id", "domain", "repository"]) {
    const v = b[key];
    if (typeof v === "string" && v) return `${key} ${v}`;
  }
  return undefined;
}

/**
 * Give each terraform entity the shape a card is drawn from: the resource type
 * as `kind`, the block class in `attrs.block`, and a data source's declared
 * read as a row. Mutates and returns `ir`; a no-op on an IR with none.
 *
 * The entity class is not lost — it moves to `attrs.block`, which is what the
 * zoom filter and the lens read. Nothing else in behold keys on
 * `Terraform::*`, and chant remains free to add entity types: an unknown
 * `Terraform::X` is left exactly as it arrived rather than guessed at.
 */
export function normalizeTerraformNodes(ir: GraphIR): GraphIR {
  for (const n of ir.nodes) {
    const block = BLOCK_OF[n.kind];
    if (n.lexicon !== TERRAFORM_LEXICON || !block) continue;
    const address = typeof n.attrs.address === "string" ? n.attrs.address : n.id;
    const reads = block === "data" ? readsOf(n.attrs.body) : undefined;
    n.kind = typeOfAddress(address, block);
    n.attrs = { ...n.attrs, block, ...(reads ? { reads } : {}) };
  }
  return ir;
}

/**
 * Roots become the boxes. Reads `attrs.root` — the lexicon's own field — and
 * falls back to the `<root>/` id prefix it also mints. Leaves the KEYING alone
 * when something upstream has already grouped by root (chant#2266), so this
 * pass retires itself rather than fighting the producer.
 *
 * #393: a node sits in exactly ONE box (pinhole's `layoutIr`: "a node may sit
 * in one group"), so every box a regrouped node has left must give it up.
 * Composition puts one box per member around a member's whole IR
 * (`composeStacks`, src/estate.ts) and until now this pass added the root boxes
 * beside it — so `behold serve <a terraform directory>` drew five root boxes
 * AND an empty box named after the served directory. Both readings were
 * available and the empty one is what it drew.
 *
 * Of the two fixes — nest the roots inside the member box, or drop a member box
 * every node has left — nesting is not on offer here: `boxes: "byStack"` is a
 * flat set of titled boundary boxes and only the architecture lens
 * (`groups.byContainer`) nests. So the emptied box goes, and the thing it was
 * there to say — WHICH member these roots came from — moves into the root box's
 * own title: `<member>/<root>` when the estate holds more than that one member,
 * the bare root name when it does not. Without that, two Terraform members with
 * a root apiece named `prod` would silently merge into one box, which is a
 * worse lie than the empty box this fixes.
 */
export function groupTerraformByRoot(ir: GraphIR): GraphIR {
  /** Each root's nodes, keyed by the composed member prefix its ids carry
   * (`""` when nothing composed them) together with the root name. */
  const roots = new Map<string, { prefix: string; root: string; ids: string[] }>();
  for (const n of ir.nodes) {
    if (n.lexicon !== TERRAFORM_LEXICON) continue;
    const root = typeof n.attrs.root === "string" && n.attrs.root ? n.attrs.root : n.id.includes("/") ? n.id.slice(0, n.id.indexOf("/")) : undefined;
    if (!root) continue;
    // `<member>/<root>/<address>` once composed, `<root>/<address>` otherwise.
    const at = n.id.indexOf(`/${root}/`);
    const prefix = at > 0 ? n.id.slice(0, at) : "";
    const key = `${prefix} ${root}`;
    (roots.get(key) ?? roots.set(key, { prefix, root, ids: [] }).get(key)!).ids.push(n.id);
  }
  if (roots.size === 0) return ir;
  const byStack = { ...(ir.groups.byStack ?? {}) } as Record<string, string[]>;
  // Already grouped by root upstream: every root is its own entry and the
  // lexicon-wide bucket is gone. The keying below is then a no-op — the strip
  // under it is not, so only the keying is skipped.
  const grouped = [...roots.values()].every((r) => byStack[r.root]?.length === r.ids.length);
  const rootBoxes = new Set<string>();
  if (grouped) {
    for (const r of roots.values()) rootBoxes.add(r.root);
  } else {
    delete byStack[TERRAFORM_LEXICON];
    const members = new Set([...roots.values()].map((r) => r.prefix));
    const qualify = members.size > 1 || [...members].some((p) => p && Object.keys(byStack).some((b) => b !== p));
    for (const { prefix, root, ids } of roots.values()) {
      const box = qualify && prefix ? `${prefix}/${root}` : root;
      byStack[box] = ids;
      rootBoxes.add(box);
    }
  }
  const regrouped = new Set([...roots.values()].flatMap((r) => r.ids));
  for (const [box, ids] of Object.entries(byStack)) {
    if (rootBoxes.has(box)) continue;
    const left = ids.filter((id) => !regrouped.has(id));
    if (left.length) byStack[box] = left;
    else delete byStack[box];
  }
  ir.groups = { ...ir.groups, byStack };
  return ir;
}

/** What a zoom filter left out, so a thinned view can say so rather than
 * implying the estate is small. */
export interface TerraformElision {
  /** Cards dropped, by block. */
  dropped: Partial<Record<TerraformBlock, number>>;
  total: number;
}

/**
 * Drop the blocks that are not cards at this detail (#382), and report what
 * went. Edges touching a dropped node go with it — there are none today, and a
 * dangling edge would be worse than a missing one when chant#2265 lands.
 */
export function filterTerraformCards(ir: GraphIR, detail: number | undefined): TerraformElision {
  const blocks = cardBlocksAt(detail);
  const dropped: Partial<Record<TerraformBlock, number>> = {};
  const gone = new Set<string>();
  for (const n of ir.nodes) {
    const block = n.attrs.block as TerraformBlock | undefined;
    if (n.lexicon !== TERRAFORM_LEXICON || !block || blocks.has(block)) continue;
    gone.add(n.id);
    dropped[block] = (dropped[block] ?? 0) + 1;
  }
  const total = gone.size;
  if (total === 0) return { dropped, total };
  ir.nodes = ir.nodes.filter((n) => !gone.has(n.id));
  ir.edges = ir.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
  const byStack = { ...(ir.groups.byStack ?? {}) } as Record<string, string[]>;
  for (const [box, ids] of Object.entries(byStack)) {
    const left = ids.filter((id) => !gone.has(id));
    if (left.length) byStack[box] = left;
    else delete byStack[box];
  }
  ir.groups = { ...ir.groups, byStack };
  return { dropped, total };
}

/** What a block is called in a sentence, singular and plural. `locals` and
 * `terraform` are the two HCL spells English will not pluralise for us. */
const BLOCK_LABEL: Record<TerraformBlock, [string, string]> = {
  resource: ["resource", "resources"],
  data: ["data source", "data sources"],
  module: ["module", "modules"],
  output: ["output", "outputs"],
  variable: ["variable", "variables"],
  locals: ["locals block", "locals blocks"],
  provider: ["provider", "providers"],
  terraform: ["terraform block", "terraform blocks"],
};

/** The note a thinned Terraform view carries: what it is not showing, and how
 * to see it. Undefined when nothing was dropped. */
export function terraformElisionNote(e: TerraformElision, detail: number | undefined): string | undefined {
  if (e.total === 0) return undefined;
  const parts = Object.entries(e.dropped)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([block, n]) => {
      const label = BLOCK_LABEL[block as TerraformBlock];
      return `${n} ${label ? label[n === 1 ? 0 : 1] : block}`;
    });
  const interfaceHidden = (detail ?? 2) < 3 && (e.dropped.variable || e.dropped.output);
  return `showing the estate — ${parts.join(", ")} not drawn${interfaceHidden ? " (outputs and variables appear at detail 3 — ⌘K → attributes)" : ""}`;
}

/** The same fact as a chip rather than a sentence (#393): the statusbar note
 * lives in a 260px panel, and the full sentence — every block class, its count,
 * and how to see it — is a paragraph there. The long form stays reachable (the
 * strip's tooltip, and the panel's Model tab); this is what the strip shows. */
export function terraformElisionNoteShort(e: TerraformElision): string | undefined {
  return e.total === 0 ? undefined : `${e.total} block${e.total === 1 ? "" : "s"} not drawn`;
}

/**
 * The two fields a Terraform card leads with: which root it belongs to, and
 * what it reads when it is a data source. The type and the name are already the
 * card's kind and title once `normalizeTerraformNodes` has run, so repeating
 * them here would spend both rows saying what the card says.
 *
 * Returns undefined for a carve node (which has a score and its own fields) and
 * for anything that is not a terraform entity, so one pack serves both.
 */
export function terraformCardFields(node: { attrs: Record<string, unknown> }): Array<{ label: string; value: string }> | undefined {
  const a = node.attrs;
  if (typeof a.score === "number" || typeof a.block !== "string") return undefined;
  const reads = typeof a.reads === "string" ? [{ label: "reads", value: a.reads }] : [];
  const root = typeof a.root === "string" ? [{ label: "root", value: a.root }] : [];
  const fields = [...reads, ...root];
  return fields.length ? fields : [{ label: "block", value: a.block }];
}
