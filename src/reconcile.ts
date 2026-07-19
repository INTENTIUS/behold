/**
 * M2 (#54) — the "reconcile" step of the observe→reconcile→apply dial:
 * summarize `chant lifecycle plan <env> --live --json`'s entity-level change
 * set per component. Pure join, no chant call (src/chant.ts `lifecyclePlan`
 * does the shell-out) — mirrors component-status.ts's shape: `X[] -> a
 * derived view`, no I/O, easy to test against a fixture.
 *
 * Correlation key: a plan entry's `name` is a chant entity name — exactly
 * what `resourcesByComponent`'s (src/resources.ts) per-component resource
 * list keys its `id` on, since both come from the same entity graph IR.
 * That's the SAME source-location correlation #59's `/api/resources` uses
 * (`sourceLoc.file` under `src/<component>/`), reused rather than
 * reconstructed — one correlation, two consumers (see resources.ts).
 *
 * An entry whose name isn't in any component's resource list (a lexicon
 * without the `src/<component>/` convention, or an entity outside every
 * discovered component) is counted separately as `uncorrelated`, never
 * silently dropped or guessed at — the same "don't fabricate a join"
 * discipline `joinComponentStatus` follows for an unmatched node.
 */
import type { LifecyclePlan } from "./chant.ts";
import type { ComponentResource } from "./resources.ts";

export interface ReconcileSummary {
  env: string;
  /** Non-`noop` entries only — "pending changes" excludes entities already
   * in sync (declared, live, no drift). */
  total: number;
  /** Pending-change count per component, by the source-location correlation. */
  byComponent: Record<string, number>;
  /** Pending entries that couldn't be mapped to a component. */
  uncorrelated: number;
}

/** Summarize a plan's pending (non-noop) entries per component. Pure. */
export function summarizePlan(
  plan: LifecyclePlan,
  byComponent: Record<string, ComponentResource[]>,
): ReconcileSummary {
  const componentByEntity = new Map<string, string>();
  for (const [component, resources] of Object.entries(byComponent)) {
    for (const r of resources) componentByEntity.set(r.id, component);
  }
  const counts: Record<string, number> = {};
  let uncorrelated = 0;
  let total = 0;
  for (const entry of plan.entries) {
    if (entry.action === "noop") continue;
    total++;
    const component = componentByEntity.get(entry.name);
    if (component) counts[component] = (counts[component] ?? 0) + 1;
    else uncorrelated++;
  }
  return { env: plan.env, total, byComponent: counts, uncorrelated };
}
