/**
 * Read a directory, get behold's graph (behold#1057). The one function the
 * `/api/graph` route, the CLI and any later host call to turn a folder on disk
 * into the IR behold draws, with no server behind it.
 *
 *     readGraph(dir, opts?) => Promise<{ ir, members, run, meta }>
 *
 * `dir` is a path, or a list of paths.
 *
 * - A path with a `chant.workspace.json` that declares members is read as that
 *   workspace: chant lists the members (`readWorkspace`, one `chant workspace
 *   ls`) and each drawn member is read through the workspace contract, as
 *   `behold serve <root>` does. A declaration chant refuses throws a
 *   `ReadGraphError` carrying chant's refusal.
 * - Any other path is read as a one-member estate of whatever kind it is: a
 *   folder of `.tf` files, a choudoufu estate, a chant project.
 * - A list is read as given, one member per path. It belongs to the workspace
 *   `opts.workspace` names, and is loose when that is left out. This is the
 *   form the server uses, since it has already read the workspace it serves.
 *
 * `opts` is chant's `GraphOptions` (`detail`, `tier`, `target`, `env` and the
 * rest, passed to every member's read) plus:
 *
 * - `workspace`: the declared workspace the paths are members of. Given, it is
 *   used as it is and no declaration is read. It is an argument, never the
 *   process's served workspace, so two reads in one process can name two
 *   workspaces, or one and none.
 * - `k8sContext`: the kube context the estate is bound to, which anchors the
 *   Kubernetes half of a mixed estate to its managed cluster. Left out, no
 *   cluster is preferred and no kubeconfig is read: this module reads files,
 *   and resolving a context is the caller's choice (the server resolves the
 *   primary project's, as `boundK8sContext` in src/server.ts always has).
 * - `logical`: the read is for the logical lens, which needs every attribute,
 *   so members are read at detail 3 while the member passes keep `detail`.
 *
 * It answers:
 *
 * - `ir`: the composed estate, each member's ids under `<member>/`, after the
 *   edge passes (declared Kubernetes contracts, chant's derived edges or value
 *   match, the estate's own member edges, choudoufu's cross-estate references),
 *   the operator mark, cluster anchoring and each member kind's render passes.
 *   The route's lenses (collapse, stacking alike cards, plans, behaviour) and
 *   the SVG come after this and are not done here.
 * - `members`: each member's name, directory and kind, in the order of `ir`'s
 *   boxes.
 * - `run`: what the member kinds' passes did, which is what their notes are
 *   written from. A caller that re-ran the passes would get an empty run back,
 *   so it is handed over instead.
 * - `workspace`: the declared workspace read (or given), absent when loose.
 * - `meta`: `estate`, the number of members read, and `note`/`noteShort`, the
 *   member kinds' own lines (the roots a Terraform folder has, what it skipped,
 *   what this detail leaves out).
 *
 * The module imports nothing from `hono` (src/read-graph-imports.test.ts holds
 * that) and keeps no state of its own. Member reads still go through the
 * process's member cache (src/member-ir.ts), keyed by directory, so a second
 * read of an unchanged folder spawns nothing.
 *
 * Today only the estate branch of `/api/graph` reads through here. The route's
 * single-project branches (a chant project served alone, its logical and
 * components lenses) move over one at a time; until they do, a chant project
 * read here is drawn as a one-member estate, boxed under its name, where the
 * route draws it bare.
 */
import type { GraphIR } from "@intentius/chant";
import type { GraphOptions } from "./chant.ts";
import { deriveGraphEdges } from "./chant-edges.ts";
import { addChoudoufuReferenceEdges } from "./choudoufu-member.ts";
import { addClusterAnchorEdges } from "./cluster-anchor.ts";
import { composeEstate, estateMembers } from "./estate.ts";
import { addEstateMemberEdges } from "./estate-edges.ts";
import { addK8sDeclaredEdges } from "./k8s-edges.ts";
import { applyMemberPasses, memberPassNote, type MemberKind, type MemberPassRun } from "./member-kind.ts";
import { markOperatorHome } from "./operator.ts";
import { drawnMembers, hasDeclaration, readWorkspace, workspaceLookup, type Workspace } from "./workspace.ts";

