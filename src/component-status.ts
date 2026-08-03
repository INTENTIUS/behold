/**
 * M1.1 (#57), palette hardened in M2 (#54) — join live per-component AWS
 * status onto the component-DAG IR. M2 is the "observe" step of the epic's
 * observe→reconcile→apply dial: this IS observe, already live since M1.1.
 *
 * The data comes from `chant components status <env> --live --json`
 * (src/chant.ts `componentStatus`), one row per component keyed by component
 * name — the same join key as `componentGraphIr`'s node ids (M1.0, #56; see
 * docs/roadmap/m1-cli-notes.md Q2). This module is the pure join: no chant
 * call, no I/O, just `ComponentStatusRow[]` + `GraphIR` -> a coloured `GraphIR`.
 *
 * Deliberately single-substrate AWS, not the cross-substrate live overlay —
 * `chant graph --live --overlay` (the source-anchored overlay, chant #821,
 * shipped 0.18.31 — see src/overlay.ts) is a distinct entity-level view the
 * epic keeps separate from this component-level facet. The component DAG
 * stays the spine; status hangs off each node by name.
 */
import type { GraphIR, ComponentStatusRow, ComponentResourceRollup } from "@intentius/chant";

/** The colour behold paints a component node, in pinhole's `_status`
 * vocabulary (neutral/accent/good/warn/selected — src/overlay.ts documents
 * the same enum for the entity overlay). Deliberately a DIFFERENT semantic
 * axis than the entity overlay's managed/foreign/pending: "not deployed"
 * reads as `neutral` (grey) here, not the entity overlay's `accent` (blue,
 * "declared but not yet observed") — the two views intentionally don't share
 * a colour for "nothing there yet", so they don't read as the same claim.
 *
 * M2 (#54, chant 0.18.29) widens this from 3 values to all 4 pinhole paints —
 * see `componentStatusColor` for which raw stack status maps to which. */
export type ComponentStatusColor = "good" | "warn" | "accent" | "neutral";

/**
 * How a component's own resources answered (behold#98, chant#1300).
 *
 * Re-exported from `@intentius/chant` rather than declared structurally. It was
 * a local interface while behold's floor was ^0.32.0 and the field landed in
 * 0.34: on that floor `resources` could never arrive, so the rollup tier of
 * `componentStatusColor` was unreachable and every component fell through to
 * the `live` boolean. AWS hid that (a CloudFormation stack still answered);
 * GCP and Azure, which have no deploy object, are what #98 was for and had
 * nothing to paint from. Raising the floor to ^0.38.0 is what made the field
 * reachable, and the alias now tracks chant's own definition.
 */
export type ResourceRollup = ComponentResourceRollup;

