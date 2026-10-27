/**
 * RETIRING (behold#1030): src/chant-edges.ts draws chant's derived edges
 * (chant#4522, #4523) where chant can, and runs this pass only as its
 * fallback. behold#1005 flipped src/chant-release.ts (chant 0.124.54), and
 * this module stays until the pulumi lexicon has a `referenceCatalog` and
 * choudoufu roster nodes are mapped to terraform's rules (chant#4535's note
 * on behold#1005); then delete it (the checklist on behold#1005).
 *
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
 *
 * ## Nested attributes (#166)
 *
 * Both halves used to read `Object.entries(attrs)` and `continue` on anything
 * that wasn't a string — which is every attribute a k8s node has. The #166
 * measurement put a number on it: on a mixed aws+k8s fixture whose Deployment
 * sets `ASSET_BUCKET` to a Bucket's literal `BucketName`, with the bucket
 * already in the owner index, this pass drew nothing, because the value lives
 * at `spec.template.spec.containers[].env[].value`. So the CONSUMER half now
 * walks to string leaves through objects and arrays, and `viaAttr` carries the
 * dotted path it found them at (`spec.…​.env.value`) — identical to today's bare
 * key for a top-level attr.
 *
 * The OWNER half stays shallow on purpose: an own-name key one level down is
 * still identity (`metadata.name` is what k8s calls a resource), but the same
 * key deeper down is not (`spec.template.spec.containers[].name` is a
 * CONTAINER's name, and indexing it would let a Deployment "own" the string
 * `web-frontend`). So the owner index reads top-level keys plus `metadata.*`,
 * and nothing else.
 */
import type { GraphIR } from "@intentius/chant";
import { stringLeaves } from "./attr-leaves.ts";

interface VNode {
  id: string;
  kind: string;
  attrs?: Record<string, unknown>;
}

/** Last segment of a kind, whichever shape the lexicon writes it in:
 * `AWS::RDS::DBSubnetGroup` → `DBSubnetGroup`, and Azure's slash form
 * `Microsoft.ContainerService/managedClusters` → `managedClusters` (#147 —
 * splitting on `::` alone made every Azure kind opaque to this pass, and azure
 * IRs carry no symbolic edges at all, so this pass was their only in-behold
 * edge source and it never fired). */
function typeSegment(kind: string): string {
  const parts = kind.split(kind.includes("::") ? "::" : "/");
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

/** Above this a string stops being a name and starts being a payload — a
 * rendered manifest in an annotation, a script, a certificate. Nothing that
 * long is a resource's own name, and equality against one is coincidence. */
const MAX_NAME_LEN = 200;

/** The cloud a kind belongs to, for the three whose kinds say so. A resource
 * in one cloud cannot name a resource in another by its literal name: a GCP
 * project id that happens to equal an Azure environment's name (the
 * three-cloud demo names both `three-cloud`) is coincidence, not wiring. A
 * kind outside the three (Kubernetes, a Terraform block) can still name a
 * cloud resource, as a Deployment names a bucket (#166). */
function cloudOf(kind: string): string | undefined {
  if (kind.startsWith("AWS::")) return "aws";
  if (kind.startsWith("Microsoft.")) return "azure";
  if (kind.startsWith("GCP::")) return "gcp";
  return undefined;
}

/** Is this string one a bare equality may be read as a reference? Applied to
 * both halves, so an owner whose name is a paragraph is not indexed either. A
 * name has no whitespace: anything that does is prose, a command line or a
 * rendered document. */
function joinable(v: string): boolean {
  return v.length >= MIN_NAME_LEN && v.length <= MAX_NAME_LEN && !/\s/.test(v);
}

/** Add inferred edges for resources wired by a literal name value. Mutates +
 * returns `ir`. */
export function addValueMatchEdges(ir: GraphIR): GraphIR {
  const nodes = ir.nodes as VNode[];

  // 1. Index each node's own-name value → owning node id. A value claimed by
  //    more than one owner is ambiguous (null) and never matched. Top-level
  //    keys and `metadata.*` only — see the module doc on why identity stops
  //    one level down.
  const owner = new Map<string, string | null>();
  for (const n of nodes) {
    for (const { path, key, value } of stringLeaves(n.attrs)) {
      if (path !== key && path !== `metadata.${key}`) continue;
      if (!joinable(value) || !isOwnNameAttr(n.kind, key)) continue;
      owner.set(value, owner.has(value) ? null : n.id);
    }
  }
  if (owner.size === 0) return ir;

  // 2. Dedup against declared edges (either direction is "already wired").
  const declared = new Set<string>();
  for (const e of ir.edges) declared.add(`${e.from}\0${e.to}`);

  // 3. Scan every node's string attr values — at any depth (#166) — for a match
  //    to some other node's own name → inferred edge (consumer → named
  //    resource). One edge per pair: the first path that matched names it.
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const added = new Set<string>();
  for (const a of nodes) {
    const from = cloudOf(a.kind);
    for (const { path, value } of stringLeaves(a.attrs)) {
      if (!joinable(value)) continue;
      const b = owner.get(value);
      if (!b || b === a.id) continue; // unknown, ambiguous, or self
      const to = cloudOf(kindOf.get(b) ?? "");
      if (from && to && from !== to) continue; // two clouds: coincidence
      const key = `${a.id}\0${b}`;
      if (declared.has(key) || added.has(key)) continue;
      added.add(key);
      ir.edges.push({ from: a.id, to: b, kind: "ref", viaAttr: path, inferred: true } as never);
    }
  }
  return ir;
}
