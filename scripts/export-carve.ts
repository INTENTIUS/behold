// `npm run export:carve` (#712): the recorded terralith carve as one static
// page, `dist-carve/index.html`, that needs no behold server. It holds the card
// SVG (rendered here, as /api/graph renders it for the preview), the
// recording (gzipped, base64), and one script bundling the dots layer, the
// theme and the narration (web/carve-export.js). The recording is copied
// beside it too, as the page's source.
//
//   npm run export:carve                       the terralith-14 carve
//   npm run export:carve -- --source terralith the 23-resource walkthrough
//   npm run export:carve -- --out <dir>
//
// Open dist-carve/index.html from disk, or serve the folder: `npm run preview:carve`.

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DOTS_SOURCE, dotsIr, readDotsSource, showOf } from "../src/dots-preview.ts";
import { renderGrid } from "../src/render.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const name = arg("--source", DEFAULT_DOTS_SOURCE);
const out = resolve(arg("--out", join(root, "dist-carve")));
const opts = { recordings: join(root, "scripts", "dot-bench"), walkthrough: join(root, "src", "__fixtures__", "terralith") };

const src = readDotsSource(opts, name);
const show = showOf(src);
const { ir, order } = dotsIr(show);
// Theme-neutral: the page's theme supplies every --pin-* the SVG asks for (web/app.js does the same).
const svg = renderGrid(ir, order, show.source).svg.replace(/:root\s*\{[^{}]*--pin-[^{}]*\}/g, "");

let data: Record<string, unknown>;
let recordingFile: string | null = null;
if (src.kind === "carve") {
  const base = name.replace(/^carve:/, "");
  const gz = join(opts.recordings, `${base}.jsonl.gz`);
  const bytes = existsSync(gz) ? readFileSync(gz) : (await import("node:zlib")).gzipSync(readFileSync(join(opts.recordings, `${base}.jsonl`)));
  data = { name, kind: "carve", gz: bytes.toString("base64") };
  recordingFile = existsSync(gz) ? gz : null;
} else {
  data = { name, kind: "walkthrough", model: src.model };
}

const bundle = await build({
  entryPoints: [join(root, "web", "carve-export.js")],
  bundle: true,
  format: "iife",
  minify: true,
  write: false,
  target: "es2022",
  legalComments: "none",
  logLevel: "error",
});
const js = bundle.outputFiles[0]!.text;
// Nothing inlined may close its <script> early.
const safe = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

const CSS = `
:root { --font-ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace; --t-body: 13px; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--fg); font: 14px/1.35 var(--font-ui); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; }
#cx-head { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--surface-pane-a, var(--panel)); }
#cx-bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; min-width: 0; flex: 1; }
.cx-place { display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
.cx-src { font: 600 13px var(--font-mono); color: var(--fg); }
.cx-rec { display: inline-block; font: 600 11px var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted-ink, var(--muted)); border: 1px solid var(--rule, var(--line)); border-radius: 999px; padding: 1px 8px; cursor: help; vertical-align: 0.15em; margin-right: 10px; }
.cx-strip { display: flex; gap: 6px; list-style: none; margin: 0; padding: 0; }
.cx-stop { font: 12px var(--font-mono); padding: 2px 9px; border-radius: 999px; border: 1px solid var(--rule, var(--line)); color: var(--muted); white-space: nowrap; }
.cx-stop.cx-done { color: var(--fg); }
.cx-stop.cx-current { background: var(--active); color: var(--fg); border-color: var(--focus); }
#cx-theme select { max-width: 180px; }
#graph { position: relative; overflow: hidden; min-height: 0; }
#graph > svg { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
#cx-caption { padding: 10px 18px 12px; background: var(--surface-pane-b, var(--panel)); border-top: 1px solid var(--line); display: grid; gap: 4px; }
.cx-top { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
.cx-title { margin: 0; font-size: 21px; line-height: 1.2; min-width: 0; }
.cx-next { margin: 0 0 0 auto; color: var(--muted); font: 13px var(--font-mono); position: relative; padding-bottom: 7px; white-space: nowrap; }
.cx-nbar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--rule, var(--line)) 55%, transparent); overflow: hidden; }
.cx-nbar-in { position: absolute; left: 0; top: 0; bottom: 0; background: var(--bar, var(--bar-pending)); border-radius: inherit; }
.cx-row { margin: 0; display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 10px; padding-left: 10px; box-shadow: inset 3px 0 0 var(--bar, var(--bar-neutral)); }
.cx-label { font: 600 11px var(--font-mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--bar, var(--muted)); padding-top: 3px; }
.cx-lead { font-size: 16px; font-weight: 600; }
.cx-tone-busy { --bar: var(--bar-pending); }
.cx-tone-ok { --bar: var(--bar-managed); }
.cx-tone-bad { --bar: var(--bar-degraded); }
.cx-tone-idle { --bar: var(--bar-neutral); }
.cx-error { position: fixed; inset: auto 16px 16px; padding: 10px; background: var(--panel); border: 1px solid var(--bar-degraded); }
@media (max-width: 640px) {
  #cx-head { flex-wrap: wrap; padding: 6px 12px; }
  .cx-strip { display: none; }
  #cx-theme select { max-width: 120px !important; }
  .cx-place { min-width: 0; overflow: hidden; }
  #cx-caption { padding: 8px 12px 10px; }
  .cx-title { font-size: 16px; }
  .cx-next { margin-left: 0; flex: 1 1 100%; }
  .cx-row { grid-template-columns: 5em minmax(0, 1fr); }
  .cx-lead { font-size: 14px; }
}
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>behold · the terralith carve, recorded</title>
<meta name="description" content="A recorded carve of ${show.source}, ${show.roster.length.toLocaleString("en-US")} resources, replayed: one Terraform state moved into team estates by tag writes alone.">
<style>${CSS}</style>
</head>
<body>
<header id="cx-head"><div id="cx-bar"></div><div id="cx-theme"></div></header>
<main id="graph" aria-label="The carve, replayed">${svg}</main>
<footer id="cx-caption" aria-live="polite"></footer>
<div id="eh-tips" aria-live="polite"></div>
<div id="eh-modals"></div>
<script id="cx-data" type="application/json">${safe(JSON.stringify(data))}</script>
<script>${safe(js)}</script>
</body>
</html>
`;

mkdirSync(out, { recursive: true });
const page = join(out, "index.html");
writeFileSync(page, html);
if (recordingFile) copyFileSync(recordingFile, join(out, recordingFile.split("/").pop()!));
const kb = (p: string) => `${Math.round(statSync(p).size / 1024)} KB`;
process.stdout.write(`wrote ${page} (${kb(page)})${recordingFile ? `, and ${join(out, recordingFile.split("/").pop()!)} (${kb(recordingFile)})` : ""}\n`);
