/**
 * Edge routing over pinhole's finished SVG (#571).
 *
 * pinhole 0.5's `renderSvg` draws every edge from one card's CENTRE to the
 * other's, as a vertical-tangent cubic. Cards stacked in one column (the
 * components zoom of a terragucci repo: one root per wave, the waves stacked)
 * then get a straight line down the middle of each card, through "Component ·
 * chant" and "archetype: infra", and an edge that skips a rank goes straight
 * through the card in between.
 *
 * This pass rewrites the edge paths pinhole emitted so no line passes over a
 * card or a box's title:
 *
 * - each end attaches to the BORDER of its card, on the side facing the other
 *   end (the bottom of the upper card to the top of the lower one), and the
 *   ends sharing one side of a card are spread along it, ordered by where the
 *   other end sits, so two edges leaving one card do not share a point;
 * - the line is pinhole's own cubic between those two ports when that clears
 *   every other card and box title, and an orthogonal route with rounded
 *   corners otherwise — first a Z through the space between the two cards,
 *   then a detour down a gutter beside whatever is in the way;
 * - a label chip (`viaAttr`) moves to the first spot along the new route where
 *   it covers no card and no title.
 *
 * It reads geometry off the SVG rather than the layout, so it applies to every
 * picture `renderSvg` paints (the components, resources, logical and estate
 * zooms) whatever pass moved the cards after dagre. Only edge `d`s and chip
 * coordinates change; cards and boxes are untouched. The fix belongs in
 * pinhole's painter, which knows its cards when it draws the edge; this is the
 * behold-side stopgap until it lands there.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** What the router reads off a pinhole SVG. Card ids are as the SVG spells
 * them (escaped), which is also how the edge attributes spell them. */
export interface SvgGeometry {
  cards: Map<string, Rect>;
  /** Box titles, badges and the top-right mark corner: text an edge may cross
   * a box border near, but not over. */
  labels: Rect[];
}

