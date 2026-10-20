// behold#752: where a kiosk page reads its demo. terragucci's loop (demo.json,
// cycles/<tool>/latest.json, runs/ copied from the forge) through
// /api/terragucci/…, or chant's fan-out demo's own records (demo-step/v1,
// demo-cycle/v1, runs built from chant's run events) through /api/chant/demo…
// (src/chant-demo.ts). The server says which in a meta tag
// (src/terragucci-demo.ts vendorPage); a page without it reads terragucci's,
// as every page did before.

/** The reads of terragucci's loop. `own: false`: the reports, run view, event stream and lane are read too. */
export const TERRAGUCCI_READS = {
  source: null,
  demo: "/api/terragucci/demo",
  cycle: (tool) => `/api/terragucci/cycles/${encodeURIComponent(tool)}`,
  runs: "/api/terragucci/runs",
  run: (id) => `/api/terragucci/runs/${id}`,
  own: false,
};

/**
 * The reads of chant's fan-out demo. `own: true`: the demo is chant's alone, so
 * terragucci's reports, run view, event stream and lane are never asked for.
 * The cycle is the demo's one latest cycle, whatever tool the page names.
 */
export const CHANT_DEMO_READS = {
  source: "chant-demo",
  demo: "/api/chant/demo",
  cycle: () => "/api/chant/demo/cycle",
  runs: "/api/chant/demo/runs",
  run: (id) => `/api/chant/demo/runs/${id}`,
  own: true,
};

/** The reads for a source name: chant's demo for `chant-demo`, terragucci's for anything else. */
export function readsFor(source) {
  return source === "chant-demo" ? CHANT_DEMO_READS : TERRAGUCCI_READS;
}

/** The source the page was served for (`<meta name="kiosk-source">`), or null. */
export function pageSource(doc) {
  const m = doc && doc.querySelector ? doc.querySelector('meta[name="kiosk-source"]') : null;
  const s = m ? m.getAttribute("content") : null;
  return s === "chant-demo" ? s : null;
}

/**
 * behold#815: the runs pane's reads when serve was given `--ci-report-url`:
 * chant's run index and each run's events (src/ci-run-index.ts), in place of
 * the forge's runs. Only the runs pane reads them; the demo's cycle and its
 * approval panel read as before. `from` is the pane's line under "Runs".
 */
export const CI_RUNS_READS = {
  runs: "/api/chant/ci/runs",
  run: (id) => `/api/chant/ci/runs/${encodeURIComponent(id)}`,
  from: "From chant's run index, newest first.",
};

/** The runs the page was served for (`<meta name="kiosk-runs">`): `chant-ci`, or null for the source's own. */
export function pageRuns(doc) {
  const m = doc && doc.querySelector ? doc.querySelector('meta[name="kiosk-runs"]') : null;
  return m && m.getAttribute("content") === "chant-ci" ? "chant-ci" : null;
}

/** The runs pane's reads: chant's run index for `chant-ci`, else the source's (`reads.runs`, `reads.run`). */
export function runsReadsFor(runs, reads) {
  return runs === "chant-ci" ? CI_RUNS_READS : { runs: reads.runs, run: reads.run };
}
