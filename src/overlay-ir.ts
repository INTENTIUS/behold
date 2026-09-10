/**
 * The overlay document a member was last read as (#396 finding 6).
 *
 * `?collapse=1` is a RENDER decision over a document behold already holds —
 * which member boxes are drawn shut (#393 C, src/collapse-lens.ts). The SPA
 * sends it as a query param, so "Collapse large boxes" and "Expand all" each
 * re-fetched `/api/overlay`, and each re-fetch re-ran `live-ls` and
 * `live-plan` per member: four seconds on `terralith-4`, with the graph frozen
 * behind "loading resources · live…", to draw the same 301 cards as one card
 * instead of 301. A toggle should be a re-render.
 *
 * So a member's live read is cached, exactly the way #404 caches its plan
 * (src/choudoufu-plan.ts's own header states the argument): under the member's
 * SOURCE STAMP — every file under the member root by path, mtime and size,
 * `memberSourceStamp` from src/member-ir.ts — together with the read's own
 * options, which is where the env lives. An unstampable member caches nothing,
 * and a stamp that moved while the read was in flight caches nothing, both
 * being the rules src/member-ir.ts already follows.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE STAMP DOES NOT COVER is the account, and that is the whole subject
 * of a live read — src/member-ir.ts's rule 1 refuses to cache a live read for
 * precisely this reason, and this module is the stated exception to it, not a
 * quiet reinterpretation. The exception is bounded by naming, once, everything
 * that drops an entry:
 *
 *   1. **A re-observe that was asked for.** `POST /api/refresh` is the
 *      palette's "Re-check live (refresh drift)" and it exists to look again;
 *      it clears the whole cache before it captures. `GET /api/overlay?plan=1`
 *      ("Re-check live with plan") re-reads too — re-check means re-check, on
 *      both halves of the answer, which is the rule #404 already states for
 *      the plan half.
 *   2. **A write behold itself ran.** An Op run that finished has changed the
 *      account behold is about to describe, so the same capture that ends a
 *      run drops the cache with it.
 *   3. **The member's source moved** — the stamp, plus `invalidateOverlay`
 *      wired to the estate source watcher the way `invalidateMember` is, which
 *      covers a filesystem whose mtime granularity can hide an edit landing in
 *      the same tick as the read that cached it.
 *
 * What is left uncovered is a change made to the account by something that is
 * not behold, between two reads with no refresh between them — a person at a
 * console, another apply. That was already the case for the plan half of the
 * same overlay, and the honest answer to it is the row that says "Re-check
 * live", not a spawn on every re-render of a picture nobody asked to re-read.
 * ---------------------------------------------------------------------------
 *
 * Everything here is in memory and per process. behold keeps no database and
 * writes nothing outside `.behold/layout.json` (AGENTS.md, "Invariant").
 */
import type { GraphIR } from "@intentius/chant";
import type { GraphOptions } from "./chant.ts";
import { memberSourceStamp, type MemberVia } from "./member-ir.ts";
import { resolve } from "node:path";

interface Entry {
  stamp: string;
  ir: GraphIR;
}

/** dir → its options-key → entry. Two levels so a member can be dropped whole
 * without walking every option shape it was read under. */
const cache = new Map<string, Map<string, Entry>>();
let hits = 0;
let misses = 0;

/** Hit/miss counts and the live member count — read by tests. */
export function overlayCacheStats(): { hits: number; misses: number; members: number } {
  return { hits, misses, members: cache.size };
}

/** Drop one member's overlay documents, or every member's. Called by the
 * re-observe routes and by the estate source watcher. */
export function invalidateOverlay(dir?: string): void {
  if (dir === undefined) cache.clear();
  else cache.delete(resolve(dir));
}

/** Reset the cache and its counters — for tests, so one file's reads cannot
 * warm another's. */
export function resetOverlayCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

/** `GraphOptions` keys sorted, so two equal option sets built in different
 * orders are one key — `cacheKey` in src/member-ir.ts, same reasoning. */
function optionsKey(opts: GraphOptions, via: MemberVia, dir: string): string {
  return `${via.tool(dir)}\0${JSON.stringify(opts, Object.keys(opts).sort())}`;
}

/**
 * A member's live IR: the stored answer when the member's source has not
 * moved, else the member kind's own read.
 *
 * `fresh` is the caller saying it wants the account looked at again — the
 * re-observe rows — and it both bypasses the entry and replaces it.
 */
export async function overlayIr(dir: string, opts: GraphOptions, via: MemberVia, fresh = false): Promise<GraphIR> {
  const root = resolve(dir);
  const key = optionsKey(opts, via, dir);
  const stamp = memberSourceStamp(dir);
  if (!fresh && stamp !== undefined) {
    const hit = cache.get(root)?.get(key);
    if (hit && hit.stamp === stamp) {
      hits++;
      // A deep copy, never the stored object: the estate's own passes mutate
      // what they are handed (`namespaceRuntimeOwners`, the overlay
      // reclassifier, the paint passes), so handing out the stored IR would
      // let one read's mutations become the next read's "cached" truth. This
      // is `memberIr`'s reasoning and its measurement — 0.7ms for a 280-node
      // IR, against the seconds a live read costs.
      return structuredClone(hit.ir);
    }
  }
  misses++;
  const ir = await via.read(dir, opts);
  // Re-stamp: an edit that landed WHILE the read was out would otherwise be
  // stored under the stamp taken before it.
  if (stamp === undefined || memberSourceStamp(dir) !== stamp) return ir;
  const per = cache.get(root) ?? new Map<string, Entry>();
  per.set(key, { stamp, ir });
  cache.set(root, per);
  return structuredClone(ir);
}
