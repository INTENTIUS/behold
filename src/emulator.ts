/**
 * Local mode (#46): boot the served project's emulators through chant's
 * `chant emulator up|down|status --json` (chant #920) and hand back the env that
 * redirects tooling at them. behold applies that env to its own process, so every
 * chant shell-out it makes — `graph --live --overlay` (observe) and `run <op>`
 * (deploy) — inherits it and hits the same emulator. No cloud creds: a local
 * Docker emulator holds none, and the apply still goes through a committed Op.
 */
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
