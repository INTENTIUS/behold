/**
 * Project autodetection (#17). behold reads the served project so the SPA can
 * offer pickers — chiefly the environment.
 *
 * Authoritative path: import the project's `chant.config.ts` and read the real
 * config object (behold runs under tsx, so `.ts` transpiles). That handles every
 * shape — `export default { … }`, `defineConfig(…)`, `satisfies ChantConfig`,
 * values built from constants. If the import can't run (odd deps, side effects),
 * fall back to a text parse of the literal fields it can (the two string arrays,
 * plus `sourceDir` — see below), then to empty (the SPA shows just `(source)`).
 *
 * `sourceDir`/`stacks` (#71): also read here, alongside `environments`/
 * `lexicons`, so `chant.ts`'s `graphPath()` can honor the project's declared
 * infra source dir instead of guessing a literal `src/` convention.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A `chant.config.ts` `stacks[]` entry: a multi-stack project's independently-
 * deployed CloudFormation stack, built from its own source directory. */
export interface StackInfo {
  /** The deployed CloudFormation stack name. */
  name: string;
  /** Source directory for this stack, relative to the project root. */
  src: string;
}

export interface ProjectInfo {
  /** Declared environments (drives the env picker → live overlay per env). */
  environments: string[];
  /** Declared lexicons (the substrates in play — shown, no picker yet). */
  lexicons: string[];
  /** `k8s.profiles` — environment → bound kubeconfig context (#106). chant's
   * k8s reader binds `--env <env>` to this and resolves the apiserver from the
   * kubeconfig; behold reads it only to report which cluster that is, never to
   * override it (see src/k8s-target.ts). */
  k8sProfiles?: Record<string, { context?: string }>;
  /** `sourceDir` (#71): the directory (relative to the project root) that holds
   * the chant infra source, honored by `chant.ts`'s `graphPath()` instead of the
   * hardcoded `src/`-then-root guess. Undefined when the config doesn't declare
   * one (chant itself defaults unset `sourceDir` to the project root). */
  sourceDir?: string;
  /** `stacks[]` (#71): a multi-stack project's per-stack source dirs. Only
   * populated when the authoritative config import succeeds — the text-parse
   * fallback doesn't attempt to parse this array of objects (see
   * `parseStringArray`, which only handles flat string arrays). Undefined for a
   * single-stack project. Graph resolution doesn't render every stack yet
   * (#76, follow-up to #71) — `graphPath()` warns rather than silently picking
   * one when this is set. */
  stacks?: StackInfo[];
}

/** The deploy-tier axis a project declares (#70) — a dimension orthogonal to
 * `environment`, entirely the served project's own convention (chant has no
 * native tier concept). `envVar` is the env var name the project's source
 * branches on (loomster: `LOOM_TIER`); `values` are its valid settings
 * (loomster: light/production/production-ha) — the tier picker's options. */
export interface TierConfig {
  envVar: string;
  values: string[];
}

/** behold's own project-root config (`.behold.json`) — distinct from
 * `chant.config.ts` (chant's own concerns): today just the optional tier
 * axis. Absent `tiers` means the project declares none. */
export interface BeholdConfig {
  tiers?: TierConfig;
}

const CONFIG_NAMES = ["chant.config.ts", "chant.config.mts", "chant.config.js", "chant.config.mjs"];
const BEHOLD_CONFIG_NAME = ".behold.json";

