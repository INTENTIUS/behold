/**
 * An estate's components (#897): each member's component DAG, drawn in that
 * member's box, with the lines between members.
 *
 * chant projects one project's components at a time (`chant graph
 * --components`), so an estate's picture is put together here: every chant
 * member's DAG, its ids prefixed with the member's name the way composition
 * prefixes its resources, and its components boxed by member (`groups.byStack`).
 *
 * The lines inside a member are chant's own. The lines between members come
 * from the composed resource graph: a resource in one member that references
 * a resource in another (an output read as a parameter, src/estate-member-edges.ts)
 * is a line between the components that own the two. A resource belongs to the
 * member's only component when there is one, and otherwise to the component
 * whose directory declares it (`resourcesByComponent`, src/resources.ts).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import { resourcesByComponent } from "./resources.ts";

/** One member's component DAG, or why it couldn't be read. */
export interface MemberComponents {
  member: string;
  dag?: GraphIR;
  reason?: string;
}

export interface EstateComponents {
  ir: GraphIR;
  /** Members that declare no component. */
  empty: string[];
  /** Members whose components couldn't be read, and why. */
  unread: Array<{ member: string; reason: string }>;
}

/** The member a composed id belongs to: the part before the first `/`. */
function memberOf(id: string): string {
  const at = id.indexOf("/");
  return at < 0 ? "" : id.slice(0, at);
}

/** Put the members' DAGs together, and join them through the composed resource graph `entity`. Pure. */
export function estateComponents(members: MemberComponents[], entity: GraphIR): EstateComponents {
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const byStack: Record<string, string[]> = {};
  const empty: string[] = [];
  const unread: Array<{ member: string; reason: string }> = [];
  const ownerOf = new Map<string, string>();

  for (const { member, dag, reason } of members) {
    if (!dag) {
      unread.push({ member, reason: reason ?? "no answer" });
      continue;
    }
    if (!dag.nodes.length) {
      empty.push(member);
      continue;
    }
    const q = (id: string): string => `${member}/${id}`;
    for (const n of dag.nodes) nodes.push({ ...n, id: q(n.id), attrs: { ...n.attrs, member } });
    for (const e of dag.edges) edges.push({ ...e, from: q(e.from), to: q(e.to) });
    byStack[member] = dag.nodes.map((n) => q(n.id));

    // Which component owns each of this member's resources.
    const mine = entity.nodes.filter((n) => memberOf(n.id) === member);
    if (dag.nodes.length === 1) {
      for (const n of mine) ownerOf.set(n.id, q(dag.nodes[0]!.id));
    } else {
      const known = new Set(dag.nodes.map((n) => n.id));
      for (const [component, rs] of Object.entries(resourcesByComponent({ ...entity, nodes: mine }, known))) {
        for (const r of rs) ownerOf.set(r.id, q(component));
      }
    }
  }

  // A reference between two members' resources is a line between their components, drawn once.
  const seen = new Set(edges.map((e) => `${e.from}|${e.to}`));
  for (const e of entity.edges) {
    if (memberOf(e.from) === memberOf(e.to)) continue;
    const from = ownerOf.get(e.from);
    const to = ownerOf.get(e.to);
    if (!from || !to || from === to || seen.has(`${from}|${to}`)) continue;
    seen.add(`${from}|${to}`);
    edges.push({ from, to, kind: e.kind ?? "ref", ...(e.viaAttr ? { viaAttr: e.viaAttr } : {}) });
  }

  return { ir: { ...entity, nodes, edges, groups: { byStack } } as GraphIR, empty, unread };
}

/** What an estate's components picture leaves out, or undefined when it leaves nothing. */
export function estateComponentsNote(r: Pick<EstateComponents, "empty" | "unread">, drawn: number): string | undefined {
  const parts: string[] = [];
  if (!drawn) parts.push("no member declares a component (a `*.component.ts` file)");
  else if (r.empty.length) parts.push(`no components declared in ${r.empty.join(", ")}`);
  for (const u of r.unread) parts.push(`${u.member}'s components couldn't be read: ${u.reason}`);
  return parts.length ? parts.join(" · ") : undefined;
}

const SKIP = new Set(["node_modules", "dist", ".git", "export"]);

/** Whether a member directory declares a component: any `*.component.ts` under it, a few levels down. */
export function declaresComponents(dir: string, depth = 4): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".component.ts")) return true;
  }
  if (depth <= 0) return false;
  return entries.some((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".") && declaresComponents(join(dir, e.name), depth - 1));
}
