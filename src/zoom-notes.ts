/**
 * Why a zoom level rendered what it rendered (#131).
 *
 * Four of the six levels can legitimately produce a picture that is either
 * empty or identical to the level below, and until now none of them said so.
 * A user stepping through the picker saw the same view repeatedly and read the
 * control as stuck — which is how #131 was reported.
 *
 * None of these are errors. `logical` on a k8s estate is correctly empty (#74,
 * the projection's headline kinds are AWS-only) and `composites` with no
 * component ownership is correctly the resource graph. The defect is silence,
 * so this module produces one short line saying which of those happened, and
 * `renderStatusbar()` in web/app.js puts it beside the zoom name that caused
 * it.
 *
 * Deliberately not a `RouteError` (src/server.ts): those replace the canvas
 * with a card, and are for a view that could not be produced at all. These
 * views were produced and are honest; they just need a caption.
 *
 * Every function is pure and takes the finished IR, so a note describes what
 * was actually rendered rather than what the request asked for. Nothing here
 * infers intent from query parameters.
 */

/** The finished graph a note is written about — only the parts a note reads. */
export interface NotableGraph {
  nodes: unknown[];
  edges: unknown[];
  groups?: { byContainer?: Record<string, string[]> };
}

/** Which zoom produced the graph. Mirrors web/app.js's `ZOOM_OPTS` values. */
export type Zoom = "components" | "logical" | "composites" | "resources" | "attributes" | "runtime";

/**
 * The note for a rendered graph, or `undefined` when the view is unremarkable.
 *
 * `composites` is the one that needs a second input: it is *defined* as the
 * resource graph plus the component DAG's `dependsOn` edges, so "did any get
 * attached" is the question, and that is not visible from the finished IR
 * alone — an estate can legitimately have zero edges either way (#84).
 */
export function zoomNote(zoom: Zoom, ir: NotableGraph, compositeEdgesAttached?: number): string | undefined {
  const empty = ir.nodes.length === 0;

  if (zoom === "components") {
    return empty ? "no components discovered — nothing declares one in this project" : undefined;
  }

  if (zoom === "logical") {
    // #74: src/logical.ts's headline kinds are literal `AWS::*`, so a project
    // with no AWS resources matches nothing. Correct, and indistinguishable
    // from a broken lens without saying it.
    //
    // Empty is the loud case; the quiet one is a projection that kept a
    // handful of nodes out of many, which looks like a working lens on a tiny
    // estate. `logicalKept` covers both — see its threshold note. Callers that
    // cannot count the input fall back to the empty-only check.
    return empty ? "logical is an AWS projection — no AWS resources in this estate" : undefined;
  }

  if (zoom === "composites") {
    // Attached edges are what makes this level different from `resources`.
    // Zero means the component→node mapping found nothing to join (#138), so
    // the user is looking at the resource graph under a different name.
    return compositeEdgesAttached === 0
      ? "no component ownership to join — showing the resource graph unchanged"
      : undefined;
  }

  if (zoom === "runtime") {
    // Counted from the children themselves, not from byContainer: chant's own
    // live containment (VPC ⊃ subnet, #779) populates byContainer on a mixed
    // estate, which used to mask this note exactly where it matters — a cloud
    // estate whose k8s half has no owner-referenced children (#148).
    const children = ir.nodes.filter((n) => (n as { runtimeOwner?: string }).runtimeOwner).length;
    return children === 0
      ? "nothing below the declaration boundary — no owner-referenced children on this substrate"
      : undefined;
  }

  return undefined;
}

/**
 * The logical lens, judged against what it was given rather than only against
 * zero (ported from #133, which had this and the version merged in #139 did
 * not).
 *
 * A projection that keeps 1 of 11 nodes renders a plausible-looking diagram of
 * almost nothing, which is worse than an empty one: empty reads as "no data",
 * partial reads as "this is your estate". Both get named.
 *
 * Silent when the projection kept most of the graph. #133's reasoning, kept
 * verbatim because it is the right reasoning: a note on every logical view
 * would be noise, and noise is how a real signal stops being read. The `* 3`
 * threshold is a judgement call and is better argued with than inherited.
 */
export function logicalKept(before: number, after: number): string | undefined {
  if (after > 0 && after * 3 >= before) return undefined;
  return after === 0
    ? `logical projected nothing from ${before} resources — it is a cloud-topology lens, and this estate declares none of the kinds it nests (behold#74)`
    : `logical kept ${after} of ${before} resources — it is a cloud-topology lens, and the rest are kinds it does not nest (behold#74)`;
}

/**
 * A second note, orthogonal to the zoom: an estate whose nodes relate to
 * nothing.
 *
 * A graph with nodes and no edges lays out as a single flat row, which reads
 * as a broken renderer rather than as an accurate picture of a project that
 * declares no references. Worth saying once, on the levels where an edge would
 * have been drawn if there were any.
 *
 * `components` and `logical` are exempt: the first draws its own DAG and the
 * second lays itself out as nested boxes, so neither is judged on edge count.
 */
