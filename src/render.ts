/**
 * Painter — behold reuses pinhole's mature SVG painter as a library (pinhole #82).
 * pinhole lays the IR out (dagre, no native dep) and paints it; its `_status`
 * colouring already speaks the overlay vocabulary (managed/foreign/pending) —
 * chant #821 (source-anchored overlay, shipped 0.18.31) feeds it, see
 * src/overlay.ts. behold owns the live data + the server + (later) the
 * temporal/action layers around this.
 */
import {
  layoutIr,
  layoutArchitecture,
  renderSvg,
  renderMorphHtml,
  cardSizes,
  registerPack,
  type GlyphSpec,
  type GroupBox,
  type MorphView,
  type Status,
} from "@intentius/pinhole";
import type { GraphIR, IRGroups, Layout } from "@intentius/chant";
import type { ByContainer } from "./logical.ts";
import { k8sIconFor, helmIconFor } from "./icon-packs.ts";
import { carveCardFields } from "./carve-lens.ts";
import { carveProgress, splitCarveState, type CarveState } from "./carve-manifest.ts";
import { opCardFields } from "./ops-lens.ts";

// Lexicon-native icons (#227), step 2 of 2. pinhole resolves a node's glyph
// through a chain — per-node override → lexicon pack → keyword heuristic →
// generic — and 0.3.0 lets a pack answer with its own geometry (`{ body,
// colored, viewBox }`) instead of naming one of the 21 built-in line glyphs.
// src/icon-packs.ts holds the kind → vendored-mark mapping; this is where it
// meets the painter. Every SVG behold emits goes through this module, so
// registering here covers the graph, the architecture view, the overlay,
// `behold export` and the static snapshots in one move.
//
// The registry is process-global and keyed by lexicon, so this runs ONCE at
// module load, before any renderSvg call. A kind neither pack answers for
// returns undefined and falls through pinhole's chain untouched — the keyword
// heuristic is a better answer than a wrong picture.
registerPack({ lexicon: "k8s", iconFor: k8sIconFor });
registerPack({ lexicon: "helm", iconFor: helmIconFor });

// The carve lens (#252) registers a pack for its `terraform` lexicon to pin the
// two fields a peelability card shows — the score and the verdict. Without it
// pinhole's default template picks the first two short scalar attrs in
// ALPHABETICAL order, which on a carve node is "band" then "dynamic": true, and
// the number the whole report exists to communicate never reaches the card. No
// `iconFor` opinion: the keyword heuristic already resolves aws_s3_bucket,
// aws_vpc, aws_subnet and aws_lambda_function to sensible glyphs, and guessing
// per Terraform type here would be a worse picture than the one it produces.
registerPack({ lexicon: "terraform", iconFor: () => undefined, fields: carveCardFields });

// The ops lens (#284) registers its own `op` lexicon for the same reason: a step
// card must lead with the phase it sits in and the retry profile it runs under,
// and alphabetical order would lead with `args`. No `iconFor` opinion either —
// a step's kind IS the activity's function name (`awsApply`, `httpCheck`,
// `chantBuild`), which pinhole's keyword heuristic already reads better than a
// per-activity table behold would have to keep in step with every lexicon.
registerPack({ lexicon: "op", iconFor: () => undefined, fields: opCardFields });

export interface RenderResult {
  svg: string;
}

/** Paint the logical/architecture view (#63) — pinhole's `layoutArchitecture`
 * (chant#74) nests the resource cards inside their container boxes (VPC ⊃ subnet
 * ⊃ component ⊃ resource, per `byContainer`) and routes the surviving edges
 * between them; `renderSvg` paints the nested boundary boxes. behold's own title
 * band is suppressed (the SPA header owns it). */
export function renderArchitecture(
  ir: GraphIR,
  byContainer: ByContainer,
  opts: {
    theme?: string;
    /** Box KEY → mark (pinhole#119's `GroupBox.mark`, #331's structural keys)
     * — e.g. `operatorHomeBoxMarks` (src/operator.ts). Applied after layout,
     * matched on `GroupBox.id` (the same `byContainer` key, pinhole#103), so a
     * caller never has to know a box's rendered title. Absent = every box
     * renders exactly as before this option existed. */
    groupMarks?: Readonly<Record<string, string | GlyphSpec>>;
  } = {},
): RenderResult {
  // Spacing nudge by edge density: the projected graph can be nearly complete
  // (every workload wired to the gateway/each other), so a dense edge set bundles
  // into overlapping corridors. Spread nodes further apart the tighter the graph
  // is — `spread` runs 0 (a tree) → 1.5 (very dense) — giving the edges more room
  // to fan out, rather than a blunt uniform bump. Sparse graphs keep pinhole's
  // compact defaults (nodesep 48 / ranksep 60).
  const spread = Math.min(1.5, ir.edges.length / Math.max(ir.nodes.length, 1));
  const layout = layoutArchitecture(ir, byContainer, {
    fit: true,
    nodesep: Math.round(48 + spread * 48),
    ranksep: Math.round(60 + spread * 56),
  });
  if (opts.groupMarks) {
    for (const box of layout.groups ?? []) {
      const mark = box.id !== undefined ? opts.groupMarks[box.id] : undefined;
      if (mark !== undefined) box.mark = mark;
    }
  }
  const svg = renderSvg(ir, layout, {
    fit: true,
    hideTitle: true,
    groups: layout.groups,
    ...(opts.theme ? { theme: opts.theme as never } : {}),
  });
  return { svg };
}

