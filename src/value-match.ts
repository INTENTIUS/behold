/**
 * Value-matched edges — connect resources wired by a literal name/ARN VALUE
 * rather than a symbolic `$ref`. chant's source graph only draws an edge when
 * one resource references another through an attribute reference; a resource
 * that instead names another by its physical name (common with fixed names)
 * produces no symbolic ref, so the target floats even though it deploys wired.
 *
 * Example: an RDS instance sets `DBSubnetGroupName: "loom-…-subnet-group"` — a
 * plain string equal to the subnet group's OWN name. This pass indexes every
 * node's own-name value and, when another node carries that exact string in an
 * attribute, draws an inferred edge. It's the source-graph analogue of the live
 * reconstruction's identifier match (chant graph-refs.ts), but over declared
 * names instead of live physical ids.
 *
 * Kept deliberately conservative so it never invents wiring: own-name attrs
 * only (not reference attrs that happen to end in "Name"), values of a
 * meaningful length, a single unambiguous owner per value, and dedup against
 * declared edges. Inferred edges are tagged `inferred: true` so a viewer can
 * style them apart from declared refs.
 */
import type { GraphIR } from "@intentius/chant";

interface VNode {
  id: string;
  kind: string;
  attrs?: Record<string, unknown>;
}

/** Last segment of an `AWS::RDS::DBSubnetGroup`-style kind → `DBSubnetGroup`. */
function typeSegment(kind: string): string {
  const parts = kind.split("::");
  return parts[parts.length - 1] ?? kind;
}

/** Is `key` this node's OWN name attribute (its identity), rather than a
 * reference to some other resource's name? `DBSubnetGroupName` is the subnet
 * group's own name, but on an RDS instance the same key names a *different*
 * resource. True when the key's prefix (minus a trailing "Name") is part of the
 * node's own type, or the key is exactly "Name". */
export function isOwnNameAttr(kind: string, key: string): boolean {
  if (!/name$/i.test(key)) return false;
  const prefix = key.slice(0, -4).toLowerCase();
  if (prefix === "") return true;
  return typeSegment(kind).toLowerCase().includes(prefix);
}

/** Names shorter than this are too likely to collide (e.g. "db", "web") to
 * treat a bare string equality as a real reference. */
const MIN_NAME_LEN = 6;

/** Add inferred edges for resources wired by a literal name value. Mutates +
 * returns `ir`. */
export function addValueMatchEdges(ir: GraphIR): GraphIR {
  const nodes = ir.nodes as VNode[];

  // 1. Index each node's own-name value → owning node id. A value claimed by
  //    more than one owner is ambiguous (null) and never matched.
  const owner = new Map<string, string | null>();
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.attrs ?? {})) {
      if (typeof v !== "string" || v.length < MIN_NAME_LEN) continue;
      if (!isOwnNameAttr(n.kind, k)) continue;
      owner.set(v, owner.has(v) ? null : n.id);
    }
  }
  if (owner.size === 0) return ir;

  // 2. Dedup against declared edges (either direction is "already wired").
  const declared = new Set<string>();
  for (const e of ir.edges) declared.add(`${e.from}\0${e.to}`);

  // 3. Scan every node's string attr values for a match to some other node's
  //    own name → inferred edge (consumer → named resource).
  const added = new Set<string>();
  for (const a of nodes) {
    for (const [k, v] of Object.entries(a.attrs ?? {})) {
      if (typeof v !== "string" || v.length < MIN_NAME_LEN) continue;
      const b = owner.get(v);
      if (!b || b === a.id) continue; // unknown, ambiguous, or self
      const key = `${a.id}\0${b}`;
      if (declared.has(key) || added.has(key)) continue;
      added.add(key);
      ir.edges.push({ from: a.id, to: b, kind: "ref", viaAttr: k, inferred: true } as never);
    }
  }
  return ir;
}
