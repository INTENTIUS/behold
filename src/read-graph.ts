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
 * - Any other path, and a folder chant does not discover (below), is read as a
 *   one-member estate of whatever kind it is: a
 *   folder of `.tf` files, a choudoufu estate, a chant project.
 * - A folder with no declaration that chant can read by its kinds' probes (a
 *   Kubernetes or Helm tree, or a folder that mixes them with Terraform,
 *   from chant 0.124.98) is read through `chant workspace graph <dir>
 *   --discover` (behold#1079, src/discover-read.ts), as a workspace whose
 *   members chant found. A list of one path is that folder.
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
import { discoveredNote, discoverApplies, discoverWorkspace, readDiscovered, DiscoverError } from "./discover-read.ts";
import { REFERENCE_CATALOG_CHANT_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { applyReferenceCatalog, readReferenceCatalog, referenceCatalogOf, type CatalogIr, type CatalogReadDeps, type ReferenceCatalog } from "./reference-catalog.ts";
import { drawnMembers, hasDeclaration, readWorkspace, workspaceLookup, type DiscoveredDir, type Workspace } from "./workspace.ts";

export interface ReadGraphOptions extends GraphOptions {
  /** The declared workspace the paths are members of; none means loose. */
  workspace?: Workspace;
  /** The kube context cluster anchoring prefers. No kubeconfig is read here. */
  k8sContext?: string;
  /** Read members at detail 3 for the logical lens; the passes keep `detail`. */
  logical?: boolean;
  /** How the reference catalog is read (behold#1080). Tests hand it recorded documents; the default is chant. */
  catalog?: CatalogReadDeps;
  /**
   * Handed the composed members before any pass runs (behold#1115): the nodes
   * as chant read them, which the joined read hands to chant's catalog pass.
   * The passes then change them in place, so a caller that keeps them copies.
   */
  composed?: (ir: GraphIR) => void;
}

export interface ReadGraphResult {
  ir: GraphIR;
  members: { name: string; dir: string; kind: MemberKind }[];
  run: MemberPassRun;
  meta: { estate: number; note?: string; noteShort?: string; /** behold#1080: what the reference catalog could not say, and why a cluster anchor was declined. */ catalogNote?: string };
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

const meetsCatalogFloor = (chant: string | undefined): boolean => meetsFloor(chant, REFERENCE_CATALOG_CHANT_FLOOR);

/** The member paths and workspace `dir` stands for, as `behold serve <dir>` reads them. `graphOpts` are the options the members are read with, which a discovery carries too. */
async function resolveDirs(dir: string | readonly string[], workspace: Workspace | undefined, graphOpts: GraphOptions): Promise<{ dirs: readonly string[]; workspace: Workspace | undefined }> {
  // behold#1079: a folder with no declaration that chant can read by its kinds' probes (src/discover-read.ts says which). A list of one is the folder itself, as the server hands it over.
  const alone = typeof dir === "string" ? dir : dir.length === 1 ? dir[0] : undefined;
  if (alone !== undefined && !workspace && discoverApplies(alone)) {
    try {
      const { workspace: found } = await discoverWorkspace(alone, graphOpts);
      // Nothing claimed: the folder is read as it always was, which says so in its own words.
      // A member chant could not read is drawn as an unreadable box beside the others, as in a declared workspace.
      if (found.members.length) return { dirs: drawnMembers(found).map((m) => m.abs), workspace: found };
    } catch (e) {
      if (e instanceof DiscoverError) throw new ReadGraphError(e.refusal);
      throw e;
    }
  }
  if (typeof dir !== "string") return { dirs: dir, workspace };
  if (workspace) return { dirs: workspace.members.length ? drawnMembers(workspace).map((m) => m.abs) : [dir], workspace };
  if (!hasDeclaration(dir)) return { dirs: [dir], workspace: undefined };
  const read = await readWorkspace(dir);
  if (!read.ok) throw new ReadGraphError(read.refusal);
  // A declaration of no members (terragucci writes one for its gates) declares nothing to draw (#489).
  if (!read.workspace.members.length) return { dirs: [dir], workspace: undefined };
  return { dirs: drawnMembers(read.workspace).map((m) => m.abs), workspace: read.workspace };
}

/** Two notes as one: the long forms and the short forms each joined as the member kinds join theirs. */
function joinNotes(a: { note?: string; noteShort?: string }, b: { note?: string; noteShort?: string }): { note?: string; noteShort?: string } {
  const note = [a.note, b.note].filter(Boolean).join("; ");
  const short = [a.noteShort ?? a.note, b.noteShort ?? b.note].filter(Boolean).join(" · ");
  return note ? { note, ...(short && short !== note ? { noteShort: short } : {}) } : {};
}

/** Read `dir` into behold's graph. The module header says what each argument and answer is. */
export async function readGraph(dir: string | readonly string[], opts: ReadGraphOptions = {}): Promise<ReadGraphResult> {
  const { workspace: given, k8sContext, logical, catalog: catalogDeps, composed, ...graphOpts } = opts;
  const memberOpts = logical ? { ...graphOpts, detail: 3 } : graphOpts;
  const { dirs, workspace } = await resolveDirs(dir, given, memberOpts);
  const lookup = workspaceLookup(workspace);
  const members = estateMembers(dirs, lookup);
  const ir = await composeEstate(dirs, memberOpts, lookup);
  composed?.(ir);
  // behold#1080: chant's reference catalog for the whole workspace, which a read of one member cannot see.
  const found = workspace ? await catalogOf(workspace, memberOpts, catalogDeps) : undefined;
  const read = await readComposed(ir, members, dirs, {
    detail: graphOpts.detail,
    k8sContext,
    ...(workspace?.discovered ? { discovered: workspace.discovered } : {}),
    ...(found?.catalog ? { catalog: found.catalog } : {}),
    ...(found?.note ? { catalogNotes: [found.note] } : {}),
  });
  return { ir: read.ir, members: read.members, run: read.run, ...(workspace ? { workspace } : {}), meta: read.meta };
}

/**
 * The reference catalog of a workspace (behold#1080), or the note saying why a
 * chant at its floor could not give it. A folder read through `--discover`
 * already holds chant's whole-workspace document (the same read, cached by
 * src/discover-read.ts), so its catalog is taken from that and no second
 * `chant workspace graph` runs. A declared workspace is read once, behind
 * REFERENCE_CATALOG_CHANT_FLOOR; below it nothing is sent.
 */
async function catalogOf(workspace: Workspace, memberOpts: GraphOptions, deps: CatalogReadDeps | undefined): Promise<{ catalog?: ReferenceCatalog; note?: string }> {
  if (workspace.discovered) {
    try {
      const doc = await readDiscovered(workspace.root, memberOpts);
      const catalog = referenceCatalogOf(doc);
      if (catalog && meetsCatalogFloor(workspace.chant)) return { catalog };
    } catch {
      // A discovery that could not be read again has nothing to add; the folder's own read said so.
    }
    return {};
  }
  const found = await readReferenceCatalog(workspace.root, { ...memberOpts, chant: workspace.chant }, deps);
  if (found.ok) return { catalog: found.catalog };
  return found.reason === "error" ? { note: `reference catalog not read: ${found.message ?? "chant refused the read"}` } : {};
}

/**
 * The passes `readGraph` runs over a composed estate, for a caller whose
 * members did not come from directories (behold#1083: a cluster read through
 * chant's lister, src/read-cluster.ts). `dirs` are the directories the members
 * were read from, which the member kinds' notes name; none for a cluster. A
 * cluster read passes no `catalog` and is unchanged by behold#1080.
 */
export async function readComposed(
  composed: GraphIR,
  members: ReadGraphResult["members"],
  dirs: readonly string[],
  opts: { detail?: number; k8sContext?: string; discovered?: DiscoveredDir[]; catalog?: ReferenceCatalog; catalogNotes?: readonly string[] } = {},
): Promise<ReadGraphResult> {
  const { detail, k8sContext, discovered, catalog, catalogNotes = [] } = opts;
  let ir = composed;
  // #188: the edge passes are the Kubernetes half's only edge source, and they
  // join on attribute values, never node ids, so composed ids pass through and
  // a join across two members is the cross-member edge an estate needs. #166:
  // the declared contracts go first, since whichever pass runs first claims a
  // pair, and chant's catalog and identity passes fill what is left.
  ir = addK8sDeclaredEdges(ir);
  ir = await deriveGraphEdges(ir);
  // #166: a control-plane member's Kustomization or Application names the
  // directory it applies, and the estate knows each member by its checkout.
  ir = addEstateMemberEdges(ir, members);
  // #369: a choudoufu member's cross-estate data sources name a producer estate.
  ir = addChoudoufuReferenceEdges(ir);
  // behold#1080: chant's reference catalog, read once for the whole workspace
  // (a read of one member cannot see a reference into another), when the
  // workspace's chant is at its floor. What it finds replaces the guesses it
  // covers and is drawn by src/catalog-draw.ts; the cluster anchor reads it.
  if (catalog) applyReferenceCatalog(ir, catalog);
  // #234: an OperatorStack's CronJobs, named as the operating loop they are.
  ir = markOperatorHome(ir);
  // #103: the Kubernetes half joined to the managed cluster it runs on.
  ir = addClusterAnchorEdges(ir, k8sContext);
  // #379/#380/#382: each member kind's render passes (a Terraform card titled
  // by its type, boxed by root, its settings blocks left out at this detail).
  const run = applyMemberPasses(ir, { detail });
  const pass = memberPassNote(run, dirs);
  // behold#1079: what a discovery left unread, after the member kinds' own lines. A cluster read has no `discovered`.
  const note = discovered ? joinNotes(pass, discoveredNote(discovered)) : pass;
  let catalogNote: string | undefined;
  const clauses = [...catalogNotes, ...((ir as CatalogIr).anchorNotes ?? [])];
  if (clauses.length) {
    catalogNote = clauses.join(" · ");
    note.note = [note.note, ...clauses].filter(Boolean).join(" · ");
    if (note.noteShort) note.noteShort = [note.noteShort, ...clauses].join(" · ");
  }
  return {
    ir,
    members,
    run,
    meta: { estate: members.length, ...(catalogNote ? { catalogNote } : {}), ...(note.note ? { note: note.note } : {}), ...(note.noteShort ? { noteShort: note.noteShort } : {}) },
  };
}
