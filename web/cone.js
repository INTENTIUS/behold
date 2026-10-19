// A cone plan on the stage (report minor 34). A choudoufu root under a `live`
// block that a pull request planned with `plan -cone=<base>` plans only the
// blocks the change touches and the blocks that read them. The server's
// `pull_request.cone` (src/terragucci-cone.ts) names every root of the
// estate as the plan treated it: `cone` (its size, and the instances its
// plan.json planned), `full` (choudoufu's guard planned the whole estate, and
// why), `planned` (planned with no cone) or `not-planned`.
//
// This module decides what lights and what dims, and the one quiet line that
// says it. Pure: the answer in, plain data out. The frame (web/app.js) lights
// the SVG's cards and boxes, the dots layer (web/dots.js) its dots and roster
// cards, and the kiosk (web/kiosk-watch.js, web/kiosk.js) writes the line.
// A plan with no `cone` has no cone view, and every function here answers
// null: nothing on the stage changes.

/** The pull request's cone view, or null when its plan has none. */
export function coneOf(pr) {
  const c = pr && pr.cone;
  return c && Array.isArray(c.roots) && c.roots.length ? c : null;
}

const n = (v) => Number.isInteger(v) && v >= 0;
const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const stop = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** A cone root's size in words: "2 of 16 blocks", else "3 addresses", else null when choudoufu said neither. */
export function coneSize(r) {
  if (n(r.blocks) && n(r.of)) return `${r.blocks} of ${r.of} blocks`;
  if (n(r.targets)) return plural(r.targets, "address", "addresses");
  return null;
}

/**
 * behold#736: a fallback's kind in words, for a card: choudoufu's `empty-cone` is "empty cone". The reason is the
 * tooltip's (fallbackWhy): on fan-out-choudoufu's fix six apps fall back at once, and a card holds a few words.
 * Null for a kind choudoufu didn't name.
 */
export function fallbackKind(r) {
  const k = r && r.fallback && typeof r.fallback.kind === "string" ? r.fallback.kind : "";
  return k && k !== "unknown" ? k.replace(/[-_]+/g, " ") : null;
}

/** behold#736: why choudoufu planned the whole estate, for a fallback's tooltip: "choudoufu planned it in full: <reason>". Null without a reason. */
export function fallbackWhy(r) {
  return r && r.kind === "full" && r.fallback && r.fallback.reason ? `choudoufu planned it in full: ${r.fallback.reason}` : null;
}

/** One root's part of the plan in words, for its box: "2 of 16 blocks, as a cone", "planned in full: empty cone" (else its reason), "not planned"; null for a root planned with no cone. */
export function coneFact(r) {
  if (!r) return null;
  if (r.kind === "cone") {
    const size = coneSize(r);
    return size ? `${size}, as a cone` : "planned as a cone";
  }
  if (r.kind === "full") {
    const why = fallbackKind(r) || (r.fallback && r.fallback.reason) || "";
    return why ? `planned in full: ${why}` : "planned in full";
  }
  if (r.kind === "not-planned") return "not planned";
  return null;
}

/**
 * The plan line. One root and nothing else: "Planned as a cone: 2 of 16
 * blocks. The rest of the estate was not read." or "Planned in full:
 * <reason>." Several roots: "service-b: 2 of 6 blocks, as a cone · network,
 * service-a: not planned". Null with no cone view.
 */
