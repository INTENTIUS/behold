/// <reference lib="dom" />
// behold#1162: `behold export --graphdb`. A fixture estate (a chant project with a choudoufu
// document, a plunge document, an index version and its own .chant/templates.json) is exported
// twice, without and with the flag. Without it the bundle is the bundle it was: no file of the
// flag's, graph.html as web/graph.html. With it, the bundle is served over HTTP and opened in a
// real headless Chrome (the shot launcher's, as src/export-csp.test.ts does), where every Cypher
// template of the catalog is run for every node it applies to in LadybugDB's WebAssembly build,
// and each answer must equal the server's (`@ladybugdb/core`) over the same rows. Skipped, saying
// so, where no browser launches; the server half needs the real engine (BEHOLD_REQUIRE_LADYBUG).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, relative } from "node:path";
import type { GraphIR } from "@intentius/chant";

vi.mock("../chant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chant.ts")>()),
  graphIr: vi.fn(),
}));
import { graphIr } from "../chant.ts";
import { GRAPHDB_FILES, runExport } from "../export.ts";
import { launchShotBrowser } from "../shot.ts";
import { queryAnswer, templateAnswer, viewLinkFor, type Answer, type PaneReads } from "./answers.ts";
import type { LoadedRows } from "./rows.ts";
import { GraphDb, checkReadQuery, CypherRefused } from "./db.ts";
import { ASSET_FILE_LIMIT, GraphDbExportRefusal, browserModule, checkAssetSize, findWasmCore, staticGraphHtml, type GraphBundle } from "./export-graphdb.ts";
import { ASK_DEMO_CSP } from "../../scripts/ask-demo/bundle.ts";
// @ts-expect-error the graph pane is plain browser ESM
import { STATIC_SEARCH_LINE } from "../../web/graph-query.js";
import { realLadybug } from "./fake-lbug.ts";
import { GRAPHDB_FILE, catalogFromFile, isGraphDbFile, rowsFromFile, type GraphDbFile } from "./graphdb-file.ts";
import type { LbugModule } from "./peer.ts";
import { LOCAL_INDEX_DIR } from "./sources.ts";
import { applies, engineRefusals } from "./template-rules.ts";
import { PROJECT_TEMPLATES_FILE } from "./chant-templates.ts";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..");
const FIXTURES = join(HERE, "__fixtures__");
const ORIGIN = "http://bundle.test";
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".css": "text/css" };

const chantIr: GraphIR = {
  version: 1,
  nodes: [
    { id: "aws_s3_bucket.logs", kind: "aws_s3_bucket", lexicon: "terraform", attrs: { name: "logs", password: "hunter2" }, physicalId: "web-logs" },
    { id: "aws_instance.web", kind: "aws_instance", lexicon: "terraform", attrs: { name: "web", logs: "arn:aws:s3:::web-logs" } },
  ],
  edges: [{ from: "aws_instance.web", to: "aws_s3_bucket.logs", kind: "ref", viaAttr: "logs" }],
  groups: {},
};

/** The project's own templates: one Cypher template that runs, one the engine cannot bind. */
const OWN_TEMPLATES = {
  version: 1,
  templates: [
    {
      id: "bucket-users",
      title: "Who uses this bucket",
      question: "Which resources reference this bucket?",
      kinds: ["aws_s3_bucket"],
      inputs: [{ name: "node", kind: "resource", description: "the bucket" }],
      reads: "session",
      query: { kind: "cypher", text: "MATCH (u:Resource)-[:REF]->(b:Resource {key: $key}) RETURN u.key AS key ORDER BY key" },
    },
    {
      id: "misspelt",
      title: "Bucket owner",
      question: "Who owns it?",
      inputs: [{ name: "node", kind: "resource", description: "the bucket" }],
      reads: "session",
      query: { kind: "cypher", text: "MATCH (b:Resource {key: $key}) RETURN b.ownr AS owner" },
    },
  ],
};

