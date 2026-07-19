/**
 * Multi-estate composition (#31, headline of M4) — the app-of-apps view. behold
 * graphs N chant projects and composes their IRs into one estate via pinhole's
 * `composeStacks`: ids namespaced per project (`<project>/<nodeId>`), a
 * `groups.byStack` entry per project, and cross-stack edges from export↔import
 * handle matching (chant #513). Composition lives in the viewer, not chant —
 * behold just points at the projects.
 *
 * `groups.byStack` becomes an actual drawn boundary box (not just an IR field)
 * via `src/server.ts`'s `/api/graph` multi-estate branch passing `{ boxes:
 * "byStack" }` to `renderGraph` (src/render.ts) — see that module's doc comment
 * for why it's an explicit opt-in there rather than auto-detected.
 *
 * Source-level composition only (each project's `graphIr` call uses whatever
 * `opts` the request carries — an `env` reaches every composed project's own
 * chant the same way). A per-project env/live overlay (e.g. loomster live,
 * a second project source-only) is possible today by choosing `opts` per
 * project; that per-project targeting isn't wired into the HTTP API yet — see
 * the M4 report for what a proper "many live instances" estate would need.
 */
import { composeStacks, shortStackNames, type GraphIR } from "@intentius/pinhole";
import { graphIr, type GraphOptions } from "./chant.ts";

/** Graph each project's source and compose them into one estate IR. */
export async function composeEstate(projectDirs: string[], opts: GraphOptions = {}): Promise<GraphIR> {
  const names = shortStackNames(projectDirs); // readable per-project labels (common prefix stripped)
  const stacks = await Promise.all(
    projectDirs.map(async (dir, i) => ({ name: names[i], ir: await graphIr(dir, opts) })),
  );
  return composeStacks(stacks);
}