export function coneLine(cone) {
  if (!cone) return null;
  const roots = cone.roots;
  if (roots.length === 1) {
    const r = roots[0];
    if (r.kind === "cone") {
      const size = coneSize(r);
      return `Planned as a cone${size ? `: ${size}` : ""}. The rest of the estate was not read.`;
    }
    if (r.kind === "full") return stop(`Planned in full${r.fallback && r.fallback.reason ? `: ${r.fallback.reason}` : ""}`);
  }
  // behold#736: roots the plan treated alike say it once (fan-out-choudoufu's fix: six apps fall back on an empty
  // cone, eight roots aren't planned), so the line stays one line on a fifteen-estate stage.
  const groups = new Map();
  for (const r of roots) {
    if (r.kind === "not-planned") continue;
    const fact = r.kind === "planned" ? "planned" : coneFact(r);
    const key = `${r.kind}\u0000${fact}`;
    if (!groups.has(key)) groups.set(key, { kind: r.kind, fact, names: [] });
    groups.get(key).names.push(r.root);
  }
  const parts = [];
  const order = { cone: 0, full: 1, planned: 2 };
  for (const g of [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind])) parts.push(g.kind === "full" ? `${names(g.names)} ${g.fact}` : `${names(g.names)}: ${g.fact}`);
  const not = roots.filter((r) => r.kind === "not-planned").map((r) => r.root);
  if (not.length) parts.push(not.length > 3 ? `${not.length} others not planned` : `${not.join(", ")}: not planned`);
  return parts.join(" · ");
}

/** behold#736: a group's roots: up to three by name, more as the first to the last ("app-01 to app-06"). */
const names = (list) => {
  if (list.length <= 3) return list.join(", ");
  const sorted = [...list].sort();
  return `${sorted[0]} to ${sorted[sorted.length - 1]}`;
};

/** A resource's address as a card line says it: the provider's prefix off its type (`aws_iam_role.x` is `iam_role.x`), module calls kept. */
export function shortAddress(address) {
  return String(address).replace(/(^|\.)(?:aws|google|azurerm|kubernetes)_([a-z0-9_]+\.)/, "$1$2");
}

/**
 * The cone's resources as lines inside its root's card: what the plan changes
 * first, then what it only read, at most `max` lines, the rest counted:
 * "iam_role_policy.service · changed", "iam_role.service · read". None for a
 * root that is not a cone, or whose plan.json was not read.
 */
export function coneResourceLines(r, max = 2) {
  if (!r || r.kind !== "cone" || !Array.isArray(r.planned) || !r.planned.length) return [];
  const sorted = [...r.planned.filter((p) => p.changed), ...r.planned.filter((p) => !p.changed)];
  const lines = sorted.slice(0, max).map((p) => `${shortAddress(p.address)} · ${p.changed ? "changed" : "read"}`);
  const more = sorted.length - lines.length;
  if (more > 0) lines[lines.length - 1] += ` · and ${more} more`;
  return lines;
}

/**
 * A line wrapped to `room` px by `measure(text)`: at spaces, and a word still
 * too wide at its last `.` or `_` that fits (a resource's address), so every
 * part of it reads; never cut. ["iam_role_policy.service", "· changed"].
 */
export function wrapWords(text, room, measure) {
  const fits = (t) => measure(t) <= room;
  const out = [];
  let cur = "";
  const push = (w) => {
    const next = cur ? `${cur} ${w}` : w;
    if (fits(next) || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
    }
  };
  // A lone "·" goes with the word after it, so a line never ends on one.
  const words = [];
  for (const w of String(text).split(" ").filter(Boolean)) {
    if (words.length && words[words.length - 1] === "·") words[words.length - 1] = `· ${w}`;
    else words.push(w);
  }
  for (const word of words) {
    let w = word;
    // A word wider than the whole line: break it after a `.` or `_`, as far along as fits.
    while (!fits(w) && w.length > 1) {
      let at = -1;
      for (let k = w.length - 1; k > 0; k--) if ((w[k - 1] === "." || w[k - 1] === "_") && fits(w.slice(0, k))) {
        at = k;
        break;
      }
      if (at < 0) break;
      if (cur) {
        out.push(cur);
        cur = "";
      }
      out.push(w.slice(0, at));
      w = w.slice(at);
    }
    push(w);
  }
  if (cur) out.push(cur);
  return out;
}

