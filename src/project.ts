/**
 * Project autodetection (#17). behold reads the served project so the SPA can
 * offer pickers — chiefly the environment.
 *
 * Authoritative path: import the project's `chant.config.ts` and read the real
 * config object (behold runs under tsx, so `.ts` transpiles). That handles every
 * shape — `export default { … }`, `defineConfig(…)`, `satisfies ChantConfig`,
 * values built from constants. If the import can't run (odd deps, side effects),
 * fall back to a text parse of the two literal arrays, then to empty (the SPA
 * shows just `(source)`).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ProjectInfo {
  /** Declared environments (drives the env picker → live overlay per env). */
  environments: string[];
  /** Declared lexicons (the substrates in play — shown, no picker yet). */
  lexicons: string[];
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

/** Pull a config object's `environments`/`lexicons`, keeping only string entries. */
function readInfo(cfg: Record<string, unknown> | undefined): ProjectInfo {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { environments: arr(cfg?.environments), lexicons: arr(cfg?.lexicons) };
}

/** Extract the string literals from a `key: [ "a", "b" ]` array in config source.
 * Only matches a literal array — a computed value yields []. Pure. */
function parseStringArray(content: string, key: string): string[] {
  const arr = content.match(new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!arr) return [];
  return [...arr[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
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
    if (info.environments.length || info.lexicons.length) return info;
  } catch {
    // Import wouldn't run — fall through to a text parse.
  }

  const content = readFileSync(path, "utf8");
  return {
    environments: parseStringArray(content, "environments"),
    lexicons: parseStringArray(content, "lexicons"),
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
