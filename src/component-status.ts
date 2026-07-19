/**
 * M1.1 (#57) — join live per-component AWS status onto the component-DAG IR.
 *
 * The data comes from `chant components status <env> --live --json`
 * (src/chant.ts `componentStatus`), one row per component keyed by component
 * name — the same join key as `componentGraphIr`'s node ids (M1.0, #56; see
 * docs/roadmap/m1-cli-notes.md Q2). This module is the pure join: no chant
 * call, no I/O, just `ComponentStatusRow[]` + `GraphIR` -> a coloured `GraphIR`.
 *
 * Deliberately single-substrate AWS, not the cross-substrate live overlay —
 * `chant graph --live --overlay` / `sourceAnchoredOverlay` throws (chant
 * #821) and the epic forbids it here. The component DAG stays the spine;
 * status hangs off each node by name.
 */
import type { GraphIR, ComponentStatusRow } from "@intentius/chant";

/** The colour behold paints a component node, in pinhole's `_status`
 * vocabulary (neutral/accent/good/warn/selected — src/overlay.ts documents
 * the same enum for the entity overlay). Deliberately a DIFFERENT semantic
 * axis than the entity overlay's managed/foreign/pending: "not deployed"
 * reads as `neutral` (grey) here, not the entity overlay's `accent` (blue,
 * "declared but not yet observed") — the two views intentionally don't share
 * a colour for "nothing there yet", so they don't read as the same claim. */
export type ComponentStatusColor = "good" | "warn" | "neutral";

/**
 * Map a `ComponentStatusRow` to a paint colour. See chant's `reconcileStatus`
 * (lifecycle/status.ts) for how each verdict is derived, and
 * docs/roadmap/m1-cli-notes.md Q2 for the verified loomster/Floci output this
 * was checked against:
 *
 *  - `reconciled`                        -> good    (recorded + live, consistent)
 *  - `unrecorded`, detail starts "live"   -> good    (deployed outside the release
 *    ledger — still deployed; loomster's 5 infra components publish no image
 *    digest, so they're always unrecorded-but-live, not an error state)
 *  - `unrecorded`, detail doesn't         -> neutral (nothing recorded, nothing
 *    observed — genuinely not deployed)
 *  - `stale`  (recorded, nothing live now)     -> warn (was deployed, now gone)
 *  - `drifted` (recorded, live config changed) -> warn (deployed, but diverged
 *    from the recorded release — a different anomaly than `stale`, painted the
 *    same colour today; the inspect panel's `detail` text disambiguates)
 *  - `unknown` (no live evidence queried)      -> neutral (defensive default —
 *    `componentStatus` always passes `--live`, so a live caller shouldn't see this)
 */
export function componentStatusColor(row: Pick<ComponentStatusRow, "reconciliation" | "detail">): ComponentStatusColor {
  switch (row.reconciliation) {
    case "reconciled":
      return "good";
    case "unrecorded":
      // `ComponentStatusRow` has no machine-readable `live` boolean (chant
      // 0.18.27) — `detail` is the only signal for "unrecorded" splitting
      // into two very different cases. chant's two "unrecorded" detail
      // strings (lifecycle/status.ts reconcileStatus) are:
      //   "live[ and chant-owned], but no release record exists — …"   (live)
      //   "no release record and nothing observed live"                (not live)
      // Both contain the substring "live" (the second one negates it at the
      // end), so the discriminator has to anchor on the start of the string,
      // not just presence of the word. A `live: boolean` field on the row
      // would make this exact instead of textual — worth requesting upstream
      // if this heuristic ever needs to survive a chant wording change.
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
 * alone (#57's accessibility note). */
export interface LiveStatus {
  reconciliation: ComponentStatusRow["reconciliation"];
  detail: string;
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
          _liveStatus: { reconciliation: row.reconciliation, detail: row.detail } satisfies LiveStatus,
        },
      };
    }),
  };
}
