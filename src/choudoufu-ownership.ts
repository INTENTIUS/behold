/**
 * A choudoufu member's ownership, painted from chant's live read (behold#1227).
 *
 * chant's terraform lexicon reads a choudoufu live root with `choudoufu
 * live-plan -json` and `live-graph`, and with `CHANT_TERRAFORM_LIVE_LISTING=1`
 * with `live-ls -json` too. Every instance node of `chant graph --live
 * --overlay` then carries the engine's verdict and the rows behind it:
 *
 *  - `facts.ownership`, one word: `bound`, `pending`, `unowned` or `foreign`
 *    (INTENTIUS/chant#5333);
 *  - `facts.ownershipRows`, in choudoufu's own words (INTENTIUS/chant#5402):
 *    `boundBy` and `identityValues` from `bound[]`, `omission { reason,
 *    detail }`, `adopt { owner, address, command, matched }` from `unowned[]`
 *    and `adoptable[]`, `gaps [{ read, reason, detail }]` from `live-ls`'s
 *    `gaps[]` and the engine graph, and `listed`, whether the listing holds
 *    the object under the estate's marker;
 *  - `facts.markers.owner`, who holds a `foreign` object.
 *
 * behold reads no choudoufu document for ownership any more. It puts those
 * facts on the cards of the member's roster (`live-check`, one card per
 * instance, the ids saved layouts are keyed on) by instance address, and the
 * colour comes from the one `(status, read)` table (src/drift-tone.ts), read
 * `ownership`, with the status chant's drift record gives the same verdict:
 * `bound` is in-sync, `pending` is pending, `unowned` and `foreign` are
 * unclaimed, and an instance with no word is not observed.
 *
 * No Node imports, so the card module and the paint stay usable anywhere.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import { CHOUDOUFU_LEXICON } from "./choudoufu-card.ts";
import { decomposeAddress } from "./choudoufu-refs.ts";
import { toneFor } from "./drift-tone.ts";
import { engineOwnershipOf } from "./engine-ownership.ts";

/** chant's `EngineOwnershipRows` (`@intentius/chant/engine-facts`), as behold reads it. */
export interface OwnershipRows {
  boundBy?: string;
  identityValues?: Record<string, string>;
  omission?: { reason: string; detail: string };
  adopt?: { owner?: string; address?: string; command?: string; matched?: Array<{ attribute: string; value: string }> };
  gaps?: Array<{ read: string; reason: string; detail: string }>;
  listed?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The rows on a node, or undefined when chant put none there. */
export function ownershipRowsOf(node: unknown): OwnershipRows | undefined {
  const facts = (node as { facts?: unknown } | null | undefined)?.facts;
  const rows = isRecord(facts) ? facts.ownershipRows : undefined;
  return isRecord(rows) ? (rows as OwnershipRows) : undefined;
}

/** Who holds a node, from chant's `facts.markers.owner`. */
function markerOwnerOf(node: unknown): string | undefined {
  const facts = (node as { facts?: unknown } | null | undefined)?.facts;
  const markers = isRecord(facts) ? facts.markers : undefined;
  return isRecord(markers) && typeof markers.owner === "string" && markers.owner ? markers.owner : undefined;
}

/** The drift status chant's record gives each ownership word, the status the tone table is read with. */
export const OWNERSHIP_STATUS: Readonly<Record<string, string>> = { bound: "in-sync", pending: "pending", unowned: "unclaimed", foreign: "unclaimed" };

/** How the plan bound an instance, in the words a card's row prints. */
const BOUND_WORDS: Record<string, string> = {
  marker: "by its marker (the estate-wide tag sweep)",
  derived: "by derived identity (the name the configuration states)",
  record: "from the estate's record store",
  cache: "from the local state cache",
};

/** The `marker` row: what the listing says the object wears. */
export const MARKER_ON = "on the object (tofu-estate, tofu-address)";
export const MARKER_NONE = "no marker on the object";

/** The line that adopts an object: choudoufu's composed command when it printed one, else the two marker values. Never a command behold made up. */
export function adoptLine(adopt: OwnershipRows["adopt"]): string | undefined {
  if (!adopt) return undefined;
  if (adopt.command) return adopt.command;
  if (!adopt.owner) return undefined;
  return `tofu-estate=${adopt.owner}${adopt.address ? ` tofu-address=${adopt.address}` : ""}`;
}

/**
 * Split a path on the `/` between its segments, never one inside a key
 * (`module.a["x/y"]`).
 */
function segments(path: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of path) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "[") depth++;
    else if (!quoted && ch === "]") depth--;
    if (ch === "/" && depth === 0 && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A node of chant's graph of the member, as the instance address choudoufu knows it: `<root>/module.a[0]/aws_x.y[1]` -> `module.a[0].aws_x.y[1]`. */
export function instanceAddressOf(node: Pick<IRNode, "id">, root: string): string | undefined {
  if (!node.id.startsWith(`${root}/`)) return undefined;
  return segments(node.id.slice(root.length + 1).replace(/~\d+$/, "")).join(".");
}

/** What a card takes from one node's facts: its status, its rows and the ids. */
export interface OwnershipVerdict {
  status: string;
  unobserved?: string;
  ownership?: "owned" | "foreign";
  physicalId?: string;
  attrs: Record<string, unknown>;
}

/** The verdict for one instance node of chant's live read. */
export function ownershipVerdictOf(node: unknown): OwnershipVerdict {
  const word = engineOwnershipOf(node);
  const rows = ownershipRowsOf(node) ?? {};
  const physicalId = (node as { physicalId?: unknown }).physicalId;
  const id = typeof physicalId === "string" && physicalId ? { physicalId } : {};
  const listing = rows.gaps?.find((g) => g.read === "listing");
  const listingRow = listing ? { listing: listing.detail || listing.reason } : {};
  const omission = rows.omission ? { omission: rows.omission.reason, detail: rows.omission.detail } : {};
  if (word === "bound") {
    return {
      status: "in-sync",
      ownership: "owned",
      ...id,
      attrs: {
        ...(rows.boundBy ? { bound: BOUND_WORDS[rows.boundBy] ?? rows.boundBy } : {}),
        ...(rows.listed !== undefined ? { marker: rows.listed ? MARKER_ON : MARKER_NONE } : {}),
        ...(rows.boundBy ? { _identity: { source: rows.boundBy, ...(rows.listed !== undefined ? { marked: rows.listed } : {}) } } : {}),
        ...(rows.identityValues ? { identity: rows.identityValues } : {}),
        ...listingRow,
      },
    };
  }
  if (word === "unowned" || word === "foreign") {
    const adopt = adoptLine(rows.adopt);
    const matched = rows.adopt?.matched ?? [];
    const owner = word === "foreign" ? markerOwnerOf(node) : undefined;
    return {
      status: OWNERSHIP_STATUS[word]!,
      ownership: "foreign",
      ...id,
      attrs: {
        // The write to run first; then why choudoufu believes it, in its own words.
        ...(adopt ? { adopt } : {}),
        ...(matched.length ? { matchedOn: matched.map((m) => `${m.attribute}=${m.value}`).join(", ") } : {}),
        ...(owner ? { ownedBy: owner } : {}),
        ...omission,
        ...listingRow,
      },
    };
  }
  if (word === "pending") return { status: "pending", attrs: { ...omission, ...listingRow } };
  // No word: the plan could not say, and the omission or the gap is why.
  const why = rows.omission ? rows.omission.detail || `${rows.omission.reason}` : listing ? listing.detail || listing.reason : "chant's live read gave no ownership for this instance";
  return { status: "not-observed", unobserved: why, attrs: { ...omission, ...listingRow } };
}

/**
 * Paint the roster with chant's live read of the member. `live` is chant's
 * graph of the member (ids `<root>/<block path>`, instance nodes included),
 * `root` the root it names the member's blocks under. Mutates and returns
 * `roster`.
 *
 * Every instance card gets a verdict, and a data-source card (the declared
 * read) stays uncoloured. An instance chant's read did not place is not
 * observed. A bound object chant places at an address the roster does not
 * declare, under no block the roster has, becomes a card of its own: marked
 * for this estate, declared nowhere.
 */
export function paintChoudoufuOwnership(roster: GraphIR, live: Pick<GraphIR, "nodes">, root: string, estate?: string): GraphIR {
  const byAddress = new Map<string, IRNode>();
  for (const n of live.nodes) {
    const address = instanceAddressOf(n, root);
    if (address && engineOwnershipOf(n) !== undefined) byAddress.set(address, n);
    else if (address && ownershipRowsOf(n) && !byAddress.has(address)) byAddress.set(address, n);
  }
  const declared = new Set<string>();
  const blocks = new Set<string>();
  for (const n of roster.nodes) {
    if (n.lexicon !== CHOUDOUFU_LEXICON || isRecord(n.attrs.producer)) continue;
    declared.add(n.id);
    blocks.add(decomposeAddress(n.id).blockPath);
    const node = byAddress.get(n.id);
    const v: OwnershipVerdict = node ? ownershipVerdictOf(node) : { status: "not-observed", unobserved: "chant's live read placed nothing at this address", attrs: {} };
    const tone = toneFor({ status: v.status, read: "ownership" });
    n.attrs = {
      ...n.attrs,
      ...v.attrs,
      _status: tone.tone,
      _drift: { status: v.status, read: "ownership", label: tone.label },
      ...(v.unobserved ? { _unobserved: v.unobserved } : {}),
    };
    if (v.physicalId) n.physicalId = v.physicalId;
    if (v.ownership) n.ownership = v.ownership;
    if (node?.facts) (n as IRNode & { facts?: unknown }).facts = node.facts;
  }
  for (const [address, node] of byAddress) {
    if (declared.has(address) || engineOwnershipOf(node) !== "bound") continue;
    const block = decomposeAddress(address).blockPath;
    if (blocks.has(block)) continue;
    declared.add(address);
    roster.nodes.push({
      id: address,
      kind: typeof node.attrs?.type === "string" ? (node.attrs.type as string) : node.kind,
      lexicon: CHOUDOUFU_LEXICON,
      ...(node.physicalId ? { physicalId: node.physicalId } : {}),
      ownership: "owned",
      facts: node.facts,
      attrs: {
        ...(estate ? { estate } : {}),
        marked: "carries this estate's marker, declared nowhere in its configuration",
        _status: toneFor({ status: "undeclared", read: "ownership" }).tone,
      },
    } as IRNode);
  }
  return roster;
}