/**
 * Map a `ComponentStatusRow` to a paint colour.
 *
 * M2 (#54): chant 0.18.29 added machine-readable `live` (boolean) and `stack`
 * ({name, status, healthy}, from a lexicon's `describeStackStatus` — AWS: the
 * component's own CFN stack) to the row. This reads those directly instead of
 * the old `detail.startsWith("live")` sniff — the fragile part chant's own
 * doc comment on `ComponentStatusRow` flagged as a heuristic that "should
 * read [`live`] rather than string-matching detail". `reconciliation`/
 * `detail` (M1.1) stay as the last-resort fallback for a row with no live
 * evidence at all (a caller that skipped `--live`; `componentStatus` here
 * always passes it, so real usage shouldn't reach that branch).
 *
 * Priority, richest signal first:
 *
 *  1. `stack` present AND unhealthy (AWS today) — chant's own provider-native
 *     read, and the one thing no rollup can tell you: the deploy operation
 *     itself failed or is still running.
 *     - status ROLLBACK/FAILED                    -> warn   (pinhole paints
 *       `warn` red — see its theme tokens `warnFill`/`warnStroke`/`warnBar` —
 *       not amber, despite the token's name)
 *     - otherwise (e.g. *_IN_PROGRESS, mid-deploy) -> accent (pinhole's blue
 *       "in flux" paint; pinhole has no distinct amber token, and `accent`
 *       already carries the "not-yet-settled" connotation the entity overlay
 *       uses it for). Mid-deploy explains any rollup shape underneath it, so
 *       it outranks the rollup rather than fighting it.
 *  2. The `resources` rollup (behold#98, chant#1300) — how the component's own
 *     resources answered. The substrate-neutral tier, and since behold#100 the
 *     PRESENCE source on every substrate including AWS:
 *     - any `unobserved`                          -> accent (a hole: chant
 *       could not read part of this component, so neither "deployed" nor
 *       "not deployed" is a claim we hold — never good, never neutral)
 *     - every resource present                    -> good
 *     - none present                              -> neutral
 *     - some present, some absent                 -> warn (partly there;
 *       the boolean rounded this up to "live")
 *  3. No rollup (or an empty one), but `live` was reported ->
 *     good when live, neutral when not — the coarse but machine-real
 *     presence signal. A healthy `stack` with no rollup lands here.
 *  4. None of the above — the pre-0.18.29
 *     reconciliation/detail heuristic, kept only as a defensive fallback:
 *     `reconciled` -> good; `unrecorded` -> good iff `detail` starts "live";
 *     `stale`/`drifted` -> warn; `unknown`/default -> neutral.
 *
 * ## Why a HEALTHY stack no longer paints (behold#100)
 *
 * Until #100 a present `stack` decided the colour outright, healthy or not,
 * and returned before the rollup was ever consulted. Since AWS is the only
 * substrate that HAS a stack, that made CloudFormation the status source on
 * the one substrate the rollup was supposed to be verified against — and #98's
 * own stated shape ("keep AWS CFN-stack status as optional enrichment where
 * present") was not what the code did.
 *
 * So the two signals now answer the questions they can actually answer: the
 * rollup answers "how many of this component's resources came back", the stack
 * answers "did the deploy operation go wrong". An unhealthy stack still
 * decides — unchanged from M2, which is why loom-db's
 * `UPDATE_ROLLBACK_COMPLETE` still reads `warn` — and a healthy one now simply
 * declines to overrule what the resources said. A partial or unreadable
 * component is no longer rounded up to green by a stack that only knows its
 * last operation succeeded.
 *
 * ## What this does NOT yet buy on AWS
 *
 * Verified against Floci while closing #100, and worth stating so nobody reads
 * more into the colour than it carries: chant's AWS `describeResources` is the
 * THIN path (`cloudformation describe-stack-resources`), so the rollup counts
 * CloudFormation's own per-resource inventory, not independently observed
 * existence. Terminating a stack's EC2 instance out of band leaves that
 * resource listed `CREATE_COMPLETE`, and the rollup still reports it present.
 *
 * The rollup is therefore finer-grained than the stack, and substrate-neutral,
 * but on AWS it is not yet a live existence check. Making it one is chant's
 * per-type reader registry (chant#1269/#1271) applied to the thin path — the
 * same fix chant#1198 already records as carried for `--owned`. Until then a
 * green AWS component means "CloudFormation lists all ten and the last
 * operation succeeded", which is more than the old paint claimed but less than
 * the word "live" suggests.
 *
 * docs/roadmap/m1-cli-notes.md Q2 has the verified loomster/Floci output this
 * was checked against (pre-0.18.29); loom-db's `UPDATE_ROLLBACK_COMPLETE` /
 * `healthy: false` stack (verified live against the running Floci, M2) is the
 * proof this palette reads it as `warn` (red), not `good`.
 */
