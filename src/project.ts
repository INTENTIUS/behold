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

const CONFIG_NAMES = ["chant.config.ts", "chant.config.mts", "chant.config.js", "chant.config.mjs"];

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
