/**
 * Per-member source-IR cache (#307) — the estate's warm read.
 *
 * #295/#306 bounded the estate fan-out, which fixed the memory blow-up and left
 * the latency exactly where it was: an 11-member estate still pays 11 `chant
 * graph` subprocesses per read. Profiled on the synthesized 11-member estate
 * (3-node members, chant 0.44.12), one member read is ~890ms of which ~750ms is
 * process spawn plus chant's own CLI module load — `chant --help`, which parses
 * argv and exits before any graph work, costs the same ~750ms. The member's
 * actual compose is ~145ms and the behold-side join (`composeStacks`) is 0.2ms.
 * So ~85% of an estate read is fixed cost per spawn that has nothing to do with
 * the member's content, and a member whose source has not moved pays all of it
 * to be handed back the bytes it was handed last time.
 *
 * This caches those bytes. Not by making the spawn cheaper (an in-process chant
 * would, and cannot: behold shells the member's OWN chant precisely because
 * members pin different versions — src/chant.ts `resolveChant` — so a single
 * imported chant would silently graph one member's source with another's
 * compiler) but by not spawning at all for a member that has not changed.
 *
 * ---------------------------------------------------------------------------
 * THE INVALIDATION RULE. An entry is served only when ALL of these still hold;
 * anything else is a miss, and a miss is a real chant read:
 *
 *   1. The read is source-only. `live` or `overlay` is never cached — those
 *      observe the cluster, which moves with nothing on disk to notice, so a
 *      cached live read is a stale drift report by construction. The estate's
 *      live pass (`composeEstateOverlay`) still spawns per member, every read.
 *   2. The member's source stamp is unchanged — every file under the member
 *      root (minus node_modules/dist/.git) by path, mtime and size. A stamp
 *      that cannot be taken (an unreadable or missing member) caches nothing,
 *      and a stamp that moved between the start and the end of the read that
 *      would have populated the entry caches nothing either.
 *   3. The resolved chant is unchanged — bin path and declared version, the
 *      same `resolveChant` the read itself would use. An `npm install` that
 *      moves a member onto a new chant changes what the same source graphs to.
 *   4. Every graph option that reaches the invocation is unchanged — the whole
 *      `GraphOptions` shape, canonicalised, since detail/lens/env/namespace/
 *      tier/target/stack each change chant's answer.
 *   5. Nothing has explicitly dropped the member. `invalidateMember` is wired
 *      to the estate source watcher's own `onEstateChange` (#297, src/events.ts
 *      `watchSources`) rather than to a second change-detector of this module's
 *      own: the watcher is already the thing that knows a member moved, and it
 *      covers the one case the stamp cannot — a filesystem whose mtime
 *      granularity is coarse enough (1s on some network mounts) to hide an edit
 *      that lands in the same tick as the read that cached it.
 *
 * Not covered, deliberately and stated rather than pretended away: chant source
 * that reads an ambient `process.env` var behold does not thread through
 * `GraphOptions`. behold's own environment is fixed for the life of the serve,
 * so this cannot go stale within a process; it only means two behold processes
 * with different environments do not share a cache — which they don't anyway,
 * because this cache is in-memory and per-process. behold stays read-only with
 * no database (AGENTS.md): nothing here touches disk, and everything here dies
 * with the process.
 * ---------------------------------------------------------------------------
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { graphIr, resolveChant, type GraphOptions } from "./chant.ts";

/** Directories a member's source stamp never walks: build output and installed
 * packages are not the member's declared source, and a `node_modules` sweep is
 * exactly the walk that would make stamping cost more than the spawn it saves
 * (the same set `watchSource` ignores, src/events.ts). */
const SKIP = new Set(["node_modules", "dist", ".git"]);

/** How many entries the cache holds before the least recently used are dropped.
 * A bound, not a tuning knob: #306 fixed an OOM and this must not reintroduce
 * one. An estate reads each member under a handful of option shapes, so a
 * default of 64 covers an 11-member estate's working set several times over.
 * `BEHOLD_ESTATE_IR_CACHE=0` disables caching entirely; an unparseable or
 * negative value is ignored rather than honoured into a broken cache. */
export function memberIrCacheSize(env: Record<string, string | undefined> = process.env): number {
  const override = Number.parseInt(env.BEHOLD_ESTATE_IR_CACHE ?? "", 10);
  return Number.isInteger(override) && override >= 0 ? override : 64;
}

/**
 * A fingerprint of everything a member declares on disk: each file's
 * member-relative path, mtime and size, hashed. Undefined when the member
 * cannot be walked at all — an unstampable member is never cached, which is the
 * safe direction (a spawn, not a guess).
 *
 * The whole member root, not just the resolved graph source dir: `chant.config.ts`
 * decides what the source dir even is, a multi-stack member graphs from several
 * of them, and a member's `cluster/` build root is source too. Over-broad by
 * design — a stray edit under the member costs one spawn, and the alternative
 * (walking only what this read happens to graph) is a stamp that can miss the
 * file that changed the answer. Exported for testing.
 */
