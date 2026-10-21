/**
 * Local mode (#46): boot the served project's emulators through chant's
 * `chant emulator up|down|status --json` (chant #920) and hand back the env that
 * redirects tooling at them. behold applies that env to its own process, so every
 * chant shell-out it makes — `graph --live --overlay` (observe) and `run <op>`
 * (deploy) — inherits it and hits the same emulator. No cloud creds: a local
 * Docker emulator holds none, and the apply still goes through a committed Op.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runChantRaw } from "./chant.ts";

/** One booted emulator, as reported by `chant emulator … --json`. */
export interface EmulatorInfo {
  lexicon: string;
  /** Container name (e.g. `chant-floci`). */
  name: string;
  /** `http://localhost:<port>` when up; empty when down. */
  endpoint: string;
  /** Env that redirects the SDK / `graph --live` / a triggered Op at it. */
  env: Record<string, string>;
}

/** Parse the `chant emulator … --json` envelope (`{ emulators: [...] }`). `up`
 * prints progress lines ("emulator … ready on …") to stdout before the JSON, so
 * scan for the JSON line from the end rather than parsing the whole stream.
 * Tolerant of an empty or malformed body — returns []. Exported for testing. */
export function parseEmulators(stdout: string): EmulatorInfo[] {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines[i]) as { emulators?: EmulatorInfo[] };
      if (Array.isArray(parsed.emulators)) return parsed.emulators;
    } catch {
      // not the JSON line — keep scanning upward
    }
  }
  return [];
}

/** Merge every emulator's redirect env into one map (later wins on a key clash —
 * the per-cloud vars don't overlap in practice). Exported for testing. */
export function mergedEnv(emulators: EmulatorInfo[]): Record<string, string> {
  return Object.assign({}, ...emulators.map((e) => e.env));
}

/** A clear "Docker isn't available" message when the failure looks like Docker is
 * missing or its daemon is down, else undefined. Exported for testing. */
export function dockerHint(stderr: string): string | undefined {
  const s = stderr.toLowerCase();
  if (
    s.includes("docker") ||
    s.includes("enoent") ||
    s.includes("cannot connect") ||
    s.includes("command not found")
  ) {
    return "behold serve --local needs Docker running (the emulator is a container). Start Docker and retry.";
  }
  return undefined;
}

/**
 * Boot the project's configured emulators — all of them when the project spans
 * several emulator-backed lexicons, none when it has zero. Throws with a clear
 * message when Docker is unavailable or chant can't boot them.
 */
export async function emulatorUp(projectDir: string): Promise<EmulatorInfo[]> {
  const { code, stdout, stderr } = await runChantRaw(["emulator", "up", "--json"], projectDir);
  if (code !== 0) {
    throw new Error(dockerHint(stderr) ?? `chant emulator up failed (exit ${code}): ${stderr.trim() || "no output"}`);
  }
  return parseEmulators(stdout);
}

/** Tear the emulators down (`chant emulator down`). Best-effort — a teardown
 * failure on shutdown is logged by the caller, never thrown. */
export async function emulatorDown(projectDir: string): Promise<void> {
  await runChantRaw(["emulator", "down"], projectDir);
}

/**
 * #824: the directories whose emulators `--local` boots. A chant project is
 * its own; a declared workspace is every chant member's, because `chant
 * emulator up` reads one project's lexicons and the three-cloud workspace's
 * first member (dns) would boot floci alone, leaving the azure and gcp reads
 * pointed at the real clouds. The members come from the served workspace when
 * there is one, else from a `chant.workspace.json` in `dir` (the demo route
 * boots before it serves). A declaration that can't be read is `[dir]`.
 */
export function emulatorDirs(dir: string, workspace?: { members: Array<{ kind: string; abs: string }> }): string[] {
  if (workspace) {
    const dirs = workspace.members.filter((m) => m.kind === "chant").map((m) => m.abs);
    return dirs.length ? dirs : [dir];
  }
  const file = join(dir, "chant.workspace.json");
  if (!existsSync(file)) return [dir];
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { members?: Array<{ dir?: unknown; kind?: unknown }> };
    const dirs = (doc.members ?? []).filter((m) => (m.kind ?? "chant") === "chant" && typeof m.dir === "string").map((m) => resolve(dir, m.dir as string));
    return dirs.length ? dirs : [dir];
  } catch {
    return [dir];
  }
}

/** Boot every directory's emulators, one directory at a time, keeping one
 * entry per container: two members on the same lexicon share its emulator. */
export async function emulatorsUp(dirs: string[]): Promise<EmulatorInfo[]> {
  const seen = new Map<string, EmulatorInfo>();
  for (const d of dirs) for (const e of await emulatorUp(d)) if (!seen.has(e.name)) seen.set(e.name, e);
  return [...seen.values()];
}

/** Tear down every directory's emulators, best-effort. */
export async function emulatorsDown(dirs: string[]): Promise<void> {
  for (const d of dirs) await emulatorDown(d).catch(() => undefined);
}
