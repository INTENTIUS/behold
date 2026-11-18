/**
 * behold#1163: the ask demo page as a static bundle, ready for
 * `npx wrangler deploy`.
 *
 *   just ask-demo-bundle                      ask-demo/narration.json into dist-ask-demo/
 *   npx tsx scripts/ask-demo/bundle.ts [--narration <file>] [--estate <dir>] [--out <dir>]
 *
 * It plays the recording `just ask-demo-record` made: the narration, and the
 * estate it was recorded against, which the recorder keeps beside it in
 * ask-demo/estate/ (graph.json, the GET /api/graph answer the cards to light
 * came from, and graphdb.json, the graph pane's rows). Nothing is read from a
 * project or a cloud here, so the page draws the estate that answered.
 *
 * The bundle:
 *
 *   index.html            the page (ask-demo/page/index.html)
 *   ask-demo.js           ask-demo/page/main.js and what it imports, bundled
 *   narration.json        the recording
 *   estate.json           the estate graph's SVG and its cards' ids
 *   graphdb.json          the rows a visitor's Cypher runs on
 *   graph-db-wasm.js, lbug-wasm.js, lbug_wasm_worker.js
 *                         the browser's graph database, as `behold export --graphdb` carries it
 *   graph.html, graph-static.js, graph-query.js, index-diff.js
 *                         the full /graph pane over the same rows
 *   LICENSE, THIRD_PARTY.md, licenses/, wrangler.jsonc, .assetsignore
 *   _headers              the content security policy the Worker serves every
 *                         file with (behold#1164): the bundle's own origin only,
 *                         plus WebAssembly and the engine's blob: worker
 *
 * Refused, naming what is wrong, when the estate is missing or is not the
 * one the narration lights.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { copyNotices } from "../../src/export.ts";
import { WASM_LICENSE_FILE, browserModule, checkAssetSize, findWasmCore, staticGraphHtml, type GraphBundle } from "../../src/graph-db/export-graphdb.ts";
import { GRAPHDB_FILE, GRAPHDB_MODULE_FILE, LBUG_MODULE_FILE, LBUG_WORKER_FILE, isGraphDbFile } from "../../src/graph-db/graphdb-file.ts";
import { cardIndex, type IrNodeLike } from "../../web/key-light.js";
import { validateNarration, type Narration } from "./narration.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGE = join(ROOT, "ask-demo", "page");

export const DEFAULT_OUT = "dist-ask-demo";
export const WORKER_NAME = "behold-ask-demo";
/** The wrangler the check serves the bundle with and the deploy recipe runs, pinned. */
export const WRANGLER_VERSION = "4.156.2";
export const ESTATE_FILE = "estate.json";
/** The /graph pane's own files, from web/, beside the page. */
export const GRAPH_PANE_FILES = ["graph-static.js", "graph-query.js", "index-diff.js"] as const;

/**
 * behold#1164: the policy every file is served with. Nothing loads from
 * outside the bundle. LadybugDB starts its worker from a blob: URL that
 * importScripts lbug_wasm_worker.js, and the worker inherits this policy. It
 * compiles WebAssembly ('wasm-unsafe-eval'), and its embind glue builds each
 * C++ binding's invoker with `new Function`, so the worker needs
 * 'unsafe-eval' too (without it the engine does not load; `just
 * ask-demo-check` shows it). Every script is a file of the bundle: no inline
 * script, no other origin. Inline styles stay: the page and the drawn SVG
 * carry them.
 */
export const ASK_DEMO_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Cloudflare's `_headers` file: every path gets the policy. Wrangler reads it and does not serve it. */
export function headersFile(): string {
  return `/*\n  Content-Security-Policy: ${ASK_DEMO_CSP}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`;
}

export class BundleRefusal extends Error {}

/** What estate.json holds: the SVG, and each card's id with the ids of what it stacks. */
export interface EstateFile {
  svg: string;
  nodes: IrNodeLike[];
}

/** The estate graph trimmed to what the page reads: the drawing, and the ids it can light. */
export function estateFile(graph: { ir?: { nodes?: IrNodeLike[] }; svg?: string }): EstateFile {
  if (!graph || typeof graph.svg !== "string" || !Array.isArray(graph.ir?.nodes)) throw new BundleRefusal("the estate graph is not a GET /api/graph answer (it needs ir.nodes and svg)");
  return {
    svg: graph.svg,
    nodes: graph.ir.nodes.map((n) => {
      const stack = (n.attrs?._stackOf ?? []).filter((s) => typeof s?.id === "string").map((s) => ({ id: s.id }));
      return stack.length ? { id: n.id, attrs: { _stackOf: stack } } : { id: n.id };
    }),
  };
}

/** Each turn's lit card the estate graph does not draw, as `turn: card`. */
export function unlitCards(narration: Pick<Narration, "turns">, nodes: readonly IrNodeLike[]): string[] {
  const cards = new Set(cardIndex(nodes).values());
  return narration.turns.flatMap((t) => t.light.filter((id) => !cards.has(id)).map((id) => `${t.id}: ${id}`));
}

/**
 * behold#1180: what the demo's graph.html is told about the bundle. It has no
 * estate view (index.html is the demo page), so the header link goes back to
 * the demo and an answer has no estate link; the Cypher box starts with the
 * first question's query and parameters.
 */
export function askDemoGraphBundle(narration: Pick<Narration, "turns">): GraphBundle {
  const first = narration.turns.find((t) => t.kind === "question" && t.cypher);
  return {
    estate: null,
    back: { href: "./", label: "Back to the demo" },
    searches: [],
    indexVersions: false,
    ...(first?.cypher ? { cypher: { query: first.cypher, params: first.params ?? {} } } : {}),
  };
}

export interface BundleOptions {
  narration: string;
  estate: string;
  out: string;
}

