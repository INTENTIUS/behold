// A fixed position for every resource in a carve recording (#457, question 2).
//
// The rule the whole view rests on: a dot's position is a function of what the
// resource IS, never of who owns it, so a recolour is the only thing an owner
// change can do to it. Position therefore comes from the address alone:
//
//   unit     the resource's cluster: its module path, plus its block name with
//            the role suffix taken off (`team_0000_role`, `team_0000_inline`
//            and `team_0000_profile` are all unit `team_0000`), plus its
//            count/for_each index. For a terralith that is one team, one
//            service, or the DNS zone with its records.
//   parent   the unit's anchor: its IAM role, its ECS service, its hosted zone,
//            else its first taggable member.
//   orbit    every untaggable member (live-ls reports them as gaps, not items:
//            inline policies, attachments, records) sits on a ring around the
//            parent, which is where "untaggable children orbit their parent"
//            lands without animating anything.
//
// Units are packed row by row in address order, each given a square cell
// sized to its member count, so a large unit (140 DNS records) takes a large
// cell and a six-resource team a small one. Pure: roster in, positions out.

const ROLE_SUFFIXES = [
  "_managed_attach", "_custom_attach", "_attach", "_inline", "_policy", "_profile", "_role",
  "_exec", "_execution", "_task", "_taskdef", "_service", "_svc",
];
const ANCHOR_TYPES = ["aws_iam_role", "aws_ecs_service", "aws_route53_zone", "aws_vpc"];

/** `module.team_pod["pod-a"].aws_iam_role.pod_role[3]` -> { module, type, name, index }. */
export function parseAddress(address) {
  const parts = [];
  let depth = 0; let cur = "";
  for (const ch of address) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "." && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  const modules = [];
  while (parts[0] === "module" || parts[0]?.startsWith("module")) {
    if (parts[0] === "module") { modules.push(`module.${parts[1]}`); parts.splice(0, 2); } else break;
  }
  if (parts[0] === "data") parts.shift();
  const type = parts[0] ?? "";
  const m = /^([^[]+)(\[.*\])?$/.exec(parts[1] ?? "");
  return { module: modules.join("."), type, name: m ? m[1] : "", index: m && m[2] ? m[2] : "" };
}

export function unitOf(address, type) {
  const a = parseAddress(address);
  if (/^aws_route53_/.test(type || a.type)) return `${a.module}|dns`;
  let stem = a.name;
  for (const s of ROLE_SUFFIXES) if (stem.endsWith(s) && stem.length > s.length) { stem = stem.slice(0, -s.length); break; }
  if (/^pod(_|$)/.test(stem)) stem = "pod";
  // A resource-level for_each key (records["www"]) is not a unit of its own;
  // a count index on a team block is, since each index is a whole team.
  const index = /^\["/.test(a.index) ? "" : a.index;
  return `${a.module}|${stem}${index}`;
}

/**
 * roster: [{ address, type, taggable }] from the first keyframe.
 * Returns { positions: Map<address, {x, y, parent?}>, width, height, units }.
 */
export function layout(roster, { spacing = 10, width = 1600 } = {}) {
  const units = new Map();
  for (const r of roster) {
    const key = unitOf(r.address, r.type);
    let u = units.get(key);
    if (!u) units.set(key, (u = { key, members: [] }));
    u.members.push(r);
  }
  const ordered = [...units.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const positions = new Map();
  let x = 0; let y = 0; let rowH = 0;
  for (const u of ordered) {
    const taggable = u.members.filter((m) => m.taggable).sort((a, b) => (a.address < b.address ? -1 : 1));
    const children = u.members.filter((m) => !m.taggable).sort((a, b) => (a.address < b.address ? -1 : 1));
    const anchor = taggable.find((m) => ANCHOR_TYPES.includes(m.type)) ?? taggable[0] ?? children.shift();
    const others = taggable.filter((m) => m !== anchor);
    // Ring radius grows with the ring's population so orbiting dots never touch.
    const ringR = children.length ? Math.max(spacing * 1.6, (children.length * spacing) / (2 * Math.PI)) : 0;
    const core = spacing * (1 + Math.ceil(others.length / 2));
    const cell = 2 * Math.max(ringR + spacing, core) + spacing;
    if (x + cell > width && x > 0) { x = 0; y += rowH; rowH = 0; }
    const cx = x + cell / 2; const cy = y + cell / 2;
    positions.set(anchor.address, { x: cx, y: cy });
    others.forEach((m, i) => {
      const a = (i / Math.max(1, others.length)) * Math.PI * 2;
      positions.set(m.address, { x: cx + Math.cos(a) * spacing, y: cy + Math.sin(a) * spacing });
    });
    children.forEach((m, i) => {
      const a = (i / children.length) * Math.PI * 2 - Math.PI / 2;
      positions.set(m.address, { x: cx + Math.cos(a) * ringR, y: cy + Math.sin(a) * ringR, parent: anchor.address });
    });
    x += cell; rowH = Math.max(rowH, cell);
    u.anchor = anchor.address;
  }
  return { positions, width, height: y + rowH, units: ordered };
}
