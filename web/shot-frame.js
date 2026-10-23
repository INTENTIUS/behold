// behold#915: the page `behold shot` photographs. `frame=matches` is an embed
// parameter, not a view key (a reload never writes it back): in a bare frame
// it lights what the view asks for, dims the rest, frames the lit cards with
// the kiosk's own arithmetic (web/kiosk-shot.js shotViewBox), draws one
// caption line, and says it is ready by setting `data-behold-shot` on <html>
// to `drawn`, `no-matches` or `failed`. The driver (src/shot.ts) waits for
// that attribute and never photographs a page that did not set it.
//
// Pure logic, no DOM: app.js measures the cards and boxes, this decides.

/** The attribute on <html> the driver waits for. */
export const SHOT_ATTR = "data-behold-shot";

/** What the attribute can say. */
export const SHOT_STATES = ["drawn", "no-matches", "failed"];

/** Room kept under the framed cards for the caption line, in px. */
export const SHOT_CAPTION_PX = 30;

/** How faint an unlit card is drawn. */
export const SHOT_DIM = 0.22;

/** The shot frame a query asks for: "matches" in a bare embed frame with `frame=matches`, else null. */
export function readShotFrame(search) {
  const q = new URLSearchParams(search || "");
  const on = (k) => /^(1|true|on|yes)$/i.test(q.get(k) || "");
  if (!on("embed") || !on("bare")) return null;
  return (q.get("frame") || "").trim() === "matches" ? "matches" : null;
}

const centreIn = (c, b) => {
  const x = (c.x + c.x2) / 2;
  const y = (c.y + c.y2) / 2;
  return x > b.x && x < b.x2 && y > b.y && y < b.y2;
};

/**
 * The cards a shot lights. `cards` and `groups` are `[{id, box}]` as drawn
 * (boxes in svg units). `matches` is the lit set a query answered: behold#913
 * passes its rows' node ids here once `q` is a view key, and this function
 * needs no other change. Until then the view's own selection stands in:
 * `node` lights that card, `focus` the cards inside the named boxes (or the
 * cards it names). `{ids, asked, label}`: `asked` is false when the view asks
 * for nothing, and then the whole graph is the shot.
 */
export function shotLit(view, cards, groups, matches = null) {
  const have = new Set((cards || []).map((c) => c.id));
  if (Array.isArray(matches)) {
    return { ids: matches.filter((id) => have.has(id)), asked: true, label: null };
  }
  const v = view || {};
  if (typeof v.node === "string" && v.node) {
    return { ids: have.has(v.node) ? [v.node] : [], asked: true, label: `node ${v.node}` };
  }
  if (typeof v.focus === "string" && v.focus) {
    const names = new Set(v.focus.split(",").map((s) => s.trim()).filter(Boolean));
    const boxes = (groups || []).filter((g) => names.has(g.id) && g.box);
    const ids = (cards || []).filter((c) => names.has(c.id) || (c.box && boxes.some((g) => centreIn(c.box, g.box)))).map((c) => c.id);
    return { ids, asked: true, label: `focus ${[...names].join(", ")}` };
  }
  return { ids: [], asked: false, label: null };
}

/**
 * With a query answered, what the shot lights and frames, from the marks
 * drawQuery put on the drawn cards (`[{id, mark}]`, mark "lit" | "path" |
 * "dim"). The lit cards are the matches, a stack holding one among them; the
 * frame takes in the path cards too. Found in #908's stage 3 run: framed on
 * chant's lit ids alone, `cap:internet-reachable(22)` zoomed onto the bastion
 * and left its route to the internet gateway out of the picture, and a match
 * inside a stack was not a drawn card at all.
 */
export function queryFrame(cards) {
  const lit = [];
  const frame = [];
  for (const c of cards || []) {
    if (c.mark === "lit") lit.push(c.id);
    if (c.mark === "lit" || c.mark === "path") frame.push(c.id);
  }
  return { lit, frame };
}

/** The state a drawn shot reports: a graph that failed, a question with no answer on the graph, or drawn. */
export function shotState({ failed = false, lit }) {
  if (failed) return "failed";
  return lit && lit.asked && !lit.ids.length ? "no-matches" : "drawn";
}

/** Where the picture's facts come from, in a few words: the source graph, or the env's live read (and its snapshot). */
export function shotProvenance(view) {
  const v = view || {};
  if (!v.env) return "source graph";
  return v.snapshot ? `env ${v.env}, snapshot ${v.snapshot}` : `env ${v.env}, live`;
}

/**
 * The caption's one line: what was asked (the query, or the stand-in
 * selection), where the picture comes from, and when. A failure line comes
 * first when there is one. Control characters become spaces, so it stays one line.
 */
export function shotCaption({ query = null, label = null, provenance = "", at = new Date(), failure = null, state = "drawn", counts = null } = {}) {
  const one = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const asked = query ? (query === "the whole graph" ? query : `"${one(query)}"`) : label ? one(label) : "the whole graph";
  const parts = [];
  if (failure) parts.push(one(failure));
  parts.push(state === "no-matches" ? `no matches for ${asked}` : asked);
  if (counts) parts.push(one(counts)); // behold#922: chant's groups and total
  if (provenance) parts.push(one(provenance));
  const t = at instanceof Date && !Number.isNaN(at.getTime()) ? at.toISOString().replace(/\.\d+Z$/, "Z") : "";
  if (t) parts.push(t);
  return parts.join("  ·  ");
}
