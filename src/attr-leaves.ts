/**
 * The string leaves of a node's declared attrs, moved out of src/value-match.ts
 * (behold#1030) so that module can go once behold#1005 flips chant's release
 * switch: src/ops-lens.ts joins op steps onto these leaves and is not an edge
 * pass. The walk is the one value-match used, unchanged (#166).
 */

/** How deep the consumer walk goes before it stops, counting an array as a step
 * of its own. Twelve is the deepest place a real k8s reference sits —
 * `spec.template.spec.containers[].env[].valueFrom.secretKeyRef.name` is ten —
 * with headroom, and short of turning a CRD's arbitrary payload into an
 * unbounded scan. */
const MAX_DEPTH = 12;

/** Subtrees the walk does not enter, because a match inside them is not
 * evidence of wiring:
 *  - `status` is OBSERVED state (and where behold's own overlay paint lands),
 *    not a declaration;
 *  - `annotations` carries rendered blobs — `kubectl.kubernetes.io/last-applied
 *    -configuration` is the whole object as one string, which would match every
 *    name in it at once;
 *  - `labels`/`matchLabels` are the SELECTOR lexicon, and joining on them is
 *    `src/k8s-edges.ts`'s job (it evaluates the selector properly, rather than
 *    calling a shared label value a reference);
 *  - `managedFields`, `ownerReferences` and the apiserver's identity bookkeeping
 *    are runtime metadata — `ownerReferences` in particular is containment the
 *    runtime tier already draws from `runtimeOwner`.
 * Keys starting with `_` are behold's own injected attrs (`_status`,
 * `_unobserved`, …), never the project's declarations. */
const SKIP_KEYS = new Set([
  "status",
  "annotations",
  "labels",
  "matchLabels",
  "managedFields",
  "ownerReferences",
  "creationTimestamp",
  "resourceVersion",
  "uid",
  "selfLink",
  "generation",
  "finalizers",
]);

/** Every string leaf under `attrs`, with the dotted path it was found at (array
 * indices elided — `containers[2].env[0].value` reads `containers.env.value`,
 * which is what an edge label wants) and its own leaf key. Bounded by
 * `MAX_DEPTH`, `SKIP_KEYS` and a seen-set, so a self-referential attr bag
 * terminates. */
export function stringLeaves(attrs: Record<string, unknown> | undefined): { path: string; key: string; value: string }[] {
  const out: { path: string; key: string; value: string }[] = [];
  // Cycle guard on the CURRENT path, not a global seen-set: an attr bag built
  // in memory (behold's own fixtures, a lexicon reusing one literal) shares
  // sibling objects legitimately, and a global set would silently drop the
  // second sighting.
  const onPath = new Set<object>();
  const step = (v: unknown, key: string, path: string, depth: number): void => {
    if (typeof v === "string") {
      out.push({ path, key, value: v });
      return;
    }
    if (depth >= MAX_DEPTH || !v || typeof v !== "object") return;
    if (onPath.has(v)) return;
    onPath.add(v);
    if (Array.isArray(v)) {
      // An array element sits at its array's path — the index is noise in a label.
      for (const item of v) step(item, key, path, depth + 1);
    } else {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k.startsWith("_") || SKIP_KEYS.has(k)) continue;
        step(val, k, path ? `${path}.${k}` : k, depth + 1);
      }
    }
    onPath.delete(v);
  };
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k.startsWith("_") || SKIP_KEYS.has(k)) continue;
    step(v, k, k, 0);
  }
  return out;
}