export function memberSourceStamp(dir: string): string | undefined {
  const root = resolve(dir);
  const h = createHash("sha1");
  let any = false;
  const walk = (at: string): void => {
    // Sorted, so the same tree stamps the same however the filesystem enumerates it.
    const entries = readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const path = join(at, e.name);
      if (e.isDirectory()) {
        walk(path);
        continue;
      }
      if (!e.isFile()) continue; // sockets, fifos, dangling symlinks: nothing to stamp
      const st = statSync(path);
      h.update(`${relative(root, path)}\0${st.mtimeMs}\0${st.size}\n`);
      any = true;
    }
  };
  try {
    walk(root);
  } catch {
    return undefined;
  }
  return any ? h.digest("hex") : undefined;
}

/** The identity of one cached read: the member, the chant that would answer it,
 * and every graph option that reaches the invocation. `GraphOptions` keys are
 * sorted so two equal option sets built in different orders are one key. */
function cacheKey(dir: string, opts: GraphOptions): string {
  const chant = resolveChant(dir);
  const canonical = JSON.stringify(opts, Object.keys(opts).sort());
  return `${resolve(dir)}\0${chant.bin}\0${chant.version ?? ""}\0${canonical}`;
}

interface Entry {
  /** The member root this entry belongs to — the key `invalidateMember` sweeps by. */
  dir: string;
  stamp: string;
  ir: GraphIR;
}

// Insertion-ordered Map as an LRU: a hit re-inserts, so the oldest key is
// always the least recently used one.
const cache = new Map<string, Entry>();
let hits = 0;
let misses = 0;

/** Hit/miss counts and the live entry count — read by tests, and cheap enough
 * to expose for a future `/api/doctor` line. */
export function memberIrCacheStats(): { hits: number; misses: number; entries: number } {
  return { hits, misses, entries: cache.size };
}

/** Drop `dir`'s entries (every option shape), or the whole cache when called
 * with nothing. Wired to the estate source watcher — see rule 5 above. */
export function invalidateMember(dir?: string): void {
  if (dir === undefined) {
    cache.clear();
    return;
  }
  const root = resolve(dir);
  for (const [key, entry] of cache) if (entry.dir === root) cache.delete(key);
}

/** Reset the cache and its counters — for tests, so one file's reads cannot
 * warm another's. */
export function resetMemberIrCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

/**
 * `graphIr` for one estate member, served from the cache when the invalidation
 * rule above says the last answer still stands.
 *
 * Always returns a deep copy, never the cached object: the estate's own passes
 * mutate what they are handed (`namespaceRuntimeOwners` re-points
 * `runtimeOwner` in place, the unobserved fallback rewrites every node's
 * `attrs`, `classify` is the caller's overlay reclassifier), so handing out the
 * stored IR would let one read's mutations become the next read's "cached"
 * truth. Measured at 0.7ms for a 280-node, 92KB IR — a whole #307-sized estate
 * in one member — against the ~750ms spawn it replaces.
 */
export async function memberIr(dir: string, opts: GraphOptions = {}): Promise<GraphIR> {
  // Rule 1: a live/overlay read observes the cluster. Never cached, and never
  // even stamped — the walk would be pure cost on a read that cannot be served.
  const size = memberIrCacheSize();
  if (opts.live || opts.overlay || size === 0) return graphIr(dir, opts);

  const stamp = memberSourceStamp(dir);
  const key = cacheKey(dir, opts);
  const hit = stamp !== undefined ? cache.get(key) : undefined;
  if (hit && hit.stamp === stamp) {
    hits++;
    cache.delete(key); // re-insert at the end: most recently used
    cache.set(key, hit);
    return structuredClone(hit.ir);
  }
  misses++;
  const ir = await graphIr(dir, opts);
  // Re-stamp: an edit that landed WHILE chant was reading would otherwise be
  // cached as the stamp taken before it, and every later read would serve an IR
  // of source that no longer exists. A moved stamp caches nothing — the next
  // read pays a spawn, which is the correct price for an unknown answer.
  // Stamping costs <1ms against the ~750ms spawn, so doing it twice is free.
  if (stamp === undefined || memberSourceStamp(dir) !== stamp) return ir;
  cache.delete(key);
  cache.set(key, { dir: resolve(dir), stamp, ir });
  // Evict from the front (least recently used) until the bound holds.
  for (const oldest of cache.keys()) {
    if (cache.size <= size) break;
    cache.delete(oldest);
  }
  return structuredClone(ir);
}
