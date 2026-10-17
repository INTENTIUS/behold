// The tour on the dots layer (behold.tour/v1): the chapter's visuals mapped
// onto the scene's boxes and dots, and what the kiosk's caption says about
// them. Pure: the tour's state (web/tour-player.js), the scene's names and
// the dots' owners in, plain data out. web/dots.js draws it.
//
// Each visual stands on what the server read for it (src/terragucci-tour.ts):
// a light is a resource a run's plan.json planned, a pulse is a root a wave's
// plan named, a travel is a plan's read threads and the output's planned
// value, the state object is a migration record's source version, and a check
// is a root whose post-write plan changes nothing.

import { chapterAt, shownAt, railOf, chapterLines, cardRows, firedBy } from "./tour-player.js";

const fmt = (n) => Number(n).toLocaleString("en-US");

/** The tour's chapter and its visuals now, from the answer's events; null with no tour. */
export function tourNow(answer) {
  const tour = answer && answer.tour;
  if (!tour) return null;
  const at = chapterAt(tour, tour.events, Infinity, tour.step);
  return { tour, at, shown: at ? shownAt(at.chapter, tour.events) : [] };
}

/** The box an estate is drawn in: an adopted estate is drawn in its stock root's box (the answer's `adopted`). */
export function boxOfEstates(estates, names, adopted = []) {
  const alias = new Map((adopted || []).map((a) => [a.to, a.from]));
  const set = names instanceof Set ? names : new Set(names);
  for (const e of estates || []) {
    const b = alias.get(e) ?? e;
    if (set.has(b)) return b;
  }
  return null;
}

/** What the chapter frames: the source box, all of them, or the box its lights are in. */
export function tourFocus(tn, names, adopted) {
  const f = tn && tn.at && tn.at.chapter.focus ? tn.at.chapter.focus.boxes : "all";
  if (f === "source") return { kind: "source" };
  if (f === "lit") {
    const light = tn.shown.find((x) => x.kind === "light");
    const b = light && light.lit.length ? boxOfEstates(light.lit[0].estates, names, adopted) : null;
    if (b) return { kind: "box", estate: b };
  }
  return { kind: "all" };
}

/**
 * The chapter's visuals mapped onto the scene. `ids`: the dots' ids (an
 * address, or an address with `#n` when two estates name it); `owners`: each
 * dot's box now; `source`: the source box.
 */
