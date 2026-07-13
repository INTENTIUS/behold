/**
 * Project autodetection (#17). behold reads the served project so the SPA can
 * offer pickers — chiefly the environment — instead of the env being a launch
 * flag. Light-parses `chant.config.ts` (regex, like `discoverOps`) rather than
 * executing it: no project chant version to match, and it degrades to empty when
 * the config computes its arrays dynamically (the SPA then just shows `(source)`).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ProjectInfo {
  /** Declared environments (drives the env picker → live overlay per env). */
  environments: string[];
  /** Declared lexicons (the substrates in play — shown, no picker yet). */
  lexicons: string[];
}

/** Extract the string literals from a `key: [ "a", "b" ]` array in config source.
 * Only matches a literal array — a computed value yields []. Pure. */
function parseStringArray(content: string, key: string): string[] {
  const arr = content.match(new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!arr) return [];
  return [...arr[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** Detect what the project offers by parsing its chant config. Returns empty
 * arrays when there's no config or the fields aren't literal arrays. */
export function detectProject(projectDir: string): ProjectInfo {
  for (const name of ["chant.config.ts", "chant.config.mts", "chant.config.js"]) {
    const p = join(projectDir, name);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    return {
      environments: parseStringArray(content, "environments"),
      lexicons: parseStringArray(content, "lexicons"),
    };
  }
  return { environments: [], lexicons: [] };
}
