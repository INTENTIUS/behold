/**
 * Declarations that are not this project's (chant#2058).
 *
 * chant's graph joins Ops "from the git root" (`discoverOps` walks up to
 * `git rev-parse --show-toplevel` and collects every `*.op.ts` beneath it,
 * packages/core/src/op/discover.ts) — so a project that shares a repository
 * with other chant projects graphs THEIR Ops too, with absolute `sourceLoc`
 * paths pointing outside itself. behold's carve demo showed four Ops from
 * sibling examples in a two-entity project's box.
 *
 * Until chant scopes discovery to the project (chant#2058), a node whose
 * declaring file resolves outside the project it was graphed from is dropped
 * here, with its edges and group memberships, and the routes say so on the
 * statusbar. The test is the file, not the kind: an Op declared INSIDE the
 * project keeps its place, and anything else chant ever reports from beyond
 * the root gets the same treatment. Relative `sourceLoc` paths are by
 * definition inside (chant reports them relative to what it graphed) and are
 * never touched. Pure — a new IR when anything was dropped, the same object
 * otherwise, so a cached member IR is never written into.
 */
import { isAbsolute, resolve, sep } from "node:path";
import type { GraphIR } from "@intentius/chant";

/** One dropped declaration: the node id and the file that put it outside. */
export interface ForeignDeclaration {
  id: string;
  kind: string;
  file: string;
}

/** The IR plus what was dropped from it — the routes read `foreign` for the note. */
export type GraphIRWithForeign = GraphIR & { foreign?: ForeignDeclaration[] };

export function dropForeignDeclarations(ir: GraphIR, projectDir: string): GraphIRWithForeign {
  const root = resolve(projectDir);
  const foreign: ForeignDeclaration[] = [];
  for (const n of ir.nodes) {
    const file = n.sourceLoc?.file;
    if (!file || !isAbsolute(file)) continue;
    const abs = resolve(file);
    if (abs === root || abs.startsWith(root + sep)) continue;
    foreign.push({ id: n.id, kind: n.kind, file });
  }
  if (foreign.length === 0) return ir;
  const gone = new Set(foreign.map((f) => f.id));
  const groups: GraphIR["groups"] = {};
  for (const [axis, members] of Object.entries(ir.groups ?? {})) {
    if (!members || typeof members !== "object") continue;
    const kept: Record<string, string[]> = {};
    for (const [box, ids] of Object.entries(members as Record<string, string[]>)) {
      const left = ids.filter((id) => !gone.has(id));
      if (left.length) kept[box] = left;
    }
    (groups as Record<string, unknown>)[axis] = kept;
  }
  return {
    ...ir,
    nodes: ir.nodes.filter((n) => !gone.has(n.id)),
    edges: ir.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
    groups,
    foreign,
  };
}

/** The statusbar clause for dropped declarations, or undefined when none. */
export function foreignNote(ir: { foreign?: ForeignDeclaration[]; nodes?: unknown[] }): string | undefined {
  const f = ir.foreign;
  if (!f || f.length === 0) return undefined;
  const named = f
    .slice(0, 3)
    .map((d) => d.id)
    .join(", ");
  const more = f.length > 3 ? ` +${f.length - 3}` : "";
  return `${f.length} declaration${f.length === 1 ? "" : "s"} outside this project dropped (${named}${more}) — chant graphs Ops from the git root (chant#2058)`;
}
