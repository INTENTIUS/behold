/**
 * Per-user settings for a served project (#470): who is approving (`approver`)
 * and the traffic level the behaviour overlay predicts at (`behaviour.traffic`).
 * These are one operator's settings, not facts about the estate, so they live
 * beside the hand layout (#469) in behold's per-user cache, never in the
 * served project.
 *
 * WHERE IT LIVES. `<cache>/behold/settings/<key>.json`, with the same `<cache>`
 * and `<key>` as the layout (src/layout.ts): the OS user cache directory
 * (`BEHOLD_CACHE_DIR` replaces `<cache>/behold`) and the first 32 hex
 * characters of the sha256 of the project directory's realpath. 0600 in a
 * 0700 directory. The file:
 *
 *   { "version": 1, "projectDir": "<realpath>",
 *     "approver": { "as": "github:alice", "signingKey": "~/.ssh/id_ed25519", "keys": { … },
 *                   "header": "x-forwarded-user", "headerForge": "github" },
 *     "behaviour": { "traffic": "100 rps, p50" } }
 *
 * Every key is optional. A relative key path resolves against the project
 * directory, as it did in `.behold.json`. `projectDir` is for a person reading
 * the file; it is not trusted on read.
 *
 * MIGRATION. When the cache holds no settings file for the project and the
 * project has a `.behold.json`, its `approver` and `behaviour` blocks are read
 * once and copied into the cache (key paths made absolute); after that only
 * the cache is read. `.behold.json` is never written, moved or deleted.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { beholdCacheDir, layoutKey } from "./layout.ts";

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** A key file path from a flag or the settings, absolute: `~` expanded, relative to `base`. */
export function keyPath(path: string, base: string): string {
  const p = expandHome(path);
  return isAbsolute(p) ? p : resolve(base, p);
}

/** `.behold.json`'s `approver` block as written: strings, key paths unresolved. */
export interface ApproverSettings {
  as?: string;
  signingKey?: string;
  keys?: Record<string, string>;
  header?: string;
  headerForge?: string;
}

export interface UserSettings {
  approver?: ApproverSettings;
  /** The behaviour overlay's inputs (#402). `traffic` is the level every
   * prediction is asked for, verbatim, as chant's `--traffic` takes it
   * ("100 rps, p50"). behold never picks one: with none here and none on the
   * request (`?traffic=`), no prediction is asked for at all, which reads as
   * "not looked" rather than as a refusal. */
  behaviour?: { traffic: string };
}

const MAX_FILE_BYTES = 64 * 1024;

/** Where the settings files live. */
export function settingsCacheDir(root: string = beholdCacheDir()): string {
  return join(root, "settings");
}

/** The cache file holding a project's settings. Outside the project, always. */
export function settingsPath(projectDir: string, root?: string): string {
  return join(settingsCacheDir(root), `${layoutKey(projectDir)}.json`);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A parsed `approver` block, keeping only non-blank strings. `base`, when
 * given, makes key paths absolute (the migration does this). */
function readApprover(v: unknown, base?: string): ApproverSettings | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  const path = (p: string): string => (base ? keyPath(p, base) : p);
  const keys: Record<string, string> = {};
  if (b.keys && typeof b.keys === "object" && !Array.isArray(b.keys)) {
    for (const [who, k] of Object.entries(b.keys as Record<string, unknown>)) if (who.trim() && str(k)) keys[who.trim()] = path(str(k)!);
  }
  const as = str(b.as);
  const signingKey = str(b.signingKey);
  const header = str(b.header);
  const headerForge = str(b.headerForge);
  const out: ApproverSettings = {
    ...(as ? { as } : {}),
    ...(signingKey ? { signingKey: path(signingKey) } : {}),
    ...(Object.keys(keys).length ? { keys } : {}),
    ...(header ? { header } : {}),
    ...(headerForge ? { headerForge } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** `behaviour.traffic`, when it is a non-blank string. A wrong-typed or blank
 * value is dropped like any other typo: it means "not looked". */
function readBehaviour(v: unknown): { traffic: string } | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const traffic = str((v as { traffic?: unknown }).traffic);
  return traffic ? { traffic } : undefined;
}

/** The settings in a parsed document. `base` as in {@link readApprover}. */
function settingsOf(raw: unknown, base?: string): UserSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const approver = readApprover(r.approver, base);
  const behaviour = readBehaviour(r.behaviour);
  return { ...(approver ? { approver } : {}), ...(behaviour ? { behaviour } : {}) };
}

function parseFile(file: string): unknown {
  const text = readFileSync(file, "utf8");
  if (text.length > MAX_FILE_BYTES) return undefined;
  return JSON.parse(text);
}

function realDir(dir: string): string {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

/** Replace a project's settings in the cache, through a sibling `.tmp` + rename. */
export function writeUserSettings(projectDir: string, settings: UserSettings, root?: string): string {
  const file = settingsPath(projectDir, root);
  mkdirSync(settingsCacheDir(root), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ version: 1, projectDir: realDir(projectDir), ...settings }, null, 2) + "\n";
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
  return file;
}

/**
 * A project's per-user settings. The cache file when there is one; else the
 * `approver` and `behaviour` blocks of the project's `.behold.json`, copied
 * into the cache so that file is read only this once (best-effort: a cache
 * that can't be written means it is read again next time). The copy is
 * written even when neither block is there, so a block added to `.behold.json`
 * later is not picked up: the file is retired. Missing or unreadable reads as
 * `{}`; settings must never stop a serve.
 */
export function readUserSettings(projectDir: string, root?: string): UserSettings {
  if (!projectDir) return {};
  const cached = settingsPath(projectDir, root);
  if (existsSync(cached)) {
    try {
      return settingsOf(parseFile(cached));
    } catch {
      return {};
    }
  }
  const legacy = join(projectDir, ".behold.json");
  if (!existsSync(legacy)) return {};
  let settings: UserSettings;
  try {
    settings = settingsOf(parseFile(legacy), projectDir);
  } catch {
    return {};
  }
  try {
    writeUserSettings(projectDir, settings, root);
  } catch {
    /* read again next time */
  }
  return settings;
}
