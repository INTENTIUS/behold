/**
 * Cross-member estate edges (#166) — the edge a GitOps estate is FOR.
 *
 * The #166 measurement counted them: neither bundled estate draws a single edge
 * across a member boundary, at any detail tier. flux-estate's
 * `control-plane/appA` Kustomization declares `path:
 * ./example-flux-estate/app-a/manifests`; the member whose manifests those are
 * sits right there in the same composed IR as `app-a/deployment` and
 * `app-a/service` — and nothing joined the two, because every join in
 * `src/k8s-edges.ts` keys on `kind\0namespace\0name` and a `spec.path` is none
 * of those. So the estate rendered as N boxes side by side with the defining
 * relation — this control plane delivers that app — missing.
 *
 * ## The join
 *
 * A control-plane member declares a directory it applies:
 *
 *   Flux  `Kustomization.spec.path`            → "reconciles"
 *   Argo  `Application.spec.source.path`       → "delivers"
 *   Argo  `Application.spec.sources[].path`    → "delivers"
 *
 * behold already knows each member by its checkout directory (it is what the
 * operator pointed `behold serve` at). `pathAlignment` (src/estate.ts, #221)
 * aligns the two: the declared path's leading segments must equal a member
 * directory's trailing segments, and the REMAINDER of the declared path must
 * exist as a real directory under that member. That on-disk check is what makes
 * this a join on declared data rather than on name similarity — a Kustomization
 * whose path merely resembles a member's name matches nothing.
 *
 * The same function already decides where a member's live read is scoped (#221),
 * so the edge drawn here and the namespace a member is observed in come from one
 * reading of one declaration. Its refusals are inherited whole: an absolute path,
 * a `..` escape, a path aimed at a PARENT of the member, and a path a member
 * merely sits beside all score 0.
 *
 * ## Where the edge lands: the member's entry nodes
 *
 * A member is a box of many cards, and a controller applies all of them — but
 * drawing one arrow per card restates what the box already says and turns a
 * 20-object member into a hairball. So the edge lands on the member's ENTRY
 * nodes: the ones nothing INSIDE that member already points at. The member's own
 * derived edges carry the rest, which is what makes this containment-respecting
 * — one crossing per boundary per root, and the box's interior unchanged. On
 * flux-estate's app-a that is the Service (the Deployment is already the
 * Service's selector target), so the estate reads
 * `control-plane/appA → app-a/service → app-a/deployment`.
 *
 * Only cards of the reconciler's OWN lexicon are candidates. A GitOps controller
 * applies Kubernetes objects; the `Temporal::Op` card every bundled member also
 * carries (its `ops/` directory, chant 0.52) is that project's own operation,
 * not something Flux or Argo delivers — and it is an entry node by the rule
 * above, so without this it would collect an arrow saying otherwise.
 *
 * Consequence for ordering: this pass runs AFTER the intra-member joins
 * (`addK8sDeclaredEdges`, `addValueMatchEdges`), since it reads the edges they
 * derived to decide what an entry node is. A member with no entry node at all
 * (every node pointed at from within — a cycle) falls back to all of its nodes
 * rather than drawing nothing.
 *
 * ## What is refused
 *
 * - Any join a `pathAlignment` of 0 gives, and any path two members claim
 *   equally well (ambiguous → no edge, the discipline #221 and the cluster
 *   anchor both follow).
 * - A member delivering itself: the split across projects is the premise.
 * - `HelmRelease.spec.chart.spec.chart`: a chart path is relative to the source
 *   and names a chart directory, not a chant project — matching one against a
 *   member checkout would be an accident when it hit.
 * - `ApplicationSet` generator templates: the path is a template expanded per
 *   generated element (`{{path}}`), so what is declared is not a path.
 * - Argo's `spec.source.repoURL` and Flux's `GitRepository.spec.url`: a repo URL
 *   is not a member of this estate — behold knows members by checkout, and two
 *   objects sharing a URL is value-match's business, not a delivery.
 *
 * Edges are tagged `inferred: true` with a `viaAttr` naming what the controller
 * does, matching `deriveK8sEdges`'s contract so the two compose in the server's
 * pipeline. Pure (given `isDir`); `addEstateMemberEdges` mutates + returns `ir`.
 */
import { statSync } from "node:fs";
import type { GraphIR, IRNode } from "@intentius/chant";
import { pathAlignment } from "./estate.ts";

/** One composed member: the name `composeStacks` namespaced its ids with, and
 * the checkout directory behold read it from. */
export interface EstateMember {
  name: string;
  dir: string;
}

