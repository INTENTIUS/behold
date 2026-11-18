/**
 * behold#1162: what `behold export --graphdb` adds to a bundle, so its /graph
 * page answers Cypher with no server:
 *
 *   graphdb.json         the graph pane's session (./graphdb-file.ts)
 *   graph-db-wasm.js     src/graph-db/browser.ts, bundled for the browser
 *   lbug-wasm.js         `@ladybugdb/wasm-core`'s default build (async,
 *                        single-threaded, no cross-origin isolation)
 *   lbug_wasm_worker.js  its worker, which holds the engine
 *   graph-static.js      the /graph page's glue (web/graph-static.js)
 *   graph.html           web/graph.html with its inline script swapped for graph-static.js,
 *                        and what the bundle holds (staticGraphHtml)
 *   licenses/ladybugdb-wasm-core.LICENSE
 *
 * wasm-core is pinned at the version the `@ladybugdb/core` dev dependency
 * is, so the browser and the server run one engine release.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphSession } from "./pane.ts";
import { maskValue } from "./mask.ts";
import { GRAPH_LAYOUT } from "./layout.generated.ts";
import { GRAPHDB_FORMAT, LBUG_MODULE_FILE, LBUG_WORKER_FILE, catalogToFile, type GraphDbFile, type GraphDbStatus } from "./graphdb-file.ts";
import type { ResourceRow } from "./rows.ts";
import { PROJECT_TEMPLATES_FILE } from "./chant-templates.ts";

export const WASM_PACKAGE = "@ladybugdb/wasm-core";

/** Cloudflare's static assets take a file of at most 25 MiB. */
export const ASSET_FILE_LIMIT = 25 * 1024 * 1024;

export const WASM_LICENSE_FILE = "licenses/ladybugdb-wasm-core.LICENSE";

export class GraphDbExportRefusal extends Error {}

export interface WasmCore {
  dir: string;
  version: string;
  module: string;
  worker: string;
  workerBytes: number;
  license?: string;
}

