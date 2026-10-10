/**
 * A declared choudoufu member, read through `chant workspace graph` (#465).
 *
 * chant reads a choudoufu member through the terraform lexicon pinned in the
 * workspace (INTENTIUS/chant#2874): one node per BLOCK, ids
 * `<member>/<root>/<block path>`, the HCL's own references as edges, and
 * `file`, `line` and the estate's name on each node. That is the same block
 * graph behold used to get by running the lexicon itself in a scratch project
 * (src/choudoufu-refs.ts `readEstateLexicon`), so for a declared member the
 * contract read replaces it: the edges between the estate's own resources and
 * each block's place in the source come from chant.
 *
 * Two things behold still reads itself, from `choudoufu live-check -json`,
 * and this is why:
 *
 * - **The roster is per instance, and chant's graph is per block.** Ownership
 *   is two tags on each object, so `module.team_pod["pod-a"].aws_iam_role.
 *   pod_role[2]` is a card of its own, painted by `live-ls` on its own; one
 *   card for the `pod_role` block could not say which of its eight objects
 *   is unowned. The roster also sets the card ids, which is what keeps every
 *   saved layout and every overlay join (src/choudoufu-live.ts) matching: a
 *   declared member's cards are named exactly as before.
 * - **The rung and the cross-estate references are choudoufu's, and chant's
 *   graph carries neither.** A rung is choudoufu's verdict on a type
 *   (`tag-governable`, `declaration-carried`, `record-only`), and a reference
 *   is a data source filtered on ANOTHER estate's marker tags, which only
 *   choudoufu reads as an edge between estates. chant 0.102's graph node for
 *   a choudoufu member carries `address`, `estate`, `file`, `line`, `mode`,
 *   `root` and `source`, and no rung or reference.
 *
 * So the roster is choudoufu's, the topology is chant's, and the two are
 * joined by address the way src/choudoufu-refs.ts already joins a block graph
 * onto instances. The live half (`live-ls`, `live-plan`) paints the same
 * roster, so /api/graph and /api/overlay keep one topology. behold's own
 * lexicon read stays only for a loose view, a directory with no declaration.
 */
import type { GraphIR } from "@intentius/chant";
import { envOverridesFor, resolveChant, type GraphOptions } from "./chant.ts";
import { choudoufuLiveIr, choudoufuVia } from "./choudoufu-live.ts";
import { ChoudoufuReadError, captureChoudoufu, liveCheckToIr, readLiveCheck } from "./choudoufu-member.ts";
import { decomposeAddress, joinLexiconEdges, indexRoster } from "./choudoufu-refs.ts";
import type { MemberVia } from "./member-ir.ts";
import { memberIrFromGraphDocument, workspaceGraphArgs, type WorkspaceMember } from "./workspace.ts";
import { rootReader, type WorkspaceReader } from "./workspace-reader.ts";

type Runner = Parameters<typeof readLiveCheck>[1];

export interface ChoudoufuWorkspaceSeams {
  /** The workspace reader; a test hands in one that answers a recorded document. */
  reader?: (root: string, opts: GraphOptions) => WorkspaceReader;
  /** The choudoufu runner, for the roster and the live half. */
  run?: Runner;
}

/** chant's block graph for one member, as the member's own IR: ids `<root>/<block path>`. */
export async function memberBlockGraph(member: WorkspaceMember, root: string, seams: ChoudoufuWorkspaceSeams = {}): Promise<GraphIR> {
  // Source only, whatever the caller asked: the topology is the same live or
  // not, and chant's live read of a choudoufu member is not what paints it.
  const reader = (seams.reader ?? ((r, o) => rootReader(r, envOverridesFor(o))))(root, {});
  return memberIrFromGraphDocument(await reader.read("graph", workspaceGraphArgs(root, member.name, {})), member.name);
}

/** The root segment chant names a member's blocks under (`team-a` in `team-a/aws_iam_role.x`). */
function blockRoot(blocks: GraphIR): string | undefined {
  for (const n of blocks.nodes) {
    const root = (n.attrs as Record<string, unknown> | undefined)?.root;
    if (typeof root === "string") return root;
  }
  const first = blocks.nodes[0]?.id;
  return first?.includes("/") ? first.slice(0, first.indexOf("/")) : undefined;
}

/**
 * Join chant's block graph onto the roster, in place: each instance card gets
 * its block's `file` and `line`, and the block graph's edges become edges
 * between instance cards (src/choudoufu-refs.ts, rules 1 to 4). The roster's
 * own `reads` edges (cross-estate references) are kept.
 */
export function joinBlockGraph(roster: GraphIR, blocks: GraphIR): GraphIR {
  const root = blockRoot(blocks);
  if (!root) return roster;
  const byPath = new Map(blocks.nodes.map((n) => [n.id.startsWith(`${root}/`) ? n.id.slice(root.length + 1) : n.id, n] as const));
  for (const n of roster.nodes) {
    const block = byPath.get(decomposeAddress(n.id).blockPath);
    const a = block?.attrs as Record<string, unknown> | undefined;
    if (!a) continue;
    n.attrs = {
      ...n.attrs,
      ...(typeof a.file === "string" && n.attrs.file === undefined ? { file: a.file } : {}),
      ...(typeof a.line === "number" && n.attrs.line === undefined ? { line: a.line } : {}),
    };
  }
  const have = new Set(roster.edges.map((e) => `${e.from}\0${e.to}`));
  for (const e of joinLexiconEdges(blocks.edges, indexRoster(roster.nodes.map((n) => n.id)), root)) {
    if (have.has(`${e.from}\0${e.to}`)) continue;
    have.add(`${e.from}\0${e.to}`);
    roster.edges.push(e);
  }
  return roster;
}

/** How a declared choudoufu member is read: choudoufu's roster, chant's topology. */
export function choudoufuWorkspaceVia(member: WorkspaceMember, root: string, seams: ChoudoufuWorkspaceSeams = {}): MemberVia {
  const run = seams.run ?? captureChoudoufu;
  return {
    tool: (dir) => {
      const chant = resolveChant(root);
      return `workspace\0${chant.bin}\0${chant.version ?? ""}\0${choudoufuVia.tool(dir)}`;
    },
    read: async (dir, opts) => {
      const blocks = memberBlockGraph(member, root, seams);
      let roster: GraphIR;
      if (opts.live || opts.overlay) {
        roster = await choudoufuLiveIr(dir, opts, run);
      } else {
        const parsed = await readLiveCheck(dir, run);
        if (!parsed.ok) throw new ChoudoufuReadError(parsed.refusal, dir);
        roster = liveCheckToIr(parsed.doc);
      }
      return joinBlockGraph(roster, await blocks);
    },
  };
}
