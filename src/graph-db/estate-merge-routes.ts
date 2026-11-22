/**
 * behold#1246: the estate merge route, a GET over the rows the graph pane
 * loaded (./estate-merge.ts). It acts on nothing and writes nothing.
 *
 *   GET /api/graphdb/estate-merge   ?left=<member>[,<member>]&right=<member>[,<member>]
 *
 * Both sides name served members (never paths). With neither given, an estate
 * of exactly two members compares them. The answer carries the same
 * `sources` stamps as the pane's other answers.
 *
 * A view rather than an Ask template: the template catalog is chant's
 * (./templates.ts keeps no copy), and a template takes one node, while this
 * takes two sets of members.
 */
import type { Context, Hono } from "hono";
import { stamps } from "./answers.ts";
import { estateMerge, MergeSidesRefused, resolveSides, splitNames } from "./estate-merge.ts";
import type { LoadedRows } from "./rows.ts";
import type { MemberRef } from "./sources.ts";

export const ESTATE_MERGE_ROUTES = [
  {
    method: "GET",
    path: "/api/graphdb/estate-merge",
    desc: "behold#1246: two sets of served members side by side: ?left=a,b&right=c (member names, or neither for an estate of two members) -> {left, right: members, resources, cloud ids and substrates per side; shared: cloud ids known on both sides, as shared claims; references: REF rows from one side into the other, each with its origin; unassigned; notes; sources}; 400 with the served members when the sides are missing, unknown or overlapping; 403 on --public",
  },
] as const;

export interface EstateMergeDeps {
  rows: () => Promise<{ rows: LoadedRows; builtAt: string }>;
  members: () => readonly MemberRef[];
  public?: boolean;
}

/** Mount the route. A GET; it acts on nothing. */
export function mountEstateMerge(app: Hono, deps: EstateMergeDeps): void {
  const refusePublic = (c: Context) =>
    deps.public ? c.json({ error: "a public view shows the declared source only, and a merge compares the cloud ids engine documents and index versions hold", code: "public", remedy: "Serve without --public to compare two estates." }, 403) : undefined;

  app.get("/api/graphdb/estate-merge", async (c) => {
    const pub = refusePublic(c);
    if (pub) return pub;
    const members = deps.members();
    const names = members.map((m) => m.name);
    let sides;
    try {
      sides = resolveSides(names, { left: splitNames(c.req.queries("left")), right: splitNames(c.req.queries("right")) });
    } catch (e) {
      if (e instanceof MergeSidesRefused) return c.json({ error: e.message, code: e.code, members: names, remedy: "Name the members on each side: ?left=<member>&right=<member>, each a comma-separated list of the served members above." }, 400);
      throw e;
    }
    const { rows, builtAt } = await deps.rows();
    const merge = estateMerge(rows, sides, new Map(members.map((m) => [m.name, m.kind])));
    return c.json({ members: names, builtAt, ...merge, sources: stamps(rows) });
  });
}