/** `groups.byWave` (component DAG, M1.0 spike) and `groups.byStack` (multi-
 * estate composition, #31/M4 — pinhole's `composeStacks` per-project grouping):
 * name → member node ids. Declared locally because behold's pinned
 * `@intentius/chant` predates `byWave`; a served project's own (newer) chant
 * still emits it on the IR JSON, this just types the read. Drop `byWave` once
 * behold's chant dependency ships it (spike note: chant 0.18.27+). */
type ExtraGroups = IRGroups & { byWave?: Record<string, string[]>; byStack?: Record<string, string[]> };

/** Paint a graph IR into an SVG document. Title is behold's job (the SPA header),
 * so pinhole's own title band is suppressed.
 *
 * Boundary boxes, via pinhole's existing grouped/compound layout: when the IR
 * carries `groups.byWave` (chant's component-DAG projection) each wave draws as
 * a titled box, auto-detected — no caller opt-in needed. The multi-estate view
 * (#31/M4, `composeEstate`) wants `groups.byStack` boxed instead (one box per
 * composed project) — deliberately NOT auto-detected the same way, because a
 * single (non-composed) project's own `chant graph` IR also carries a
 * `groups.byStack` field, but there it's a lexicon partition (see
 * src/resources.ts), not a project boundary — auto-boxing it would surprise
 * every M1–M3 view with an unrequested box. A caller that knows it's rendering
 * a composed estate opts in explicitly via `opts.boxes: "byStack"`.
 *
 * `opts.boxes: "byContainer"` (#86) is the runtime tier's opt-in, same shape:
 * `src/overlay.ts`'s `attachRuntimeContainment` populates `groups.byContainer`
 * (owner entity id → its live, undeclared runtime children, chant#1180/#1077)
 * on the live-overlay render path, which passes this explicitly — same
 * "caller knows" discipline as `byStack`, since a source-only or component-DAG
 * graph never carries a meaningful `byContainer` to box. */
export function renderGraph(ir: GraphIR, opts: { theme?: string; boxes?: "byStack" | "byContainer"; radial?: boolean } = {}): RenderResult {
  const groups = ir.groups as ExtraGroups;
  const boxKey = groups.byWave ? "byWave" : opts.boxes;
  const boxes = boxKey ? groups[boxKey] : undefined;
  const layout = layoutIr(ir, { fit: true, ...(boxes ? { groups: boxes } : {}) });
  // Radial layout (opt-in): dagre lays a wide DAG out in horizontal ranks that
  // sprawl off-screen. Re-place the same nodes on concentric rings — one ring
  // per rank — so the graph curls around a centre and far more fits in view. Only
  // for ungrouped graphs (the entity/infra view); the wave-boxed component graph
  // keeps its lanes.
  if (opts.radial && !boxes) radializeLayout(layout as unknown as RadialLayout, groupKeyByNode(ir), footprints(ir));
  // Otherwise, pull disconnected islands in: dagre strings each connected
  // component out along a row, so a few unconnected composites sprawl far to the
  // right of the action. Pack the components into compact shelves instead (a
  // no-op when the graph is a single connected component).
  else if (!boxes) packComponents(layout as unknown as RadialLayout, ir);
  // A composed estate's member boxes get the same treatment (#296): dagre lays
  // the member clusters out along one horizontal band, so an 11-member estate
  // rendered ~45k units wide and 316 tall. Wrap the boxes into rows instead.
  else if (boxKey === "byStack" && boxes) packMemberBoxes(layout, ir, boxes);
  const svg = renderSvg(ir, layout, {
    fit: true,
    hideTitle: true,
    ...(boxes ? { groups: layout.groups } : {}),
    ...(opts.theme ? { theme: opts.theme as never } : {}),
  });
  return { svg };
}

/**
 * Paint a BANDED graph — a ranking, not a topology — as stacked, titled panels
 * with their members in a grid. The carve lens (#252) is the case: a peelability
 * report is a ranked list in three bands, and (until chant#1636 publishes the
 * boundary edge lists) it arrives with no edges at all.
 *
 * It needs its own layout because dagre has nothing to work with here. Every
 * node is its own connected component, so they all land in rank 0 and stretch
 * out along a single row: the eight-resource sample estate laid out 2433px wide
 * and 316 tall, and a 150-resource estate 40680 x 316 — a picture no viewport
 * can show. Grid-wrapping inside each band keeps the whole thing near a screen's
 * aspect at any size, and stacking the bands top-to-bottom makes the graph read
 * in the same order the report's own console output does.
 *
 * Groups come from `ir.groups.byStack` in insertion order, so the caller decides
 * the band order. Each panel is tinted with its members' shared `attrs._status`
 * when they agree, which is how the band colour reaches the panel border and its
 * title as well as the cards. Any node no group claims lands in a trailing
 * panel rather than vanishing.
 */
export function renderBanded(ir: GraphIR, opts: { theme?: string } = {}): RenderResult {
  const plan = bandedPlan(ir, (ir.groups.byStack ?? {}) as Record<string, string[]>);
  const height = plan.height;
  const layout: Layout = {
    width: plan.width,
    height,
    nodes: plan.placed.map((p) => ({ id: p.id, x: p.x, y: height - p.y })),
  };
  const svg = renderSvg(ir, layout, {
    fit: true,
    hideTitle: true,
    groups: plan.boxes.map((b) => ({ ...b, y: height - b.y })),
    ...(opts.theme ? { theme: opts.theme as never } : {}),
  });
  return { svg };
}

