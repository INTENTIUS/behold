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
 * Which Op (if any) auto-sync should trigger for a drift event. Returns null
 * when it's off, an Op is already running, or the project has no matching Op.
 * Pure — unit-tested.
 */
export function pickAutoSyncOp(mode: AutoSyncMode, ops: OpInfo[], running: string | null): OpInfo | null {
  if (mode === "off" || running) return null;
  const kind = mode === "apply" ? "apply" : "reconcile";
  return ops.find((o) => o.kind === kind) ?? null;
}
