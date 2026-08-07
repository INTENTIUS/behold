/**
 * Helm logical projection (behold#146) — the fifth topology lens:
 *
 *   release <chart> ⊃ the chart's own k8s objects
 *
 * A chart project's IR is `Helm::Chart` + `Helm::Values` (helm lexicon) plus
 * the chart's k8s wrappers re-declared as `lexicon: "k8s"` nodes. The four
 * existing lenses each filter to their own lexicon, so before this the helm
 * half contributed nothing: helm-only estates projected empty, and on a mixed
 * estate the chart silently vanished.
 *
 * The lens keeps the `Helm::Chart` node as the release's card (the values/
 * notes/hook entities are authoring plumbing, same reasoning as the k8s
 * lens's `K8S_PLUMBING_KINDS`) and claims the chart's k8s-lexicon nodes into
 * a `release <name>` box by shared source directory — a chart's objects are
 * declared beside its Chart.yaml, and the source graph carries that as
 * `sourceLoc`. The k8s NODES stay owned by the k8s lens (each lens keeps
 * only its own lexicon's nodes — the composition invariant that keeps the
 * union duplicate-free); this lens contributes membership only.
 *
 * Nesting under the k8s namespace boxes — "release inside namespace" — is a
 * cross-lens fact, so it lives in `projectTopology`'s composition
 * (`nestReleaseBoxes`, src/logical.ts), not here: when every object a release
 * box claims sits in one namespace box, the release box moves inside it and
 * the objects leave the namespace's direct membership. Helm-only estates
 * (no namespace boxes) keep release boxes at the root.
 */
import type { GraphIR } from "@intentius/chant";
import type { LogicalProjection, ByContainer } from "./logical.ts";

/** The box title for a chart's release. */
export function releaseBoxTitle(chartName: string): string {
  return `release ${chartName}`;
}

/** The chart name a `Helm::Chart` node declares (Chart.yaml `name`), falling
 * back to the node id — an unnamed box beats a dropped chart. */
function chartNameOf(node: { id: string; attrs?: Record<string, unknown> }): string {
  const name = node.attrs?.name;
  return typeof name === "string" && name.length > 0 ? name : node.id;
}

/** Directory of a node's declaring file, "" when unknown. */
function dirOf(node: { sourceLoc?: { file?: string } }): string {
  const file = node.sourceLoc?.file;
  if (typeof file !== "string") return "";
  const slash = file.lastIndexOf("/");
  return slash >= 0 ? file.slice(0, slash) : "";
}

export function projectHelmLogical(ir: GraphIR): LogicalProjection {
  const charts = ir.nodes.filter((n) => n.lexicon === "helm" && n.kind === "Helm::Chart");
  // Observed releases synthesized by src/helm-releases.ts (a deploy-step
  // estate's helm half — no declared chart nodes at all). Cards of this lens;
  // their namespace placement is cross-lens, so it happens in
  // `projectTopology`'s composition (`placeHelmReleases`), not here.
  const releases = ir.nodes.filter((n) => n.lexicon === "helm" && n.kind === "Helm::Release");
  if (charts.length === 0 && releases.length === 0) return { ir: { nodes: [], edges: [], groups: {} }, byContainer: {} };

  const byContainer: ByContainer = {};
  const child = (parent: string, c: string) => {
    const arr = byContainer[parent] ?? (byContainer[parent] = []);
    if (!arr.includes(c)) arr.push(c);
  };

  // The chart's objects: k8s-lexicon nodes declared in the chart's own source
  // directory (or below it). Membership only — the nodes stay the k8s lens's.
  const k8s = ir.nodes.filter((n) => n.lexicon === "k8s");
  for (const chart of charts) {
    const box = releaseBoxTitle(chartNameOf(chart));
    child(box, chart.id);
    const chartDir = dirOf(chart);
    if (chartDir === "") continue;
    for (const n of k8s) {
      const d = dirOf(n);
      if (d === chartDir || d.startsWith(`${chartDir}/`)) child(box, n.id);
    }
  }

  // The chart + release cards are this lens's nodes; edges pass through when
  // both ends survive (none exist for helm today — same posture as the k8s
  // lens before the declared-attribute pass).
  const cards = [...charts, ...releases];
  const kept = new Set(cards.map((n) => n.id));
  const edges = ir.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
  return { ir: { nodes: cards, edges, groups: {} }, byContainer };
}