// Shared metrics for the banded grid and the estate frame that wraps it.
const GAP = 28; // between cards
const PAD = 24; // panel inner padding
const TITLE = 34; // panel title band (pinhole draws its title at y + 23)
const BAND_GAP = 26; // between panels
const MEMBER_GAP = 48; // between the estate's member boxes

/** The banded grid, before it becomes a picture: positions and panel boxes in
 * y-DOWN coordinates (first band on top, the way the ranking reads) with a
 * local (0,0) origin, so a caller can either flip and paint it as-is
 * (`renderBanded`) or offset it into a larger composition first
 * (`renderCarveEstate`). */
interface BandedPlan {
  placed: Array<{ id: string; x: number; y: number }>;
  boxes: GroupBox[];
  width: number;
  height: number;
}

function bandedPlan(ir: GraphIR, bands: Record<string, string[]>): BandedPlan {
  const size = footprints(ir);
  const dims = (id: string) => size.get(id) ?? { w: NODE_W, h: NODE_H };

  // A uniform cell keeps the grid a grid (cards centre in their cell), and a
  // uniform panel width stacks the bands as an aligned column.
  const ids = ir.nodes.map((n) => n.id);
  const cellW = Math.max(NODE_W, ...ids.map((id) => dims(id).w));
  const cellH = Math.max(NODE_H, ...ids.map((id) => dims(id).h));
  // Aim at a landscape picture rather than a square one — the graph pane is
  // wider than it is tall once the side panel takes its share.
  const cols = Math.max(1, Math.round(Math.sqrt((ids.length * (cellH + GAP) * 2) / (cellW + GAP))));
  const contentW = cols * cellW + (cols - 1) * GAP;
  const panelW = contentW + PAD * 2;

  // Nodes no band claims still get drawn — a renderer that silently drops a node
  // is worse than one that shows an unlabelled panel.
  const claimed = new Set(Object.values(bands).flat());
  const orphans = ids.filter((id) => !claimed.has(id));
  const panels: Array<[string, string[]]> = [
    ...Object.entries(bands).map(([title, members]) => [title, members.filter((id) => size.has(id))] as [string, string[]]),
    ...(orphans.length ? ([["unbanded", orphans]] as Array<[string, string[]]>) : []),
  ].filter(([, members]) => members.length > 0);

  const statusOf = new Map(ir.nodes.map((n) => [n.id, n.attrs?._status as Status | undefined]));
  const placed: Array<{ id: string; x: number; y: number }> = [];
  const boxes: GroupBox[] = [];
  let top = 0;
  for (const [title, members] of panels) {
    const rows = Math.ceil(members.length / cols);
    const panelH = TITLE + PAD + rows * cellH + (rows - 1) * GAP + PAD;
    members.forEach((id, i) => {
      placed.push({
        id,
        x: PAD + (i % cols) * (cellW + GAP) + cellW / 2,
        y: top + TITLE + PAD + Math.floor(i / cols) * (cellH + GAP) + cellH / 2,
      });
    });
    // Tint only when the band speaks with one voice — a mixed panel gets the
    // plain border rather than one member's colour standing for all of them.
    const statuses = new Set(members.map((id) => statusOf.get(id)));
    const status = statuses.size === 1 ? [...statuses][0] : undefined;
    boxes.push({ title, x: panelW / 2, y: top + panelH / 2, w: panelW, h: panelH, ...(status ? { status } : {}) });
    top += panelH + BAND_GAP;
  }
  return { placed, boxes, width: panelW, height: Math.max(1, top - BAND_GAP) };
}

/** The carve estate frame (#254): the banded peelability ranking inside a
 * titled Terraform member box, with the served demo's chant project in its own
 * box beside it — the estate view opens on a migration already half-done, and
 * the morph at the end of the walkthrough has somewhere to land.
 *
 * The composed IR is returned alongside the SVG because the caller serves it
 * to the SPA: app-side node ids are namespaced `<member>/<id>` (composeStacks'
 * convention) so they can never collide with a Terraform address, while the
 * ranked TF addresses keep their ids untouched — the morph's identity
 * continuity (#230 M2b) depends on the carved card keeping its id across
 * views. `groups.byStack` on the composed IR carries the bands plus the app
 * member, so the client's box matcher sees every box it is shown.
 *
 * `carved` (#230 M3) is the carve state manifests chant persisted — the
 * strangler-fig's memory. It decides which side of the estate a ranked address
 * draws on, so the picture is the same after a restart as it was before one;
 * see src/carve-manifest.ts. Absent (or empty) it is a no-op and this renders
 * exactly the #254 frame. */
export function renderCarveEstate(
  tfIr: GraphIR,
  appIr: GraphIR,
  opts: {
    tfTitle: string;
    appTitle: string;
    theme?: string;
    carved?: Map<string, CarveState>;
    shorten?: (path: string) => string;
  },
): RenderResult & { ir: GraphIR } {
  const staged = withCarveState(tfIr, appIr, opts);
  const comp = composeCarveEstate(staged.tf, staged.appNs, { ...opts, carvedTitle: staged.carvedTitle });
  const svg = renderSvg(comp.ir, comp.layout, {
    fit: true,
    hideTitle: true,
    groups: comp.boxes,
    ...(opts.theme ? { theme: opts.theme as never } : {}),
  });
  return { svg, ir: comp.ir };
}