export function componentStatusColor(
  row: Pick<ComponentStatusRow, "reconciliation" | "detail" | "live" | "stack" | "resources">,
): ComponentStatusColor {
  // An UNHEALTHY deploy object decides on its own — a failed or in-flight
  // CloudFormation operation is a fact about the component that no count of
  // its resources can express. A HEALTHY one asserts nothing and falls through
  // to the rollup: it reports that the last operation succeeded, not that the
  // resources survived since (see the #100 note above).
  if (row.stack && !row.stack.healthy) {
    if (row.stack.status && /ROLLBACK|FAILED/i.test(row.stack.status)) return "warn";
    return "accent"; // present but not healthy and not a rollback/failure — e.g. *_IN_PROGRESS
  }
  const rollup = row.resources;
  if (rollup && rollup.total > 0) {
    // A hole outranks everything below it. `neutral` would assert the component
    // is not deployed and `good` would assert it is; chant could not read some
    // of its resources, so neither claim is available. `accent` is the paint
    // that already means not-settled.
    if (rollup.unobserved > 0) return "accent";
    if (rollup.present === rollup.total) return "good";
    if (rollup.present === 0) return "neutral";
    // Partly there: something this component owns is gone, which is the case
    // the coarse `live` boolean rounded up to "live".
    return "warn";
  }
  if (row.live !== undefined) return row.live ? "good" : "neutral";
  switch (row.reconciliation) {
    case "reconciled":
      return "good";
    case "unrecorded":
      // Pre-0.18.29 fallback only (see doc comment above) — `detail`'s two
      // "unrecorded" strings (lifecycle/status.ts reconcileStatus) are:
      //   "live[ and chant-owned], but no release record exists — …"   (live)
      //   "no release record and nothing observed live"                (not live)
      // Both contain "live" (the second negates it at the end), so anchor on
      // the start of the string, not mere presence of the word.
      return row.detail.startsWith("live") ? "good" : "neutral";
    case "stale":
    case "drifted":
      return "warn";
    case "unknown":
    default:
      return "neutral";
  }
}

/** The verdict + human-readable reasoning behind a node's `_status` colour —
 * everything the inspect panel needs so the graph never relies on colour
 * alone (#57's accessibility note). M2 (#54) adds the raw `live`/`stack`
 * fields (chant 0.18.29) alongside the M1.1 reconciliation verdict, so the
 * inspect panel can show the actual stack name/status behind the paint, not
 * just the ledger-reconciliation story. */
export interface LiveStatus {
  reconciliation: ComponentStatusRow["reconciliation"];
  detail: string;
  live?: boolean;
  stack?: { name: string; status?: string; healthy?: boolean };
  /** How the component's own resources answered (behold#98). Carried so the
   * inspect panel can say *why* a component is amber — "3 of 4 present, 1
   * could not be read" is the sentence a colour cannot make, and on a
   * substrate with no deploy object it is the only detail available. */
  resources?: ResourceRollup;
}

/**
 * Join `rows` onto `ir`'s nodes by `node.id === row.component`, tagging each
 * matched node with `_status` (the paint colour pinhole reads) and
 * `_liveStatus` (the verdict + detail, read by the SPA's inspect panel; see
 * web/app.js). `_liveStatus` is deliberately an object, not two more scalar
 * attrs: pinhole's default node-card renderer picks up to 2 short scalar
 * attrs (alphabetically) to print directly on the card (`isScalar` in
 * pinhole's src/labels.ts) — flat `_reconciliation`/`_statusDetail` strings
 * would win that slot over the existing `wave` attr and print as a raw,
 * truncated `_reconciliation…:` label. An object attr is skipped by
 * `isScalar`, so the card stays as M1.0 left it; the full detail still
 * surfaces on click, which is where free-form text belongs anyway.
 * A component with no matching row is left untouched (no colour) rather than
 * guessing at a status chant didn't report. Pure — returns a new IR; `ir` is
 * not mutated (nodes shallow-copied).
 */
export function joinComponentStatus(ir: GraphIR, rows: ComponentStatusRow[]): GraphIR {
  const byComponent = new Map(rows.map((r) => [r.component, r]));
  return {
    ...ir,
    nodes: ir.nodes.map((n) => {
      const row = byComponent.get(n.id);
      if (!row) return n;
      return {
        ...n,
        attrs: {
          ...n.attrs,
          _status: componentStatusColor(row),
          _liveStatus: {
            reconciliation: row.reconciliation,
            detail: row.detail,
            ...(row.live !== undefined ? { live: row.live } : {}),
            ...(row.stack ? { stack: row.stack } : {}),
            ...(row.resources ? { resources: row.resources } : {}),
          } satisfies LiveStatus,
        },
      };
    }),
  };
}
