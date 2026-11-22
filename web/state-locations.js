// behold#1247: the State tab. Pure words from /api/workspace/state, and one
// render. One table row per member and environment: the substrate that holds
// the member's state, the backend and where it is, how it is locked, and
// whether chant could reach it. Every value is chant's (workspace state,
// chant#5456), kept as chant wrote it; chant masks a secret in a location.
// A member whose lexicon publishes no location, a member chant skipped and a
// member it could not read each get one row with chant's words and no
// invented location. `unchecked` reach is drawn neutral with its own label.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A location map as `key=value` pairs in the order chant wrote them. */
export function locationText(location) {
  if (!location) return "";
  return Object.entries(location)
    .map(([k, v]) => `${k}=${v === null ? "(none)" : v}`)
    .join(" ");
}

/** The lock column: its mechanism and where it is, or that the state is not locked. */
export function lockText(lock) {
  if (!lock) return "not locked";
  const where = locationText(lock.location);
  return where ? `${lock.mechanism} ${where}` : lock.mechanism;
}

/** The tone class of a reach status: only chant's own words earn a colour. */
const REACH_TONE = { reachable: "state-ok", unreachable: "state-fail", unchecked: "state-quiet" };

/** The tab's first line: what was read, or why it wasn't. */
export function stateLegend(a) {
  if (!a || a.error) return { text: `state locations not read${a && a.error ? `: ${a.error}` : ""}`, title: a && a.remedy ? a.remedy : "", tone: "refusal" };
  if (a.workspace === false) return { text: "State locations are read from a declared chant workspace.", title: "", tone: "quiet" };
  if (a.refusal) return { text: `state locations not read: ${a.refusal.error}`, title: a.refusal.remedy || "", tone: "refusal" };
  const s = a.summary || { members: 0, published: 0, locations: 0, unreachable: 0 };
  const scope = [a.member ? `member ${a.member}` : null, a.env ? `environment ${a.env}` : "every environment"].filter(Boolean).join(" · ");
  const bad = s.unreachable ? ` · ${s.unreachable} unreachable` : "";
  return {
    text: `${plural(s.locations, "state location")} in ${plural(s.published, "member")} of ${s.members} · ${scope}${bad}`,
    title: "Where each member's state lives, as chant workspace state reads it. A Terraform backend is found from its configuration and is not checked.",
    tone: "quiet",
  };
}

/** One table row as cells and a tone. */
export function stateRowView(r) {
  if (!r.location && !r.backend) {
    return { member: r.member, kind: r.kind, cells: [r.member, r.kind, "", "", "", "", r.note || "no state location", ""], reachTone: "state-quiet", reach: "", note: true };
  }
  const reach = r.reach || { status: "", label: "", reason: null };
  return {
    member: r.member,
    kind: r.kind,
    cells: [r.member, r.kind, r.environment === null ? "(none)" : r.environment, r.unit || "", `${r.substrate} ${r.backend}`.trim(), locationText(r.location), lockText(r.lock), reach.label],
    reachTone: REACH_TONE[reach.status] || "state-quiet",
    reach: reach.reason || "",
    note: false,
  };
}

export const STATE_COLUMNS = ["member", "kind", "environment", "unit", "backend", "location", "lock", "reach"];

/** The whole tab as words. */
export function stateView(a) {
  const legend = stateLegend(a);
  if (!a || a.error || a.refusal || a.workspace === false) return { legend, rows: [] };
  return { legend, rows: (a.rows || []).map(stateRowView) };
}

/** Draw the tab into `host`. */
export function renderState(host, a) {
  host.replaceChildren();
  const v = stateView(a);
  const el = (tag, cls, text, title) => {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    if (title) d.title = title;
    return d;
  };
  host.appendChild(el("div", v.legend.tone === "refusal" ? "tg-refusal" : "tg-legend", v.legend.text, v.legend.title));
  if (!v.rows.length) return;
  const table = el("table", "state-table");
  const head = el("tr", "state-head");
  for (const c of STATE_COLUMNS) head.appendChild(el("th", "", c));
  table.appendChild(head);
  for (const r of v.rows) {
    const tr = el("tr", r.note ? "state-row state-note" : "state-row");
    tr.dataset.member = r.member;
    r.cells.forEach((text, i) => {
      const last = i === r.cells.length - 1;
      tr.appendChild(el("td", last ? r.reachTone : "", text, last && r.reach ? r.reach : undefined));
    });
    table.appendChild(tr);
  }
  host.appendChild(table);
}
