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

/** The estate-wide overlay's composition report (#189). */
export interface EstateOverlayResult {
  ir: GraphIR;
  /** How many projects were actually observed live. */
  observed: number;
  total: number;
  /** Live observe failed; the project's SOURCE graph is in `ir`, every node
   * painted `neutral` + `_unobserved` (#1089's tri-state: unobserved ≠
   * absent) rather than dropped from the picture. */
  unobserved: { name: string; reason: string }[];
  /** Even the source graph failed — the project is absent from `ir`. */
  dropped: { name: string; reason: string }[];
}

/** A short human reason from a failure. ChantCliError's message leads with
 * the full invocation line — the part after "exited N: " is chant's own
 * words, which is what a note (or an inspect pane) should carry. */
const firstLine = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/exited \d+:\s*([\s\S]*)/);
  return (m ? m[1] : msg).split("\n")[0].trim().slice(0, 160);
};

/**
 * The estate-wide live overlay (#189): overlay each project and compose the
 * results, rather than composing sources and overlaying only the primary —
 * "behold your whole estate, coloured by drift" was 1/N projects true before
 * this. One `env` name reaches every composed project's own chant (the same
 * threading `composeEstate` does; per-project env mapping is a future
 * decision the issue records). Reads run concurrently with per-project
 * failure isolation: one unreachable cluster degrades that project to its
 * source graph painted `unobserved`, never blanks the estate; a project
 * whose source can't even be graphed is dropped and reported.
 *
 * `classify` is the per-project post-pass (the caller's reclassifyOverlay) —
 * a parameter so this module stays composition-only.
 */
export async function composeEstateOverlay(
  projectDirs: string[],
  opts: GraphOptions,
  classify: (ir: GraphIR) => GraphIR,
): Promise<EstateOverlayResult> {
  const names = shortStackNames(projectDirs);
  const unobserved: { name: string; reason: string }[] = [];
  const dropped: { name: string; reason: string }[] = [];
  const stacks: ({ name: string; ir: GraphIR } | undefined)[] = new Array(projectDirs.length);
  await Promise.all(
    projectDirs.map(async (dir, i) => {
      const name = names[i];
      try {
        stacks[i] = { name, ir: classify(await graphIr(dir, { ...opts, live: true, overlay: true })) };
      } catch (err) {
        const reason = firstLine(err);
        try {
          // Source fallback WITHOUT env/live: the declared shape, honestly
          // tagged as not-looked-at rather than absent.
          const { env: _env, live: _live, overlay: _overlay, ...srcOpts } = opts;
          const src = await graphIr(dir, srcOpts);
          for (const n of src.nodes) n.attrs = { ...n.attrs, _status: "neutral", _unobserved: reason };
          stacks[i] = { name, ir: src };
          unobserved.push({ name, reason });
        } catch (err2) {
          dropped.push({ name, reason: firstLine(err2) });
        }
      }
    }),
  );
  const present = stacks.filter((s): s is { name: string; ir: GraphIR } => !!s);
  return {
    ir: composeStacks(present),
    observed: present.length - unobserved.length,
    total: projectDirs.length,
    unobserved,
    dropped,
  };
}
