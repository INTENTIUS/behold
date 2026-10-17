// The dots preview's layout (#712, after #457's scripts/dot-bench/layout.js).
//
// Inside an estate's box, a dot's slot is a function of what the resource is:
// its unit (module path, block stem without its role suffix, count index),
// with the unit's anchor in the middle, its other taggable members beside it
// and its untaggable members on rings round them. Which box a dot is in is its
// owner's (web/dots-scene.js places the boxes). Pure: roster in, positions out.

const ROLE_SUFFIXES = [
  "_managed_attach", "_custom_attach", "_attach", "_inline", "_policy", "_profile", "_role",
  "_exec", "_execution", "_task", "_taskdef", "_service", "_svc",
];
const ANCHOR_TYPES = ["aws_iam_role", "aws_ecs_service", "aws_route53_zone", "aws_vpc"];

/** `module.team_pod["pod-a"].aws_iam_role.pod_role[3]` -> { module, type, name, index }. */
export function parseAddress(address) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of address) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "." && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const modules = [];
  while (parts[0] === "module") {
    modules.push(`module.${parts[1]}`);
    parts.splice(0, 2);
  }
  if (parts[0] === "data") parts.shift();
  const type = parts[0] ?? "";
  const m = /^([^[]+)(\[.*\])?$/.exec(parts[1] ?? "");
  return { module: modules.join("."), type, name: m ? m[1] : "", index: m && m[2] ? m[2] : "" };
}

/** The unit a resource belongs to: its module path, its block stem and its count index. */
export function unitOf(address, type) {
  const a = parseAddress(address);
  if (/^aws_route53_/.test(type || a.type)) return `${a.module}|dns`;
  let stem = a.name;
  for (const s of ROLE_SUFFIXES) {
    if (stem.endsWith(s) && stem.length > s.length) {
      stem = stem.slice(0, -s.length);
      break;
    }
  }
  if (/^pod(_|$)/.test(stem)) stem = "pod";
  // A short numbered suffix (`team_a_0`, `team_a_2`: one team's log groups)
  // is the same unit; a generated four-digit id (`svc_0007`) is its own.
  stem = stem.replace(/_\d{1,2}$/, "");
  // A for_each key on a resource (records["www"]) is not a unit of its own;
  // a count index on a team block is, since each index is a whole team.
  const index = /^\["/.test(a.index) ? "" : a.index;
  return `${a.module}|${stem}${index}`;
}

const byAddress = (a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

/** roster [{address, type, taggable}] -> [{key, anchor, others, children}] in key order. */
export function unitsOf(roster) {
  const units = new Map();
  for (const r of roster) {
    const key = unitOf(r.address, r.type);
    let u = units.get(key);
    if (!u) units.set(key, (u = { key, members: [] }));
    u.members.push(r);
  }
  return [...units.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((u) => {
      const taggable = u.members.filter((m) => m.taggable).sort(byAddress);
      const children = u.members.filter((m) => !m.taggable).sort(byAddress);
      const anchor = taggable.find((m) => ANCHOR_TYPES.includes(m.type)) ?? taggable[0] ?? children.shift();
      return { key: u.key, anchor, others: taggable.filter((m) => m !== anchor), children };
    });
}

/** Address -> the anchor of its unit, for every untaggable member (a follower's parent). */
export function parentsOf(roster) {
  const out = new Map();
  for (const u of unitsOf(roster)) for (const c of u.children) out.set(c.address, u.anchor.address);
  return out;
}

/**
 * The rings a unit's untaggable members sit on: concentric, one pitch apart,
 * each holding as many as fit at one pitch spacing, so a zone with 140
 * records is a compact disc of rings rather than one huge ring.
 */
export function ringsOf(n, start = 1.6) {
  const rings = [];
  let r = start;
  let left = n;
  while (left > 0) {
    const cap = Math.max(4, Math.floor(2 * Math.PI * r));
    const k = Math.min(cap, left);
    rings.push({ r, n: k });
    left -= k;
    r += 1;
  }
  return rings;
}

/** A unit's square cell, in dot pitches: its anchor and taggable members in the middle, the rings around them. */
export function unitCell(u) {
  // With taggable members round the anchor, the rings start outside them.
  const rings = ringsOf(u.children.length, u.others.length ? 2.2 : 1.6);
  const core = 1 + Math.ceil(u.others.length / 2);
  // The core's members sit one pitch from the anchor; rings start outside them.
  const shift = u.others.length > 6 ? Math.ceil(u.others.length / 6) : 0;
  const outer = rings.length ? rings[rings.length - 1].r + shift : 0;
  return { rings, shift, cell: 2 * Math.max(outer + 1, core) + 1 };
}

/** The row width (in pitches) that keeps a block of these units near `aspect` (width / height). */
export function blockWidth(units, aspect = 1.3) {
  const cells = units.map((u) => unitCell(u).cell);
  const area = cells.reduce((s, c) => s + c * c, 0);
  return Math.max(Math.sqrt(area * aspect) * 1.04, ...cells, 1);
}

/**
 * The dot slots of one block, in pitches. Units are packed into rows of a
 * fixed `width`, so a box keeps its width as units come and go.
 *
 * `fromEnd` packs from the last unit backwards, right to left and bottom to
 * top, with the bottom edge at y = 0 (slots have y <= 0). A unit's slot then
 * depends only on the units after it, so units leaving from the front (the
 * carve takes them in unit order) never move the ones that stay: the box just
 * loses its top rows. Reading order is kept: the first unit is still top-left.
 * Without it, units are packed from the top-left, and a unit appended at the
 * end never moves the ones before it.
 */
export function packBlock(units, { width = blockWidth(units), fromEnd = false } = {}) {
  const list = fromEnd ? [...units].reverse() : units;
  const slots = new Map();
  let x = 0;
  let y = 0;
  let rowH = 0;
  let maxX = 0;
  for (const u of list) {
    const { rings, shift, cell } = unitCell(u);
    if (x + cell > width && x > 0) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    const put = (a, px, py, parent) => {
      const sx = fromEnd ? width - px : px;
      const sy = fromEnd ? -py : py;
      slots.set(a, parent ? { x: sx, y: sy, parent } : { x: sx, y: sy });
    };
    const cx = x + cell / 2;
    const cy = y + cell / 2;
    put(u.anchor.address, cx, cy);
    u.others.forEach((m, i) => {
      const a = (i / Math.max(1, u.others.length)) * Math.PI * 2;
      const r = 1 + Math.floor(i / 6) * 0.9;
      put(m.address, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    });
    let j = 0;
    for (const ring of rings) {
      for (let q = 0; q < ring.n; q++, j++) {
        const a = (q / ring.n) * Math.PI * 2 - Math.PI / 2;
        const r = ring.r + shift;
        put(u.children[j].address, cx + Math.cos(a) * r, cy + Math.sin(a) * r, u.anchor.address);
      }
    }
    x += cell;
    maxX = Math.max(maxX, x);
    rowH = Math.max(rowH, cell);
  }
  const h = y + rowH;
  return { slots, w: fromEnd ? width : maxX, h, top: fromEnd ? -h : 0 };
}

/**
 * Shelf-pack boxes (each {key, w, h}) in the given order into rows about
 * `width` wide, with `gap` between them. Returns Map<key, {x, y}> (top-left).
 */
export function shelfPack(boxes, { width, gap = 0 }) {
  const out = new Map();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > width) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    out.set(b.key, { x, y });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}
