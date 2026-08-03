/**
 * Resource health (#26) — a signal distinct from drift. Drift (managed/foreign/
 * pending) answers "does live match source?"; health answers "is the live
 * resource actually well?". A resource can be managed (synced) yet Degraded
 * (a CloudFormation ROLLBACK_COMPLETE, a k8s CrashLoopBackOff).
 *
 * chant's observed `status` string (#862) is the source — behold classifies it
 * into an Argo-style verdict. Heuristic, and meant to be substrate-agnostic:
 * it matches common status tokens across CloudFormation, Config Connector, ARM
 * and Kubernetes. `unknown` when a status doesn't map (never fabricated).
 *
 * ## Substrate audit (#104)
 *
 * The "substrate-agnostic" claim held for CloudFormation, whose statuses are
 * verbose and unambiguous (`CREATE_COMPLETE`, `UPDATE_ROLLBACK_COMPLETE`), and
 * failed on both non-AWS readers. Checked against the strings chant's own
 * plugins actually emit — gcp `statusFromCC` (Config Connector conditions) and
 * azure's ARM `provisioningState` — rather than against what they might emit:
 *
 * | status | reader | was | is |
 * |---|---|---|---|
 * | `NOT_READY`    | gcp, Ready condition present and False, no reason | healthy | degraded |
 * | `Ready=False`  | gcp, condition list fallback                      | healthy | degraded |
 * | `Synced=False` | gcp, condition list fallback                      | healthy | degraded |
 * | `PRESENT`      | gcp AND azure, "read it back, nothing richer"     | unknown | healthy |
 * | `Canceled`     | azure, a terminal ARM state                       | unknown | degraded |
 * | `Accepted`     | azure, an in-flight ARM state                     | unknown | progressing |
 *
 * The first three are the serious ones and they share a cause: the positive
 * token is a SUBSTRING of its own negation, so `NOT_READY` matched `ready` and
 * a broken resource painted green. Config Connector states everything as a
 * `Type=Status` pair, so this affects every GCP resource that is not well —
 * exactly the case the panel exists to surface. Negation is now detected and
 * neutralized before any positive match runs.
 *
 * `PRESENT` is the sentinel BOTH non-AWS readers emit for a resource they read
 * back successfully but which carries no richer status. Reading that as
 * `unknown` meant a perfectly healthy Azure resource type with no
 * `provisioningState` — most of them — never showed a verdict at all.
 */

export type Health = "healthy" | "progressing" | "degraded" | "unknown";

// Order matters: a failing terminal state ("ROLLBACK_COMPLETE") contains
// "complete", so degraded/progressing are tested before healthy.
//
// `cancel` — ARM's `Canceled`, a terminal failure state.
// `unschedulable` — a Pod the scheduler cannot place (chant#1397 surfaces it;
// before that a Pod stuck this way reported the bare phase `Pending`).
const DEGRADED = /fail|error|rollback|crash|backoff|degraded|unhealthy|terminat|delete|denied|timeout|evicted|imagepull|cancel|unschedulable/i;
// `accepted` — ARM has taken the request and is working on it.
const PROGRESSING = /in[_-]?progress|pending|creating|updating|provisioning|initializ|deploying|scaling|waiting|containercreating|accepted/i;
// `present` — gcp/azure's "read back, exists, no richer status" sentinel.
const HEALTHY = /complete|running|active|ready|available|succeed|healthy|\bok\b|bound|synced|current|present/i;

/**
 * Neutralize explicitly negated status tokens so they cannot match a positive
 * pattern, and report whether any were found.
 *
 * Two forms, both real: `NOT_READY` / `not-ready` (Config Connector's missing
 * `Ready` reason), and `Ready=False` / `Synced=False` (its `Type=Status` pair
 * listing). The negated word is removed outright rather than rewritten,
 * because what matters downstream is only that it must not count as positive
 * evidence.
 */
export function neutralizeNegations(lower: string): { text: string; negated: boolean } {
  let negated = false;
  const mark = () => {
    negated = true;
    return " ";
  };
  const text = lower.replace(/\bnot[_\-\s]?[a-z]+\b/g, mark).replace(/\b[a-z]+\s*[=:]\s*false\b/g, mark);
  return { text, negated };
}

/** Classify a provider status string into a health verdict. Pure — unit-tested. */
export function classifyHealth(status: string | undefined | null): Health {
  if (!status) return "unknown";
  const { text, negated } = neutralizeNegations(status.toLowerCase());
  if (DEGRADED.test(text)) return "degraded";
  if (PROGRESSING.test(text)) return "progressing";
  // An explicit negation with nothing else to go on is still a real answer:
  // the resource told us it is not ready. `unknown` would understate that, and
  // falling through to HEALTHY on whatever positive token survived the strip
  // (`Ready=False,Synced=True`) is what this fixes.
  if (negated) return "degraded";
  if (HEALTHY.test(text)) return "healthy";
  return "unknown";
}
