/**
 * behold#1162: the /graph page of a bundle `behold export --graphdb` wrote.
 *
 * The page is web/graph.html with this module in place of its inline script,
 * and web/graph-query.js and web/index-diff.js unchanged: every request they
 * make for /api/graphdb/* goes to the browser module (graph-db-wasm.js,
 * src/graph-db/browser.ts) instead of a server. That module, LadybugDB's
 * WebAssembly build and its worker load after the page has drawn; until the
 * database is built, the Cypher box says it is loading and its button waits.
 *
 * behold#1180: the page carries a JSON block (#g-bundle, staticGraphHtml in
 * src/graph-db/export-graphdb.ts) saying what the bundle holds. The pane
 * offers only what works here: search templates open the estate view only for
 * a query `--q` captured, the estate links go to the bundle's estate view or
 * are hidden when it has none, the diff starts only with index versions, and
 * the Cypher box can start with a query.
 */
import { initGraphPane } from "./graph-query.js";
import { initIndexDiff } from "./index-diff.js";

const GRAPHDB = new URL("./graphdb.json", import.meta.url).href;

let opening;
let begin;
/** Settles once the page has drawn: nothing is fetched for the database before. */
const begun = new Promise((resolve) => (begin = resolve));
/** The database, opened once. */
// View links relative to this folder ("./?focus=..."), the bundle's estate view.
const open = () => (opening ??= import("./graph-db-wasm.js").then((m) => m.openGraphDb(GRAPHDB, { origin: "." })));
const fetchJson = async (url) => {
  await begun;
  return (await open()).fetchJson(url);
};

/** What a page without a #g-bundle block is taken to hold: an estate view beside it, and nothing else. */
export const DEFAULT_BUNDLE = Object.freeze({ estate: { href: "./" }, back: { href: "./", label: "Back to the estate" }, searches: [], indexVersions: false });

/** The bundle's description from the page's #g-bundle block; {@link DEFAULT_BUNDLE} where it is missing or unreadable. */
export function readBundle(doc) {
  const text = doc.getElementById("g-bundle")?.textContent;
  if (!text) return DEFAULT_BUNDLE;
  try {
    const b = JSON.parse(text);
    return {
      estate: b.estate && typeof b.estate.href === "string" ? { href: b.estate.href } : null,
      back: b.back && typeof b.back.href === "string" && typeof b.back.label === "string" ? { href: b.back.href, label: b.back.label } : DEFAULT_BUNDLE.back,
      searches: Array.isArray(b.searches) ? b.searches.filter((q) => typeof q === "string") : [],
      indexVersions: b.indexVersions === true,
      ...(b.cypher && typeof b.cypher.query === "string" ? { cypher: { query: b.cypher.query, params: b.cypher.params && typeof b.cypher.params === "object" ? b.cypher.params : {} } } : {}),
    };
  } catch {
    return DEFAULT_BUNDLE;
  }
}

/** The options initGraphPane takes for a bundle: its search templates and its estate links. */
export function paneOptions(bundle) {
  return { bundle: { estate: bundle.estate, searches: bundle.searches }, viewLinks: Boolean(bundle.estate) };
}

/** The bundle's header link and starting Cypher, and its diff section left out without index versions. */
export function applyBundle(doc, bundle) {
  const back = doc.getElementById("g-back");
  if (back) {
    back.setAttribute("href", bundle.back.href);
    back.textContent = bundle.back.label;
  }
  if (bundle.cypher) {
    const box = doc.getElementById("g-cypher");
    const params = doc.getElementById("g-params");
    if (box) box.value = bundle.cypher.query;
    if (params) params.value = Object.keys(bundle.cypher.params).length ? JSON.stringify(bundle.cypher.params) : "";
  }
  if (!bundle.indexVersions) doc.getElementById("d-section")?.remove();
}

/** The loading line above the Cypher box, and the button that waits for it. */
export function showLoading(doc, state, detail = "") {
  const form = doc.getElementById("g-cypher-form");
  if (!form) return;
  let line = doc.getElementById("g-loading");
  if (!line) {
    line = doc.createElement("p");
    line.id = "g-loading";
    line.className = "g-muted";
    line.setAttribute("role", "status");
    form.before(line);
  }
  const button = form.querySelector("button[type=submit]");
  if (state === "loading") {
    line.textContent = "Loading the graph database in this page (LadybugDB's WebAssembly build). Cypher answers once it is ready.";
    line.hidden = false;
    if (button) {
      button.disabled = true;
      button.textContent = "Loading...";
    }
  } else if (state === "ready") {
    line.textContent = "";
    line.hidden = true;
    if (button) {
      button.disabled = false;
      button.textContent = "Ask";
    }
  } else {
    line.textContent = `The graph database did not load: ${detail}`;
    line.hidden = false;
    if (button) button.textContent = "Ask";
  }
}

/* c8 ignore start: the DOM half, driven by the page */
export function initStaticGraphPane(doc = document) {
  const bundle = readBundle(doc);
  applyBundle(doc, bundle);
  showLoading(doc, "loading");
  initGraphPane(doc, fetchJson, paneOptions(bundle));
  if (bundle.indexVersions) initIndexDiff(doc, fetchJson);
  // After the first frame, so the page is on screen before 23 MiB of engine arrive.
  const start = () => {
    begin();
    return open()
      .then((db) => db.ready.then(() => db.status()))
      .then((s) => {
        showLoading(doc, "ready");
        const peer = s.body?.peer;
        if (peer?.available) doc.getElementById("g-peer").textContent = `LadybugDB ${peer.version ?? ""}`.trim();
      })
      .catch((e) => {
        showLoading(doc, "failed", e?.message ?? String(e));
        doc.getElementById("g-peer").textContent = `LadybugDB did not load: ${e?.message ?? String(e)}`;
      });
  };
  globalThis.requestAnimationFrame ? requestAnimationFrame(() => setTimeout(start, 0)) : setTimeout(start, 0);
}
/* c8 ignore stop */

if (typeof document !== "undefined" && document.getElementById("g-cypher-form")) initStaticGraphPane(document);