const made: string[] = [];
const servers: Server[] = [];

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-graphdb-src-"));
  made.push(dir);
  copyFileSync(join(FIXTURES, "choudoufu.engine-graph.json"), join(dir, "engine-graph.json"));
  mkdirSync(join(dir, ".behold", "graph"), { recursive: true });
  copyFileSync(join(FIXTURES, "plunge.engine-graph.json"), join(dir, ".behold", "graph", "plunge.json"));
  const idx = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8")) as { stamp: { scopeKey: string } };
  const scopeDir = join(dir, LOCAL_INDEX_DIR, ...idx.stamp.scopeKey.split("/"));
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(join(scopeDir, "20261026T120000Z-e2f92b265a4d.json"), JSON.stringify(idx));
  mkdirSync(join(dir, ".chant"), { recursive: true });
  writeFileSync(join(dir, PROJECT_TEMPLATES_FILE), JSON.stringify(OWN_TEMPLATES, null, 2));
  return dir;
}

async function exportOnce(dir: string, graphdb: boolean): Promise<string> {
  const out = join(mkdtempSync(join(tmpdir(), "behold-graphdb-out-")), "bundle");
  made.push(join(out, ".."));
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runExport(
      { projectDir: dir, port: 0, graph: { env: { BEHOLD_INDEX_DIR: join(dir, "no-user-index") }, git: () => { throw new Error("not a git repository"); } } },
      out,
      graphdb ? { graphdb: true } : {},
    );
  } finally {
    write.mockRestore();
  }
  return out;
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

