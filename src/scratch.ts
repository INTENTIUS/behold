/**
 * Scratch-infra discipline — the one place behold says which infrastructure it
 * may boot or tear down on a developer's machine.
 *
 * behold's demos and e2es bring up throwaway substrates (a Floci container for
 * the carve walkthrough's `--live` tier, k3d clusters for the GitOps e2es). The
 * same machine usually also runs the operator's OWN long-lived substrates — a
 * shared Floci on :4566, the kubemicrovm and fountain k3d clusters — and those
 * are never behold's to touch. The rule, stated once here and asserted in
 * scratch.test.ts across every boot site:
 *
 *   1. Anything behold creates is named `behold-*`. The prefix is the audit
 *      trail: `docker ps` / `k3d cluster list` show at a glance what is ours.
 *   2. Refuse if the name is already taken. A leftover from a crashed run is
 *      reported with the remedy, never adopted and never deleted — behold
 *      only ever deletes what this process created.
 *   3. Tear down on exit, our own name only.
 *   4. Never speak to the conventional Floci port. A scratch Floci gets its
 *      own host port, so a shared one is not written to by accident.
 *
 * `chant emulator up|down` (src/emulator.ts) is outside this module on
 * purpose: those containers are chant's contract (`chant-floci*`), booted and
 * torn down by chant for the project that declared them, and behold only
 * relays the request the user made.
 */

/** Names behold must never create, adopt, delete, or bind. Substrings and
 * anchored patterns — `floci` catches `floci`, `floci-az`, `floci-gcp`;
 * `chant-floci` the emulator containers chant owns. */
export const PROTECTED_INFRA: ReadonlyArray<RegExp> = [
  /^floci(-|$)/,
  /^chant-floci(-|$)/,
  /^k3d-kubemicrovm-local$/,
  /^k3d-fountain-local$/,
  /^kubemicrovm-local$/,
  /^fountain-local$/,
];

/** Host ports behold must never bind for a scratch substrate: the shared
 * Floci (and its Azure/GCP siblings) listen here. */
export const PROTECTED_PORTS: ReadonlyArray<number> = [4566, 4577, 4588];

export const SCRATCH_PREFIX = "behold-";

/** Why a name is not an acceptable scratch name, or undefined if it is. */
export function scratchNameProblem(name: string): string | undefined {
  if (!name.startsWith(SCRATCH_PREFIX)) return `scratch infra must be named ${SCRATCH_PREFIX}*, got ${JSON.stringify(name)}`;
  const hit = PROTECTED_INFRA.find((re) => re.test(name));
  if (hit) return `${JSON.stringify(name)} is protected infrastructure (${hit}) — behold never touches it`;
  return undefined;
}

/** Why a port is not an acceptable scratch port, or undefined if it is. */
export function scratchPortProblem(port: number): string | undefined {
  if (PROTECTED_PORTS.includes(port)) return `port ${port} belongs to a shared emulator — a scratch substrate gets its own`;
  return undefined;
}

/** Throw unless `name` (and `port`, if given) may be booted as scratch. Boot
 * sites call this before the spawn that would create the thing. */
export function assertScratch(name: string, port?: number): void {
  const p = scratchNameProblem(name) ?? (port === undefined ? undefined : scratchPortProblem(port));
  if (p) throw new Error(`scratch discipline: ${p}`);
}
