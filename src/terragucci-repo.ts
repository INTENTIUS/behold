/**
 * A terragucci repo is applied by its pipeline and by nothing else (#489).
 * terragucci plans on a pull request, applies wave by wave behind gates whose
 * approvals are signed git records bound to a plan digest, and keeps its
 * reports in a bucket. A deploy from behold would be an apply with no plan
 * digest, no wave and no approval record, run with whatever credentials the
 * laptop holds, so on such a repo every behold write is refused, and the
 * refusal names the pipeline. The few writes that stay inside behold (the
 * layout sidecar, project switching, the carve walkthrough's scratch steps)
 * are named in TERRAGUCCI_ALLOWED_WRITES; anything else is refused (#500).
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

/** The refusal every write answers on a terragucci repo: 409, `code: "terragucci"`. */
export function terragucciRefusal(config: string, what: string): { error: string; code: "terragucci"; remedy: string } {
  return {
    error: `${what} is refused: this is a terragucci repo (${config}), and a terragucci repo is applied by its pipeline only — behold never deploys, approves or starts a run here`,
    code: "terragucci",
    remedy:
      "Open a pull request: terragucci plans it, and after the merge applies it wave by wave. Approve a waiting wave at your shell with `npx terragucci approve wave-<k> --plan <digest>`; the digest is on the wave's gate card, and it binds the approval to the plan you looked at.",
  };
}

/** The methods that read. Every other method is a write, and on a terragucci repo a write is refused unless TERRAGUCCI_ALLOWED_WRITES names it (#500). */
export const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The writes a terragucci repo still answers (#500): each writes nothing
 * outside behold, as AGENTS.md's "The exceptions, and their exact size" lists
 * them. Everything else that is not a read is refused, so a route added later
 * is refused until someone puts it here, whatever its method.
 */
export const TERRAGUCCI_ALLOWED_WRITES: readonly { method: string; pattern: RegExp; why: string }[] = [
  { method: "POST", pattern: /^\/api\/layout$/, why: "the layout sidecar, .behold/layout.json" },
  { method: "POST", pattern: /^\/api\/project\/open$/, why: "switching what is served" },
  { method: "POST", pattern: /^\/api\/project\/reveal$/, why: "opening the served directory in the file manager" },
  { method: "POST", pattern: /^\/api\/demos\/open$/, why: "loading a bundled demo into a copy behold makes, and serving it" },
  { method: "POST", pattern: /^\/api\/refresh$/, why: "dropping behold's caches" },
  { method: "POST", pattern: /^\/api\/carve\/emit$/, why: "the carve walkthrough's scratch directory" },
  { method: "POST", pattern: /^\/api\/carve\/bridge$/, why: "the carve walkthrough's scratch directory" },
  { method: "POST", pattern: /^\/api\/carve\/observe$/, why: "the carve walkthrough's read of its scratch emulator" },
  { method: "POST", pattern: /^\/api\/carve\/plan$/, why: "the carve walkthrough's read-only plan" },
];

/** Whether a `method` request to `path` is one of TERRAGUCCI_ALLOWED_WRITES. Reads are not writes and are not in it. */
export function allowedWrite(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return TERRAGUCCI_ALLOWED_WRITES.some((w) => w.method === m && w.pattern.test(path));
}

/**
 * What the known writes do, for the refusal's wording. Not the boundary: a
 * write missing here is refused all the same, as "<METHOD> <path>".
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

/**
 * What a `method` request to `path` is refused as on a terragucci repo, or
 * undefined when it is a read or an allowed write.
 */
export function refusedWrite(method: string, path: string): string | undefined {
  const m = method.toUpperCase();
  if (READ_METHODS.has(m) || allowedWrite(m, path)) return undefined;
  return (m === "POST" ? TERRAGUCCI_REFUSED_WRITES.find((w) => w.pattern.test(path))?.what : undefined) ?? `${m} ${path}`;
}
