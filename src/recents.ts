// Recently-opened chant projects (#195) — the project switcher's memory.
// A tiny JSON file under the user's home dir (override with
// BEHOLD_RECENTS_FILE, which the tests use), most-recent first, capped, and
// re-validated on every read: a row whose directory no longer exists — or no
// longer has a chant.config.ts — silently drops out rather than offering a
// switch that would 400.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface RecentProject {
  dir: string;
  lastOpened: string; // ISO timestamp
}

const MAX_RECENTS = 20;

function recentsFile(): string {
  return process.env.BEHOLD_RECENTS_FILE || join(homedir(), ".behold", "recents.json");
}

/** The recents list, validated: only rows whose dir still looks like a chant
 * project survive. Corrupt or absent file → empty list, never a throw. */
export function listRecents(): RecentProject[] {
  try {
    const rows = JSON.parse(readFileSync(recentsFile(), "utf8")) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (r): r is RecentProject =>
        !!r && typeof (r as RecentProject).dir === "string" && existsSync(join((r as RecentProject).dir, "chant.config.ts")),
    );
  } catch {
    return [];
  }
}

/** Record `dir` as the most recent project (deduped, capped). Best-effort:
 * recents are a convenience — a read-only home dir must never fail a serve. */
export function addRecent(dir: string, now: () => string = () => new Date().toISOString()): void {
  const rows = listRecents().filter((r) => r.dir !== dir);
  rows.unshift({ dir, lastOpened: now() });
  const file = recentsFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(rows.slice(0, MAX_RECENTS), null, 2) + "\n");
  } catch {
    /* best-effort */
  }
}
