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
import type { GraphIR, ComponentStatusRow } from "@intentius/chant";

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
 *  1. `stack` present (AWS today) — chant's own provider-native read:
 *     - `stack.healthy`                          -> good    (e.g. CREATE_COMPLETE)
 *     - present, unhealthy, status ROLLBACK/FAILED -> warn   (pinhole paints
 *       `warn` red — see its theme tokens `warnFill`/`warnStroke`/`warnBar` —
 *       not amber, despite the token's name)
 *     - present, unhealthy, otherwise (e.g. *_IN_PROGRESS, mid-deploy)
 *                                                  -> accent (pinhole's blue
 *       "in flux" paint; pinhole has no distinct amber token, and `accent`
 *       already carries the "not-yet-settled" connotation the entity overlay
 *       uses it for)
 *  2. No `stack`, but `live` was reported (a lexicon with no
 *     `describeStackStatus`, or the component resolved to no stack) ->
 *     good when live, neutral when not — the coarse but now-machine-real
 *     presence signal.
 *  3. Neither `live` nor `stack` present at all — the pre-0.18.29
 *     reconciliation/detail heuristic, kept only as a defensive fallback:
 *     `reconciled` -> good; `unrecorded` -> good iff `detail` starts "live";
 *     `stale`/`drifted` -> warn; `unknown`/default -> neutral.
 *
 * docs/roadmap/m1-cli-notes.md Q2 has the verified loomster/Floci output this
 * was checked against (pre-0.18.29); loom-db's `UPDATE_ROLLBACK_COMPLETE` /
 * `healthy: false` stack (verified live against the running Floci, M2) is the
 * proof this palette reads it as `warn` (red), not `good`.
 */
export function componentStatusColor(
  row: Pick<ComponentStatusRow, "reconciliation" | "detail" | "live" | "stack">,
): ComponentStatusColor {
  if (row.stack) {
    if (row.stack.healthy) return "good";
    if (row.stack.status && /ROLLBACK|FAILED/i.test(row.stack.status)) return "warn";
    return "accent"; // present but not healthy and not a rollback/failure — e.g. *_IN_PROGRESS
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
          } satisfies LiveStatus,
        },
      };
    }),
  };
}
