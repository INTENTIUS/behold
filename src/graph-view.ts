/**
 * behold#1058: the picture `/api/graph` draws for an estate, with no server.
 *
 *     graphView(dir, opts?) => Promise<{ ir, meta, read }>
 *
 * `readGraph` (src/read-graph.ts) answers the composed IR. The route then runs
 * lenses over it before it paints. This module holds the ones a program
 * reading a folder needs too, so the CLI (`behold graph`), the package
 * (`@intentius/behold`) and the route answer the same graph:
 *
 * - The plan, when `opts.terraformPlan` is given: each stock Terraform
 *   member's plan read through chant and painted on its cards
 *   (`attrs._plan`), plus a card per `count`/`for_each` instance. It is the
 *   server's `terraformPlan` setting, passed in, never read from the process. Off by
 *   default, since a plan refreshes every resource in a root.
 * - Collapse (`opts.collapse`): a box over the limit drawn as one card.
 * - Stacking alike cards (`opts.alike`, on by default as on the route).
 * - The note: the member kinds' own lines, the choudoufu lexicon line on a
 *   loose estate with no edges, the zoom that draws the same as resources,
 *   the plan's clause, the references to undeclared targets, and what the
 *   collapse and the stacking did, in the route's order.
 *
 * Left in the route: the logical and components lenses (their own read
 * paths), the declared-traffic prediction (it reads the person's saved
 * settings), and the SVG. A painter is an output format of its own
 * (src/graph-formats.ts), so an SVG or Mermaid emitter plugs in there and
 * reads the same view.
 *
 * Like `readGraph`, it imports nothing from `hono` and keeps no state
 * (src/read-graph-imports.test.ts walks this module too).
 */
import type { GraphIR } from "@intentius/chant";
import { collapseBoxes, collapseNote } from "./collapse-lens.ts";
import { choudoufuLexiconNote } from "./choudoufu-refs.ts";
import { addInstanceCards } from "./instance-cards.ts";
import { drawCatalog } from "./catalog-draw.ts";
import { readGraph, type ReadGraphOptions, type ReadGraphResult } from "./read-graph.ts";
import { stackAlike, stackNote } from "./stack-lens.ts";
import { paintTerraformPlan, readTerraformPlan, terraformPlanNote, type MemberPlanAnswer, type PlanReadDeps } from "./terraform-plan.ts";
import { danglingNote, unchangedZoomNote, type Zoom } from "./zoom-notes.ts";

export interface GraphViewOptions extends ReadGraphOptions {
  /** Stack alike cards and count crowded references, as the route does unless `?alike=0`. Default true. */
  alike?: boolean;
  /** Draw a box over the limit as one summary card (`?collapse=1`). Default false. */
  collapse?: boolean;
  /** Read and paint each stock Terraform member's plan (`?plan=1`), with the server's plan settings (`{}` for the defaults). */
  terraformPlan?: PlanReadDeps;
}

export interface GraphViewMeta {
  /** How many members were read. */
  estate: number;
  /** The zoom this view is: `composites`, `resources` or `attributes`, from `detail`. */
  zoom: Zoom;
  note?: string;
  /** The strip's form of `note`, when there is a shorter true one. */
  noteShort?: string;
}

export interface GraphView {
  /** The graph as drawn: after the plan, the collapse and the stacking. */
  ir: GraphIR;
  meta: GraphViewMeta;
  /** What `readGraph` answered, before the lenses. Its `ir` is the expanded graph the notes read. */
  read: ReadGraphResult;
}

/** The zoom a source read at `detail` is, as the route names it. */
export function zoomOf(detail: number | undefined): Zoom {
  return detail === 1 ? "composites" : detail === 3 ? "attributes" : "resources";
}

/**
 * The collapse and stacking lenses over an estate's IR, and the clause that
 * says what they did. Pure. The route calls this for an estate, and
 * `graphView` does.
 */
export function shapeEstate(ir: GraphIR, opts: { collapse?: boolean; alike?: boolean }): { ir: GraphIR; note?: string } {
  let out = ir;
  let note: string | undefined;
  if (opts.collapse) {
    const shut = collapseBoxes(out);
    out = shut.ir;
    note = collapseNote(shut.collapsed);
  }
  if (opts.alike !== false) {
    const stacked = stackAlike(out);
    out = stacked.ir;
    note = [note, stackNote(stacked)].filter(Boolean).join(" · ") || undefined;
  }
  return { ir: out, ...(note ? { note } : {}) };
}