export function edgelessNote(zoom: Zoom, ir: NotableGraph): string | undefined {
  if (zoom === "components" || zoom === "logical") return undefined;
  if (ir.nodes.length === 0 || ir.edges.length > 0) return undefined;
  return "no edges — nothing in this estate references anything else";
}

/** The slice of a node the namespace-mismatch check reads (#192). */
interface NsNoteNode {
  lexicon?: string;
  kind?: string;
  attrs?: { _status?: string; metadata?: { namespace?: unknown } };
}

/** k8s kinds that are cluster-scoped by definition — no namespace to get
 * wrong, so they carry no evidence either way for the mismatch check. */
const CLUSTER_SCOPED = new Set([
  "K8s::Core::Namespace",
  "K8s::Rbac::ClusterRole",
  "K8s::Rbac::ClusterRoleBinding",
  "K8s::Storage::StorageClass",
  "K8s::Apiextensions::CustomResourceDefinition",
]);

/**
 * #192: the namespace-mismatch signature. A Flux estate commonly declares no
 * `metadata.namespace` on its objects — `Kustomization.spec.targetNamespace`
 * stamps it at apply time — so chant's live read looks in `default`, finds
 * nothing, and honestly reports absence. The overlay then paints weeks-old
 * running infrastructure `pending` ("declared, not deployed yet" — an
 * invitation to hit Deploy), while cluster-scoped objects, which have no
 * namespace to get wrong, resolve fine. That split is mechanically
 * detectable: several namespaced-kind k8s nodes read `accent` AND none of
 * them declares a namespace, while something else k8s resolved `good`
 * (proving the read reached the right cluster). A pending node that DOES
 * declare its namespace is genuine absence — one of those and the note stays
 * silent, because then the read looked exactly where the source said.
 */
export function namespaceMismatchNote(nodes: readonly unknown[]): string | undefined {
  const k8s = (nodes as NsNoteNode[]).filter((n) => n?.lexicon === "k8s");
  if (k8s.length === 0) return undefined;
  const pending = k8s.filter((n) => n.attrs?._status === "accent" && !CLUSTER_SCOPED.has(n.kind ?? ""));
  if (pending.length < 3) return undefined;
  if (pending.some((n) => typeof n.attrs?.metadata?.namespace === "string" && n.attrs.metadata.namespace)) return undefined;
  if (!k8s.some((n) => n.attrs?._status === "good")) return undefined;
  return (
    `${pending.length} pending k8s objects declare no metadata.namespace — if a controller stamps it at ` +
    `apply time (e.g. Flux's targetNamespace), the live read looked in "default", not where they run`
  );
}

/** Both notes for a view, in reading order, joined for a one-line statusbar. */
export function notesFor(
  zoom: Zoom,
  ir: NotableGraph,
  compositeEdgesAttached?: number,
  logicalBefore?: number,
): string | undefined {
  // When the caller can say what logical was given, that reading wins: it
  // catches the partial projection the empty-only check cannot see.
  const primary =
    zoom === "logical" && logicalBefore !== undefined
      ? logicalKept(logicalBefore, ir.nodes.length)
      : zoomNote(zoom, ir, compositeEdgesAttached);
  const notes = [primary, edgelessNote(zoom, ir)].filter((n): n is string => n !== undefined);
  return notes.length ? notes.join(" · ") : undefined;
}

/**
 * The wrong-tier trap: when the project declares a tier lens and a
 * substrate's declared resources read half-or-more "declared, not present"
 * (`accent`) at the current tier, the far likelier story is a mis-picked
 * tier than a half-deployed estate — declared names embed the tier on these
 * projects, so every workload of a running estate reads absent at any other
 * tier, and resources/attributes/runtime collapse into identical near-empty
 * views with nothing saying why. This says why.
 *
 * Only fires when a tier lens exists (`.behold.json` `tiers`), only counts a
 * lexicon's classified nodes (neutral is unobserved, not absent), and needs
 * at least two accent nodes so a single genuinely-pending resource on a tiny
 * estate stays quiet.
 */
export function tierMismatchNote(
  ir: NotableGraph,
  tiers: { values?: readonly string[] } | undefined,
  currentTier: string | undefined,
): string | undefined {
  const values = tiers?.values ?? [];
  if (values.length < 2) return undefined;

  const byLexicon = new Map<string, { good: number; accent: number }>();
  for (const n of ir.nodes) {
    const status = (n as { attrs?: Record<string, unknown> }).attrs?._status;
    if (status !== "good" && status !== "accent") continue;
    const lexicon = (n as { lexicon?: string }).lexicon ?? "?";
    const c = byLexicon.get(lexicon) ?? { good: 0, accent: 0 };
    c[status === "good" ? "good" : "accent"]++;
    byLexicon.set(lexicon, c);
  }

  for (const [lexicon, { good, accent }] of [...byLexicon].sort()) {
    if (accent < 2 || accent * 2 < good + accent) continue;
    const here = currentTier ? `tier "${currentTier}"` : "the default tier";
    const others = values.filter((v) => v !== currentTier).join(", ");
    return (
      `${accent} of ${good + accent} ${lexicon} resources read "declared, not deployed" at ${here} — ` +
      `if the estate runs another declared tier (${others}), pick it (⌘K → tier)`
    );
  }
  return undefined;
}
