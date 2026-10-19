// behold#744: a terragucci read's words ("app-06 reads cluster-a's applied
// state") are no longer drawn for good, out in open ground. Each read's line
// stays; its pill sits at the reader's end and shows only while it matters:
// while someone points at the reader, the root it reads or the line, or, on a
// kiosk playing on its own, for a few seconds when the reader starts applying
// or fails or is blocked. This module says which reads those are and for how
// long; app.js draws them.
//
// Pure apart from the clock it is given.

/** How long a read's pill shows on its own, in ms; the fade is the last fifth of it. */
export const FLASH_MS = 6000;
/** At most this many pills show on their own at once: the newest win. */
export const FLASH_MAX = 3;
/**
 * The reader states a pill shows for (its wave runs it, or it did not apply), most telling first: a failed root's read
 * before its wave's, and those before the blocked apps that follow it. Seen first after a reload counts too: the kiosk
 * reloads its frame at a new step (the step's focus is in its address), which is when the state matters.
 */
const MATTERS = { failed: 0, applying: 1, blocked: 2 };

/** A read's key, one per line: reader and the root it reads. */
export const readKey = (e) => `${e.from}→${e.to}`;

/** A wave job's status that says the wave runs now (its job's, or the run view's after a re-run took it over). */
const RUNNING = new Set(["running", "applying"]);
/** A card's states that its running wave makes applying: the pull request's plan still shows until the run view moves. */
const NOT_YET = new Set(["planned", "not-started", "waiting"]);

/**
 * Each reader root's state, from the marks the components zoom draws
 * (componentMarks: `cards[component] = { root, wave, state }` and each
 * wave's job status, paced as a story plays it) when there are, else
 * rootStates' `roots[path] = { state }`. A card whose wave's job runs now
 * reads applying, though the view still shows the plan it applies.
 */
export function readerStates(marks, roots) {
  const out = {};
  for (const c of Object.values((marks && marks.cards) || {})) {
    if (!c || !c.root) continue;
    const w = marks.waves && marks.waves[c.wave];
    const job = w && w.status ? w.status.status : null;
    out[c.root] = NOT_YET.has(c.state) && RUNNING.has(job) ? "applying" : c.state;
  }
  if (roots) for (const [path, r] of Object.entries(roots)) if (!(path in out) && r) out[path] = r.state;
  return out;
}

/**
 * The reads whose pill shows on its own now. `live(edges, states)` keeps when
 * each reader came into the state it is in, and answers `[{ key, age }]`
 * (age in ms) for the reads whose reader came into applying, failed or
 * blocked less than `hold` ms ago, newest first (then failed, applying,
 * blocked), `max` at most.
 */
export function createReadFlash({ now = () => Date.now(), hold = FLASH_MS, max = FLASH_MAX } = {}) {
  const seen = new Map(); // root -> { state, at } (at null: nothing to show for it)
  const live = (edges, states) => {
    const t = now();
    for (const root of new Set((edges || []).map((e) => e.from))) {
      const s = (states && states[root]) || null;
      const was = seen.get(root);
      if (was && was.state === s) continue;
      seen.set(root, { state: s, at: s in MATTERS ? t : null });
    }
    const out = [];
    for (const e of edges || []) {
      const w = seen.get(e.from);
      if (!w || w.at === null || t - w.at >= hold) continue;
      out.push({ key: readKey(e), age: t - w.at, rank: MATTERS[w.state] });
    }
    out.sort((a, b) => a.age - b.age || a.rank - b.rank || (a.key < b.key ? -1 : 1));
    return out.slice(0, max).map(({ key, age }) => ({ key, age }));
  };
  return { live };
}

/**
 * The reads a pointer on a root lights: the ones it makes and the ones made
 * of it. On a read's own line, that read alone.
 */
export function hotReads(edges, { root = null, key = null } = {}) {
  if (key) return (edges || []).some((e) => readKey(e) === key) ? [key] : [];
  if (!root) return [];
  return (edges || []).filter((e) => e.from === root || e.to === root).map(readKey);
}

/**
 * Where a pill goes beside the reader's card, `box` ({ x, y, x2, y2 }), for
 * the line that leaves it at `p0`: just outside the side `p0` is on, slid
 * along it, a few gaps out, each with how far it sits from `p0`. The caller
 * scores them against the text and cards around; nearer is better.
 */
export function pillSpots(box, p0, w, h, { gaps = [6, 18, 34], slides = [0, -0.3, 0.3, -0.5, 0.5] } = {}) {
  const d = { top: Math.abs(p0.y - box.y), bottom: Math.abs(p0.y - box.y2), left: Math.abs(p0.x - box.x), right: Math.abs(p0.x - box.x2) };
  const side = Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
  const out = [];
  // The side the line leaves from first; the card's other sides after, farther round from p0.
  const sides = [side, ...["top", "bottom", "left", "right"].filter((s) => s !== side)];
  sides.forEach((s, i) => {
    for (const g of gaps) {
      for (const f of slides) {
        let c;
        if (s === "top" || s === "bottom") {
          const x = (i === 0 ? p0.x : (box.x + box.x2) / 2) + f * w;
          c = { x, y: s === "top" ? box.y - g - h / 2 : box.y2 + g + h / 2 };
        } else {
          const y = (i === 0 ? p0.y : (box.y + box.y2) / 2) + f * h * 2;
          c = { x: s === "left" ? box.x - g - w / 2 : box.x2 + g + w / 2, y };
        }
        const r = { x: c.x - w / 2, y: c.y - h / 2, x2: c.x + w / 2, y2: c.y + h / 2 };
        out.push({ c, r, side: s, gap: g, far: Math.hypot(Math.max(r.x - p0.x, 0, p0.x - r.x2), Math.max(r.y - p0.y, 0, p0.y - r.y2)), round: i });
      }
    }
  });
  return out;
}

/** The point on rect `r` nearest `p`: where a pill's leader meets it. */
export function nearestOn(r, p) {
  return { x: Math.max(r.x, Math.min(p.x, r.x2)), y: Math.max(r.y, Math.min(p.y, r.y2)) };
}

/**
 * behold#762: whether a read's root (a path, "apps/app-01", or a name) is the card `id` names: the components zoom names a
 * card after the root, and the read after its path (tipComponentEdges matches them the same way).
 */
const sameEnd = (root, id) => !!root && !!id && (root === id || root.endsWith(`/${id}`));

/**
 * behold#762: which dependency edges a read line already draws, so a pair gets one line, not two. `deps` are the graph's
 * edges ({ from, to }, as pinhole names their ends); answers, for each, the key of the read (readKey) whose ends are the
 * edge's, in either direction, or null when no read covers it.
 */
export function coveredEdges(reads, deps) {
  return (deps || []).map((d) => {
    const r = (reads || []).find((e) => (sameEnd(e.from, d.from) && sameEnd(e.to, d.to)) || (sameEnd(e.from, d.to) && sameEnd(e.to, d.from)));
    return r ? readKey(r) : null;
  });
}

/** behold#762: what a dependency edge means, in the words its own tooltip had (behold#744), for the read line that stands for it. */
export function dependsLine(d) {
  return `${d.from} → ${d.to}\n${d.from} depends on ${d.to}, so ${d.to} applies first`;
}
