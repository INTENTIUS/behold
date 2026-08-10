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
 *
 * ## The GitOps controllers (#226)
 *
 * The regex above is a denylist-shaped heuristic over a status WORD, and for
 * the two controllers whose entire job is convergence that was luck: a Flux
 * `BuildFailed` classified as degraded only because the word contains "fail",
 * and a Kustomization mid-reconcile (`Ready: Unknown`, reason `Progressing`)
 * reached the reader as chant's `PRESENT` sentinel and painted green. Argo's
 * `Application` doesn't write a `Ready` condition at all — it reports
 * `status.health.status` and `status.sync.status` — so an app whose health is
 * `Degraded` could read healthy too.
 *
 * `classifyObservedHealth` puts a kind-aware layer in front of the regex,
 * reading what the controllers actually write (the same contracts chant's
 * `wait-for-ready` readiness registry encodes). Only `K8s::Argo::Application`
 * and the `K8s::Flux::*` kinds take that path; everything else falls through
 * to `classifyHealth` byte for byte, which is the k8s lens's denylist
 * philosophy — a kind we have not read the contract for is not a kind we
 * pretend to know.
 */

export type Health = "healthy" | "progressing" | "degraded" | "unknown";

/**
 * A verdict plus the controller's own words for it (#226).
 *
 * `detail` is the condition `reason` (`BuildFailed`, `UpgradeFailed`), the
 * Argo health/sync pair, or the revisions that disagree — the line that says
 * what to do about the colour. Absent when the verdict came from the regex
 * fallback, which has nothing to add beyond the status string the panel
 * already shows.
 */
export interface HealthVerdict {
  health: Health;
  detail?: string;
}

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

// ── The GitOps controllers (#226) ────────────────────────────────────

/**
 * The observed record a verdict is read from — a structural subset of
 * `ObservedResource` (src/diff.ts), declared locally so this module stays
 * import-free and pure.
 *
 * `attributes` is where the controller's own status reaches us. chant's k8s
 * reader (describe-resources.ts) sends `namespace`/`labels`/`resourceVersion`
 * plus `conditions` — the UNHAPPY ones only, as `Type=Reason: message`
 * (chant#1401) — and collapses the rest to the `status` word. Both are read
 * below. A caller holding the raw `status` subtree (a fixture, a richer chant)
 * can put it under `attributes.status`, or flatten its fields into
 * `attributes` directly; the readers accept either and prefer the structured
 * form, because it carries the True/False/Unknown that the collapsed word
 * loses.
 */
