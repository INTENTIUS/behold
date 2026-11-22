/**
 * behold#1246: two estates side by side, on the graph pane (web/graph.html).
 *
 * Asks GET /api/graphdb/estate-merge for two sets of served members and draws
 * the answer as two columns (members, resources, cloud ids, substrates) with
 * the shared claims and the references from one side into the other beneath.
 * A refusal that lists the served members fills the two pickers. Every
 * request is a GET.
 *
 * The pure helpers are exported for web/estate-merge.test.js.
 */

/** The route for two sets of members; empty sides are left to the server's default (an estate of two members). */
export function mergeUrl(left = [], right = []) {
  const q = new URLSearchParams();
  if (left.length) q.set("left", left.join(","));
  if (right.length) q.set("right", right.join(","));
  const s = q.toString();
  return `/api/graphdb/estate-merge${s ? `?${s}` : ""}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const claimants = (list) => list.map((c) => `${esc(c.member)}: ${esc(c.name)} <span class="g-muted">(${esc(c.kind)}, ${esc(c.source)})</span>`).join("<br>");

function sideColumn(title, side) {
  const members = side.members.map((m) => `<li>${esc(m.name)}${m.kind ? ` <span class="g-muted">${esc(m.kind)}</span>` : ""}: ${m.resources} resources</li>`).join("");
  const substrates = side.substrates.length ? side.substrates.map((s) => `${esc(s.lexicon)} ${s.resources}`).join(", ") : "none";
  return `<div class="m-side"><h3>${esc(title)}</h3><ul>${members}</ul><p class="g-muted">${side.resources} resources, ${side.cloudIds} cloud ids<br>substrates: ${substrates}</p></div>`;
}

/** The answer as HTML: the two sides, the shared claims, the references across. Every value is escaped. */
export function renderMerge(m) {
  const sides = `<div class="m-sides">${sideColumn("Left", m.left)}${sideColumn("Right", m.right)}</div>`;
  const shared = m.shared.length
    ? `<table><thead><tr><th>Cloud id</th><th>Left</th><th>Right</th></tr></thead><tbody>${m.shared
        .map((c) => `<tr><td>${esc(c.value)}<br><span class="g-muted">${esc(c.kind)}</span></td><td>${claimants(c.left)}</td><td>${claimants(c.right)}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="g-muted">No cloud id is known on both sides.</p>`;
  const refs = m.references.length
    ? `<table><thead><tr><th>From</th><th>To</th><th>Via</th><th>Origin</th></tr></thead><tbody>${m.references
        .map((r) => `<tr><td>${esc(r.from)}: ${esc(r.fromKey)}</td><td>${esc(r.toKey)}</td><td>${esc(r.viaAttr)}</td><td>${esc(r.origin)}${r.rule ? ` (${esc(r.rule)})` : ""}${r.ambiguous ? ", ambiguous" : ""}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="g-muted">No reference runs from one side into the other.</p>`;
  const notes = m.notes.length ? `<ul class="g-muted">${m.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  return `${sides}<h3>Shared claims (${m.shared.length})</h3>${shared}<h3>References across (${m.references.length})</h3>${refs}${notes}`;
}

/* c8 ignore start: the DOM half, driven by the page */
export function initEstateMerge(doc = document, fetchJson = (u) => fetch(u, { headers: { accept: "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))) {
  const $ = (id) => doc.getElementById(id);
  if (!$("m-form")) return;
  const fill = (sel, names) => {
    sel.innerHTML = "";
    for (const n of names) {
      const o = doc.createElement("option");
      o.value = n;
      o.textContent = n;
      sel.append(o);
    }
  };
  const picked = (sel) => [...sel.selectedOptions].map((o) => o.value);
  let filled = false;
  const ask = async (left, right) => {
    const r = await fetchJson(mergeUrl(left, right));
    const names = r.body.members;
    if (Array.isArray(names) && names.length > 1) {
      $("m-section").hidden = false;
      if (!filled) {
        fill($("m-left"), names);
        fill($("m-right"), names);
        filled = true;
      }
    }
    if (r.status === 200) {
      $("m-section").hidden = false;
      $("m-error").textContent = "";
      $("m-answer").innerHTML = renderMerge(r.body);
    } else if (r.status === 400 && !left.length && !right.length) {
      // No default sides: the pickers are filled, and the answer waits for a choice.
      $("m-error").textContent = "";
      $("m-answer").innerHTML = `<p class="g-muted">${esc(r.body.error ?? "Pick the members on each side.")}</p>`;
    } else if (r.status !== 404) {
      $("m-error").textContent = `${r.body.error ?? "Refused."}${r.body.code ? ` (${r.body.code})` : ""}`;
    }
  };
  $("m-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    ask(picked($("m-left")), picked($("m-right")));
  });
  ask([], []);
}
/* c8 ignore stop */