/**
 * The manifest overlay, applied to both halves of the estate at once (#230 M3).
 *
 * Graduated addresses come out of the TF ranking and go into the chant box
 * keeping their Terraform address as their id — the same identity continuity
 * the morph relies on, which is what makes a restart show the card ALREADY in
 * the chant box rather than a different card in a similar place. Partial
 * carves stay in their band, repainted (src/carve-manifest.ts `splitCarveState`).
 *
 * The chant panel's title carries the progress read, because the panel is where
 * the estate already summarizes this member's contents. The denominator is the
 * ranking's own size BEFORE the split: a graduated resource left the ranking,
 * and counting it out of both halves would make the progress bar shrink as it
 * filled.
 */
function withCarveState(
  tfIr: GraphIR,
  appIr: GraphIR,
  opts: { appTitle: string; carved?: Map<string, CarveState>; shorten?: (path: string) => string },
): { tf: GraphIR; appNs: GraphIR; carvedTitle: string } {
  const states = opts.carved ?? new Map<string, CarveState>();
  const { tf, graduated } = splitCarveState(tfIr, states, { ...(opts.shorten ? { shorten: opts.shorten } : {}) });
  const ns = namespaceAppIr(appIr, opts.appTitle);
  const progress = carveProgress(states.values(), tfIr.nodes.length);
  return {
    tf,
    appNs: { ...ns, nodes: [...ns.nodes, ...graduated] },
    carvedTitle: states.size ? `carved so far — ${progress.label}` : "carved so far",
  };
}

/** App-side node ids get the member prefix (`app/<id>`, composeStacks'
 * convention) so they can never collide with a Terraform address. The carved
 * nodes the morph moves INTO the app box deliberately skip this — they keep
 * their TF address, which is what makes the card glide instead of swap. */
function namespaceAppIr(appIr: GraphIR, appTitle: string): GraphIR {
  const prefix = `${appTitle.split(" ")[0]}/`;
  const appId = (id: string) => `${prefix}${id}`;
  return {
    ...appIr,
    nodes: appIr.nodes.map((n) => ({ ...n, id: appId(n.id) })),
    edges: appIr.edges.map((e) => ({ ...e, from: appId(e.from), to: appId(e.to) })),
    groups: {},
  };
}

/** One composed estate frame, render-ready: layout and boxes in renderSvg's
 * y-up plane — the same plane pinhole's `MorphView` reads, so a composition
 * serves both the static SVG and one morph view. */
interface EstateComposition {
  ir: GraphIR;
  layout: Layout;
  boxes: GroupBox[];
}

function composeCarveEstate(
  tfIr: GraphIR,
  appNs: GraphIR,
  opts: { tfTitle: string; appTitle: string; carvedTitle?: string },
): EstateComposition {
  const tfPlan = bandedPlan(tfIr, (tfIr.groups.byStack ?? {}) as Record<string, string[]>);
  // The app side reuses the banded grid as a single panel: same cell metrics
  // discipline, and the panel title says what these cards have in common —
  // plus the manifest-backed progress read when there is one (#230 M3).
  const appPlan = bandedPlan(appNs, { [opts.carvedTitle ?? "carved so far"]: appNs.nodes.map((n) => n.id) });

  // Two member boxes, top-aligned, TF on the left where the ranking's weight
  // is. Content sits inside each member at (PAD, TITLE + PAD).
  const memberH = (plan: BandedPlan) => TITLE + PAD + plan.height + PAD;
  const memberW = (plan: BandedPlan) => plan.width + PAD * 2;
  const appX0 = memberW(tfPlan) + MEMBER_GAP;
  const width = appX0 + memberW(appPlan);
  const height = Math.max(memberH(tfPlan), memberH(appPlan));

  const offset = (plan: BandedPlan, x0: number) => ({
    placed: plan.placed.map((p) => ({ id: p.id, x: x0 + PAD + p.x, y: TITLE + PAD + p.y })),
    boxes: plan.boxes.map((b) => ({ ...b, x: x0 + PAD + b.x, y: TITLE + PAD + b.y })),
  });
  const tf = offset(tfPlan, 0);
  const app = offset(appPlan, appX0);

  // Member boxes first so the inner band panels draw on top of them.
  const boxes: GroupBox[] = [
    { title: opts.tfTitle, x: memberW(tfPlan) / 2, y: memberH(tfPlan) / 2, w: memberW(tfPlan), h: memberH(tfPlan) },
    { title: opts.appTitle, x: appX0 + memberW(appPlan) / 2, y: memberH(appPlan) / 2, w: memberW(appPlan), h: memberH(appPlan) },
    ...tf.boxes,
    ...app.boxes,
  ];

  const ir: GraphIR = {
    nodes: [...tfIr.nodes, ...appNs.nodes],
    edges: [...tfIr.edges, ...appNs.edges],
    groups: {
      byStack: {
        ...((tfIr.groups.byStack ?? {}) as Record<string, string[]>),
        [opts.appTitle]: appNs.nodes.map((n) => n.id),
      },
    },
  };
  return {
    ir,
    layout: {
      width,
      height,
      nodes: [...tf.placed, ...app.placed].map((p) => ({ id: p.id, x: p.x, y: height - p.y })),
    },
    boxes: boxes.map((b) => ({ ...b, y: height - b.y })),
  };
}

