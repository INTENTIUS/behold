// #511: a choudoufu wave's progress per resource, from terragucci's run view.
// app.js fetches /api/terragucci/progress (and hears the `progress` event on
// /api/terragucci/events), then stamps cards and fills the panel from what
// these functions return.
//
// A progress mark is dated by the records read it came from ("in flight,
// records read 09:43 UTC, 2m ago"). It is a corner tag, never a fill: the
// fill is the live-status channel, and this is what the wave job's last read
// of the estates' records found, which may already be behind.

import { ago, clock, hrefOf } from "./terragucci.js";

export const PROGRESS_WORDS = { done: "done", "in-flight": "in flight", waiting: "waiting", "not-applied": "not applied" };
const GLYPH = { done: "✓", "in-flight": "▶", waiting: "…", "not-applied": "✕" };

/** "records read 09:43 UTC, 2m ago". */
export function readWords(read, now = new Date()) {
  return `records read ${clock(read, now)}, ${ago(read, now)}`;
}

/** The newest wave's mark on a card: a wave applying now outranks an earlier one. */
export function cardProgress(marks) {
  if (!marks || !marks.length) return null;
  return [...marks].sort((a, b) => b.wave - a.wave)[0];
}

/** The corner tag of a card: "▶ wave 2 in flight · 2m". */
export function progressTag(mark, now = new Date()) {
  const s = Math.max(0, (now.getTime() - Date.parse(mark.read)) / 1000);
  const age = s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return { text: `${GLYPH[mark.status]} wave ${mark.wave} ${PROGRESS_WORDS[mark.status]} · ${age}`, tone: mark.status };
}

/** One instance as a line: "module.x.aws_y.z[1] (replace): in flight", with when a read first found it done. */
export function resourceLine(r, now = new Date()) {
  const done = r.status === "done" && r.done_at ? ` ${clock(r.done_at, now)}` : "";
  return `${r.address} (${r.action}): ${PROGRESS_WORDS[r.status]}${done}`;
}

/** A card's mark as sentences, for its tooltip and the inspect pane. */
export function progressLines(mark, now = new Date()) {
  return [`wave ${mark.wave} ${PROGRESS_WORDS[mark.status]}, ${readWords(mark.read, now)}`, ...mark.resources.map((r) => resourceLine(r, now))];
}

/** "2 of 5 done, 1 in flight, 2 waiting", plus "1 not applied" when there is one. */
export function countsLine(counts) {
  const total = counts.done + counts["in-flight"] + counts.waiting + counts["not-applied"];
  return `${counts.done} of ${total} done, ${counts["in-flight"]} in flight, ${counts.waiting} waiting${counts["not-applied"] ? `, ${counts["not-applied"]} not applied` : ""}`;
}

/** The panel's rows: the run's line, then one per wave with progress. Never "live". */
export function progressRows(answer, now = new Date()) {
  if (!answer || answer.error) return { head: answer && answer.error ? `apply progress not read: ${answer.error}` : "", title: (answer && answer.remedy) || "", waves: [] };
  if (!answer.run || !answer.run.present) return { head: answer.absent || "", title: "", waves: [] };
  const head = `apply progress of ${answer.run.commit.slice(0, 12)}, from terragucci's run view${answer.watching ? " · asked again while a wave moves" : " · settled"}`;
  const title = [`${answer.run.key}, read ${ago(answer.read, now)}`, answer.unmatched.length ? `no card: ${answer.unmatched.map((u) => `${u.root}: ${u.address}`).join(", ")}` : ""].filter(Boolean).join("\n");
  return {
    head,
    title,
    html: answer.run.html,
    waves: answer.waves.map((w) => ({
      number: w.number,
      text: `wave ${w.number} ${w.state}: ${countsLine(w.counts)}`,
      read: readWords(w.read, now),
      tone: w.counts["not-applied"] ? "not-applied" : w.counts["in-flight"] ? "in-flight" : w.counts.waiting ? "waiting" : "done",
      lines: w.resources.map((r) => `${r.root}: ${resourceLine(r, now)}`),
    })),
  };
}

const FILL = { done: "var(--muted)", "in-flight": "var(--pending)", waiting: "var(--muted)", "not-applied": "var(--degraded)" };

/** Stamp each card's progress tag at its top-right corner. Replaces the previous stamps. */
export function stampProgress(svg, answer, now = new Date()) {
  if (!svg) return;
  for (const old of svg.querySelectorAll("[data-tg-progress]")) old.remove();
  if (!answer || !answer.cards) return;
  for (const [id, marks] of Object.entries(answer.cards)) {
    const g = svg.querySelector('[data-node-id="' + CSS.escape(id) + '"]');
    const mark = cardProgress(marks);
    if (!g || !mark) continue;
    const rect = g.querySelector("rect");
    const box = rect && rect.getBBox ? rect.getBBox() : null;
    const t = progressTag(mark, now);
    const tag = document.createElementNS("http://www.w3.org/2000/svg", "text");
    tag.setAttribute("data-tg-progress", t.tone);
    tag.setAttribute("x", String((box ? box.x + box.width : 150) - 10));
    tag.setAttribute("y", String((box ? box.y : 0) + 14));
    tag.setAttribute("text-anchor", "end");
    tag.setAttribute("font-size", "10");
    tag.setAttribute("fill", FILL[t.tone]);
    tag.textContent = t.text;
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = progressLines(mark, now).join("\n") + "\n(from terragucci's run view, as of that read: not live)";
    tag.appendChild(title);
    g.appendChild(tag);
  }
}

/** The panel section: the run's line, then each wave's counts and read time, its resources folded. */
export function progressSection(answer, now, link) {
  const rows = progressRows(answer, now);
  const box = document.createElement("div");
  box.className = "tg-progress";
  if (!rows.head) return box;
  const head = document.createElement("div");
  head.className = "tg-legend";
  head.textContent = rows.head + " ";
  if (rows.title) head.title = rows.title;
  if (rows.html && link) head.appendChild(link("run", hrefOf(answer, rows.html)));
  box.appendChild(head);
  for (const w of rows.waves) {
    const d = document.createElement("details");
    d.className = `tg-progress-wave tg-progress-${w.tone}`;
    const s = document.createElement("summary");
    s.textContent = `${w.text} · ${w.read}`;
    d.appendChild(s);
    for (const line of w.lines) {
      const row = document.createElement("div");
      row.className = "ws-gate-note";
      row.textContent = line;
      d.appendChild(row);
    }
    box.appendChild(d);
  }
  return box;
}
