/**
 * The Terraform lens (#380): the logical topology's projection for a Terraform
 * estate chant read. One box per root — a Terraform project's only grouping —
 * every card in it, and only the edges the graph actually states.
 *
 * No inference. A stock estate has no edges until chant#2265 resolves a block's
 * `"${…}"` references, and the cross-root read that looked derivable was
 * measured and refused (#381). A lens that drew one anyway would be inventing
 * the one thing this estate's own tooling declines to claim.
 *
 * Every other projection filters on its own lexicon and ignores the rest, so a
 * mixed estate merges byte-for-byte as before, and `retainCrossLensEdges`
 * (#321) keeps an edge whose two ends are drawn by different lenses — which on
 * a chant project beside a Terraform root is exactly the seam that matters.
 */
import type { GraphIR, IREdge } from "@intentius/chant";
import type { ByContainer, LogicalProjection } from "./logical.ts";
import { TERRAFORM_LEXICON, isTerraformEntity } from "./terraform-lens.ts";

export function rootBoxTitle(root: string): string {
  return `root ${root}`;
}

/** The root a node belongs to: the lexicon's own `attrs.root`, else the
 * `<root>/` prefix it mints on every id. */
export function rootOf(node: { id: string; attrs: Record<string, unknown> }): string | undefined {
  if (typeof node.attrs.root === "string" && node.attrs.root) return node.attrs.root;
  return node.id.includes("/") ? node.id.slice(0, node.id.indexOf("/")) : undefined;
}

export function projectTerraformLogical(ir: GraphIR): LogicalProjection {
  // `normalizeTerraformNodes` has usually run by here, which moves the resource
  // type into `kind` — so match on the lexicon plus the block attr it leaves,
  // and fall back to the raw entity kinds for a caller that skipped it.
  const cards = ir.nodes.filter((n) => n.lexicon === TERRAFORM_LEXICON && (typeof n.attrs.block === "string" || isTerraformEntity(n)));
  if (cards.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };
  const kept = new Set(cards.map((n) => n.id));
  const byContainer: ByContainer = {};
  for (const n of cards) {
    const root = rootOf(n);
    if (!root) continue;
    (byContainer[rootBoxTitle(root)] ??= []).push(n.id);
  }
  const edges: IREdge[] = [];
  const seen = new Set<string>();
  for (const e of ir.edges) {
    if (!kept.has(e.from) || !kept.has(e.to) || seen.has(`${e.from}|${e.to}`)) continue;
    seen.add(`${e.from}|${e.to}`);
    edges.push(e);
  }
  return { ir: { nodes: cards, edges, groups: {} }, byContainer };
}