/** The carve morph (#230 M2b): two estate frames — Terraform owns the carved
 * resource / chant owns it — as one self-contained morph artifact. The carved
 * card keeps its TF address in both views, so pinhole's FLIP glides it out of
 * its band and into the chant box while the boxes resize around it; the band
 * panels and both member boxes share titles across views, so they morph too.
 * (Morph badges are pinhole's neutral fill by design (#107), so the after view
 * marks ownership in the carved node's attrs — the inspector shows
 * `carved → chant` — rather than in the badge colour.) */
export function renderCarveMorph(
  tfIr: GraphIR,
  appIr: GraphIR,
  carved: string[],
  opts: {
    tfTitle: string;
    appTitle: string;
    title?: string;
    carved?: Map<string, CarveState>;
    shorten?: (path: string) => string;
  },
): string {
  // The BEFORE frame is the estate as it stands, manifests included (#230 M3):
  // a resource that graduated in a previous session is already in the chant box
  // when the morph opens, so the one card that moves is the one this morph is
  // about. Selecting an address that has already graduated is therefore a
  // no-movement morph — which is the truth, not a bug.
  const staged = withCarveState(tfIr, appIr, opts);
  const appNs = staged.appNs;
  // Both views keep the PLAIN panel title, not the progress one the estate
  // frame uses: a box morphs to the box with the same title, and a title that
  // counted the cards would read "N of M" in a frame showing N+1 of them and
  // break the FLIP into a swap. The progress read lives on the estate view.
  const morphOpts = { ...opts, carvedTitle: "carved so far" };
  const before = composeCarveEstate(staged.tf, appNs, morphOpts);

  const gone = new Set(carved);
  const bands = (staged.tf.groups.byStack ?? {}) as Record<string, string[]>;
  const bandsAfter: Record<string, string[]> = {};
  for (const [band, members] of Object.entries(bands)) {
    const left = members.filter((id) => !gone.has(id));
    if (left.length) bandsAfter[band] = left;
  }
  const tfAfter: GraphIR = {
    nodes: staged.tf.nodes.filter((n) => !gone.has(n.id)),
    edges: staged.tf.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
    groups: { byStack: bandsAfter },
  };
  const carvedNodes = staged.tf.nodes
    .filter((n) => gone.has(n.id))
    .map((n) => ({ ...n, attrs: { ...n.attrs, _status: "good", carve: "carved → chant" } }));
  const appAfter: GraphIR = { ...appNs, nodes: [...appNs.nodes, ...carvedNodes] };
  const after = composeCarveEstate(tfAfter, appAfter, morphOpts);

  const view = (name: string, comp: EstateComposition): MorphView => ({
    name,
    ir: comp.ir,
    layout: comp.layout,
    groups: comp.boxes,
  });
  return renderMorphHtml([view("Terraform owns it", before), view("chant owns it", after)], {
    title: opts.title ?? `carve morph — ${carved.join(", ")}`,
  });
}

/** Re-place a laid-out graph's nodes on concentric rings by dagre rank (the
 * layout's discrete Y levels), so a wide horizontal DAG becomes a compact radial
 * one. Each ring's radius grows enough to seat its nodes without crowding
 * (circumference ≥ total node width), and rank 0 sits at/near the centre.
 * Mutates `layout.X`/`layout.Y` in place; edges re-anchor to the new centres. */
interface RadialLayout {
  nodes: Array<{ id: string; x: number; y: number }>;
  width: number;
  height: number;
}

/** Typical card width/height — fallbacks when a node has no computed footprint
 * (radial arc capacity still uses the typical width as its packing unit). */
const NODE_W = 175;
const NODE_H = 104;

/** Per-node painted footprints for the fit layout — pinhole's own `cardSizes`,
 * the same source `layoutIr`/`renderSvg` size cards from. The packing passes
 * used to assume every card was NODE_W wide; with `fit: true` a long-titled
 * card grows to ~420px (a synthesized `release/<ns>/<name>` card, exactly the
 * nodes that arrive edgeless and get packed), so islands were shelved by a
 * width half their painted size and landed on their neighbours. */
function footprints(ir: GraphIR): Map<string, { w: number; h: number }> {
  const sizes = cardSizes(ir, { fit: true });
  return new Map(Object.entries(sizes));
}

/** Pack a laid-out graph's disconnected components into compact shelves, so a few
 * unconnected islands don't string out far to the right of the main cluster
 * (dagre lays each connected component along its own row). Connected components
 * are found by union-find over the IR edges; each keeps its internal dagre layout
 * and is translated as a rigid block. Components are shelf-packed biggest-first
 * into a roughly square target width, so the main cluster anchors top-left and
 * the islands tuck in beside/below it. No-op for a single-component graph.
 * Mutates node x/y and the layout bounds; edges re-anchor to the new centres. */