/** "3 estates · 1 backend · no state files", when the reports say the estates share choudoufu's live backend; else null. */
export function backendLine(cone) {
  const b = cone && cone.backend;
  if (!b || !n(b.estates) || b.estates < 1) return null;
  return `${plural(b.estates, "estate")} · 1 backend · no state files`;
}

/** An instance address's block path, behold's way (src/terragucci-overlay.ts blockPath): module calls as segments, instance keys dropped. */
export function blockPath(address) {
  const bare = String(address).replace(/\[(?:"(?:[^"\\]|\\.)*"|[^\]])*\]/g, "");
  const tokens = bare.split(".");
  const segments = [];
  let i = 0;
  while (tokens[i] === "module" && i + 1 < tokens.length) {
    segments.push(`module.${tokens[i + 1]}`);
    i += 2;
  }
  segments.push(tokens.slice(i).join("."));
  return segments.join("/");
}

/**
 * The cone view as lights: by root, its kind, and with a cone the planned
 * and changed resources by address and by block path. `{ roots: Map }`, or
 * null with no cone view.
 */
export function coneLights(cone) {
  if (!cone) return null;
  const roots = new Map();
  for (const r of cone.roots) {
    const planned = Array.isArray(r.planned) ? r.planned : null;
    const keys = (list) => new Set(list.flatMap((p) => [p.address, blockPath(p.address)]));
    roots.set(r.root, {
      kind: r.kind,
      count: r.kind === "cone" ? coneSize(r) : null,
      planned: planned ? keys(planned) : null,
      changed: planned ? keys(planned.filter((p) => p.changed)) : new Set(),
    });
  }
  return { roots };
}

/**
 * How a root's box shows: "lit" (planned: a cone, or in full), "dim" (not
 * planned), or null (no cone view, a root it does not name, or one planned
 * with no cone: drawn as before).
 */
export function rootLight(lights, root) {
  const r = lights && lights.roots.get(root);
  if (!r) return null;
  if (r.kind === "cone" || r.kind === "full") return "lit";
  if (r.kind === "not-planned") return "dim";
  return null;
}

/**
 * How one resource of a root shows: "changed" (the cone planned it and its
 * plan changes it), "lit" (the cone planned it, or the whole estate was
 * planned), "dim" (in the cone's root but not planned, or in a root the pull
 * request did not plan), or null (drawn as before: no cone view, a root it
 * does not name, a root planned with no cone, or a cone whose plan.json was
 * not read, which lights at its box instead).
 */
export function resourceLight(lights, root, address) {
  const r = lights && lights.roots.get(root);
  if (!r) return null;
  if (r.kind === "full") return "lit";
  if (r.kind === "not-planned") return "dim";
  if (r.kind !== "cone" || !r.planned) return null;
  const k = [address, blockPath(address)];
  if (k.some((x) => r.changed.has(x))) return "changed";
  return k.some((x) => r.planned.has(x)) ? "lit" : "dim";
}

/**
 * The root and address a card id names, of the roots the cone view names:
 * `<member>/<root name>/<block path>` (a Terraform member, by `roots`, the
 * answer's `{member, name, path}`), else `<member>/<address>` whose member is
 * the root's directory name (a choudoufu member). Null when it names none.
 */
export function cardRoot(id, lights, roots = []) {
  if (!lights || typeof id !== "string") return null;
  for (const r of roots) {
    if (!r || !lights.roots.has(r.path)) continue;
    const prefix = `${r.member}/${r.name}/`;
    if (id.startsWith(prefix)) return { root: r.path, address: id.slice(prefix.length) };
  }
  const slash = id.indexOf("/");
  if (slash < 0) return null;
  const member = id.slice(0, slash);
  for (const path of lights.roots.keys()) {
    const leaf = path.replace(/\/+$/, "").split("/").pop();
    if (member === path || member === leaf) return { root: path, address: id.slice(slash + 1) };
  }
  return null;
}