export interface EstateMemberEdge {
  from: string;
  to: string;
  kind: "ref";
  viaAttr: string;
  inferred: true;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

const realIsDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A path a controller declares it applies, and the verb its kind applies with. */
export interface Delivery {
  /** The node id declaring it (already member-namespaced). */
  from: string;
  path: string;
  viaAttr: string;
}

/** Every delivery one node declares. Empty for anything that is not one of the
 * two reconciler kinds — see the module doc for what is deliberately absent. */
export function declaredDeliveries(n: IRNode): Delivery[] {
  const spec = rec(n.attrs?.spec);
  if (n.kind === "K8s::Flux::Kustomization") {
    const path = str(spec?.path);
    return path ? [{ from: n.id, path, viaAttr: "reconciles" }] : [];
  }
  if (n.kind === "K8s::Argo::Application") {
    // Argo 2.6+ multi-source Applications declare `sources[]` instead of
    // `source`; both spellings carry the same `path` field.
    const sources = [spec?.source, ...(Array.isArray(spec?.sources) ? spec.sources : [])];
    const out: Delivery[] = [];
    for (const s of sources) {
      const path = str(rec(s)?.path);
      if (path) out.push({ from: n.id, path, viaAttr: "delivers" });
    }
    return out;
  }
  return [];
}

/** The member each composed node belongs to, read from `composeStacks`' own
 * `groups.byStack` (authoritative — a node id can itself contain a `/`), with
 * the id-prefix convention as the fallback for an IR that carries no groups.
 * Only members the caller named are indexed. */
function membershipOf(ir: GraphIR, members: readonly EstateMember[]): Map<string, string> {
  const named = new Set(members.map((m) => m.name));
  const byStack = (ir.groups as Rec | undefined)?.byStack;
  const out = new Map<string, string>();
  const grouped = rec(byStack);
  if (grouped) {
    for (const [name, ids] of Object.entries(grouped)) {
      if (!named.has(name) || !Array.isArray(ids)) continue;
      for (const id of ids) if (typeof id === "string") out.set(id, name);
    }
  }
  if (out.size > 0) return out;
  // Longest name first: one member's name can prefix another's.
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  for (const n of ir.nodes) {
    const m = byLength.find((c) => n.id.startsWith(`${c.name}/`));
    if (m) out.set(n.id, m.name);
  }
  return out;
}

/**
 * Derive the cross-member delivery edges over a composed estate IR. `members`
 * pairs each composed stack name with the directory it was read from — the one
 * fact the composed IR does not carry and the join cannot be made without.
 * Pure (given `isDir`).
 */
export function deriveEstateMemberEdges(
  ir: GraphIR,
  members: readonly EstateMember[],
  isDir: (p: string) => boolean = realIsDir,
): EstateMemberEdge[] {
  if (members.length < 2) return []; // a one-member "estate" has nothing to cross
  const memberOf = membershipOf(ir, members);
  if (memberOf.size === 0) return [];

  const present = new Set(ir.nodes.map((n) => n.id));
  // Nodes something INSIDE the same member already points at — the entry set is
  // everything else. Cross-member edges (another control plane's) do not count:
  // they are the boundary crossing, not the member's own structure.
  const pointedAt = new Set<string>();
  for (const e of ir.edges) {
    const from = memberOf.get(e.from);
    if (from && from === memberOf.get(e.to)) pointedAt.add(e.to);
  }
  const entryNodes = (name: string, lexicon: string | undefined): string[] => {
    const own = ir.nodes.filter((n) => memberOf.get(n.id) === name && n.lexicon === lexicon).map((n) => n.id);
    const entries = own.filter((id) => !pointedAt.has(id));
    return entries.length > 0 ? entries : own;
  };

  const out: EstateMemberEdge[] = [];
  const seen = new Set<string>();
  for (const n of ir.nodes) {
    const home = memberOf.get(n.id);
    if (!home) continue;
    for (const delivery of declaredDeliveries(n)) {
      // The member the declared path points at, most specific reading first.
      let winner: { name: string; score: number } | undefined;
      let tied = false;
      for (const m of members) {
        if (m.name === home) continue; // a member never delivers itself
        const score = pathAlignment(delivery.path, m.dir, isDir);
        if (score === 0) continue;
        if (!winner || score > winner.score) {
          winner = { name: m.name, score };
          tied = false;
        } else if (score === winner.score) {
          tied = true;
        }
      }
      if (!winner || tied) continue;
      for (const to of entryNodes(winner.name, n.lexicon)) {
        if (!present.has(to) || to === delivery.from) continue;
        const key = `${delivery.from}\0${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ from: delivery.from, to, kind: "ref", viaAttr: delivery.viaAttr, inferred: true });
      }
    }
  }
  return out;
}

/**
 * Add the cross-member edges to a composed estate IR, deduped against whatever
 * is already there — the same contract as `addK8sDeclaredEdges` and
 * `addValueMatchEdges`, so the passes compose in the server's pipeline. Runs
 * after them: see the module doc on entry nodes.
 */
export function addEstateMemberEdges(
  ir: GraphIR,
  members: readonly EstateMember[],
  isDir: (p: string) => boolean = realIsDir,
): GraphIR {
  const existing = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  for (const e of deriveEstateMemberEdges(ir, members, isDir)) {
    const key = `${e.from}\0${e.to}`;
    if (existing.has(key)) continue;
    existing.add(key);
    ir.edges.push(e as never);
  }
  return ir;
}