function packComponents(layout: RadialLayout, ir: GraphIR): void {
  const nodes = layout.nodes;
  if (!Array.isArray(nodes) || nodes.length < 2) return;
  const idxOf = new Map(nodes.map((n, i) => [n.id, i]));
  const parent = nodes.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (const e of ir.edges) {
    const a = idxOf.get(e.from);
    const b = idxOf.get(e.to);
    if (a != null && b != null) parent[find(a)] = find(b);
  }
  const comps = new Map<number, RadialLayout["nodes"]>();
  nodes.forEach((n, i) => (comps.get(find(i)) ?? comps.set(find(i), []).get(find(i))!).push(n));
  if (comps.size < 2) return; // a single connected component — dagre is already compact

  // Bounding box per component — each card centre padded by half its own
  // PAINTED footprint, not a one-size constant (see `footprints`).
  const size = footprints(ir);
  const halfW = (n: { id: string }) => (size.get(n.id)?.w ?? NODE_W) / 2;
  const halfH = (n: { id: string }) => (size.get(n.id)?.h ?? NODE_H) / 2;
  const boxes = [...comps.values()].map((ns) => {
    const minX = Math.min(...ns.map((n) => n.x - halfW(n)));
    const minY = Math.min(...ns.map((n) => n.y - halfH(n)));
    return {
      ns,
      minX,
      minY,
      w: Math.max(...ns.map((n) => n.x + halfW(n))) - minX,
      h: Math.max(...ns.map((n) => n.y + halfH(n))) - minY,
    };
  });
  boxes.sort((a, b) => b.w * b.h - a.w * a.h); // biggest cluster first (anchors top-left)

  const gap = 56;
  const totalArea = boxes.reduce((s, b) => s + (b.w + gap) * (b.h + gap), 0);
  const targetW = Math.max(boxes[0].w, Math.sqrt(totalArea) * 1.3); // roughly square
  let shelfX = 0;
  let shelfY = 0;
  let shelfH = 0;
  for (const b of boxes) {
    if (shelfX > 0 && shelfX + b.w > targetW) {
      shelfX = 0;
      shelfY += shelfH + gap;
      shelfH = 0;
    }
    const dx = shelfX - b.minX;
    const dy = shelfY - b.minY;
    for (const n of b.ns) {
      n.x += dx;
      n.y += dy;
    }
    shelfX += b.w + gap;
    shelfH = Math.max(shelfH, b.h);
  }

  // Shift to positive coords + reset bounds so renderSvg's viewBox wraps it —
  // card EDGES, not centres, so a wide fitted card doesn't clip at the border.
  const minX = Math.min(...nodes.map((n) => n.x - halfW(n)));
  const minY = Math.min(...nodes.map((n) => n.y - halfH(n)));
  const pad = 60;
  for (const n of nodes) {
    n.x = n.x - minX + pad;
    n.y = n.y - minY + pad;
  }
  layout.width = Math.max(...nodes.map((n) => n.x + halfW(n))) + pad;
  layout.height = Math.max(...nodes.map((n) => n.y + halfH(n))) + pad;
}

/** Wrap a composed estate's member boxes into rows (#296). Dagre's compound
 * layout strings the (mostly disjoint) member clusters out along one horizontal
 * band, so an 11-member estate came back `viewBox="0 0 45631 316"` — an
 * unreadable ribbon. Each member box plus its nodes moves as a rigid block:
 * blocks keep the composed order (composeStacks' insertion order, the order the
 * caller chose) and wrap into shelves aimed at a roughly square canvas — the
 * same target-width idiom as `packComponents`, minus its biggest-first sort,
 * because here the reading order IS the order. Nodes no member claims
 * (estate.ts's unjoined runtime nodes) pack after the members, one block per
 * connected component. Fewer than four members stay one band: a pair of boxes
 * side by side is already readable, and the pre-#296 pictures shouldn't move.
 * Mutates node/box x/y and the layout bounds; renderSvg routes edges from node
 * centres, so cross-member edges re-anchor on their own. */
