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

/** Entity-graph node kinds that are NOT deployable resources — cross-stack
 * interface wiring, not things you create/update/delete. A CloudFormation
 * Parameter is a stack input (loomster resolves it via seeded outputs at build
 * time, so it never exists as a live resource); a cross-stack import is the same
 * idea. Excluded from the reconcile so they don't read as perpetual "create".
 *
 * `chant:output` is the substrate-neutral half of the same idea and was missing
 * (#104): chant emits one node per declared stack output on EVERY lexicon, not
 * just AWS — the mixed AWS example carries 13 of them next to its 3
 * CloudFormation Parameters. An output is a value the stack publishes, never a
 * resource anyone creates, so it was inflating the reconcile's pending count on
 * every substrate. Listing only the AWS kind made this look AWS-shaped; it is
 * not, which is exactly the sort of assumption this issue asked for. */
const NON_RESOURCE_KINDS = new Set(["AWS::CloudFormation::Parameter", "chant:output"]);

/** Entity names in the IR that are stack interface (Parameters), not resources —
 * for the reconcile to skip so they don't count as pending changes forever. */
export function nonResourceEntities(ir: GraphIR): Set<string> {
  const out = new Set<string>();
  for (const n of ir.nodes) if (NON_RESOURCE_KINDS.has(n.kind)) out.add(n.id);
  return out;
}

/** The directory segment of `sourceLoc.file` that names the component owning a
 * node, or undefined when no segment does.
 *
 * chant emits `sourceLoc.file` relative to the graph root it was handed, and
 * `graphPath()` (src/chant.ts) hands it the project's `sourceDir` — so a
 * component's files arrive as `<component>/<rest>` with no `src/` prefix at
 * all. Both loomster and kubemicrovm-ops declare `sourceDir: "src"` and both
 * emit `loom-db/database.ts` / `aws-plane/plane.ts`. A project graphed from
 * its root instead (the `legacyGraphPath` fallback, no `sourceDir` declared)
 * still carries the prefix, so both shapes have to match.
 *
 * `known` is what disambiguates them: with the real component set in hand,
 * the owning segment is simply the first one that names a component, wherever
 * it sits in the path. That drops `src/examples/`, `src/composites/`,
 * `src/lib/` for free — they name no component — so the phantom-component
 * guard is the same mechanism rather than a second rule.
 *
 * Without `known` there is nothing to match against, so the original
 * `src/<component>/<rest>` convention stands: prefix required, and a nested
 * file required so a bare `src/<file>` is not read as a component. That path
 * is only reachable from tests now — both callers in server.ts pass `known`. */
function componentSegment(parts: string[], known?: Set<string>): string | undefined {
  if (known) {
    // Never the last segment: that is the filename, and a file named after a
    // component is not the component's directory.
    return parts.slice(0, -1).find((p) => known.has(p));
  }
  return parts[0] === "src" && parts.length >= 3 ? parts[1] : undefined;
}

/** Group an entity-graph IR's nodes by component, via the source-location
 * convention: a node belongs to the component whose directory its
 * `sourceLoc.file` sits under. See `componentSegment` for why that directory
 * is matched by name rather than by position.
 *
 * `known`, when given, is the real deployable component set (from `chant graph
 * --components`). A source dir that isn't a real component — `src/examples/`,
 * `src/composites/`, `src/lib/`, `src/local/` — is then NOT treated as one:
 * its nodes are dropped here, so summarizePlan counts them as `uncorrelated`
 * (honest — they belong to no deployable component) rather than inventing a
 * phantom "examples" component with pending changes. Pure. */
export function resourcesByComponent(ir: GraphIR, known?: Set<string>): Record<string, ComponentResource[]> {
  const byComponent: Record<string, ComponentResource[]> = {};
  for (const n of ir.nodes) {
    const parts = n.sourceLoc?.file?.split("/") ?? [];
    const component = componentSegment(parts, known);
    if (!component) continue;
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
