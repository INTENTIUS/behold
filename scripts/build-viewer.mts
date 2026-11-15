/**
 * behold#1070: build the single-file viewer and hold it to its size budget.
 *
 *   tsx scripts/build-viewer.mts [--out <dir>]
 *
 * Writes `<dir>` (default dist/behold-viewer):
 *
 *   index.html   loads graph.js and viewer.js, no inline script (#1068's CSP)
 *   viewer.js    src/viewer/main.ts as a classic script (IIFE): `file://` and
 *                a Worker started from it need no module support
 *   viewer.mjs   the same as an ES module, for a host that imports it
 *   viewer.css
 *   graph.js     a stand-in a host replaces (src/viewer/graph-script.ts)
 *   viewer.html  everything inlined, for an MCP resource or an unzipped artifact
 *
 * The vendored icon table is left out (src/icons.generated.ts is most of the
 * painter's size); a host hands over the icons its document uses. A Node
 * built-in anywhere in the bundle fails the build, as
 * scripts/check-browser-bundle.mts does for the painter.
 *
 * Prints every file's size and fails when a script is over 300 KB minified or
 * 100 KB gzipped, when the directory is over 1 MB, or when viewer.js names
 * EventSource or WebSocket (the viewer opens no connection).
 */
import { builtinModules } from "node:module";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build, type Plugin } from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src", "viewer");
const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
const OUT = resolve(outAt >= 0 ? argv[outAt + 1]! : join(ROOT, "dist", "behold-viewer"));

export const BUDGET = { scriptMin: 300 * 1024, scriptGzip: 100 * 1024, directory: 1024 * 1024 };

const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const found: Array<{ path: string; importer: string }> = [];
const plugins: Plugin[] = [
  {
    name: "no-node-builtins",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (!args.path.startsWith("node:") && !BUILTIN.has(args.path)) return undefined;
        found.push({ path: args.path, importer: args.importer });
        return { path: args.path, external: true };
      });
    },
  },
  {
    name: "no-icon-table",
    setup(b) {
      b.onLoad({ filter: /icons\.generated\.ts$/ }, () => ({ contents: "export const VENDORED_ICONS = {};", loader: "ts" }));
    },
  },
];

const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const bundle = async (format: "iife" | "esm"): Promise<string> => {
  const r = await build({
    entryPoints: [join(SRC, "main.ts")],
    bundle: true,
    platform: "browser",
    format,
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "error",
    legalComments: "none",
    define: { __VIEWER_FORMAT__: JSON.stringify(format), __VIEWER_VERSION__: JSON.stringify(version) },
    plugins,
  });
  return r.outputFiles[0]!.text;
};

const [iife, esm] = [await bundle("iife"), await bundle("esm")];
if (found.length) {
  const cwd = `${ROOT}/`;
  const seen = new Set<string>();
  console.error(`viewer: the bundle imports Node built-ins, so it cannot load in a browser:`);
  for (const f of found) {
    const line = `  ${f.path}  from  ${f.importer.startsWith(cwd) ? f.importer.slice(cwd.length) : f.importer}`;
    if (!seen.has(line)) console.error(line), seen.add(line);
  }
  process.exit(1);
}

const css = readFileSync(join(SRC, "viewer.css"), "utf8");
const index = readFileSync(join(SRC, "index.html"), "utf8");
// Inside a <script> element only `</script` ends it; in the minified output it can only sit in a string.
const inlineJs = iife.replace(/<\/script/gi, "<\\/script");
const inlined = index
  .replace('<link rel="stylesheet" href="viewer.css">', () => `<style>\n${css}</style>`)
  .replace('<script src="viewer.js"></script>', () => `<script>${inlineJs}</script>`);
if (inlined === index) throw new Error("viewer: index.html no longer has the stylesheet and script tags viewer.html replaces");

mkdirSync(OUT, { recursive: true });
const files: Record<string, string> = {
  "index.html": index,
  "viewer.css": css,
  "viewer.js": iife,
  "viewer.mjs": esm,
  "graph.js": readFileSync(join(SRC, "graph.js"), "utf8"),
  "viewer.html": inlined,
};
for (const [name, text] of Object.entries(files)) writeFileSync(join(OUT, name), text);

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const failures: string[] = [];
let total = 0;
console.log(`viewer: wrote ${OUT}`);
for (const name of readdirSync(OUT).sort()) {
  const size = statSync(join(OUT, name)).size;
  total += size;
  const isScript = name === "viewer.js" || name === "viewer.mjs";
  const gz = gzipSync(readFileSync(join(OUT, name)), { level: 9 }).length;
  console.log(`  ${kb(size).padStart(9)}  ${kb(gz).padStart(9)} gzipped  ${name}`);
  if (isScript && size > BUDGET.scriptMin) failures.push(`${name} is ${kb(size)} minified, over ${kb(BUDGET.scriptMin)}`);
  if (isScript && gz > BUDGET.scriptGzip) failures.push(`${name} is ${kb(gz)} gzipped, over ${kb(BUDGET.scriptGzip)}`);
}
console.log(`  ${kb(total).padStart(9)}  the directory`);
if (total > BUDGET.directory) failures.push(`the directory is ${kb(total)}, over ${kb(BUDGET.directory)}`);
const connections = (iife.match(/EventSource|WebSocket/g) ?? []).length;
console.log(`viewer: EventSource or WebSocket in viewer.js: ${connections}`);
if (connections) failures.push(`viewer.js names EventSource or WebSocket ${connections} times`);
if (failures.length) {
  for (const f of failures) console.error(`viewer: ${f}`);
  process.exit(1);
}
console.log(`viewer: within budget (scripts ${kb(BUDGET.scriptMin)} minified and ${kb(BUDGET.scriptGzip)} gzipped, directory ${kb(BUDGET.directory)})`);
