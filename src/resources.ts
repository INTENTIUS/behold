/**
 * Component <- resource correlation (#59 unify). Extracted from server.ts's
 * `/api/resources` handler so M2's reconcile summary (src/reconcile.ts) can
 * reuse the exact same join instead of re-deriving it — one correlation, two
 * consumers.
 *
 * What this DOES do: the entity graph (source, or `chant graph --live
 * --overlay`) carries each resource's declaring file in `sourceLoc.file`
 * (e.g. "src/loom-agents/agents.ts"). loomster follows a one-directory-per-
 * component convention — the same one `chant.ts`'s `graphPath()` already
 * leans on ("prefer a src/ subdir") — so grouping resources by their
 * top-level `src/<dir>/` segment recovers exactly the per-component resource
 * set, with no AWS shell-out and no stack-name reconstruction.
 *
 * What this does NOT do: return the literal CFN stack (name/ARN/status) or
 * claim any live-truth; see docs/roadmap/m1-cli-notes.md Q2/Q3 and
 * src/server.ts's `/api/resources` comment for the fuller writeup of why
 * (chant's `groups.byStack` is a lexicon partition, not a per-stack grouping
 * — a pre-existing chant gap, not this module's; the *other* gap that
 * comment used to document, `describeResources` assuming one stack named
 * after the env on a multi-stack project, was fixed in chant 0.18.31
 * alongside #821 — physicalId/ownership are live today).
 */
import type { GraphIR } from "@intentius/chant";

export interface ComponentResource {
  id: string;
  kind: string;
  lexicon: string;
  physicalId?: string;
  ownership?: string;
}

/** Group an entity-graph IR's nodes by component, via the `src/<component>/`
 * source-location convention. A node whose `sourceLoc.file` isn't nested
 * under a top-level `src/<dir>/` (no file, or a bare `src/<file>` with no
 * subdir) is skipped — a convention match, not a chant-native fact. Pure. */
export function resourcesByComponent(ir: GraphIR): Record<string, ComponentResource[]> {
  const byComponent: Record<string, ComponentResource[]> = {};
  for (const n of ir.nodes) {
    const file = n.sourceLoc?.file;
    const parts = file?.split("/") ?? [];
    // "src/<component>/<rest>" — needs a nested file, so a component's own
    // top-level declaration file (e.g. "src/loom-agents.ts", no subdir)
    // wouldn't match; loomster nests every component under its own dir.
    if (parts[0] !== "src" || parts.length < 3) continue;
    const component = parts[1];
    (byComponent[component] ??= []).push({
      id: n.id,
      kind: n.kind,
      lexicon: n.lexicon,
      physicalId: n.physicalId,
      ownership: n.ownership,
    });
  }
  return byComponent;
}
