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
 *
 * `action: "unobserved"` (chant#1168, #1089) is its own third category,
 * alongside pending and in-sync (`noop`): chant couldn't read the entity's
 * live state, so it's neither a proposed change nor confirmed in sync.
 * Counted separately (`unobserved`/`unobservedByComponent`/
 * `unobservedUncorrelated`) and excluded from `total`/`byComponent`/
 * `uncorrelated` — counting it as pending would inflate "N pending" with
 * holes chant never looked at; folding it into `noop` would make an unread
 * entity look confirmed in sync, the exact bug #1089 removed. A plan from a
 * chant that predates #1168 never has this action, so `unobserved` is always
 * `0` for one — fully backward compatible.
 *
 * `action: "runtime"` (chant#1180, #1077) gets the identical treatment, as
 * its OWN fourth category: a live, undeclared resource whose owner-reference
 * chain reaches a declared entity (a Pod its Deployment's controller
 * created) is neither a pending change (it's not drift — deleting it just
 * gets it recreated) nor confirmed in sync (`noop` means declared+live+no
 * drift, and a runtime child is never declared). Counted separately
 * (`runtime`/`runtimeByComponent`/`runtimeUncorrelated`), excluded from
 * `total`/`byComponent`/`uncorrelated` for the same reason `unobserved` is.
 * `0` for a plan from a chant predating #1180.
 */
import type { LifecyclePlan } from "./chant.ts";
import type { ComponentResource } from "./resources.ts";

export interface ReconcileSummary {
  env: string;
  /** Non-`noop`, non-`unobserved` entries only — "pending changes" excludes
   * entities already in sync (declared, live, no drift) AND entities chant
   * couldn't read (see `unobserved` below). */
  total: number;
  /** Pending-change count per component, by the source-location correlation. */
  byComponent: Record<string, number>;
  /** Pending entries that couldn't be mapped to a component. */
  uncorrelated: number;
  /** Declared entities chant could not read live state for (chant#1168,
   * #1089) — its own category, never counted in `total`. `0` for a plan from
   * a chant that predates this action. */
  unobserved: number;
  /** Unobserved count per component, same source-location correlation as `byComponent`. */
  unobservedByComponent: Record<string, number>;
  /** Unobserved entries that couldn't be mapped to a component. */
  unobservedUncorrelated: number;
  /** Live, undeclared resources whose owner-reference chain reaches a
   * declared entity (chant#1180, #1077) — expected runtime, never counted in
   * `total`. `0` for a plan from a chant that predates this action. */
  runtime: number;
  /** Runtime-child count per component, same source-location correlation as `byComponent`. */
  runtimeByComponent: Record<string, number>;
  /** Runtime-child entries that couldn't be mapped to a component (the common
   * case — a Pod has no `src/<component>/` source location at all). */
  runtimeUncorrelated: number;
}

/** Summarize a plan's pending (non-noop) entries per component. Pure.
 *
 * `nonResource`, when given, is the set of entity names that are stack
 * interface, not deployable resources — CloudFormation Parameters (see
 * resources.ts `nonResourceEntities`). loomster resolves those via seeded
 * outputs at build time, so they're never live and the plan reports them as
 * perpetual `create`; skipping them keeps the reconcile a count of real
 * resource changes, not cross-stack wiring. */
export function summarizePlan(
  plan: LifecyclePlan,
  byComponent: Record<string, ComponentResource[]>,
  nonResource?: Set<string>,
): ReconcileSummary {
  const componentByEntity = new Map<string, string>();
  for (const [component, resources] of Object.entries(byComponent)) {
    for (const r of resources) componentByEntity.set(r.id, component);
  }
  const counts: Record<string, number> = {};
  const unobservedCounts: Record<string, number> = {};
  const runtimeCounts: Record<string, number> = {};
  let uncorrelated = 0;
  let unobservedUncorrelated = 0;
  let runtimeUncorrelated = 0;
  let total = 0;
  let unobserved = 0;
  let runtime = 0;
  for (const entry of plan.entries) {
    if (entry.action === "noop") continue;
    if (nonResource?.has(entry.name)) continue; // cross-stack wiring, not a resource
    const component = componentByEntity.get(entry.name);
    if (entry.action === "unobserved") {
      // Its own category (chant#1168) — not pending, not in-sync. Same
      // per-component correlation as the pending counts, kept in a separate
      // bucket so it never inflates `total`.
      unobserved++;
      if (component) unobservedCounts[component] = (unobservedCounts[component] ?? 0) + 1;
      else unobservedUncorrelated++;
      continue;
    }
    if (entry.action === "runtime") {
      // Its own category too (chant#1180) — expected runtime, never pending,
      // never in-sync. A runtime child almost never has a `src/<component>/`
      // source location (it isn't declared anywhere), so it's typically
      // uncorrelated — that's expected, not a join failure.
      runtime++;
      if (component) runtimeCounts[component] = (runtimeCounts[component] ?? 0) + 1;
      else runtimeUncorrelated++;
      continue;
    }
    total++;
    if (component) counts[component] = (counts[component] ?? 0) + 1;
    else uncorrelated++;
  }
  return {
    env: plan.env,
    total,
    byComponent: counts,
    uncorrelated,
    unobserved,
    unobservedByComponent: unobservedCounts,
    unobservedUncorrelated,
    runtime,
    runtimeByComponent: runtimeCounts,
    runtimeUncorrelated,
  };
}
