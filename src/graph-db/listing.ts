/**
 * The cloud lister's output, the "listing result" source shape
 * of behold#1025's design (https://github.com/INTENTIUS/behold/issues/1025#issuecomment-6430966093,
 * ruled in #issuecomment-6431259469).
 *
 * The lister moved to chant (INTENTIUS/chant#4532,
 * packages/core/src/cloud-lister/), and `behold index` calls chant's
 * `runCloudIndex`. The graph pane still loads a listing (src/graph-db/sources.ts,
 * rows.ts), so behold re-exports chant's types from
 * `@intentius/chant/cloud-lister/types` (behold#1005 flipped
 * src/chant-release.ts) and keeps no copy.
 *
 * What the lister fills, per the design and chant#4520's ruled `EngineFacts`:
 *
 *  - every resource gets the path-style id the ruling names (Q2),
 *    `<substrate>/<scopeId>/<location>/<listedType>/<nativeId>` (chant packages/core/src/cloud-lister/ids.ts);
 *  - `facts` carries only what a cloud listing can read: `markers` (from tags
 *    and labels), `cloudIds` and `observedAt`. `ownership`, `ownedBy` and
 *    `recordVersions` stay absent, because they are relative to an estate or
 *    stack and a record the lister never reads;
 *  - properties, tags and every string under them are masked before the
 *    result exists (chant's cloud-lister/mask.ts; rows.ts masks again with
 *    src/graph-db/mask.ts).
 */
export type {
  CloudId,
  CloudScope,
  CoverageEntry,
  IndexNote,
  ListedFacts,
  ListedResource,
  ListingResult,
  MarkerFact,
  Substrate,
  TagFilter,
} from "@intentius/chant/cloud-lister/types";