export interface ObservedForHealth {
  type?: string;
  status?: string | null;
  attributes?: Record<string, unknown> | null;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The raw k8s `status` subtree, if the observed record carries one — nested
 * under `attributes.status`, or flattened into `attributes` itself. Only named
 * keys are ever read off the result, so returning `attributes` when there is
 * no nested tree cannot misread chant's own attribute set. */
function statusTree(o: ObservedForHealth): Record<string, unknown> | undefined {
  const attrs = rec(o.attributes);
  if (!attrs) return undefined;
  return rec(attrs.status) ?? attrs;
}

/**
 * Argo `Application` health and sync (argoproj.io/Application), the pair chant's
 * readiness registry overrides `Ready` with — an Application never writes a
 * `Ready` condition, so nothing below this map applies to it.
 *
 * `Missing` and `Suspended` sit with `Progressing` on the pending rung rather
 * than with `Degraded`: neither is the controller reporting a broken workload.
 * A Missing app's resources are not there YET (behold paints declared-but-absent
 * pending everywhere else too), and a Suspended one was told to stop.
 */
const ARGO_HEALTH: Record<string, Health> = {
  Healthy: "healthy",
  Degraded: "degraded",
  Progressing: "progressing",
  Suspended: "progressing",
  Missing: "progressing",
  Unknown: "unknown",
};

/** Argo sync status. `OutOfSync` is drift, not damage: live disagrees with
 * source and nothing is claimed to be broken, which is exactly what behold
 * paints pending (`var(--pending)`, the same colour the drift axis gives a
 * declared-not-yet-converged node). `Health` has no separate drift value and
 * inventing one would fork the palette; `degraded` (red) would overstate a
 * perfectly running app that is one commit behind. */
const ARGO_SYNC: Record<string, Health> = {
  Synced: "healthy",
  OutOfSync: "progressing",
  Unknown: "unknown",
};

function argoVerdict(o: ObservedForHealth): HealthVerdict | undefined {
  if (o.type !== "K8s::Argo::Application") return undefined;
  const tree = statusTree(o);
  let health = str(rec(tree?.health)?.status);
  let sync = str(rec(tree?.sync)?.status);
  if (!health && !sync) {
    // chant collapses the pair into one word (describe-resources'
    // `argoStatusWord`): the unhappy half wins, and `READY` is the happy pair.
    const word = str(o.status);
    if (word === "READY") {
      health = "Healthy";
      sync = "Synced";
    } else if (word && word in ARGO_HEALTH) health = word;
    else if (word && word in ARGO_SYNC) sync = word;
  }
  const verdicts = [health ? ARGO_HEALTH[health] : undefined, sync ? ARGO_SYNC[sync] : undefined].filter(
    (v): v is Health => v !== undefined,
  );
  // A word in neither vocabulary is not an Argo status we can read (`PRESENT`,
  // an Application the controller has not touched) — the fallback keeps it.
  if (verdicts.length === 0) return undefined;
  const detail = [health ? `health=${health}` : undefined, sync ? `sync=${sync}` : undefined].filter(Boolean).join(", ");
  // Worst-first, so a Degraded app stays degraded whatever its sync says and a
  // Healthy-but-OutOfSync one reads as not-converged rather than fine.
  for (const rung of ["degraded", "progressing", "unknown"] as const) {
    if (verdicts.includes(rung)) return { health: rung, detail };
  }
  return { health: "healthy", detail };
}

interface ReadyCondition {
  status: "True" | "False" | "Unknown";
  reason?: string;
}

/** The `reason`s Flux writes on a `Ready` condition it has set to `Unknown` —
 * a reconciliation in flight, not a failure. Used to recover the lost
 * True/False/Unknown when only chant's string form of the condition survives. */
const FLUX_PENDING_REASON = /^(progressing|reconciling)/i;

/** `Ready` off a raw `status.conditions` array of condition OBJECTS. */
function readyFromConditions(tree: Record<string, unknown> | undefined): ReadyCondition | undefined {
  const conditions = tree?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  for (const c of conditions) {
    const cond = rec(c);
    if (!cond || cond.type !== "Ready") continue;
    const status = str(cond.status);
    if (status !== "True" && status !== "False" && status !== "Unknown") continue;
    return { status, reason: str(cond.reason) };
  }
  return undefined;
}

/** `Ready` off chant's string conditions (`Type=Reason: message`, chant#1401).
 * chant sends only conditions that are NOT in their happy state, so a `Ready`
 * entry here is a `Ready` that is not True — and since the string form drops
 * the True/False/Unknown, the reason is what separates a failure from a
 * reconciliation in flight. */
function readyFromChantConditions(o: ObservedForHealth): ReadyCondition | undefined {
  const conditions = rec(o.attributes)?.conditions;
  if (!Array.isArray(conditions)) return undefined;
  for (const c of conditions) {
    if (typeof c !== "string") continue;
    const m = /^Ready(?:=([^:]*))?(?::|$)/.exec(c.trim());
    if (!m) continue;
    const reason = m[1]?.trim() || undefined;
    return { status: reason && FLUX_PENDING_REASON.test(reason) ? "Unknown" : "False", reason };
  }
  return undefined;
}

/** `Ready` off chant's collapsed status word, the last resort. For a
 * conditions-first CRD with no phase and no replica counts — every Flux kind —
 * chant's `statusFromObject` emits `READY`, the False condition's own reason,
 * `NOT-READY` when it gave none, or `PRESENT` when there is no `Ready` at all. */
function readyFromStatusWord(o: ObservedForHealth): ReadyCondition | undefined {
  const word = str(o.status);
  if (!word || word === "PRESENT") return undefined;
  if (word === "READY") return { status: "True" };
  if (word === "NOT-READY") return { status: "False" };
  return { status: FLUX_PENDING_REASON.test(word) ? "Unknown" : "False", reason: word };
}

function describeReady(ready: ReadyCondition): string {
  return `Ready=${ready.status}${ready.reason ? ` (${ready.reason})` : ""}`;
}

/**
 * The half of Flux's convergence test that fits in one node (#226).
 *
 * Flux's own definition of converged compares a Kustomization's
 * `status.lastAppliedRevision` against its SOURCE's
 * `status.artifact.revision`, and that join needs both objects — behold's
 * verdict is computed one observed record at a time, and chant's wire carries
 * no revision on either end today, so the cross-node join stays out of here.
 * What one record CAN say is that the last revision Flux attempted is not the
 * one it has applied: the object is mid-flight even though its `Ready` still
 * reports the older success.
 */
function revisionVerdict(tree: Record<string, unknown> | undefined): HealthVerdict | undefined {
  const applied = str(tree?.lastAppliedRevision);
  const attempted = str(tree?.lastAttemptedRevision);
  if (!applied || !attempted || applied === attempted) return undefined;
  return { health: "progressing", detail: `applied ${applied}, attempted ${attempted}` };
}

/** Any Flux kind — the toolkit is kstatus-conformant across sources,
 * kustomize, helm, image automation and notification, so `Ready` is the one
 * contract they all speak and a prefix is honest where an allowlist would just
 * go stale. */
const FLUX_TYPE_PREFIX = "K8s::Flux::";

function fluxVerdict(o: ObservedForHealth): HealthVerdict | undefined {
  if (!o.type?.startsWith(FLUX_TYPE_PREFIX)) return undefined;
  const tree = statusTree(o);
  const ready = readyFromConditions(tree) ?? readyFromChantConditions(o) ?? readyFromStatusWord(o);
  if (ready?.status === "False") return { health: "degraded", detail: describeReady(ready) };
  if (ready?.status === "Unknown") return { health: "progressing", detail: describeReady(ready) };
  if (ready?.status === "True") return revisionVerdict(tree) ?? { health: "healthy", detail: describeReady(ready) };
  // No `Ready` at all. A Flux object the controller has written a `Reconciling`
  // onto is mid-first-reconcile; one with no conditions whatsoever has not been
  // picked up yet. Neither is healthy, and `PRESENT` — what chant emits for
  // both — classifies as healthy through the fallback, which is #226's
  // green-when-mid-reconcile.
  const conditions = tree?.conditions;
  const reconciling =
    Array.isArray(conditions) &&
    conditions.some((c) => {
      const cond = rec(c);
      return cond?.type === "Reconciling" && cond.status === "True";
    });
  if (reconciling) return { health: "progressing", detail: "Reconciling=True" };
  if (!str(o.status) || o.status === "PRESENT") {
    return { health: "progressing", detail: "no Ready condition yet" };
  }
  return undefined;
}

/**
 * Classify an observed resource into a health verdict (#226).
 *
 * Kind-aware for the two GitOps controllers whose conditions behold has read
 * the contract for, and `classifyHealth` over the status string for everything
 * else — unchanged, including for an Argo/Flux object whose status says
 * nothing either reader recognises. Pure — unit-tested.
 */
export function classifyObservedHealth(observed: ObservedForHealth | null | undefined): HealthVerdict {
  if (!observed) return { health: "unknown" };
  return argoVerdict(observed) ?? fluxVerdict(observed) ?? { health: classifyHealth(observed.status) };
}