const MiB = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MiB`;

/** Where wasm-core is installed beside behold, and its worker's size. */
export function findWasmCore(from: string = import.meta.url): WasmCore {
  let entry: string;
  try {
    entry = createRequire(from).resolve(WASM_PACKAGE);
  } catch {
    throw new GraphDbExportRefusal(`--graphdb needs ${WASM_PACKAGE}, which is not installed beside behold; reinstall behold (it is a dependency)`);
  }
  const dir = dirname(entry);
  const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
  const worker = join(dir, LBUG_WORKER_FILE);
  if (!existsSync(worker)) throw new GraphDbExportRefusal(`${WASM_PACKAGE} ${version} has no ${LBUG_WORKER_FILE} beside ${entry}`);
  const license = join(dir, "LICENSE");
  return { dir, version, module: entry, worker, workerBytes: statSync(worker).size, ...(existsSync(license) ? { license } : {}) };
}

/** Refuse a file a static host would not serve: named, with its size and the engine's version. */
export function checkAssetSize(file: string, bytes: number, version: string, limit: number = ASSET_FILE_LIMIT): void {
  if (bytes <= limit) return;
  throw new GraphDbExportRefusal(
    `${file} is ${MiB(bytes)} (${bytes} bytes) at ${WASM_PACKAGE} ${version}, over the ${MiB(limit)} a Cloudflare static asset may be; the bundle would not deploy`,
  );
}

/** behold's package root: the nearest folder above this module with a package.json (src/graph-db/ in a checkout, dist/ in the package). */
function packageRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(d, "package.json")) && dirname(d) !== d) d = dirname(d);
  return d;
}

/**
 * src/graph-db/browser.ts bundled for the browser. A checkout bundles it
 * from source with esbuild (a dependency); the npm package carries the
 * copy `npm run build` wrote to dist/graph-db-wasm.js.
 */
export async function browserModule(root: string = packageRoot()): Promise<string> {
  const src = join(root, "src", "graph-db", "browser.ts");
  if (existsSync(src)) {
    const esbuild = (await import(["esbuild"][0]!)) as typeof import("esbuild");
    const out = await esbuild.build({ entryPoints: [src], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "error", legalComments: "none" });
    return out.outputFiles[0]!.text;
  }
  const built = [join(root, "dist", "graph-db-wasm.js")].find((f) => existsSync(f));
  if (!built) throw new GraphDbExportRefusal("--graphdb needs the browser module this build of behold carries (dist/graph-db-wasm.js), and it is missing; reinstall behold");
  return readFileSync(built, "utf8");
}

/**
 * behold#1180: what a bundle holds, so its /graph page offers only what works
 * there. `estate` is the bundle's estate view (`./` in a plain export; none in
 * the ask demo, whose index.html is the demo page); `back` is where the header
 * link goes; `searches` are the queries `--q` captured, the only search
 * templates the estate view answers; `indexVersions` is false when the bundle
 * carries none for the diff; `cypher` starts the Cypher box.
 */
export interface GraphBundle {
  estate: { href: string } | null;
  back: { href: string; label: string };
  searches: string[];
  indexVersions: boolean;
  cypher?: { query: string; params: Record<string, unknown> };
}

/** The id of the JSON block graph.html carries a {@link GraphBundle} in. */
export const GRAPH_BUNDLE_ID = "g-bundle";

/**
 * web/graph.html as a bundle serves it: its inline module script replaced by
 * graph-static.js, which a strict policy allows, after a JSON block (data, not
 * run) saying what the bundle holds. The diff section is left out when the
 * bundle has no index versions.
 */
export function staticGraphHtml(html: string, bundle: GraphBundle): string {
  // "<" escaped so no value can close the block.
  const data = JSON.stringify(bundle).replace(/</g, "\\u003c");
  const block = `<script type="application/json" id="${GRAPH_BUNDLE_ID}">${data}</script>\n    <script type="module" src="./graph-static.js"></script>`;
  let swapped = html.replace(/<script type="module">[\s\S]*?<\/script>/, () => block);
  if (swapped === html) throw new Error("web/graph.html has no inline module script to replace");
  if (!bundle.indexVersions) {
    const cut = swapped.replace(/\n *<div id="d-section">[\s\S]*?<\/div>/, "");
    if (cut === swapped) throw new Error('web/graph.html has no <div id="d-section"> to leave out');
    swapped = cut;
  }
  return swapped;
}

/** A row's JSON column with chant's mask applied again: the same text unless the mask hid something. */
function remask(json: string): string {
  if (!json) return json;
  try {
    const v: unknown = JSON.parse(json);
    const masked = JSON.stringify(maskValue(v));
    return masked === JSON.stringify(v) ? json : masked;
  } catch {
    return json;
  }
}

/**
 * The session's rows, catalog and status as graphdb.json holds them.
 * `dropSource` is `--no-source`, applied to each resource's attrs as to the
 * bundle's other snapshots.
 */
export async function graphDbFile(
  session: GraphSession,
  status: Record<string, unknown>,
  o: { behold: string; wasm: Pick<WasmCore, "version">; dropSource?: (attrs: Record<string, unknown>) => Record<string, unknown> },
): Promise<GraphDbFile> {
  const built = await session.rows();
  const { layout, ...rows } = built.rows;
  const resources: ResourceRow[] = rows.resources.map((r) => {
    let attrs = remask(r.attrs);
    if (o.dropSource && attrs) {
      try {
        attrs = JSON.stringify(o.dropSource(JSON.parse(attrs) as Record<string, unknown>));
      } catch {
        // Not JSON: left as the row held it.
      }
    }
    return { ...r, attrs, tags: remask(r.tags), facts: remask(r.facts) };
  });
  const { peer: _peer, sources: _sources, notes: _notes, ...rest } = status;
  return {
    graphdb: GRAPHDB_FORMAT,
    behold: o.behold,
    ladybug: { package: WASM_PACKAGE, version: o.wasm.version, module: LBUG_MODULE_FILE, worker: LBUG_WORKER_FILE },
    status: rest as unknown as GraphDbStatus,
    layout: layout ?? (GRAPH_LAYOUT as unknown as GraphDbFile["layout"]),
    rows: { ...rows, resources },
    catalog: catalogToFile(session.catalog(), PROJECT_TEMPLATES_FILE),
  };
}
