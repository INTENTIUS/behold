/**
 * behold#1246: two estates side by side, and the claims they share.
 *
 * A side is a set of served members. The answer is read off the rows the
 * graph pane already loaded (./rows.ts), so every fact in it came from chant's
 * reads, an engine document, an index version or a cloud listing, and
 * nothing here matches anything of its own:
 *
 *  - a shared claim is one cloud id that resources on both sides are known by
 *    (the KNOWN_AS rows, with the same minimum length `deriveIdentityEdges`
 *    uses, so a short name never joins two estates by accident);
 *  - a reference across the sides is a REF row whose ends sit on different
 *    sides, of whatever origin: declared by chant, observed by an engine, or
 *    derived from identity, and each says which;
 *  - the substrates of a side are the lexicons of its resources, counted.
 *
 * What one side has no counterpart for is not computed here: that comparison
 * is chant's to answer. "Shared claim" is not "collision", which in behold is
 * work-item overlap (using/collisions.mdx).
 *
 * Pure: rows in, an answer out. It imports no node: module and stays out of
 * the server, so a page or a package may use it.
 */
import { IDENTITY_MIN_LENGTH, type LoadedRows, type ResourceRow } from "./rows.ts";

export type SideName = "left" | "right";

/** A resource that holds a claim, as the answer names it. */
export interface Claimant {
  key: string;
  member: string;
  name: string;
  kind: string;
  lexicon: string;
  source: string;
}

/** One cloud id that resources on both sides are known by. */
export interface SharedClaim {
  value: string;
  /** The cloud id's kind (arn, import-id, provider-id, ...). */
  kind: string;
  left: Claimant[];
  right: Claimant[];
}

/** A reference whose two ends sit on different sides. */
export interface CrossReference {
  /** The side the reference starts on. */
  from: SideName;
  fromKey: string;
  toKey: string;
  viaAttr: string;
  /** declared (chant's own), observed (an engine's) or derived (identity, behold#1022). */
  origin: string;
  rule: string;
  relation: string;
  ambiguous: boolean;
}

export interface SideSummary {
  members: Array<{ name: string; kind?: string; resources: number }>;
  resources: number;
  /** Cloud ids this side's resources are known by: a side with none can share none. */
  cloudIds: number;
  /** The lexicons of the side's resources, most first. */
  substrates: Array<{ lexicon: string; resources: number }>;
}

export interface EstateMerge {
  left: SideSummary;
  right: SideSummary;
  shared: SharedClaim[];
  references: CrossReference[];
  /** Resources in neither side: an index version or a cloud listing, which belong to no member. */
  unassigned: number;
  notes: string[];
}

export interface MergeSides {
  left: readonly string[];
  right: readonly string[];
}

/** A refusal for sides that cannot be compared, with the field it is about. */
export class MergeSidesRefused extends Error {
  constructor(
    message: string,
    readonly code: "sides-needed" | "unknown-member" | "overlapping-sides" | "empty-side",
  ) {
    super(message);
  }
}

/** Parse `left`/`right` query values: repeated or comma-separated, empty entries dropped. */
export function splitNames(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean))];
}

/**
 * The sides to compare. Given none, a served estate of exactly two members is
 * one member a side; anything else needs them named. Every name must be a
 * served member (a name, never a path), and no member may be on both sides.
 */
export function resolveSides(members: readonly string[], asked: { left?: readonly string[]; right?: readonly string[] }): MergeSides {
  const left = [...(asked.left ?? [])];
  const right = [...(asked.right ?? [])];
  if (!left.length && !right.length) {
    if (members.length === 2) return { left: [members[0]!], right: [members[1]!] };
    throw new MergeSidesRefused(
      members.length < 2 ? "an estate merge compares two sets of members, and this serve has fewer than two members" : `name the members on each side: ${members.length} members are served`,
      "sides-needed",
    );
  }
  if (!left.length || !right.length) throw new MergeSidesRefused(`a side has no members: give both left and right (${left.length ? "right" : "left"} is empty)`, "empty-side");
  const unknown = [...left, ...right].filter((m) => !members.includes(m));
  if (unknown.length) throw new MergeSidesRefused(`not a served member: ${[...new Set(unknown)].join(", ")}`, "unknown-member");
  const both = left.filter((m) => right.includes(m));
  if (both.length) throw new MergeSidesRefused(`a member is on both sides: ${both.join(", ")}`, "overlapping-sides");
  return { left, right };
}