export function tourFx(tn, { ids, owners, names, adopted, source }) {
  const fx = { lights: new Map(), pulses: [], travel: null, state: null, checks: new Map() };
  if (!tn || !tn.at) return fx;
  const byAddr = new Map();
  for (const id of ids) {
    const base = id.replace(/#\d+$/, "");
    if (!byAddr.has(base)) byAddr.set(base, []);
    byAddr.get(base).push(id);
  }
  const box = (es) => boxOfEstates(es, names, adopted);
  const timed = tn.shown.filter((x) => x.at !== null);
  for (const s of tn.shown) {
    if (s.kind === "light") {
      for (const l of s.lit) {
        const b = box(l.estates);
        const cands = byAddr.get(l.address) || [];
        const id = cands.find((x) => (owners.get(x) ?? source) === b) ?? (cands.length === 1 ? cands[0] : null);
        if (id) fx.lights.set(id, { changed: l.changed, at: s.at });
      }
    } else if (s.kind === "pulse") {
      // A wave's pulse runs until the chapter's next visual fires.
      const later = timed.some((x) => x !== s && x.at > (s.at ?? -Infinity));
      if (!later) for (const es of s.estates) {
        const b = box(es);
        if (b && !fx.pulses.includes(b)) fx.pulses.push(b);
      }
    } else if (s.kind === "travel") {
      const threads = [];
      for (const th of s.threads) {
        const from = box(th.from);
        const to = box(th.to);
        if (from && to && from !== to && !threads.some((x) => x.from === from && x.to === to)) threads.push({ from, to });
      }
      if (threads.length) fx.travel = { threads, value: s.value ?? null, output: s.output, at: s.at };
    } else if (s.kind === "state") {
      const last = firedBy({ migration: s.migration, line: "last" }, tn.tour.events);
      fx.state = { box: box(s.estates) ?? source, version: s.version_id, unchanged: !!(last && s.finished) };
    } else if (s.kind === "checks") {
      for (const c of s.checks) {
        const b = box(c.estates);
        if (b) fx.checks.set(b, c.noChange);
      }
    }
  }
  return fx;
}

/** The key of what tourFx draws, so it is rebuilt only when that changes. */
export function fxKey(tn, extra = "") {
  if (!tn || !tn.at) return "";
  return `${tn.at.chapter.id}|${tn.shown.map((x) => `${x.kind}@${x.at}`).join(",")}|${extra}`;
}

/**
 * The tour as the kiosk's caption says it: the rail, the chapter's heading
 * and lines, a note for each visual naming the record it stands on, the
 * epilogue's card and the follow-along links. `counts`: each box's dots now;
 * `short(e)`: a box's name as the boxes show it.
 */
export function tourMessage(tn, { counts, names, adopted, source, short = (e) => e }) {
  const tour = tn.tour;
  const ch = tn.at.chapter;
  const facts = tour.facts || {};
  const notes = [];
  const box = (es) => boxOfEstates(es, names, adopted);
  for (const s of tn.shown) {
    const job = s.job ? `job #${s.job}` : null;
    if (s.kind === "light") {
      const what = s.stage === "tf-plan" ? (s.pull ? `pull request ${s.pull}'s plan` : "the plan") : s.wave ? `wave ${s.wave}'s plan` : "the push's plan";
      notes.push(`lit: the ${fmt(s.lit.length)} resources ${what} planned${s.changed && s.changed < s.lit.length ? `, ${fmt(s.changed)} to change` : ""}${job ? ` · ${job}` : ""}`);
    } else if (s.kind === "state") {
      const last = firedBy({ migration: s.migration, line: "last" }, tour.events);
      notes.push(`state file version ${String(s.version_id).slice(0, 8)}${last && s.finished ? ", unchanged" : ""}`);
    } else if (s.kind === "counts") {
      const parts = [...counts].filter(([e, n]) => e !== source && n > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([e, n]) => `${short(e)} ${fmt(n)}`);
      if (parts.length) notes.push(parts.join(" · "));
    } else if (s.kind === "checks") {
      const name = (c) => (c.root === "." ? short(box(c.estates) || "root") : c.root);
      const ok = s.checks.filter((c) => c.noChange).map(name);
      const not = s.checks.filter((c) => !c.noChange).map(name);
      if (ok.length) notes.push(`after the write, ${ok.join(", ")} plan${ok.length === 1 ? "s" : ""} no change${job ? ` · ${job}` : ""}`);
      if (not.length) notes.push(`${not.join(", ")} still plan${not.length === 1 ? "s" : ""} a change`);
    } else if (s.kind === "travel" && s.value !== undefined) {
      const readers = [...new Set(s.threads.map((t) => box(t.to)).filter(Boolean).map(short))];
      notes.push(`${s.output} = ${s.value}, as the plan has it, read by ${readers.join(", ")}`);
    } else if (s.kind === "pulse") notes.push(`wave ${s.wave || 1} plans ${s.estates.map((es) => short(box(es) || es[0] || "")).filter(Boolean).join(", ")}${job ? ` · ${job}` : ""}`);
  }
  const card = tn.shown.find((x) => x.kind === "card");
  return {
    name: tour.name,
    title: tour.title,
    rail: railOf(tour, tn.at),
    n: tn.at.index + 1,
    of: tour.chapters.length,
    id: ch.id,
    heading: ch.title,
    lines: chapterLines(ch, facts),
    notes,
    card: card ? cardRows(card.card, facts) : null,
    links: tour.links || { pull: null, job: null },
  };
}
