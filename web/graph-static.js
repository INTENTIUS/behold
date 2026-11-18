/**
 * behold#1162: the /graph page of a bundle `behold export --graphdb` wrote.
 *
 * The page is web/graph.html with this module in place of its inline script,
 * and web/graph-query.js and web/index-diff.js unchanged: every request they
 * make for /api/graphdb/* goes to the browser module (graph-db-wasm.js,
 * src/graph-db/browser.ts) instead of a server. That module, LadybugDB's
 * WebAssembly build and its worker load after the page has drawn; until the
 * database is built, the Cypher box says it is loading and its button waits.
 */
import { initGraphPane } from "./graph-query.js";
import { initIndexDiff } from "./index-diff.js";

const GRAPHDB = new URL("./graphdb.json", import.meta.url).href;

let opening;
let begin;
/** Settles once the page has drawn: nothing is fetched for the database before. */
const begun = new Promise((resolve) => (begin = resolve));
/** The database, opened once. */
const open = () => (opening ??= import("./graph-db-wasm.js").then((m) => m.openGraphDb(GRAPHDB)));
const fetchJson = async (url) => {
  await begun;
  return (await open()).fetchJson(url);
};

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
  showLoading(doc, "loading");
  initGraphPane(doc, fetchJson);
  initIndexDiff(doc, fetchJson);
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