const NUM = "(-?[\\d.]+(?:e[-+]?\\d+)?)";
/** How far a line keeps off a card it passes. */
const CARD_PAD = 12;
/** How far a line keeps off a box title. */
const LABEL_PAD = 3;
/** How far a detour runs from the card it goes around. */
const GUTTER = 24;
/** The straight run out of a port before an orthogonal route turns. */
const STUB = 16;
/** Corner radius on an orthogonal route. */
const RADIUS = 8;
/** Spacing between the ports sharing one side of a card. */
const PORT_GAP = 16;

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** The cards and box titles in a pinhole SVG. */
export function svgGeometry(svg: string): SvgGeometry {
  const cards = new Map<string, Rect>();
  const card = new RegExp(`<g data-node-id="([^"]*)"[^>]*><rect x="${NUM}" y="${NUM}" width="${NUM}" height="${NUM}"`, "g");
  for (const m of svg.matchAll(card)) {
    if (!cards.has(m[1]!)) cards.set(m[1]!, { x: +m[2]!, y: +m[3]!, w: +m[4]!, h: +m[5]! });
  }
  const rich = new RegExp(`<foreignObject x="${NUM}" y="${NUM}" width="${NUM}" height="${NUM}" data-node-id="([^"]*)"`, "g");
  for (const m of svg.matchAll(rich)) {
    if (!cards.has(m[5]!)) cards.set(m[5]!, { x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]! });
  }
  const labels: Rect[] = [];
  // A box is pinhole's `groupBox`: a rx="16" rect, then its title and badge.
  const box = new RegExp(`<rect(?: data-group-id="[^"]*")? x="${NUM}" y="${NUM}" width="${NUM}" height="${NUM}" rx="16"[^>]*/>((?:<text [^>]*>[^<]*</text>)?)`, "g");
  for (const m of svg.matchAll(box)) {
    const [x, y, w] = [+m[1]!, +m[2]!, +m[3]!];
    const title = /<text x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*>([^<]*)<\/text>/.exec(m[5] ?? "");
    if (title) {
      const chars = title[3]!.replace(/&[a-z]+;|&#\d+;/g, "x").length;
      labels.push({ x: +title[1]! - 4, y: +title[2]! - 14, w: chars * 7.8 + 8, h: 20 });
    }
    // The corner a mark, a badge or web/app.js's wave badge sits in.
    labels.push({ x: x + w - 44, y: y + 6, w: 38, h: 26 });
  }
  const badge = /<text x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="end"[^>]*font-size="11" font-weight="600">([^<]*)<\/text>/g;
  for (const m of svg.matchAll(badge)) {
    const chars = m[3]!.replace(/&[a-z]+;|&#\d+;/g, "x").length;
    labels.push({ x: +m[1]! - chars * 7 - 4, y: +m[2]! - 13, w: chars * 7 + 8, h: 18 });
  }
  return { cards, labels };
}

// --- Geometry ---------------------------------------------------------------

const inflate = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
const inside = (r: Rect, p: Pt): boolean => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Whether the segment p→q passes through the open rect r. Liang–Barsky. */
export function segmentHits(p: Pt, q: Pt, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const clip = (den: number, num: number): boolean => {
    // den·t ≤ num. Parallel to this boundary: inside it or not at all.
    if (den === 0) return num >= 0;
    const t = num / den;
    if (den < 0) {
      // Entering.
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  // Strict: a segment running along an edge of r does not hit it.
  const e = 1e-6;
  if (!clip(-dx, p.x - (r.x + e))) return false;
  if (!clip(dx, r.x + r.w - e - p.x)) return false;
  if (!clip(-dy, p.y - (r.y + e))) return false;
  if (!clip(dy, r.y + r.h - e - p.y)) return false;
  return t1 > t0;
}

const cubicAt = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt => {
  const u = 1 - t;
  const k = (a: number, b: number, c: number, d: number): number => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return { x: k(p0.x, p1.x, p2.x, p3.x), y: k(p0.y, p1.y, p2.y, p3.y) };
};

/**
 * Points along an SVG path made of M, L, Q and C commands (absolute, numbers
 * separated by spaces or commas), dense enough that no 4px-wide obstacle falls
 * between two of them. The router's own output and pinhole's both parse.
 */
export function samplePath(d: string): Pt[] {
  const toks = d.match(/[MLQC]|-?[\d.]+(?:e[-+]?\d+)?/gi) ?? [];
  const out: Pt[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let i = 0;
  const num = (): number => Number(toks[i++]);
  const pt = (): Pt => ({ x: num(), y: num() });
  const steps = (len: number): number => Math.max(2, Math.ceil(len / 3));
  while (i < toks.length) {
    const cmd = toks[i++]!.toUpperCase();
    if (cmd === "M") {
      cur = pt();
      out.push(cur);
    } else if (cmd === "L") {
      const q = pt();
      const n = steps(Math.hypot(q.x - cur.x, q.y - cur.y));
      for (let s = 1; s <= n; s++) out.push({ x: cur.x + ((q.x - cur.x) * s) / n, y: cur.y + ((q.y - cur.y) * s) / n });
      cur = q;
    } else if (cmd === "Q") {
      const c = pt();
      const q = pt();
      const n = steps(Math.hypot(c.x - cur.x, c.y - cur.y) + Math.hypot(q.x - c.x, q.y - c.y));
      for (let s = 1; s <= n; s++) {
        const t = s / n;
        const u = 1 - t;
        out.push({ x: u * u * cur.x + 2 * u * t * c.x + t * t * q.x, y: u * u * cur.y + 2 * u * t * c.y + t * t * q.y });
      }
      cur = q;
    } else if (cmd === "C") {
      const c1 = pt();
      const c2 = pt();
      const q = pt();
      const n = steps(Math.hypot(c1.x - cur.x, c1.y - cur.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(q.x - c2.x, q.y - c2.y));
      for (let s = 1; s <= n; s++) out.push(cubicAt(cur, c1, c2, q, s / n));
      cur = q;
    } else break;
  }
  return out;
}

// --- Frames -----------------------------------------------------------------
// Every route is worked out as if it ran DOWN the page, from a port on the
// bottom of the source card to a port on the top of the target. A frame maps
// the real direction onto that one: up flips y, left/right swap the axes.

type Dir = "down" | "up" | "right" | "left";
type Side = "top" | "bottom" | "left" | "right";

interface Frame {
  to(p: Pt): Pt;
  from(p: Pt): Pt;
  rect(r: Rect): Rect;
}

function frameOf(dir: Dir): Frame {
  switch (dir) {
    case "down":
      return { to: (p) => p, from: (p) => p, rect: (r) => r };
    case "up":
      return { to: (p) => ({ x: p.x, y: -p.y }), from: (p) => ({ x: p.x, y: -p.y }), rect: (r) => ({ x: r.x, y: -(r.y + r.h), w: r.w, h: r.h }) };
    case "right":
      return { to: (p) => ({ x: p.y, y: p.x }), from: (p) => ({ x: p.y, y: p.x }), rect: (r) => ({ x: r.y, y: r.x, w: r.h, h: r.w }) };
    case "left":
      return { to: (p) => ({ x: p.y, y: -p.x }), from: (p) => ({ x: -p.y, y: p.x }), rect: (r) => ({ x: r.y, y: -(r.x + r.w), w: r.h, h: r.w }) };
  }
}

const EXIT: Record<Dir, [Side, Side]> = {
  down: ["bottom", "top"],
  up: ["top", "bottom"],
  right: ["right", "left"],
  left: ["left", "right"],
};

/** Which way an edge runs between two cards, or null when they overlap. The
 * axis with the wider gap wins, so a dagre rank-to-rank edge runs down. */
export function directionOf(a: Rect, b: Rect): Dir | null {
  const below = b.y - (a.y + a.h);
  const above = a.y - (b.y + b.h);
  const right = b.x - (a.x + a.w);
  const left = a.x - (b.x + b.w);
  const v = Math.max(below, above);
  const h = Math.max(right, left);
  if (v < 0 && h < 0) return null;
  if (v >= h) return below >= above ? "down" : "up";
  return right >= left ? "right" : "left";
}

// --- Routing ----------------------------------------------------------------

export interface RouteInput {
  from: Rect;
  to: Rect;
  /** Where the line leaves `from` and enters `to`, as an offset from the
   * middle of the side it uses. */
  fromOffset?: number;
  toOffset?: number;
  /** The other cards: the line keeps `CARD_PAD` off each. */
  obstacles: Rect[];
  /** Box titles and badges: the line may pass close, but not over. */
  labels?: Rect[];
}

export interface Route {
  d: string;
  /** The points the route was built from, for placing a chip on it. */
  points: Pt[];
  curved: boolean;
  /** How many obstacles it still crosses (0 when a clear route was found). */
  crossings: number;
}

const portOn = (r: Rect, side: Side, off: number): Pt => {
  switch (side) {
    case "bottom":
      return { x: r.x + r.w / 2 + off, y: r.y + r.h };
    case "top":
      return { x: r.x + r.w / 2 + off, y: r.y };
    case "left":
      return { x: r.x, y: r.y + r.h / 2 + off };
    case "right":
      return { x: r.x + r.w, y: r.y + r.h / 2 + off };
  }
};

/** Rounded orthogonal polyline through `pts`, as an SVG path. */
function roundedPath(pts: Pt[]): string {
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) > 0.01);
  let d = `M ${r1(clean[0]!.x)} ${r1(clean[0]!.y)}`;
  for (let i = 1; i < clean.length - 1; i++) {
    const [p, c, n] = [clean[i - 1]!, clean[i]!, clean[i + 1]!];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y);
    const l2 = Math.hypot(n.x - c.x, n.y - c.y);
    const r = Math.min(RADIUS, l1 / 2, l2 / 2);
    const a = { x: c.x - ((c.x - p.x) / l1) * r, y: c.y - ((c.y - p.y) / l1) * r };
    const b = { x: c.x + ((n.x - c.x) / l2) * r, y: c.y + ((n.y - c.y) / l2) * r };
    d += ` L ${r1(a.x)} ${r1(a.y)} Q ${r1(c.x)} ${r1(c.y)} ${r1(b.x)} ${r1(b.y)}`;
  }
  const last = clean[clean.length - 1]!;
  return `${d} L ${r1(last.x)} ${r1(last.y)}`;
}

function polylineCrossings(pts: Pt[], blocks: Rect[]): number {
  let n = 0;
  for (const r of blocks) {
    for (let i = 1; i < pts.length; i++) {
      if (segmentHits(pts[i - 1]!, pts[i]!, r)) {
        n++;
        break;
      }
    }
  }
  return n;
}

/**
 * One edge's route between two cards, in SVG (y-down) coordinates. Tries, in
 * order, and takes the first that crosses nothing: pinhole's cubic between the
 * border ports; a Z with its crossbar in the gap between the cards; a detour
 * down a gutter beside each thing in the way. When none is clear, the one
 * crossing fewest obstacles wins, so a hopeless picture is no worse than it was.
 */
export function routeEdge(input: RouteInput): Route | null {
  const dir = directionOf(input.from, input.to);
  if (!dir) return null;
  const f = frameOf(dir);
  const [outSide, inSide] = EXIT[dir];
  const a = f.to(portOn(input.from, outSide, input.fromOffset ?? 0));
  const b = f.to(portOn(input.to, inSide, input.toOffset ?? 0));
  const A = f.rect(input.from);
  const B = f.rect(input.to);
  // The two end cards block too (the route must not double back over them),
  // shrunk a hair so a port on their border is not "inside".
  const blocks = [
    ...input.obstacles.map((r) => inflate(f.rect(r), CARD_PAD)),
    ...(input.labels ?? []).map((r) => inflate(f.rect(r), LABEL_PAD)),
    inflate(A, -0.5),
    inflate(B, -0.5),
  ];
  const back = (pts: Pt[]): Pt[] => pts.map((p) => f.from(p));

  // 1. The cubic, as pinhole draws it but from border to border.
  const mid = (a.y + b.y) / 2;
  const c1 = { x: a.x, y: mid };
  const c2 = { x: b.x, y: mid };
  const n = Math.max(8, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
  const curve: Pt[] = [];
  for (let s = 0; s <= n; s++) curve.push(cubicAt(a, c1, c2, b, s / n));
  const curveHits = polylineCrossings(curve, blocks);
  if (curveHits === 0) {
    const [p0, p1, p2, p3] = back([a, c1, c2, b]);
    return {
      d: `M ${r1(p0!.x)} ${r1(p0!.y)} C ${r1(p1!.x)} ${r1(p1!.y)}, ${r1(p2!.x)} ${r1(p2!.y)}, ${r1(p3!.x)} ${r1(p3!.y)}`,
      points: back(curve),
      curved: true,
      crossings: 0,
    };
  }

  // 2 and 3. Orthogonal candidates, shortest first.
  const stub = Math.max(4, Math.min(STUB, (b.y - a.y) / 3));
  const y1 = a.y + stub;
  const y2 = b.y - stub;
  const candidates: Pt[][] = [];
  for (const ym of [mid, y1, y2]) candidates.push([a, { x: a.x, y: ym }, { x: b.x, y: ym }, b]);
  const gutters = new Set<number>();
  const lane = input.fromOffset ?? 0;
  for (const r of [...blocks.slice(0, -2), inflate(A, CARD_PAD), inflate(B, CARD_PAD)]) {
    if (r.y + r.h < Math.min(a.y, b.y) - 200 || r.y > Math.max(a.y, b.y) + 200) continue;
    // Shifted by this edge's own port offset, so two edges between one pair
    // of cards keep apart down the gutter as they do at the ports.
    // Unshifted too, for when the shift lands on something.
    for (const g of [r.x - GUTTER + CARD_PAD, r.x + r.w + GUTTER - CARD_PAD]) {
      gutters.add(g + lane);
      gutters.add(g);
    }
  }
  for (const g of gutters) candidates.push([a, { x: a.x, y: y1 }, { x: g, y: y1 }, { x: g, y: y2 }, { x: b.x, y: y2 }, b]);
  const length = (pts: Pt[]): number => pts.slice(1).reduce((s, p, i) => s + Math.abs(p.x - pts[i]!.x) + Math.abs(p.y - pts[i]!.y), 0);
  candidates.sort((p, q) => length(p) - length(q));
  let best: { pts: Pt[]; hits: number } | null = null;
  for (const pts of candidates) {
    const hits = polylineCrossings(pts, blocks);
    if (hits === 0) {
      best = { pts, hits };
      break;
    }
    if (!best || hits < best.hits) best = { pts, hits };
  }
  if (!best || best.hits >= curveHits) {
    // Nothing orthogonal does better: keep the cubic, border to border.
    const [p0, p1, p2, p3] = back([a, c1, c2, b]);
    return {
      d: `M ${r1(p0!.x)} ${r1(p0!.y)} C ${r1(p1!.x)} ${r1(p1!.y)}, ${r1(p2!.x)} ${r1(p2!.y)}, ${r1(p3!.x)} ${r1(p3!.y)}`,
      points: back(curve),
      curved: true,
      crossings: curveHits,
    };
  }
  const pts = back(best.pts);
  return { d: roundedPath(pts), points: pts, curved: false, crossings: best.hits };
}

/** Where a chip of size w×h centres on a route without covering a card or a
 * title: the first clear spot, trying the middle of the route first and
 * working outward. Null when no spot is clear. */
export function chipSpot(points: Pt[], w: number, h: number, blocks: Rect[]): Pt | null {
  if (points.length < 2) return null;
  // Arc-length positions, middle first.
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  const total = cum[cum.length - 1]!;
  const at = (s: number): Pt => {
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < s) i++;
    const seg = cum[i]! - cum[i - 1]! || 1;
    const t = (s - cum[i - 1]!) / seg;
    return { x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t, y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t };
  };
  // On the line first; beside it (touching) only when nowhere on it is clear.
  const beside: Pt[] = [{ x: 0, y: 0 }, { x: w / 2 + 4, y: 0 }, { x: -(w / 2 + 4), y: 0 }, { x: 0, y: h / 2 + 4 }, { x: 0, y: -(h / 2 + 4) }];
  for (const nudge of beside) {
    for (const frac of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88]) {
      const on = at(total * frac);
      const c = { x: on.x + nudge.x, y: on.y + nudge.y };
      const chip = { x: c.x - w / 2, y: c.y - h / 2, w, h };
      if (!blocks.some((r) => overlaps(chip, r))) return c;
    }
  }
  return null;
}

/** How far a side's ports must slide (along the side) so the straight run
 * out of each one, `PORT_REACH` long, misses every label; 0 when they already
 * do or when the side has no room to slide them clear. */
const PORT_REACH = 40;
function clearOfLabels(card: Rect, side: Side, offsets: number[], labels: Rect[]): number {
  const along = side === "top" || side === "bottom";
  const len = along ? card.w : card.h;
  const margin = 14;
  const lo = -len / 2 + margin - Math.min(...offsets);
  const hi = len / 2 - margin - Math.max(...offsets);
  const probe = (shift: number): boolean =>
    offsets.every((off) => {
      const p = portOn(card, side, off + shift);
      const reach: Rect = along
        ? { x: p.x - 2, y: side === "top" ? p.y - PORT_REACH : p.y, w: 4, h: PORT_REACH }
        : { x: side === "left" ? p.x - PORT_REACH : p.x, y: p.y - 2, w: PORT_REACH, h: 4 };
      return !labels.some((l) => overlaps(reach, inflate(l, LABEL_PAD)));
    });
  if (probe(0)) return 0;
  // Nearest clear shift, looking both ways in small steps.
  for (let step = 4; step <= len; step += 4) {
    if (step <= hi && probe(step)) return step;
    if (-step >= lo && probe(-step)) return -step;
  }
  return 0;
}

// --- The SVG pass -------------------------------------------------------------

interface EdgeEnd {
  edge: number;
  card: string;
  side: Side;
  /** Where the OTHER end sits along this side's axis, to order the ports. */
  toward: number;
  offset: number;
}

const EDGE = new RegExp(
  // The line group pinhole's `Canvas.edge` writes, then (optionally) the chip
  // group `Canvas.edgeLabel` writes straight after it.
  `<g data-edge-from="([^"]*)" data-edge-to="([^"]*)"([^>]*)><path class="pin-edge-line([^"]*)" d="([^"]*)"([^>]*)/><path d="([^"]*)"([^>]*)/></g>` +
    `(?:<g data-edge-from="([^"]*)" data-edge-to="([^"]*)"([^>]*)><rect x="${NUM}" y="${NUM}" width="${NUM}" height="${NUM}"([^>]*)/><text x="${NUM}" y="${NUM}")?`,
  "g",
);

/**
 * Re-route every edge in a pinhole SVG so it attaches to card borders and
 * crosses no card and no box title, and move each label chip off cards. A
 * picture with no edges, or one that is not pinhole's, comes back unchanged.
 */
export function routeEdges(svg: string): string {
  if (!svg.includes("pin-edge-line")) return svg;
  const geo = svgGeometry(svg);
  const found = [...svg.matchAll(EDGE)];
  if (!found.length) return svg;

  // Pass 1: which side each end uses, then spread the ends on each side.
  const dirs = found.map((m) => {
    const a = geo.cards.get(m[1]!);
    const b = geo.cards.get(m[2]!);
    return a && b && m[1] !== m[2] ? directionOf(a, b) : null;
  });
  const sides = new Map<string, EdgeEnd[]>();
  const ends: Array<[EdgeEnd, EdgeEnd] | null> = found.map((m, i) => {
    const dir = dirs[i];
    if (!dir) return null;
    const [outSide, inSide] = EXIT[dir];
    const a = geo.cards.get(m[1]!)!;
    const b = geo.cards.get(m[2]!)!;
    const horiz = dir === "down" || dir === "up";
    const centre = (r: Rect): number => (horiz ? r.x + r.w / 2 : r.y + r.h / 2);
    const pair: [EdgeEnd, EdgeEnd] = [
      { edge: i, card: m[1]!, side: outSide, toward: centre(b), offset: 0 },
      { edge: i, card: m[2]!, side: inSide, toward: centre(a), offset: 0 },
    ];
    for (const e of pair) {
      const key = `${e.card}\u0000${e.side}`;
      const list = sides.get(key) ?? [];
      list.push(e);
      sides.set(key, list);
    }
    return pair;
  });
  for (const list of sides.values()) {
    const card = geo.cards.get(list[0]!.card)!;
    const side = list[0]!.side;
    const len = side === "top" || side === "bottom" ? card.w : card.h;
    if (list.length > 1) {
      const gap = Math.min(PORT_GAP, (len * 0.7) / (list.length - 1));
      list.sort((p, q) => p.toward - q.toward || p.edge - q.edge);
      list.forEach((e, k) => (e.offset = (k - (list.length - 1) / 2) * gap));
    }
    // A box title sits just above the top-left of the first card in its box,
    // so a port in the middle of a narrow card can be right under its last
    // letters, and no route into that port misses them. Slide the ports on
    // this side clear of any title in front of them, if the side is long
    // enough to; a title is short, so this is almost always right of it.
    const shift = clearOfLabels(card, side, list.map((e) => e.offset), geo.labels);
    if (shift) list.forEach((e) => (e.offset += shift));
  }

  // Pass 2: route, and place chips.
  const cardRects = [...geo.cards.entries()];
  const chips: Rect[] = [];
  let k = -1;
  return svg.replace(EDGE, (whole, ...g: string[]) => {
    k++;
    const pair = ends[k];
    if (!pair) return whole;
    const [from, to] = [g[0]!, g[1]!];
    const obstacles = cardRects.filter(([id]) => id !== from && id !== to).map(([, r]) => r);
    const route = routeEdge({ from: geo.cards.get(from)!, to: geo.cards.get(to)!, fromOffset: pair[0].offset, toOffset: pair[1].offset, obstacles, labels: geo.labels });
    if (!route) return whole;
    let out = `<g data-edge-from="${from}" data-edge-to="${to}"${g[2]}><path class="pin-edge-line${g[3]}" d="${route.d}"${g[5]}/><path d="${route.d}"${g[7]}/></g>`;
    if (g[8] === undefined) return out;
    // The chip: same identity as the line (pinhole#110), so it is this edge's.
    const [rx, ry, rw, rh, tx, ty] = [g[11], g[12], g[13], g[14], g[16], g[17]].map(Number) as [number, number, number, number, number, number];
    const blocks = [...[...geo.cards.values()].map((r) => inflate(r, 2)), ...geo.labels, ...chips];
    const spot = chipSpot(route.points, rw, rh, blocks);
    const c = spot ?? { x: rx + rw / 2, y: ry + rh / 2 };
    const dx = c.x - (rx + rw / 2);
    const dy = c.y - (ry + rh / 2);
    chips.push({ x: rx + dx - 2, y: ry + dy - 2, w: rw + 4, h: rh + 4 });
    out += `<g data-edge-from="${g[8]}" data-edge-to="${g[9]}"${g[10]}><rect x="${r1(rx + dx)}" y="${r1(ry + dy)}" width="${g[13]}" height="${g[14]}"${g[15]}/><text x="${r1(tx + dx)}" y="${r1(ty + dy)}"`;
    return out;
  });
}