function serveDir(dir: string, seen: string[] = [], csp?: string): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      seen.push(path);
      const file = normalize(join(dir, path === "/" ? "index.html" : path));
      let body: Buffer;
      try {
        if (!file.startsWith(dir) || !statSync(file).isFile()) throw new Error("no");
        body = readFileSync(file);
      } catch {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...(csp ? { "content-security-policy": csp } : {}) });
      res.end(body);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/`));
  });
}

let src = "";
let plainOut = "";
let graphOut = "";

beforeAll(async () => {
  vi.mocked(graphIr).mockImplementation((async () => chantIr) as never);
  src = project();
  plainOut = await exportOnce(src, false);
  graphOut = await exportOnce(src, true);
}, 240_000);

afterAll(() => {
  for (const s of servers) s.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("the pieces", () => {
  it("pins wasm-core at the version the @ladybugdb/core dev dependency is", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.dependencies["@ladybugdb/wasm-core"]).toBe(pkg.devDependencies["@ladybugdb/core"]);
    expect(findWasmCore().version).toBe(pkg.devDependencies["@ladybugdb/core"]);
  });

  it("refuses a file past Cloudflare's 25 MiB, naming its size and the engine's version", () => {
    expect(() => checkAssetSize("lbug_wasm_worker.js", ASSET_FILE_LIMIT, "0.22.3")).not.toThrow();
    expect(() => checkAssetSize("lbug_wasm_worker.js", ASSET_FILE_LIMIT + 1, "0.22.3")).toThrow(GraphDbExportRefusal);
    expect(() => checkAssetSize("lbug_wasm_worker.js", 30 * 1024 * 1024, "0.22.3")).toThrow(/lbug_wasm_worker\.js is 30\.0 MiB \(31457280 bytes\) at @ladybugdb\/wasm-core 0\.22\.3, over the 25\.0 MiB/);
    expect(findWasmCore().workerBytes).toBeLessThanOrEqual(ASSET_FILE_LIMIT);
  });

  it("bundles the browser module from source in a checkout, and reads dist/graph-db-wasm.js in the package", async () => {
    const fromSource = await browserModule(ROOT);
    expect(fromSource).toContain("openGraphDb");
    expect(fromSource).not.toMatch(/from\s*["']node:/);
    const pkg = mkdtempSync(join(tmpdir(), "behold-graphdb-pkg-"));
    made.push(pkg);
    await expect(browserModule(pkg)).rejects.toThrow(/dist\/graph-db-wasm\.js/);
    mkdirSync(join(pkg, "dist"));
    writeFileSync(join(pkg, "dist", "graph-db-wasm.js"), "export const built = 1;\n");
    await expect(browserModule(pkg)).resolves.toBe("export const built = 1;\n");
  });

  it("swaps graph.html's inline script for graph-static.js after the bundle's JSON block, and leaves out the diff without index versions", () => {
    const html = readFileSync(join(ROOT, "web", "graph.html"), "utf8");
    const bundle: GraphBundle = { estate: null, back: { href: "./", label: "Back to the demo" }, searches: [], indexVersions: true, cypher: { query: "MATCH (r) WHERE r.key = '</script>' RETURN r", params: {} } };
    const swapped = staticGraphHtml(html, bundle);
    expect(swapped).toContain('<script type="module" src="./graph-static.js"></script>');
    expect(swapped).not.toContain("initGraphPane()");
    const block = swapped.match(/<script type="application\/json" id="g-bundle">([\s\S]*?)<\/script>/)!;
    // Data, not run; and no value can close the block early.
    expect(JSON.parse(block[1]!)).toEqual(bundle);
    expect(block[1]).not.toContain("</");
    const scripts = /<script type="module">[\s\S]*?<\/script>/;
    expect(swapped.replace(/<script type="application\/json"[\s\S]*?<script type="module" src="\.\/graph-static\.js"><\/script>/, "")).toBe(html.replace(scripts, ""));
    const cut = staticGraphHtml(html, { ...bundle, indexVersions: false });
    expect(cut).not.toContain('id="d-section"');
    expect(cut).not.toContain('id="d-form"');
    expect(cut).toContain('id="g-sources"');
    expect(() => staticGraphHtml("<p>no script</p>", bundle)).toThrow(/no inline module script/);
  });
});

describe("an export without --graphdb", () => {
  it("is the bundle it was: no file of the flag's, graph.html as web/graph.html, and the same bytes as the flag's bundle everywhere else", () => {
    const plain = filesUnder(plainOut);
    const withDb = filesUnder(graphOut);
    for (const f of GRAPHDB_FILES) expect(plain).not.toContain(f);
    expect(withDb.filter((f) => !plain.includes(f)).sort()).toEqual([...GRAPHDB_FILES].sort());
    expect(plain.filter((f) => !withDb.includes(f))).toEqual([]);
    expect(readFileSync(join(plainOut, "graph.html"), "utf8")).toBe(readFileSync(join(ROOT, "web", "graph.html"), "utf8"));
    for (const f of plain) {
      if (f === "manifest.json" || f === "graph.html") continue;
      expect(readFileSync(join(plainOut, f)).equals(readFileSync(join(graphOut, f))), f).toBe(true);
    }
    const manifest = (dir: string) => {
      const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown> & { files: string[] };
      delete m.capturedAt;
      return m;
    };
    const a = manifest(plainOut);
    const b = manifest(graphOut);
    expect(a.graphdb).toBeUndefined();
    expect(b.graphdb).toBe(GRAPHDB_FILE);
    expect(b.files.filter((f) => !a.files.includes(f)).sort()).toEqual([...GRAPHDB_FILES].sort());
    delete b.graphdb;
    expect({ ...b, files: b.files.filter((f) => a.files.includes(f)) }).toEqual(a);
    // The assets-only Worker config is the same file in both, and serves the new files with the rest.
    expect(JSON.parse(readFileSync(join(graphOut, "wrangler.jsonc"), "utf8")).assets).toEqual({ directory: "." });
  });
});

describe("graphdb.json", () => {
  it("holds the session's rows, masked, with the layout's DDL and both catalogs", () => {
    const f = JSON.parse(readFileSync(join(graphOut, GRAPHDB_FILE), "utf8")) as GraphDbFile;
    expect(isGraphDbFile(f)).toBe(true);
    expect(f.ladybug).toMatchObject({ package: "@ladybugdb/wasm-core", version: findWasmCore().version });
    expect(f.layout.ddl.length).toBeGreaterThan(0);
    expect(new Set(f.rows.resources.map((r) => r.source))).toEqual(new Set(["chant", "engine", "index"]));
    const bucket = f.rows.resources.find((r) => r.key === "aws_s3_bucket.logs")!;
    expect(JSON.parse(bucket.attrs).password).toBe("<masked>");
    expect(readFileSync(join(graphOut, GRAPHDB_FILE), "utf8")).not.toContain("hunter2");
    expect(readFileSync(join(graphOut, GRAPHDB_FILE), "utf8")).not.toContain(src);
    const origins = new Set(f.catalog.templates.map((t) => t.origin));
    expect(origins).toEqual(new Set(["chant", "project"]));
    expect(f.catalog.fields).toMatchObject({ "bucket-users": expect.stringMatching(/query\.text$/) });
  });
});

const peer = await realLadybug();

async function browserOrNull() {
  try {
    return await launchShotBrowser();
  } catch {
    return null;
  }
}

/** The server's answers over graphdb.json's rows: the same route code, on @ladybugdb/core. */
async function serverReads(f: GraphDbFile, db: GraphDb): Promise<PaneReads> {
  const catalog = await engineRefusals(catalogFromFile(f.catalog), (q) => db.refusal(q), f.catalog.projectFile);
  const rows = rowsFromFile(f);
  return {
    origin: ORIGIN,
    rows: async () => rows,
    catalog: async () => catalog,
    peer: async () => ({ available: true }),
    run: (cypher, params) => db.query(cypher, params),
  };
}

describe.runIf(peer.ok)("the exported page's WebAssembly build", () => {
  it("answers every Cypher template on every node it applies to as the server does, and refuses a write in the server's words", { timeout: 240_000 }, async () => {
    const launched = await browserOrNull();
    if (!launched) {
      console.warn("export-graphdb: no browser launches here, so the WebAssembly half did not run");
      return;
    }
    const f = JSON.parse(readFileSync(join(graphOut, GRAPHDB_FILE), "utf8")) as GraphDbFile;
    const db = await GraphDb.build((peer as { lbug: LbugModule }).lbug, rowsFromFile(f), mkdtempSync(join(tmpdir(), "behold-graphdb-db-")));
    const server = await serverReads(f, db);
    const cypherTemplates = (await server.catalog()).templates.filter((t) => t.language === "cypher");
    expect(cypherTemplates.filter((t) => t.origin === "chant").length).toBeGreaterThan(0);
    const cases = cypherTemplates.flatMap((t) => f.rows.resources.filter((r) => applies(t, r)).map((r) => ({ name: t.name, key: r.key })));

    const requests: string[] = [];
    const url = await serveDir(graphOut, requests);
    const page = await (launched.browser as unknown as { newPage(): Promise<any> }).newPage();
    try {
      await page.goto(`${url}graph.html`, { waitUntil: "domcontentloaded" });
      // A string, not a function: vitest rewrites import() inside a function's source, and the page has no vite.
      const got = (await page.evaluate(`(async ({ cases, origin }) => {
          const m = await import("./graph-db-wasm.js");
          const db = m.openGraphDb("./graphdb.json", { origin });
          await db.ready;
          const answers = [];
          for (const c of cases) answers.push(await db.template(c.name, c.key));
          const write = await db.query("MATCH (r:Resource) SET r.kind = 'x' RETURN r.key");
          const create = await db.query("CREATE (:Resource {key: 'x'})");
          const templates = await db.templates();
          const status = await db.status();
          await db.close();
          return { answers, write, create, templates, status };
        })(${JSON.stringify({ cases, origin: ORIGIN })})`      )) as { answers: Array<{ status: number; body: unknown }>; write: { status: number; body: Record<string, unknown> }; create: { status: number; body: Record<string, unknown> }; templates: { body: { templates: Array<{ name: string }>; refused: Array<{ id?: string; by: string; message: string }>; engineChecked: boolean } }; status: { body: { peer: { available: boolean; version?: string } } } };

      expect(got.answers).toHaveLength(cases.length);
      let rowsSeen = 0;
      const rows = rowsFromFile(f);
      for (const [i, c] of cases.entries()) {
        const want = await templateAnswer(server, c.name, c.key, {});
        expect(canon(got.answers[i] as Answer, rows), `${c.name} on ${c.key}`).toEqual(canon(want, rows));
        rowsSeen += ((want.body.rows as unknown[]) ?? []).length;
      }
      expect(rowsSeen).toBeGreaterThan(0);

      const refusal = (() => {
        try {
          checkReadQuery("MATCH (r:Resource) SET r.kind = 'x' RETURN r.key");
        } catch (e) {
          return (e as CypherRefused).message;
        }
      })();
      expect(got.write.status).toBe(400);
      expect(got.write.body).toMatchObject({ code: "cypher-write", error: refusal });
      expect(got.write).toEqual(await queryAnswer(server, "MATCH (r:Resource) SET r.kind = 'x' RETURN r.key", null));
      expect(got.create).toEqual(await queryAnswer(server, "CREATE (:Resource {key: 'x'})", null));

      // The project's template the engine cannot bind is refused by the browser's engine too.
      expect(got.templates.body.engineChecked).toBe(true);
      expect(got.templates.body.templates.map((t) => t.name)).toContain("bucket-users");
      expect(got.templates.body.refused).toContainEqual(expect.objectContaining({ id: "misspelt", by: "engine" }));
      expect(got.status.body.peer).toMatchObject({ available: true, version: expect.stringContaining(findWasmCore().version) });

      // Every request is for a file the bundle has (the browser's own favicon.ico aside).
      expect(requests.filter((r) => r !== "/favicon.ico" && !existsIn(graphOut, r))).toEqual([]);
    } finally {
      await page.close();
      await db.close();
      await launched.browser.close();
    }
  });

  it("draws the /graph page before the database is ready, says the Cypher box is loading, then answers from it", { timeout: 240_000 }, async () => {
    const launched = await browserOrNull();
    if (!launched) {
      console.warn("export-graphdb: no browser launches here, so the page test did not run");
      return;
    }
    const url = await serveDir(graphOut);
    const page = await (launched.browser as unknown as { newPage(): Promise<any> }).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.goto(`${url}graph.html`, { waitUntil: "domcontentloaded" });
      const early = await page.evaluate(() => ({ line: document.getElementById("g-loading")?.textContent ?? "", button: document.querySelector("#g-cypher-form button")?.textContent ?? "" }));
      expect(early.line).toMatch(/Loading the graph database/);
      expect(early.button).toBe("Loading...");
      await page.waitForFunction(() => document.querySelector("#g-cypher-form button")?.textContent === "Ask", null, { timeout: 120_000 });
      expect(await page.evaluate(() => document.getElementById("g-peer")?.textContent)).toMatch(/LadybugDB .*WebAssembly/);
      await page.evaluate(() => {
        (document.getElementById("g-cypher") as HTMLTextAreaElement).value = "MATCH (r:Resource) RETURN r.key ORDER BY r.key LIMIT 3";
        (document.getElementById("g-cypher-form") as HTMLFormElement).requestSubmit();
      });
      await page.waitForFunction(() => document.querySelectorAll("#g-rows tbody tr").length === 3, null, { timeout: 30_000 });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await launched.browser.close();
    }
  });
});

describe.runIf(peer.ok)("the exported /graph page (behold#1180)", () => {
  it("offers what runs in the bundle: search templates disabled with a line saying why, estate links relative, no diff section, under a strict policy", { timeout: 240_000 }, async () => {
    const launched = await browserOrNull();
    if (!launched) {
      console.warn("export-graphdb: no browser launches here, so the bundle's /graph test did not run");
      return;
    }
    const url = await serveDir(graphOut, [], ASK_DEMO_CSP);
    const page = await (launched.browser as unknown as { newPage(): Promise<any> }).newPage();
    const errors: string[] = [];
    const consoleCsp: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    page.on("console", (m: { text(): string }) => {
      if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text());
    });
    await page.addInitScript(() => {
      (globalThis as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => (globalThis as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    try {
      await page.goto(`${url}graph.html`, { waitUntil: "domcontentloaded" });
      const head = await page.evaluate(() => ({
        back: document.getElementById("g-back")?.getAttribute("href"),
        label: document.getElementById("g-back")?.textContent,
        diff: Boolean(document.getElementById("d-section") || document.getElementById("d-form")),
      }));
      expect(head).toEqual({ back: "./", label: "Back to the estate", diff: false });
      await page.waitForFunction(() => document.querySelector("#g-cypher-form button")?.textContent === "Ask", null, { timeout: 120_000 });

      await page.fill("#g-ref", "aws_instance.web");
      await page.click("#g-resolve-form button");
      await page.waitForFunction(() => document.querySelectorAll("#g-templates button").length > 0, null, { timeout: 30_000 });
      const menu = (await page.evaluate(() => ({
        buttons: [...document.querySelectorAll("#g-templates button")].map((b) => ({ text: b.textContent, disabled: (b as HTMLButtonElement).disabled, title: (b as HTMLButtonElement).title })),
        lines: [...document.querySelectorAll("#g-templates p")].map((p) => p.textContent),
      }))) as { buttons: Array<{ text: string; disabled: boolean; title: string }>; lines: string[] };
      const searches = menu.buttons.filter((b) => !b.text.includes("(Cypher)"));
      expect(searches.length).toBeGreaterThan(0);
      for (const b of searches) {
        expect(b.disabled, b.text).toBe(true);
        expect(b.title, b.text).toMatch(/^Runs on behold serve; the Cypher templates run in this page\./);
      }
      expect(menu.buttons.some((b) => b.text.includes("(Cypher)") && !b.disabled)).toBe(true);
      expect(menu.lines).toEqual([STATIC_SEARCH_LINE]);

      await page.fill("#g-cypher", "MATCH (r:Resource {source: 'chant'}) RETURN r.key AS key ORDER BY key");
      await page.click("#g-cypher-form button");
      await page.waitForFunction(() => document.querySelectorAll("#g-rows tbody tr").length > 0, null, { timeout: 30_000 });
      const link = await page.evaluate(() => ({ hidden: (document.getElementById("g-link") as HTMLAnchorElement).hidden, href: document.getElementById("g-link")?.getAttribute("href") ?? "" }));
      expect(link.hidden).toBe(false);
      expect(link.href).toMatch(/^\.\/\?/);
      expect(new URL(link.href, `${url}graph.html`).pathname).toBe("/");

      expect(await page.evaluate(() => (globalThis as unknown as { __csp: string[] }).__csp)).toEqual([]);
      expect(consoleCsp).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await launched.browser.close();
    }
  });
});

/**
 * An answer with its row order settled where the query leaves it open. Without ORDER BY, Cypher
 * gives no order, and the native engine (threaded) and the WebAssembly one (one thread) return
 * the same rows in different orders; the keys, and the view link made from the first of them,
 * follow. A query with ORDER BY is compared as it came.
 */
function canon(a: Answer, rows: LoadedRows): Answer {
  const b = a.body as { rows?: unknown[]; keys?: string[]; expanded?: { query: string } };
  if (!b.rows || /\bORDER\s+BY\b/i.test(b.expanded?.query ?? "")) return a;
  const keys = [...(b.keys ?? [])].sort();
  return { status: a.status, body: { ...a.body, rows: [...b.rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), keys, link: viewLinkFor(ORIGIN, rows, keys) } };
}

function existsIn(dir: string, path: string): boolean {
  try {
    return statSync(join(dir, path)).isFile();
  } catch {
    return false;
  }
}
