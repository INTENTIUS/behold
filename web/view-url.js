// #475: the view in the URL. A host (arugula's workspace block) opens behold
// at `?member=delivery&zoom=components&env=prod`, a reload keeps the view, and a
// person can send the link to what they are looking at.
//
// Pure logic, no DOM: app.js reads the query once at boot, settles it against
// what the served estate offers, and writes the view back with
// history.replaceState as it changes. The static export runs the same SPA, so
// it takes the same parameters against its captured lens matrix.

/** The view's keys, in the order they are written back. Anything else in the
 * query (embed, theme, host, #476) is left where it is. */
export const VIEW_KEYS = ["member", "zoom", "env", "tier", "lens", "node", "radial"];

/** The colour lenses (web/behaviour-scale.js COLOUR_MODES). `lens` in the URL
 * is the colour the graph is painted in. */
export const LENSES = ["drift", "cost", "headroom"];

/**
 * The view a query asks for. Only the keys present come back; `radial` is a
 * boolean (`1`/`true` on, `0`/`false` off). An empty value is the same as an
 * absent one, except `env=` which asks for the source graph (null).
 */
export function readViewQuery(search) {
  const q = new URLSearchParams(search || "");
  const want = {};
  for (const k of VIEW_KEYS) {
    if (!q.has(k)) continue;
    const v = (q.get(k) || "").trim();
    if (k === "radial") {
      if (/^(1|true|on|yes)$/i.test(v)) want.radial = true;
      else if (/^(0|false|off|no)$/i.test(v)) want.radial = false;
      else want.radial = v; // left for settleView to name
      continue;
    }
    if (k === "env") {
      want.env = v || null;
      continue;
    }
    if (v) want[k] = v;
  }
  return want;
}

/**
 * The query string for a view, keeping every parameter that isn't a view key.
 * Defaults are left out so a plain view keeps a plain URL: no env is the
 * source graph, drift is the default lens, radial off is the default.
 */
export function writeViewQuery(search, state) {
  const q = new URLSearchParams(search || "");
  for (const k of VIEW_KEYS) q.delete(k);
  const s = state || {};
  if (s.member) q.set("member", s.member);
  if (s.zoom) q.set("zoom", s.zoom);
  if (s.env) q.set("env", s.env);
  if (s.tier) q.set("tier", s.tier);
  if (s.lens && s.lens !== "drift") q.set("lens", s.lens);
  if (s.node) q.set("node", s.node);
  if (s.radial) q.set("radial", "1");
  const out = q.toString();
  return out ? `?${out}` : "";
}

/**
 * Split what a query asks for into what this estate can honour and what it
 * can't, with the reason. `offer` lists what the served estate has:
 * `{ zooms, envs, tiers, lenses }`. member and node are checked later, against
 * the first graph (they are only known once it is read), so they pass through.
 * A value behold can't honour is named, never dropped without a word.
 */
export function settleView(want, offer) {
  const apply = {};
  const refused = [];
  const o = offer || {};
  if ("zoom" in want) {
    if ((o.zooms || []).includes(want.zoom)) apply.zoom = want.zoom;
    else refused.push({ key: "zoom", value: want.zoom, reason: `this estate offers ${listOr(o.zooms)}` });
  }
  if ("env" in want) {
    if (want.env === null || (o.envs || []).includes(want.env)) apply.env = want.env;
    else refused.push({ key: "env", value: want.env, reason: (o.envs || []).length ? `this estate declares ${listOr(o.envs)}` : "this estate declares no environments" });
  }
  if ("tier" in want) {
    if ((o.tiers || []).includes(want.tier)) apply.tier = want.tier;
    else refused.push({ key: "tier", value: want.tier, reason: (o.tiers || []).length ? `this project offers ${listOr(o.tiers)}` : "this project offers no tiers" });
  }
  if ("lens" in want) {
    const lenses = o.lenses || LENSES;
    if (lenses.includes(want.lens)) apply.lens = want.lens;
    else refused.push({ key: "lens", value: want.lens, reason: `the lenses are ${listOr(lenses)}` });
  }
  if ("radial" in want) {
    if (typeof want.radial === "boolean") apply.radial = want.radial;
    else refused.push({ key: "radial", value: want.radial, reason: "radial is 1 or 0" });
  }
  if (want.member) apply.member = want.member;
  if (want.node) apply.node = want.node;
  return { apply, refused };
}

/**
 * member and node, checked against a graph that came back. `members` is the
 * set of member names in it, `nodes` the set of node ids. A node in another
 * member than the one asked for is refused; so is one the zoom elided.
 */
export function settlePlace(want, members, nodes) {
  const apply = {};
  const refused = [];
  if (want.member) {
    if (members.has(want.member)) apply.member = want.member;
    else refused.push({ key: "member", value: want.member, reason: members.size ? `the members here are ${listOr([...members])}` : "this estate has no members" });
  }
  if (want.node) {
    if (!nodes.has(want.node)) refused.push({ key: "node", value: want.node, reason: "it isn't on this view; the zoom may elide it" });
    else if (apply.member && !want.node.startsWith(`${apply.member}/`)) refused.push({ key: "node", value: want.node, reason: `it isn't in member ${apply.member}` });
    else apply.node = want.node;
  }
  return { apply, refused };
}

/** One line for the now line: what the URL asked for that behold didn't do. */
export function refusalLine(refused) {
  if (!refused.length) return "";
  return "from the link: " + refused.map((r) => `${r.key}=${r.value} not opened, ${r.reason}`).join("; ");
}

function listOr(xs) {
  const a = (xs || []).filter(Boolean);
  if (!a.length) return "nothing";
  if (a.length > 8) return a.slice(0, 8).join(", ") + ", …";
  return a.join(", ");
}