export interface BundleResult {
  files: Array<{ path: string; bytes: number }>;
  turns: number;
}

function readJson(file: string, what: string): unknown {
  if (!existsSync(file)) throw new BundleRefusal(`${what} is missing: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new BundleRefusal(`${what} is not JSON (${file}): ${(e as Error).message}`);
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

export async function buildAskDemoBundle(o: BundleOptions): Promise<BundleResult> {
  const narration = readJson(o.narration, "the narration") as Narration;
  const problems = validateNarration(narration, readJson(join(ROOT, "ask-demo", "narration.schema.json"), "the narration's schema") as object);
  if (problems.length) throw new BundleRefusal(`${o.narration} does not meet ask-demo/narration.schema.json:\n  ${problems.join("\n  ")}`);
  const how = "the recorder keeps it beside the narration; record again with `just ask-demo-record`";
  const estate = estateFile(readJson(join(o.estate, "graph.json"), `the estate graph the narration was recorded against (${how})`) as never);
  const rows = readJson(join(o.estate, GRAPHDB_FILE), `the estate's graph pane rows (${how})`);
  if (!isGraphDbFile(rows)) throw new BundleRefusal(`${join(o.estate, GRAPHDB_FILE)} is not a graphdb.json this build reads; record again with \`just ask-demo-record\``);
  const unlit = unlitCards(narration, estate.nodes);
  if (unlit.length) throw new BundleRefusal(`the estate graph in ${o.estate} draws no card for what the narration lights, so they are not from one recording:\n  ${unlit.slice(0, 10).join("\n  ")}`);
  const keys = new Set(rows.rows.resources.map((r) => r.key));
  const unknown = narration.turns.flatMap((t) => t.keys.filter((k) => !keys.has(k)).map((k) => `${t.id}: ${k}`));
  if (unknown.length) throw new BundleRefusal(`the rows in ${join(o.estate, GRAPHDB_FILE)} lack keys the narration's answers name, so they are not from one recording:\n  ${unknown.slice(0, 10).join("\n  ")}`);

  const wasm = findWasmCore();
  const out = resolve(o.out);
  mkdirSync(out, { recursive: true });
  const js = await build({
    entryPoints: [join(PAGE, "main.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
    logLevel: "error",
    // The graph database loads on its own, after the page has drawn.
    external: [`./${GRAPHDB_MODULE_FILE}`],
  });
  writeFileSync(join(out, "index.html"), readFileSync(join(PAGE, "index.html")));
  writeFileSync(join(out, "ask-demo.js"), js.outputFiles[0]!.text);
  copyFileSync(o.narration, join(out, "narration.json"));
  writeFileSync(join(out, ESTATE_FILE), `${JSON.stringify(estate)}\n`);
  copyFileSync(join(o.estate, GRAPHDB_FILE), join(out, GRAPHDB_FILE));
  writeFileSync(join(out, GRAPHDB_MODULE_FILE), await browserModule(ROOT));
  copyFileSync(wasm.module, join(out, LBUG_MODULE_FILE));
  copyFileSync(wasm.worker, join(out, LBUG_WORKER_FILE));
  writeFileSync(join(out, "graph.html"), staticGraphHtml(readFileSync(join(ROOT, "web", "graph.html"), "utf8"), askDemoGraphBundle(narration)));
  for (const f of GRAPH_PANE_FILES) cpSync(join(ROOT, "web", f), join(out, f));
  copyNotices(out, ROOT);
  if (wasm.license) {
    mkdirSync(join(out, dirname(WASM_LICENSE_FILE)), { recursive: true });
    copyFileSync(wasm.license, join(out, WASM_LICENSE_FILE));
  }
  writeFileSync(join(out, "wrangler.jsonc"), `${JSON.stringify({ $schema: "node_modules/wrangler/config-schema.json", name: WORKER_NAME, compatibility_date: "2025-06-01", assets: { directory: "." } }, null, 2)}\n`);
  writeFileSync(join(out, ".assetsignore"), ".wrangler\n.assetsignore\nwrangler.jsonc\n");
  writeFileSync(join(out, "_headers"), headersFile());

  const files = filesUnder(out).map((path) => ({ path, bytes: statSync(join(out, path)).size }));
  for (const f of files) {
    try {
      checkAssetSize(f.path, f.bytes, wasm.version);
    } catch (e) {
      throw new BundleRefusal((e as Error).message);
    }
  }
  return { files, turns: narration.turns.length };
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string, dflt: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
  };
  const narration = resolve(arg("--narration", join(ROOT, "ask-demo", "narration.json")));
  const estate = resolve(arg("--estate", join(dirname(narration), "estate")));
  const out = resolve(arg("--out", join(ROOT, DEFAULT_OUT)));
  const r = await buildAskDemoBundle({ narration, estate, out });
  const largest = [...r.files].sort((a, b) => b.bytes - a.bytes)[0]!;
  const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
  process.stdout.write(
    `ask-demo bundle → ${out}\n  ${r.files.length} files, ${mib(r.files.reduce((s, f) => s + f.bytes, 0))}; largest ${largest.path} ${mib(largest.bytes)} (a static asset may be 25 MiB)\n` +
      `  ${r.turns} turns from ${relative(process.cwd(), narration) || narration}\n` +
      `  Check:  just ask-demo-check ${relative(process.cwd(), out) || out}\n` +
      `  Deploy: cd ${relative(process.cwd(), out) || out} && npx wrangler@${WRANGLER_VERSION} deploy (or just ask-demo-deploy)\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`ask-demo bundle: ${e instanceof BundleRefusal ? e.message : ((e as Error).stack ?? String(e))}\n`);
      process.exit(e instanceof BundleRefusal ? 2 : 1);
    },
  );
}