function packMemberBoxes(layout: RadialLayout & { groups?: GroupBox[] }, ir: GraphIR, members: Record<string, string[]>): void {
  const boxes = layout.groups ?? [];
  if (boxes.length < 4) return;
  const nodes = layout.nodes;
  const size = footprints(ir);
  const halfW = (n: { id: string }) => (size.get(n.id)?.w ?? NODE_W) / 2;
  const halfH = (n: { id: string }) => (size.get(n.id)?.h ?? NODE_H) / 2;

  // Work in screen space (y-down) so the shelves read top-to-bottom once
  // renderSvg flips y; flipped back against the NEW height at the end.
  for (const n of nodes) n.y = layout.height - n.y;
  for (const b of boxes) b.y = layout.height - b.y;

  // One rigid block per member box: the box rect unioned with its members'
  // painted card rects (they should already sit inside, but a card that leaks
  // must not land on a neighbour).
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const claimed = new Set<string>();
  interface Block {
    ns: RadialLayout["nodes"];
    box?: GroupBox;
    minX: number;
    minY: number;
    w: number;
    h: number;
  }
  const blocks: Block[] = boxes.map((box) => {
    const ns = (members[box.id ?? box.title] ?? members[box.title] ?? []).flatMap((id) => byId.get(id) ?? []);
    for (const n of ns) claimed.add(n.id);
    let minX = box.x - box.w / 2;
    let maxX = box.x + box.w / 2;
    let minY = box.y - box.h / 2;
    let maxY = box.y + box.h / 2;
    for (const n of ns) {
      minX = Math.min(minX, n.x - halfW(n));
      maxX = Math.max(maxX, n.x + halfW(n));
      minY = Math.min(minY, n.y - halfH(n));
      maxY = Math.max(maxY, n.y + halfH(n));
    }
    return { ns, box, minX, minY, w: maxX - minX, h: maxY - minY };
  });

  // Unjoined nodes: connected components among themselves (same union-find as
  // packComponents), appended after the members in first-appearance order.
  const rest = nodes.filter((n) => !claimed.has(n.id));
  if (rest.length) {
    const idxOf = new Map(rest.map((n, i) => [n.id, i]));
    const parent = rest.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    };
    for (const e of ir.edges) {
      const a = idxOf.get(e.from);
      const b = idxOf.get(e.to);
      if (a != null && b != null) parent[find(a)] = find(b);
    }
    const comps = new Map<number, RadialLayout["nodes"]>();
    rest.forEach((n, i) => (comps.get(find(i)) ?? comps.set(find(i), []).get(find(i))!).push(n));
    for (const ns of comps.values()) {
      const minX = Math.min(...ns.map((n) => n.x - halfW(n)));
      const minY = Math.min(...ns.map((n) => n.y - halfH(n)));
      blocks.push({
        ns,
        minX,
        minY,
        w: Math.max(...ns.map((n) => n.x + halfW(n))) - minX,
        h: Math.max(...ns.map((n) => n.y + halfH(n))) - minY,
      });
    }
  }

  // Shelf-pack in order, wrapping at a roughly square target width (never
  // narrower than the widest member — a single box can't wrap).
  const totalArea = blocks.reduce((s, b) => s + (b.w + MEMBER_GAP) * (b.h + MEMBER_GAP), 0);
  const targetW = Math.max(Math.max(...blocks.map((b) => b.w)), Math.sqrt(totalArea) * 1.3);
  let shelfX = 0;
  let shelfY = 0;
  let shelfH = 0;
  let maxX = 0;
  let maxY = 0;
  for (const b of blocks) {
    if (shelfX > 0 && shelfX + b.w > targetW) {
      shelfX = 0;
      shelfY += shelfH + MEMBER_GAP;
      shelfH = 0;
    }
    const dx = shelfX - b.minX;
    const dy = shelfY - b.minY;
    for (const n of b.ns) {
      n.x += dx;
      n.y += dy;
    }
    if (b.box) {
      b.box.x += dx;
      b.box.y += dy;
    }
    maxX = Math.max(maxX, shelfX + b.w);
    maxY = Math.max(maxY, shelfY + b.h);
    shelfX += b.w + MEMBER_GAP;
    shelfH = Math.max(shelfH, b.h);
  }

  // The packed bounds become the canvas, and everything flips back to the
  // y-up plane renderSvg expects.
  layout.width = maxX;
  layout.height = maxY;
  for (const n of nodes) n.y = maxY - n.y;
  for (const b of boxes) b.y = maxY - b.y;
}

/** Group key per node id — the `src/<component>/` a node is declared under, with
 * `src/examples/…` folded to "examples" and non-src nodes bucketed by lexicon.
 * This is the grouping the radial layout clusters into wedges. */
function groupKeyByNode(ir: GraphIR): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of ir.nodes) {
    const parts = (n.sourceLoc?.file ?? "").split("/");
    let key: string;
    if (parts[0] === "src" && parts[1] === "examples") key = "examples";
    else if (parts[0] === "src" && parts.length >= 3) key = parts[1];
    else key = n.lexicon || "other";
    out.set(n.id, key);
  }
  return out;
}

/** Re-place a laid-out graph's nodes radially, CLUSTERED BY GROUP: each group
 * (component) gets a contiguous angular wedge sized to its node count, and
 * within a wedge nodes sit by dependency depth (dagre rank → radius) fanned
 * across the wedge's angle. So each pie-slice is a component (real structure,
 * not the old even/false symmetry), a component's edges stay local to its wedge
 * (less crossing), and the frontend can label each wedge from node positions.
 * Mutates node x/y and the layout bounds. */