export interface ReadGraphOptions extends GraphOptions {
  /** The declared workspace the paths are members of; none means loose. */
  workspace?: Workspace;
  /** The kube context cluster anchoring prefers. No kubeconfig is read here. */
  k8sContext?: string;
  /** Read members at detail 3 for the logical lens; the passes keep `detail`. */
  logical?: boolean;
}

export interface ReadGraphResult {
  ir: GraphIR;
  members: { name: string; dir: string; kind: MemberKind }[];
  run: MemberPassRun;
  meta: { estate: number; note?: string; noteShort?: string };
  /** The declared workspace the members were read from; absent for a loose read. */
  workspace?: Workspace;
}

/** A declaration chant would not read, with chant's own reason. */
export class ReadGraphError extends Error {
  constructor(readonly refusal: { error: string; code: string; remedy: string }) {
    super(refusal.error);
    this.name = "ReadGraphError";
  }
}

/** The member paths and workspace `dir` stands for, as `behold serve <dir>` reads them. */
async function resolveDirs(dir: string | readonly string[], workspace: Workspace | undefined): Promise<{ dirs: readonly string[]; workspace: Workspace | undefined }> {
  if (typeof dir !== "string") return { dirs: dir, workspace };
  if (workspace) return { dirs: workspace.members.length ? drawnMembers(workspace).map((m) => m.abs) : [dir], workspace };
  if (!hasDeclaration(dir)) return { dirs: [dir], workspace: undefined };
  const read = await readWorkspace(dir);
  if (!read.ok) throw new ReadGraphError(read.refusal);
  // A declaration of no members (terragucci writes one for its gates) declares nothing to draw (#489).
  if (!read.workspace.members.length) return { dirs: [dir], workspace: undefined };
  return { dirs: drawnMembers(read.workspace).map((m) => m.abs), workspace: read.workspace };
}

/** Read `dir` into behold's graph. The module header says what each argument and answer is. */
export async function readGraph(dir: string | readonly string[], opts: ReadGraphOptions = {}): Promise<ReadGraphResult> {
  const { workspace: given, k8sContext, logical, ...graphOpts } = opts;
  const { dirs, workspace } = await resolveDirs(dir, given);
  const lookup = workspaceLookup(workspace);
  const members = estateMembers(dirs, lookup);
  let ir = await composeEstate(dirs, logical ? { ...graphOpts, detail: 3 } : graphOpts, lookup);
  // #188: the edge passes are the Kubernetes half's only edge source, and they
  // join on attribute values, never node ids, so composed ids pass through and
  // a join across two members is the cross-member edge an estate needs. #166:
  // the declared contracts go first, since whichever pass runs first claims a
  // pair, and value match fills what is left.
  ir = addK8sDeclaredEdges(ir);
  ir = await deriveGraphEdges(ir);
  // #166: a control-plane member's Kustomization or Application names the
  // directory it applies, and the estate knows each member by its checkout.
  ir = addEstateMemberEdges(ir, members);
  // #369: a choudoufu member's cross-estate data sources name a producer estate.
  ir = addChoudoufuReferenceEdges(ir);
  // #234: an OperatorStack's CronJobs, named as the operating loop they are.
  ir = markOperatorHome(ir);
  // #103: the Kubernetes half joined to the managed cluster it runs on.
  ir = addClusterAnchorEdges(ir, k8sContext);
  // #379/#380/#382: each member kind's render passes (a Terraform card titled
  // by its type, boxed by root, its settings blocks left out at this detail).
  const run = applyMemberPasses(ir, { detail: graphOpts.detail });
  const note = memberPassNote(run, dirs);
  return {
    ir,
    members,
    run,
    ...(workspace ? { workspace } : {}),
    meta: { estate: dirs.length, ...(note.note ? { note: note.note } : {}), ...(note.noteShort ? { noteShort: note.noteShort } : {}) },
  };
}