/** ARM ids are matched case-insensitively (Resource Graph lowercases them), as ./rows.ts loads both spellings. */
const claimKey = (value: string): string => (/^\/subscriptions\//i.test(value) ? value.toLowerCase() : value);

/** The two sides compared, over the loaded rows. `kinds` names each member's kind for the summary. */
export function estateMerge(rows: LoadedRows, sides: MergeSides, kinds: ReadonlyMap<string, string> = new Map()): EstateMerge {
  const memberOfScope = new Map<string, string>();
  for (const s of rows.sources) if (s.member !== undefined) memberOfScope.set(s.scopeKey, s.member);
  const sideOfMember = new Map<string, SideName>();
  for (const m of sides.left) sideOfMember.set(m, "left");
  for (const m of sides.right) sideOfMember.set(m, "right");

  const resourceBy = new Map<string, ResourceRow>();
  const sideOfKey = new Map<string, SideName>();
  const memberOfKey = new Map<string, string>();
  let unassigned = 0;
  for (const r of rows.resources) {
    resourceBy.set(r.key, r);
    const member = memberOfScope.get(r.scopeKey);
    const side = member !== undefined ? sideOfMember.get(member) : undefined;
    if (member !== undefined && side) {
      sideOfKey.set(r.key, side);
      memberOfKey.set(r.key, member);
    } else unassigned++;
  }

  const claimant = (key: string): Claimant => {
    const r = resourceBy.get(key)!;
    return { key, member: memberOfKey.get(key)!, name: r.name, kind: r.kind, lexicon: r.lexicon, source: r.source };
  };

  // Shared claims: one cloud id, resources on both sides.
  const kindOfValue = new Map(rows.cloudIds.map((c) => [c.value, c.kind]));
  const byValue = new Map<string, { value: string; left: Set<string>; right: Set<string> }>();
  const idsOnSide: Record<SideName, Set<string>> = { left: new Set(), right: new Set() };
  for (const k of rows.knownAs) {
    const side = sideOfKey.get(k.key);
    if (!side) continue;
    idsOnSide[side].add(claimKey(k.value));
    if (k.value.length < IDENTITY_MIN_LENGTH) continue;
    const id = claimKey(k.value);
    const entry = byValue.get(id) ?? { value: k.value, left: new Set<string>(), right: new Set<string>() };
    entry[side].add(k.key);
    byValue.set(id, entry);
  }
  const shared: SharedClaim[] = [...byValue.values()]
    .filter((e) => e.left.size > 0 && e.right.size > 0)
    .map((e) => ({
      value: e.value,
      kind: kindOfValue.get(e.value) ?? "provider-id",
      left: [...e.left].sort().map(claimant),
      right: [...e.right].sort().map(claimant),
    }))
    .sort((a, b) => a.value.localeCompare(b.value));

  // References across: any REF whose ends are on different sides.
  const references: CrossReference[] = [];
  for (const r of rows.refs) {
    const from = sideOfKey.get(r.from);
    const to = sideOfKey.get(r.to);
    if (!from || !to || from === to) continue;
    references.push({ from, fromKey: r.from, toKey: r.to, viaAttr: r.viaAttr, origin: r.origin, rule: r.rule, relation: r.relation, ambiguous: r.ambiguous });
  }
  references.sort((a, b) => a.fromKey.localeCompare(b.fromKey) || a.toKey.localeCompare(b.toKey) || a.viaAttr.localeCompare(b.viaAttr));

  const summary = (side: SideName): SideSummary => {
    const names = side === "left" ? sides.left : sides.right;
    const own = rows.resources.filter((r) => sideOfKey.get(r.key) === side);
    const lex = new Map<string, number>();
    for (const r of own) lex.set(r.lexicon || "unknown", (lex.get(r.lexicon || "unknown") ?? 0) + 1);
    return {
      members: names.map((name) => ({ name, ...(kinds.get(name) ? { kind: kinds.get(name)! } : {}), resources: own.filter((r) => memberOfKey.get(r.key) === name).length })),
      resources: own.length,
      cloudIds: idsOnSide[side].size,
      substrates: [...lex].map(([lexicon, resources]) => ({ lexicon, resources })).sort((a, b) => b.resources - a.resources || a.lexicon.localeCompare(b.lexicon)),
    };
  };
  const left = summary("left");
  const right = summary("right");

  const notes: string[] = [];
  for (const [name, s] of [["left", left], ["right", right]] as const) {
    if (s.resources === 0) notes.push(`the ${name} side has no resources loaded, so it can share nothing`);
    else if (s.cloudIds === 0) notes.push(`the ${name} side carries no cloud ids (a source-only read has none; an engine document, an index version or a cloud listing supplies them), so it can share none`);
  }
  if (unassigned > 0) notes.push(`${unassigned} resources belong to no member (index versions and cloud listings) and are on neither side`);
  if (rows.refs.some((r) => r.origin === "derived")) notes.push("references with origin derived join an attribute value to a cloud id, and are drawn as derived because such a join can be wrong");
  return { left, right, shared, references, unassigned, notes };
}