function radializeLayout(layout: RadialLayout, groupOf: Map<string, string>, size: Map<string, { w: number; h: number }> = new Map()): void {
  const nodes = layout.nodes;
  if (!Array.isArray(nodes) || nodes.length < 3) return;
  const wOf = (n: { id: string }) => size.get(n.id)?.w ?? NODE_W;
  const hOf = (n: { id: string }) => size.get(n.id)?.h ?? NODE_H;

  // Global dagre rank (distinct y levels) orders nodes inner→outer by dependency
  // depth; exact radius is decided by the arc-packing below so nothing overlaps.
  const bucket = (y: number) => Math.round(y / 8) * 8;
  const levels = [...new Set(nodes.map((n) => bucket(n.y)))].sort((a, b) => a - b);
  const rankOf = new Map(levels.map((y, i) => [y, i]));
  // Inner radius large enough that even the narrowest wedges' innermost nodes
  // clear each other angularly (r0 · min angular separation ≳ card width).
  const r0 = 380;

  // Nodes by group; wedge order is stable (by key) so the picture doesn't jump.
  const groups = new Map<string, RadialLayout["nodes"]>();
  for (const n of nodes) {
    const k = groupOf.get(n.id) ?? "other";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(n);
  }
  const order = [...groups.keys()].sort();
  const gapAngle = 0.08; // radians between wedges
  const usable = 2 * Math.PI - gapAngle * order.length;
  // Floor every wedge at a minimum width so a tiny (1–2 node) component still
  // gets a readable slice and its inner node clears its neighbours; the rest of
  // the circle is shared out proportionally by node count.
  const minWidth = Math.min(0.4, (usable / order.length) * 0.7);
  const flexible = usable - minWidth * order.length;

  // Pack each wedge's nodes into concentric arcs (collision detection): fill an
  // arc only to the count its circumference can seat — arc length (radius·width)
  // ≥ (NODE_W+gap) per node — then step outward. So nodes never overlap
  // angularly (capacity bound) OR radially (rowStep ≥ card height). Nodes are
  // ordered by dependency depth (rank) then x, so inner arcs read as upstream.
  const gap = 55;
  // Radially-adjacent arcs stack at the same angle in a 1-node-wide wedge; their
  // separation must exceed the card WIDTH (not height) or a horizontally-oriented
  // wedge overlaps in x. Geometry: rowStep > NODE_W means no angle can put a pair
  // within both the card's width AND height. (This, not the relaxation, was the
  // main source of residual overlaps.)
  const rowStep = 190;
  let angle = -Math.PI / 2; // first wedge starts at top
  for (const key of order) {
    const gnodes = groups
      .get(key)!
      .slice()
      .sort((a, b) => (rankOf.get(bucket(a.y)) ?? 0) - (rankOf.get(bucket(b.y)) ?? 0) || a.x - b.x);
    const width = minWidth + flexible * (gnodes.length / nodes.length);
    const start = angle;
    let radius = r0;
    let i = 0;
    while (i < gnodes.length) {
      const capacity = Math.max(1, Math.floor((radius * width) / (NODE_W + gap)));
      const arc = gnodes.slice(i, i + capacity);
      const c = arc.length;
      arc.forEach((n, j) => {
        const a = c === 1 ? start + width / 2 : start + width * ((j + 0.5) / c);
        n.x = radius * Math.cos(a);
        n.y = radius * Math.sin(a);
      });
      radius += rowStep;
      i += capacity;
    }
    angle = start + width + gapAngle;
  }

  // Second pass — box-overlap relaxation. Arc-packing clears intra-wedge crowding
  // but two cards from neighbouring wedges (or arcs) can still overlap at a seam.
  // Iteratively separate any pair whose card rectangles intersect, pushing along
  // the axis of least penetration (the cheapest nudge). Converges fast for the
  // node counts here; capped so it always terminates. Pair separation targets
  // come from the two cards' PAINTED footprints (see `footprints`) plus margin —
  // a fitted long-title card is more than twice the old constant.
  const MARGIN_W = 45;
  const MARGIN_H = 12;
  // Break exact symmetry deterministically (no RNG available) so a node caught
  // between two neighbours never sits at a frustrated fixed point where opposing
  // pushes cancel — otherwise separation stalls with a few residual overlaps.
  nodes.forEach((n, k) => {
    n.x += (((k * 13) % 7) - 3) * 0.4;
    n.y += (((k * 7) % 5) - 2) * 0.4;
  });
  for (let iter = 0; iter < 2500; iter++) {
    let overlaps = 0;
    // In-place (Gauss-Seidel): each resolved pair is seen by the next, which
    // moves a squeezed middle node instead of leaving it stuck.
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const dx = nodes[b].x - nodes[a].x;
        const dy = nodes[b].y - nodes[a].y;
        const sepW = (wOf(nodes[a]) + wOf(nodes[b])) / 2 + MARGIN_W;
        const sepH = (hOf(nodes[a]) + hOf(nodes[b])) / 2 + MARGIN_H;
        const ox = sepW - Math.abs(dx); // >0 ⟺ x-ranges overlap
        const oy = sepH - Math.abs(dy); // >0 ⟺ y-ranges overlap
        if (ox <= 0 || oy <= 0) continue; // rectangles clear
        overlaps++;
        // Push along the centre-to-centre line by half the penetration. Unlike a
        // min-axis (MTV) push, this doesn't flip axes and oscillate when a pair
        // overlaps near a corner (ox ≈ oy) — the case that left residual overlaps.
        const d = Math.hypot(dx, dy) || 0.01;
        const push = Math.min(ox, oy) * 0.75 + 2; // over-relax to escape local jams
        const ux = dx / d;
        const uy = dy / d;
        nodes[a].x -= ux * push;
        nodes[a].y -= uy * push;
        nodes[b].x += ux * push;
        nodes[b].y += uy * push;
      }
    }
    if (overlaps === 0) break;
  }

  // Shift to positive coords + reset bounds so renderSvg's viewBox wraps the
  // disc — card edges, not centres, so a wide fitted card doesn't clip.
  const minX = Math.min(...nodes.map((n) => n.x - wOf(n) / 2));
  const minY = Math.min(...nodes.map((n) => n.y - hOf(n) / 2));
  const pad = 60;
  for (const n of nodes) {
    n.x = n.x - minX + pad;
    n.y = n.y - minY + pad;
  }
  layout.width = Math.max(...nodes.map((n) => n.x + wOf(n) / 2)) + pad;
  layout.height = Math.max(...nodes.map((n) => n.y + hOf(n) / 2)) + pad;
}
