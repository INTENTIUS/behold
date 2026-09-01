/**
 * Carve manifest discovery over PROJECT roots (chant#2038), cached by source
 * stamp so the project payload and the graph joins read the same answer.
 *
 * Two kinds of directory hold carve manifests, and they are read differently:
 *
 *  - An OUTPUT dir (`--output`, a demo's `app/carveout/`, the dir a served
 *    report sits in) holds them flat, by construction. The carve routes read
 *    it flat and locally (src/server.ts `carveRoutes`); a recursive walk there
 *    would be over-inclusive, and chant's `carve status` walks recursively.
 *  - A PROJECT root holds them wherever `--output` pointed. That is the case
 *    chant#2038 named — "a renderer discovers *.carve.json by walking and
 *    guessing depth" — and since chant 0.54.0 `chant carve status --from
 *    <root> --json` is chant's own answer. Below the floor, or when the read
 *    fails, the bounded local walk stands in exactly as before.
 *
 * The result is cached per root under the member's source stamp (the same
 * fingerprint the #312 member-IR cache keys on: every file's path, mtime and
 * size, node_modules/dist/.git skipped), so an emit — which writes files —
 * invalidates it, and a graph request pays a stamp, not a spawn. That is what
 * lets the estate graph (per member, src/estate.ts), the single-project graph
 * and `/api/project` join the same manifests: one discovery, three readers.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CarveState, CarveStatusJson } from "./carve-manifest.ts";
import { CARVE_MANIFEST_SUFFIX, CARVE_STATUS_FLOOR, discoverCarveStates, nodeCarveIo, MANIFEST_SCAN_DEPTH } from "./carve-manifest.ts";
import { carveStatus, meetsFloor, resolveChant } from "./chant.ts";
import { memberSourceStamp } from "./member-ir.ts";

/** `chant carve status` for one root, through the chant `projectDir` resolves
 * (the root itself by default) — or undefined below {@link CARVE_STATUS_FLOOR}
 * and on any failure, which hands that root back to the local walk. The floor
 * is checked before the spawn: an older chant answers "unknown command" with
 * an exit code a caller would otherwise have to pattern-match. */
export function carveStatusReader(projectDir?: string): (dir: string) => Promise<CarveStatusJson | undefined> {
  return async (dir) => {
    const via = projectDir ?? dir;
    if (!meetsFloor(resolveChant(via).version, CARVE_STATUS_FLOOR)) return undefined;
    return carveStatus(dir, via).catch(() => undefined);
  };
}

/** Directories a manifest is never written into — chant's own `carve status`
 * skip list plus the two build-output trees the local walk already skips. */
const SKIP = new Set(["node_modules", ".git", "dist", ".chant", ".terraform", "cdk.out"]);

/**
 * Is there ANY carve manifest under `dir`? A file-name scan (no reads, no
 * parse) that costs what the member stamp costs, so the graph path never
 * spawns chant to be told "none": a project that has carved nothing — nearly
 * every project — gets an empty answer from its own tree, and chant's walk is
 * asked only when there is a manifest for it to place. Exported for testing.
 */
export function hasAnyCarveManifest(dir: string, io: { readdir: (d: string) => string[]; isDirectory: (p: string) => boolean } = fsIo): boolean {
  const walk = (d: string): boolean => {
    let entries: string[];
    try {
      entries = io.readdir(d);
    } catch {
      return false;
    }
    for (const name of entries) {
      if (name.endsWith(CARVE_MANIFEST_SUFFIX)) return true;
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const full = join(d, name);
      if (io.isDirectory(full) && walk(full)) return true;
    }
    return false;
  };
  return walk(dir);
}

const fsIo = {
  readdir: (d: string) => readdirSync(d),
  isDirectory: (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

const cache = new Map<string, { stamp: string | undefined; states: Map<string, CarveState> }>();

/** The carve states under one project root, discovered by chant where it can
 * be (see the module doc), cached under the root's source stamp. An
 * unstampable root is read every time — the safe direction. */
export async function carveStatesFor(dir: string): Promise<Map<string, CarveState>> {
  const stamp = memberSourceStamp(dir);
  const held = cache.get(dir);
  if (held && stamp !== undefined && held.stamp === stamp) return held.states;
  const states = hasAnyCarveManifest(dir)
    ? await discoverCarveStates([dir], carveStatusReader(), nodeCarveIo, MANIFEST_SCAN_DEPTH)
    : new Map<string, CarveState>();
  if (stamp !== undefined) cache.set(dir, { stamp, states });
  return states;
}

/** Every carve state under `dirs`, one map, the further-along stage winning a
 * duplicated target — `readCarveStates`'s rule over the cached per-root reads. */
export async function carveStatesUnder(dirs: readonly string[]): Promise<Map<string, CarveState>> {
  const rank = { emitted: 0, bridged: 1, applied: 2 } as const;
  const out = new Map<string, CarveState>();
  for (const dir of dirs) {
    for (const s of (await carveStatesFor(dir)).values()) {
      const held = out.get(s.target);
      if (!held || rank[s.stage] > rank[held.stage]) out.set(s.target, s);
    }
  }
  return out;
}

/** Drop the cached discovery for one root, or all of them. The source watcher
 * calls the member-IR equivalent on change; a stamp mismatch covers the rest. */
export function invalidateCarveStates(dir?: string): void {
  if (dir === undefined) cache.clear();
  else cache.delete(dir);
}