function configPath(projectDir: string): string | undefined {
  for (const name of CONFIG_NAMES) {
    const p = join(projectDir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Pull a `stacks[]` array's well-formed `{name, src}` entries, dropping any
 * malformed one rather than throwing — a config typo shouldn't crash graph
 * resolution. */
function readStacks(v: unknown): StackInfo[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const stacks = v.filter(
    (s): s is StackInfo =>
      !!s && typeof s === "object" && typeof (s as StackInfo).name === "string" && typeof (s as StackInfo).src === "string",
  );
  return stacks.length ? stacks : undefined;
}

/** Pull `k8s.profiles` — `{ <env>: { context } }` — keeping only entries with a
 * string context. Absent (not `{}`) when the project declares none, so a caller
 * can tell "no binding declared" from "declared and empty" (#106). */
function readK8sProfiles(k8s: unknown): Record<string, { context?: string }> | undefined {
  const profiles = (k8s as { profiles?: unknown } | undefined)?.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return undefined;
  const out: Record<string, { context?: string }> = {};
  for (const [env, value] of Object.entries(profiles as Record<string, unknown>)) {
    const context = (value as { context?: unknown } | undefined)?.context;
    if (typeof context === "string" && context.length > 0) out[env] = { context };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Pull a config object's `environments`/`lexicons`/`sourceDir`/`stacks`,
 * keeping only well-formed entries (string arrays, a string, `{name,src}[]`). */
function readInfo(cfg: Record<string, unknown> | undefined): ProjectInfo {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // An environments entry is a bare name OR chant's `{ name, endpoint }` form
  // (the emulator binding — see chant's Config File docs). The object form was
  // dropped here, so a project like cc-aws-canonical served with an empty env
  // picker despite declaring `local`.
  const envNames = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .map((x) => (typeof x === "string" ? x : typeof (x as { name?: unknown })?.name === "string" ? (x as { name: string }).name : undefined))
          .filter((x): x is string => !!x)
      : [];
  const stacks = readStacks(cfg?.stacks);
  const k8sProfiles = readK8sProfiles(cfg?.k8s);
  // #191: a pure-k8s project binds its clusters through `k8s.profiles`, not a
  // top-level `environments` array — the profile keys ARE the environment
  // names (the same list `--env` validates against downstream). Inferred only
  // when `environments` is absent/empty, so an explicit list always wins.
  const environments = envNames(cfg?.environments);
  return {
    environments: environments.length ? environments : Object.keys(k8sProfiles ?? {}),
    lexicons: arr(cfg?.lexicons),
    ...(k8sProfiles ? { k8sProfiles } : {}),
    ...(typeof cfg?.sourceDir === "string" ? { sourceDir: cfg.sourceDir } : {}),
    ...(stacks ? { stacks } : {}),
  };
}

/** Extract the string literals from a `key: [ "a", "b" ]` array in config source.
 * Only matches a literal array — a computed value yields []. Pure. */
function parseStringArray(content: string, key: string): string[] {
  const arr = content.match(new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!arr) return [];
  return [...arr[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** Extract environment NAMES from a literal `environments: [...]` array in
 * config source — entries are bare strings or chant's `{ name, endpoint }`
 * objects, and the generic string scan would happily return an endpoint URL as
 * an environment. Pure. */
function parseEnvironmentNames(content: string): string[] {
  const arr = content.match(/\benvironments\s*:\s*\[([^\]]*)\]/);
  if (!arr) return [];
  const body = arr[1];
  if (body.includes("{")) {
    return [...body.matchAll(/\bname\s*:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  }
  return [...body.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** #191: environment names from a literal `k8s: { profiles: { <env>: {…} } }`
 * block in config source — the text-parse counterpart of `readInfo`'s
 * profile-key inference, for a config that can't be imported (a `satisfies
 * ChantConfig` on a project whose deps aren't installed is the common case).
 * Brace-balanced scan of the profiles object; the keys at its top level are
 * the env names. Pure. */
function parseK8sProfileNames(content: string): string[] {
  const m = content.match(/\bprofiles\s*:\s*\{/);
  if (!m || m.index === undefined) return [];
  const start = m.index + m[0].length;
  let depth = 1;
  let end = start;
  for (; end < content.length && depth > 0; end++) {
    if (content[end] === "{") depth++;
    else if (content[end] === "}") depth--;
  }
  const body = content.slice(start, end - 1);
  const names: string[] = [];
  let d = 0;
  let segment = "";
  for (const ch of body) {
    if (ch === "{") {
      if (d === 0) {
        const key = segment.match(/(["'`]?)([\w.-]+)\1\s*:\s*$/);
        if (key) names.push(key[2]);
        segment = "";
      }
      d++;
    } else if (ch === "}") {
      d--;
    } else if (d === 0) {
      segment += ch;
    }
  }
  return names;
}

/** Extract a `key: "value"` string literal from config source. Only matches a
 * literal string — a computed value (e.g. `process.env.X`) yields undefined.
 * Pure. Used for `sourceDir` (#71) in the text-parse fallback; `stacks[]` (an
 * array of objects, not strings) isn't attempted here — see `ProjectInfo`. */
function parseStringLiteral(content: string, key: string): string | undefined {
  const m = content.match(new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
  return m?.[1];
}

/** Detect what the project offers. Async: it may import the project's config. */
export async function detectProject(projectDir: string): Promise<ProjectInfo> {
  const path = configPath(projectDir);
  if (!path) return { environments: [], lexicons: [] };

  // Authoritative: run the real config.
  try {
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    const cfg = (mod.default ?? mod.config ?? mod) as Record<string, unknown>;
    const info = readInfo(cfg);
    if (info.environments.length || info.lexicons.length || info.sourceDir || info.stacks?.length) return info;
  } catch {
    // Import wouldn't run — fall through to a text parse.
  }

  const content = readFileSync(path, "utf8");
  const sourceDir = parseStringLiteral(content, "sourceDir");
  // #191: same inference as readInfo — profile keys stand in for an
  // absent/empty environments array.
  const environments = parseEnvironmentNames(content);
  return {
    environments: environments.length ? environments : parseK8sProfileNames(content),
    lexicons: parseStringArray(content, "lexicons"),
    ...(sourceDir ? { sourceDir } : {}),
  };
}

/** Validate a parsed `.behold.json`'s `tiers` block, keeping only a
 * well-formed one — a non-empty `envVar` string alongside a non-empty array
 * of string `values`. Anything else (missing, wrong shape, empty values)
 * degrades to "no tiers", the same as an absent file. Pure. */
function readTiers(cfg: Record<string, unknown> | undefined): TierConfig | undefined {
  const tiers = cfg?.tiers as Record<string, unknown> | undefined;
  if (!tiers || typeof tiers.envVar !== "string" || !tiers.envVar) return undefined;
  const values = Array.isArray(tiers.values) ? tiers.values.filter((v): v is string => typeof v === "string") : [];
  if (!values.length) return undefined;
  return { envVar: tiers.envVar, values };
}

/** Read `.behold.json` from the project root — behold's own config (#70),
 * kept separate from `chant.config.ts` so behold's concerns (like the tier
 * picker) don't leak into chant's. No file, unparseable JSON, or a malformed/
 * absent `tiers` key all degrade to `{}` (no tier axis) rather than throwing —
 * a project that doesn't opt in just doesn't get the picker. Sync: it's a
 * plain JSON read, no code to run (unlike `detectProject`'s `chant.config.ts`
 * import). Shape:
 * ```json
 * { "tiers": { "envVar": "LOOM_TIER", "values": ["light", "production", "production-ha"] } }
 * ```
 */
export function loadBeholdConfig(projectDir: string): BeholdConfig {
  const path = join(projectDir, BEHOLD_CONFIG_NAME);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const tiers = readTiers(raw);
    return tiers ? { tiers } : {};
  } catch {
    return {};
  }
}
