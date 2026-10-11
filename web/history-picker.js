// #510: a published view lives at views/<name>/<commit>/, with
// views/<name>/history.json beside the commits (newest first, {commit, at,
// project, generated}). Inside one, this picker reads ../history.json and
// opens another commit's view. It only reads: switching is a navigation, and
// a bundle served anywhere without a history.json beside it shows no picker.

const COMMIT_SHAPE = /^[0-9a-f]{7,64}$/;

/** The rows of a history.json document worth offering, in its order. */
export function historyRows(doc) {
  if (!Array.isArray(doc)) return [];
  return doc.filter((e) => e && typeof e === "object" && typeof e.commit === "string" && COMMIT_SHAPE.test(e.commit));
}

/** Which row the page at `pathname` is: the commit named by one of its path segments, or null. */
export function commitOfPath(pathname, rows) {
  const segs = String(pathname || "").split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const hit = rows.find((r) => r.commit === segs[i]);
    if (hit) return hit.commit;
  }
  return null;
}

const stamp = (iso) => (typeof iso === "string" && iso.length >= 16 ? iso.slice(0, 16).replace("T", " ") : "");

/** One option's words: the commit, and when its view was exported. */
export function historyLabel(row) {
  const when = stamp(row.generated) || stamp(row.at);
  return `${row.commit.slice(0, 12)}${when ? ` · exported ${when}` : ""}`;
}

/** One option's tooltip. */
export function historyTitle(row) {
  return [`commit ${row.commit}`, row.at ? `committed ${row.at}` : "", row.generated ? `exported ${row.generated}` : "", row.project ? `project ${row.project}` : ""].filter(Boolean).join("\n");
}

/** Where a pick goes: the sibling commit's view, keeping the lens in the query and the fragment. */
export function commitHref(commit, search = "", hash = "") {
  return `../${commit}/index.html${search || ""}${hash || ""}`;
}

/**
 * Read ../history.json and put a commit picker into `host`. Resolves to the
 * <select>, or null when there is no history to pick from.
 */
export async function mountHistoryPicker(host, env = {}) {
  const fetchFn = env.fetch || ((u, o) => fetch(u, o));
  const loc = env.location || location;
  const doc = env.document || document;
  let rows;
  try {
    const r = await fetchFn("../history.json", { cache: "no-cache" });
    if (!r.ok) return null;
    rows = historyRows(await r.json());
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const current = commitOfPath(loc.pathname, rows);
  const select = doc.createElement("select");
  select.title = "Published views, newest first: open the view exported at another commit";
  select.setAttribute("aria-label", "Published view history");
  select.style.cssText = "align-self:center;font:var(--t-caption)/1.4 var(--font-mono);color:var(--fg);background:var(--panel);border:1px solid var(--line);border-radius:var(--r-ctl);padding:1px 4px;margin-left:6px;max-width:16em";
  if (!current) {
    const here = doc.createElement("option");
    here.value = "";
    here.textContent = "this view (not in history)";
    here.selected = true;
    select.appendChild(here);
  }
  for (const row of rows) {
    const o = doc.createElement("option");
    o.value = row.commit;
    o.textContent = historyLabel(row);
    o.title = historyTitle(row);
    if (row.commit === current) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", () => {
    if (select.value && select.value !== current) loc.assign(commitHref(select.value, loc.search, loc.hash));
  });
  host.appendChild(select);
  return select;
}
