// The demo catalog in the switcher (#268) — the panel's half of `behold demo
// --list`. The server (GET /api/demos) answers with the install's own bundled
// catalog, each entry already carrying whether it can run on this machine
// (doctor's PATH probes) and whether starting it reaches the network. This
// module turns one of those rows into what a button says about it; app.js
// builds the DOM with the panel's own helpers.
//
// A demo that can't run here is rendered disabled with its reason on its face,
// never hidden: "k8s needs k3d" is a thing worth knowing, and a catalog that
// silently shrinks to what happens to be installed teaches nothing.

/** GET the catalog. Never throws and never rejects — a server too old to know
 * the route (or an export with no server at all) is an empty catalog, and the
 * demos group simply doesn't render. */
export async function fetchDemos(fetchImpl) {
  const get = fetchImpl || ((u) => fetch(u));
  try {
    const res = await get("/api/demos");
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body.demos) ? body.demos : [];
  } catch {
    return [];
  }
}

/** `https://github.com/INTENTIUS/fountain-ops` → `github.com/INTENTIUS/fountain-ops`
 * — a label wants the host and the path, not the scheme. */
export function shortRepo(repo) {
  return String(repo || "").replace(/^[a-z+]+:\/\//i, "").replace(/\.git$/, "");
}

/** The one thing worth saying about this demo beyond its name: why it can't
 * run, that starting it clones from the network, or that it's already on disk. */
export function demoNote(demo) {
  if (!demo.satisfiable) return demo.reason || "unavailable here";
  if (demo.fetches) return demo.repo ? `clones ${shortRepo(demo.repo)}` : "clones from the network";
  if (demo.loaded) return "loaded";
  return "";
}

export function demoLabel(demo) {
  const note = demoNote(demo);
  return note ? `${demo.name} · ${note}` : demo.name;
}

/** The tooltip: what the demo is, then exactly what clicking it will do —
 * including the fetch, before it happens. */
export function demoTitle(demo) {
  if (!demo.satisfiable) {
    return `${demo.description}\n\nCan't run here — ${demo.reason || "a prerequisite is missing"}. Install it and reopen behold.`;
  }
  const source = demo.fetches
    ? `Clones ${demo.repo || "a public repo"} into ${demo.target}`
    : `${demo.loaded ? "Reuses" : "Copies the bundled example to"} ${demo.target}`;
  const setup = ", installs its dependencies";
  return `${demo.description}\n\n${source}${setup}, then serves it here. It's yours — edit it and the graph follows.`;
}

/** The loading line, said while it runs. Distinguishes the fetch from the copy
 * for the same reason the button does. */
export function demoProgress(demo) {
  return `loading the ${demo.name} demo — ${demo.fetches ? "cloning" : "copying"}, installing…`;
}
