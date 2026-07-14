/**
 * Resource health (#26) — a signal distinct from drift. Drift (managed/foreign/
 * pending) answers "does live match source?"; health answers "is the live
 * resource actually well?". A resource can be managed (synced) yet Degraded
 * (a CloudFormation ROLLBACK_COMPLETE, a k8s CrashLoopBackOff).
 *
 * chant's observed `status` string (#862) is the source — behold classifies it
 * into an Argo-style verdict. Heuristic and substrate-agnostic: it matches common
 * status tokens across CloudFormation, Kubernetes, ARM, etc. `unknown` when a
 * status doesn't map (never fabricated).
 */

export type Health = "healthy" | "progressing" | "degraded" | "unknown";

// Order matters: a failing terminal state ("ROLLBACK_COMPLETE") contains
// "complete", so degraded/progressing are tested before healthy.
const DEGRADED = /fail|error|rollback|crash|backoff|degraded|unhealthy|terminat|delete|denied|timeout|evicted|imagepull/i;
const PROGRESSING = /in[_-]?progress|pending|creating|updating|provisioning|initializ|deploying|scaling|waiting|containercreating/i;
const HEALTHY = /complete|running|active|ready|available|succeed|healthy|\bok\b|bound|synced|current/i;

/** Classify a provider status string into a health verdict. Pure — unit-tested. */
export function classifyHealth(status: string | undefined | null): Health {
  if (!status) return "unknown";
  const s = status.toLowerCase();
  if (DEGRADED.test(s)) return "degraded";
  if (PROGRESSING.test(s)) return "progressing";
  if (HEALTHY.test(s)) return "healthy";
  return "unknown";
}
