/**
 * A terragucci repo is applied by its pipeline and by nothing else (#489).
 * terragucci plans on a pull request, applies wave by wave behind gates whose
 * approvals are signed git records bound to a plan digest, and keeps its
 * reports in a bucket. A deploy from behold would be an apply with no plan
 * digest, no wave and no approval record, run with whatever credentials the
 * laptop holds, so on such a repo every behold write that deploys, approves or
 * starts a run is refused, and the refusal names the pipeline.
 *
 * The repo is recognised by terragucci's own config file (terragucci's
 * `CONFIG_NAMES`) in the served directory or any directory above it up to the
 * git root, so serving `envs/` of a terragucci repo is refused the same way.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** terragucci's config file names, in its own order (terragucci src/config.ts `CONFIG_NAMES`). */
export const TERRAGUCCI_CONFIG_NAMES = ["terragucci.yml", "terragucci.yaml", "terragucci.json", "terragucci.ts"] as const;

/** The terragucci config that governs `dir`, or undefined when no terragucci config sits in it or above it within its git repo. */
export function terragucciConfig(dir: string): string | undefined {
  let at = resolve(dir);
  for (;;) {
    for (const name of TERRAGUCCI_CONFIG_NAMES) {
      const file = join(at, name);
      if (existsSync(file)) return file;
    }
    // The git root is as far as a repo's config can be.
    if (existsSync(join(at, ".git"))) return undefined;
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/** The terragucci config that governs any of the served directories. */
export function servedTerragucciConfig(dirs: readonly string[]): string | undefined {
  for (const d of dirs) {
    const f = terragucciConfig(d);
    if (f) return f;
  }
  return undefined;
}

/** The refusal every write route answers on a terragucci repo: 409, `code: "terragucci"`. */
export function terragucciRefusal(config: string, what: string): { error: string; code: "terragucci"; remedy: string } {
  return {
    error: `${what} is refused: this is a terragucci repo (${config}), and a terragucci repo is applied by its pipeline only — behold never deploys, approves or starts a run here`,
    code: "terragucci",
    remedy:
      "Open a pull request: terragucci plans it, and after the merge applies it wave by wave. Approve a waiting wave at your shell with `npx terragucci approve wave-<k>`.",
  };
}

/**
 * The POST routes that deploy, approve or start a run, by method-less path
 * pattern: every route that spawns a write, not just /api/apply. Reads, the
 * layout sidecar, project switching and the carve walkthrough's scratch steps
 * are not in it.
 */
export const TERRAGUCCI_REFUSED_WRITES: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /^\/api\/apply$/, what: "apply" },
  { pattern: /^\/api\/local\/reset$/, what: "resetting the local emulator (a redeploy)" },
  { pattern: /^\/api\/ops\/[^/]+\/run$/, what: "running an Op" },
  { pattern: /^\/api\/ops\/[^/]+\/signal\/[^/]+$/, what: "signalling an Op's gate" },
  { pattern: /^\/api\/operator\/approve\/[^/]+\/[^/]+$/, what: "approving a gate" },
  { pattern: /^\/api\/workspace\/gates\/approve$/, what: "approving a gate" },
  { pattern: /^\/api\/substrates\/[^/]+\/up$/, what: "bringing up a substrate" },
  { pattern: /^\/api\/ci\/dispatch$/, what: "dispatching a pipeline" },
  { pattern: /^\/api\/ci\/readopt$/, what: "re-adopting a dispatched run" },
  { pattern: /^\/api\/rollback$/, what: "opening a rollback" },
];

/** What a POST to `path` would do, when it is one of TERRAGUCCI_REFUSED_WRITES. */
export function refusedWrite(path: string): string | undefined {
  return TERRAGUCCI_REFUSED_WRITES.find((w) => w.pattern.test(path))?.what;
}