/** The clauses a source view's note is made of, each already worded. */
export interface ViewNoteParts {
  /** Said first: a lens that was asked for and does not apply. */
  lens?: string;
  /** The member kinds' own note and its short form (`memberPassNote`). */
  pass?: { note?: string; noteShort?: string };
  /** The choudoufu lexicon line. */
  lexicon?: string;
  /** A zoom that draws the same as resources on this estate. */
  sameZoom?: string;
  plan?: string;
  /** References to targets not declared here. */
  dangling?: string;
  /** What the collapse and the stacking did. */
  shaped?: string;
  /** The single-project caption, consulted only when none of the clauses above the dangling one says anything. */
  fallback?: () => string | undefined;
}

/**
 * The note and its short form, in the order the route has always joined them
 * (#393 items 1, 5 and 7; #396; #554). `noteShort` is only given when it says
 * less than `note`.
 */
export function viewNote(p: ViewNoteParts): { note?: string; noteShort?: string } {
  const own = [p.lens, p.pass?.note, p.lexicon, p.sameZoom, p.plan].filter(Boolean).join(" · ");
  const note = [own || p.fallback?.(), p.dangling, p.shaped].filter(Boolean).join(" · ") || undefined;
  const short =
    p.pass?.noteShort || p.sameZoom
      ? [p.lens, p.pass?.noteShort ?? p.pass?.note, p.lexicon, p.sameZoom, p.plan, p.dangling, p.shaped].filter(Boolean).join(" · ")
      : undefined;
  return { ...(note ? { note } : {}), ...(short && short !== note ? { noteShort: short } : {}) };
}

/** Each stock Terraform member's plan, painted on `ir`, and the statusbar clause for them. */
async function paintPlans(ir: GraphIR, read: ReadGraphResult, deps: PlanReadDeps): Promise<string | undefined> {
  const terraform = read.members.filter((m) => m.kind === "terraform");
  const answers: MemberPlanAnswer[] = await Promise.all(
    terraform.map(async (m) => {
      const res = await readTerraformPlan(m.dir, deps);
      if (!res.ok) return { member: m.name, refusal: res.refusal };
      paintTerraformPlan(ir, res.read, m.name);
      return { member: m.name, roots: res.read.roots };
    }),
  );
  addInstanceCards(ir);
  return terraformPlanNote(answers);
}

/** Read `dir` and run the source view's lenses over it. The module header says which. */
export async function graphView(dir: string | readonly string[], opts: GraphViewOptions = {}): Promise<GraphView> {
  const { alike, collapse, terraformPlan, ...readOpts } = opts;
  return viewOf(await readGraph(dir, readOpts), { alike, collapse, terraformPlan, detail: readOpts.detail });
}

/**
 * A cluster read through a kubeconfig context (behold#1083, src/read-cluster.ts)
 * with the same lenses over it: stacking alike cards and collapse. There is no
 * plan to paint. The refusals `readCluster` throws pass through.
 */
export async function clusterView(read: ReadGraphResult, opts: Pick<GraphViewOptions, "alike" | "collapse" | "detail"> = {}): Promise<GraphView> {
  const n = read.ir.dangling?.length ?? 0;
  // The route's wording is for a project's source (a workflow in another repo); a cluster's references name objects the read did not list.
  return viewOf(read, { ...opts, danglingText: n ? `${n} ${n === 1 ? "reference names an object" : "references name objects"} this read did not list` : "" });
}

async function viewOf(read: ReadGraphResult, opts: Pick<GraphViewOptions, "alike" | "collapse" | "terraformPlan" | "detail"> & { danglingText?: string }): Promise<GraphView> {
  const { alike, collapse, terraformPlan } = opts;
  const zoom = zoomOf(opts.detail);
  // The plan paints the read's own IR, as the route paints the IR it read.
  const planNote = terraformPlan ? await paintPlans(read.ir, read, terraformPlan) : undefined;
  const expanded = read.ir;
  const shaped = shapeEstate(expanded, { collapse: collapse === true, alike: alike !== false });
  // #465: a declared member's edges are chant's, read through the workspace,
  // so behold's own lexicon only speaks for a loose choudoufu member.
  const lexicon = expanded.edges.length === 0 && !read.workspace && read.members.some((m) => m.kind === "choudoufu") ? choudoufuLexiconNote() : undefined;
  const note = viewNote({
    pass: read.meta,
    lexicon,
    sameZoom: unchangedZoomNote(zoom, read.members.map((m) => m.kind)),
    plan: planNote,
    dangling: opts.danglingText !== undefined ? opts.danglingText || undefined : danglingNote(expanded),
    shaped: shaped.note,
  });
  // behold#1080: chant's dangling and ambiguous references, drawn on what the stacking left.
  return { ir: drawCatalog(shaped.ir), meta: { estate: read.meta.estate, zoom, ...note }, read };
}
