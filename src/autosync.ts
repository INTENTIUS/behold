/**
 * Auto-sync (#29) — the opt-in self-heal loop. When `--poll` detects the estate
 * moved and auto-sync is on, behold triggers the project's committed Op:
 *   - `apply`        → the ApplyOp (heal the cloud toward source)
 *   - `pull-request` → the ReconcileOp (adopt the cloud into source via a PR)
 * Off by default. Delegated + gated as ever: behold triggers a committed Op on
 * the executor; a gated (destructive) apply still pauses for Approve — auto-sync
 * never approves. This module is the pure decision; the loop lives in the server.
 */
import type { OpInfo } from "./ops.ts";

export type AutoSyncMode = "off" | "apply" | "pull-request";

export const AUTO_SYNC_MODES: AutoSyncMode[] = ["off", "apply", "pull-request"];

export function isAutoSyncMode(v: string): v is AutoSyncMode {
  return (AUTO_SYNC_MODES as string[]).includes(v);
}

/**
 * Which substrates a `pull-request` loop must not reconcile while a rollback is
 * open (#117, design question 3).
 *
 * Rollback is a source change, so it looks like ordinary drift. In `apply` mode
 * that is fine and in fact intended — healing the cloud toward newly-rolled-back
 * source is the completion of a rollback, and chant's own rollback PR body says
 * to merge then apply. The danger runs the other way: a `pull-request` loop
 * opens a ReconcileOp PR adopting live into source, re-introducing exactly what
 * the rollback removed, and if both merge the two fight.
 *
 * **This suspends every moved substrate, not a subset.** The design anticipates
 * narrowing by the rolled-back `sourceDir`, but behold's rollback
 * (`/api/rollback` -> `chant lifecycle rollback <env> --to <ref>`) takes no
 * directory scope, so the rollback it triggers is whole-project and genuinely
 * does touch every substrate. Narrowing would be inventing a distinction the
 * command does not make. If rollback gains a scope, this is where it narrows —
 * the signature already takes the moved set.
 *
 * Pure — unit-tested.
 */
export function suspendedByRollback(rollbackBranches: string[], movedLexicons: string[]): Set<string> {
  return rollbackBranches.length ? new Set(movedLexicons) : new Set();
}

/** An Op auto-sync will trigger, and the moved substrates it answers for. */
export interface AutoSyncPick {
  op: OpInfo;
  /** Sorted. More than one when a single unscoped Op covers the whole estate. */
  lexicons: string[];
}

/** A moved substrate auto-sync refused to route, and why — surfaced to the
 * now-line so a declining loop is visible rather than silent. */
export interface AutoSyncDecline {
  lexicon: string;
  reason: string;
}

export interface AutoSyncRouting {
  picks: AutoSyncPick[];
  declined: AutoSyncDecline[];
}

/**
 * Route a drift event to the Op that owns each substrate that moved (#117).
 *
 * ## What this replaces
 *
 * `pickAutoSyncOp` was `ops.find((o) => o.kind === kind)` — the first Op of the
 * right kind in `localeCompare` order by name, for an event that carried no
 * substrate at all. On a mixed estate whose halves are applied by different Ops
 * (a `cloudformation` ApplyOp for the cloud half, a `kubectl` one for the k8s
 * half) that healed whichever sorted first. Drift in the k8s half could trigger
 * the AWS apply, silently, because the Op ran and succeeded without touching
 * what actually drifted.
 *
 * ## Matching
 *
 * Per moved substrate, against Ops of the mode's kind:
 *
 *  1. Ops whose declared `substrate` IS that substrate. Exactly one wins.
 *  2. Failing that, Ops that declare no substrate at all. Exactly one wins, and
 *     covers every substrate that reached this step — that is the single-Op
 *     project, and it must keep behaving as it always has.
 *  3. Anything else declines.
 *
 * Step 2 is not a loophole, it is the common case. chant's `ReconcileOp` takes
 * no `target` — it reads the estate and opens a PR, so there is no transport to
 * declare — which means EVERY reconcile Op is unscoped. Requiring a declared
 * substrate would have disabled `pull-request` mode on every project in
 * existence. The design (docs/design/per-substrate-autosync.md, question 2)
 * reads an undeclared target as the ambiguity case; that holds when several Ops
 * compete, and this narrows it to that, because one unscoped Op is not ambiguous
 * about anything.
 *
 * ## Declining
 *
 * Ambiguity does not guess — the same discipline as `soleManagedCluster` (#103)
 * and `addValueMatchEdges`. Several Ops matching one substrate, or none, and
 * auto-sync stops and says which. A self-heal loop that guesses which half of an
 * estate to rewrite is worse than one that stops.
 *
 * `suspended` carries the rollback interlock: substrates with an open rollback
 * PR, which `pull-request` mode must not reconcile (it would re-adopt exactly
 * what the rollback removed). `apply` mode is unaffected — healing toward
 * newly-rolled-back source IS the intended completion of a rollback.
 *
 * Returns empty when off or when an Op is already running; neither is a decision
 * about routing, so neither reports a decline. Pure — unit-tested.
 */
export function pickAutoSyncOps(
  mode: AutoSyncMode,
  ops: OpInfo[],
  running: string | null,
  movedLexicons: string[],
  suspended: ReadonlySet<string> = new Set(),
): AutoSyncRouting {
  if (mode === "off" || running) return { picks: [], declined: [] };
  const kind = mode === "apply" ? "apply" : "reconcile";
  const candidates = ops.filter((o) => o.kind === kind);

  const declined: AutoSyncDecline[] = [];
  // Keyed by Op name so one unscoped Op answering for two substrates is one
  // trigger carrying both, not the same Op twice.
  const byOp = new Map<string, AutoSyncPick>();

  for (const lexicon of [...movedLexicons].sort()) {
    if (mode === "pull-request" && suspended.has(lexicon)) {
      declined.push({ lexicon, reason: "a rollback is open for this substrate" });
      continue;
    }
    const exact = candidates.filter((o) => o.substrate === lexicon);
    const pool = exact.length ? exact : candidates.filter((o) => !o.substrate);
    if (pool.length === 0) {
      declined.push({ lexicon, reason: `no ${kind} Op declares this substrate` });
      continue;
    }
    if (pool.length > 1) {
      const names = pool.map((o) => o.name).join(", ");
      declined.push({ lexicon, reason: `${pool.length} ${kind} Ops match (${names})` });
      continue;
    }
    const op = pool[0];
    const pick = byOp.get(op.name);
    if (pick) pick.lexicons.push(lexicon);
    else byOp.set(op.name, { op, lexicons: [lexicon] });
  }

  return { picks: [...byOp.values()], declined };
}
