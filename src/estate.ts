/**
 * Multi-estate composition (#31) — the app-of-apps view. behold graphs N chant
 * projects and composes their IRs into one estate via pinhole's `composeStacks`:
 * ids namespaced per project, per-project `byStack` boundary boxes, and cross-stack
 * edges from export↔import handle matching (chant #513). Composition lives in the
 * viewer, not chant — behold just points at the projects.
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
