/**
 * Per-substrate deploy targets (#99).
 *
 * `deployAxes`/`deployTargets` in server.ts read one variable —
 * `AWS_ENDPOINT_URL` — and called it "the target". That is Floci's tell, and it
 * is the only one behold ever knew: an azure or gcp project had no target at
 * all, and a mixed-substrate project had one belonging to whichever substrate
 * happened to own that variable.
 *
 * The key is the **substrate**, not the component. Plenty of chant projects have
 * no components — a plain `sourceDir` project, or a multi-stack one declaring
 * `stacks[]` — so keying on components would serve only some of them. It also
 * matches the seam chant already has: `applyLiveEndpoint(environments,
 * environment, lexicons)` takes a lexicon list.
 *
 * Each entry is the ambient variable that lexicon's read path honours. Azure's
 * arrived with chant#1212 and gcp's with chant#1209 (#125) — the latter's
 * `7f4e985e` moved GCP observation off Config-Connector-over-kubectl onto the
 * applier's own direct-REST transport, which reads `GCP_ENDPOINT_URL` in both
 * `describe-resources.ts` and `deep-observe.ts`.
 *
 * This list withholds a lexicon until chant can actually be pointed, rather than
 * listing one behold cannot route — which is why gcp was absent until #1209
 * landed. The cost of that discipline is that a landed chant change leaves a
 * stale omission here until someone notices; #125 was exactly that, and left
 * behold showing a floci-gcp pill (`detectSubstrates`, :4588) it had no way to
 * aim the read path at.
 */

/** A lexicon and the ambient variable its read path resolves its endpoint from. */
export interface SubstrateTargetVar {
  /** chant lexicon name, as it appears in `chant.config.ts`'s `lexicons`. */
  lexicon: string;
  /** Display name for the picker — the emulator, not the cloud. */
  label: string;
  /** Ambient variable the lexicon's read path honours. */
  envVar: string;
}

/**
 * Mirrors chant's own `LEXICON_ENDPOINT_ENV_VAR` plus what has landed since.
 * Deliberately not every lexicon: k8s and temporal resolve their target from
 * `chant.config` rather than an ambient variable, so there is nothing here for
 * behold to override and nothing to show in a picker.
 */
export const SUBSTRATE_TARGET_VARS: readonly SubstrateTargetVar[] = [
  { lexicon: "aws", label: "Floci", envVar: "AWS_ENDPOINT_URL" },
  { lexicon: "fly", label: "Fly", envVar: "FLY_FLAPS_BASE_URL" },
  { lexicon: "azure", label: "floci-az", envVar: "AZURE_ENDPOINT_URL" },
  { lexicon: "gcp", label: "floci-gcp", envVar: "GCP_ENDPOINT_URL" },
];

/** One substrate's resolved target. */
export interface SubstrateTarget {
  /** Substrate key — the lexicon name, which is what a component inherits through. */
  name: string;
  label: string;
  endpoint: string;
  envVar: string;
}

/**
 * The targets in play for a project, one per substrate that both declares a
 * lexicon and has an endpoint set for it.
 *
 * A substrate with no endpoint is absent rather than present-and-empty: unset
 * means "real cloud", which is a target behold does not name and must not
 * imply it can redirect.
 */
export function resolveSubstrateTargets(
  lexicons: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SubstrateTarget[] {
  const targets: SubstrateTarget[] = [];
  for (const { lexicon, label, envVar } of SUBSTRATE_TARGET_VARS) {
    if (!lexicons.includes(lexicon)) continue;
    const endpoint = env[envVar];
    if (!endpoint) continue;
    targets.push({ name: lexicon, label, endpoint, envVar });
  }
  return targets;
}

/**
 * The environment overrides for a chant shell-out, given a chosen target.
 *
 * `target` stays a single global override rather than becoming a per-substrate
 * picker, which is the least disruptive reading of #99: a project with one
 * substrate behaves exactly as before, and a mixed-substrate project gets each
 * substrate pointed at its own endpoint without the UI having to grow a control
 * per substrate first. Whether the picker should eventually show one entry per
 * substrate is a UX question this deliberately does not settle.
 */
export function targetEnvOverrides(
  targets: readonly SubstrateTarget[],
  chosen?: string,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const t of targets) {
    // An explicit choice overrides every substrate's endpoint, preserving the
    // pre-#99 behaviour of `?target=` for a single-substrate project.
    overrides[t.envVar] = chosen ?? t.endpoint;
  }
  return overrides;
}
