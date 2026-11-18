/// <reference lib="dom" />
// behold#1163: the ask demo page, built by scripts/ask-demo/bundle.ts and played end to end
// in a real headless Chrome (the shot launcher's, as src/graph-db/export-graphdb.test.ts does).
//
// The estate is the graph pane's own test fixture (a chant project, a choudoufu and a plunge
// document, an index version), read by behold here: GET /api/graph gives the estate graph and
// `behold export --graphdb` the rows, as the recorder keeps them. The committed fixture
// narration (ask-demo/fixtures/page/narration.json) holds behold's answers over that estate;
// the test checks them against the server first, so the page plays answers that are real.
//
// The page plays every loop, with motion and under reduced motion, and for each turn the test
// reads the prompt pane's words, the Cypher box, the estate graph's lit cards and the answer
// drawing's lit nodes. After a loop it runs a visitor's query through LadybugDB's WebAssembly
// build. Every request the page makes must be for a file in the bundle. Skipped, saying so,
// where no browser launches.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import type { GraphIR } from "@intentius/chant";

vi.mock("./chant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chant.ts")>()),
  graphIr: vi.fn(),
}));
import { graphIr } from "./chant.ts";
import { runExport } from "./export.ts";
import { createApp } from "./server.ts";
import { launchShotBrowser } from "./shot.ts";
import { GRAPHDB_FILE } from "./graph-db/graphdb-file.ts";
import { LOCAL_INDEX_DIR } from "./graph-db/sources.ts";
import { realLadybug } from "./graph-db/fake-lbug.ts";
import { BundleRefusal, buildAskDemoBundle, estateFile, unlitCards } from "../scripts/ask-demo/bundle.ts";
import { validateNarration, type Narration } from "../scripts/ask-demo/narration.ts";
import { narrationSchema } from "../scripts/ask-demo/record.ts";
import { cardIndex, lightKeys } from "../web/key-light.js";
// @ts-expect-error the page's module is plain browser ESM
import { drawLight, loopOf, recordedAnswer } from "../ask-demo/page/play.js";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "src", "graph-db", "__fixtures__");
const NARRATION = join(ROOT, "ask-demo", "fixtures", "page", "narration.json");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".css": "text/css" };

const chantIr: GraphIR = {
  version: 1,
  nodes: [
    { id: "aws_s3_bucket.logs", kind: "aws_s3_bucket", lexicon: "terraform", attrs: { name: "logs" }, physicalId: "web-logs" },
    { id: "aws_instance.web", kind: "aws_instance", lexicon: "terraform", attrs: { name: "web", logs: "arn:aws:s3:::web-logs" } },
  ],
  edges: [{ from: "aws_instance.web", to: "aws_s3_bucket.logs", kind: "ref", viaAttr: "logs" }],
  groups: {},
};

const made: string[] = [];
const servers: Server[] = [];
const narration = JSON.parse(readFileSync(NARRATION, "utf8")) as Narration;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-ask-demo-src-"));
  made.push(dir);
  copyFileSync(join(FIXTURES, "choudoufu.engine-graph.json"), join(dir, "engine-graph.json"));
  mkdirSync(join(dir, ".behold", "graph"), { recursive: true });
  copyFileSync(join(FIXTURES, "plunge.engine-graph.json"), join(dir, ".behold", "graph", "plunge.json"));
  const idx = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8")) as { stamp: { scopeKey: string } };
  const scopeDir = join(dir, LOCAL_INDEX_DIR, ...idx.stamp.scopeKey.split("/"));
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(join(scopeDir, "20261026T120000Z-e2f92b265a4d.json"), JSON.stringify(idx));
  return dir;
}

const cfgOf = (dir: string) => ({ projectDir: dir, port: 0, graph: { env: { BEHOLD_INDEX_DIR: join(dir, "no-user-index") }, git: () => { throw new Error("not a git repository"); } } });

function serveDir(dir: string): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      const file = normalize(join(dir, path === "/" ? "index.html" : path));
      let body: Buffer;
      try {
        if (!file.startsWith(dir) || !statSync(file).isFile()) throw new Error("no");
        body = readFileSync(file);
      } catch {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/`));
  });
}

let app: ReturnType<typeof createApp>;
let estateDir = "";
let out = "";
let files: Array<{ path: string; bytes: number }> = [];

beforeAll(async () => {
  vi.mocked(graphIr).mockImplementation((async () => chantIr) as never);
  const src = project();
  app = createApp(cfgOf(src) as never);
  // The estate as the recorder keeps it: the estate graph as served, and the rows as exported.
  estateDir = mkdtempSync(join(tmpdir(), "behold-ask-demo-estate-"));
  made.push(estateDir);
  writeFileSync(join(estateDir, "graph.json"), await (await app.request("/api/graph")).text());
  const exported = join(mkdtempSync(join(tmpdir(), "behold-ask-demo-export-")), "bundle");
  made.push(join(exported, ".."));
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runExport(cfgOf(src) as never, exported, { graphdb: true });
  } finally {
    write.mockRestore();
  }
  copyFileSync(join(exported, GRAPHDB_FILE), join(estateDir, GRAPHDB_FILE));
  out = join(mkdtempSync(join(tmpdir(), "behold-ask-demo-out-")), "site");
  made.push(join(out, ".."));
  files = (await buildAskDemoBundle({ narration: NARRATION, estate: estateDir, out })).files;
}, 240_000);

afterAll(() => {
  for (const s of servers) s.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("the fixture narration", () => {
  it("meets the schema, and each answer is behold's over the fixture estate", async () => {
    expect(validateNarration(narration, narrationSchema())).toEqual([]);
    const graph = JSON.parse(readFileSync(join(estateDir, "graph.json"), "utf8")) as { ir: { nodes: Array<{ id: string }> } };
    const cards = cardIndex(graph.ir.nodes);
    for (const t of narration.turns.slice(1)) {
      const q = new URLSearchParams({ cypher: t.cypher! });
      if (Object.keys(t.params).length) q.set("params", JSON.stringify(t.params));
      const a = (await (await app.request(`/api/graphdb/query?${q}`)).json()) as { columns: string[]; rows: unknown[]; keys: string[]; draw: unknown };
      expect({ columns: a.columns, rows: a.rows, keys: a.keys }, t.id).toEqual({ columns: t.columns, rows: t.rows, keys: t.keys });
      if (t.draw) expect(a.draw, t.id).toEqual(t.draw);
      expect(lightKeys(t, cards), t.id).toEqual(t.light);
    }
    expect(narration.turns[0].light.sort()).toEqual([...new Set(cards.values())].sort());
    // A card answer and an index-only one, so the page lights both ways.
    expect(narration.turns.filter((t) => t.kind === "question" && t.light.length).length).toBeGreaterThan(0);
    expect(narration.turns.filter((t) => t.kind === "question" && !t.light.length).length).toBeGreaterThan(0);
  });
});

describe("the bundle", () => {
  it("carries the page, the recording, the estate, the rows and the engine, every file under 25 MiB", () => {
    const paths = files.map((f) => f.path);
    for (const f of ["index.html", "ask-demo.js", "narration.json", "estate.json", "graphdb.json", "graph-db-wasm.js", "lbug-wasm.js", "lbug_wasm_worker.js", "graph.html", "graph-static.js", "graph-query.js", "index-diff.js", "LICENSE", "wrangler.jsonc", ".assetsignore"]) {
      expect(paths, f).toContain(f);
    }
    for (const f of files) expect(f.bytes, f.path).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(JSON.parse(readFileSync(join(out, "wrangler.jsonc"), "utf8"))).toMatchObject({ name: "behold-ask-demo", assets: { directory: "." } });
    // The page loads the engine on its own: the page's script does not hold it.
    const js = readFileSync(join(out, "ask-demo.js"), "utf8");
    expect(js).toContain("./graph-db-wasm.js");
    expect(js).not.toContain("setWorkerPath");
    // Nothing reaches outside the bundle: no URL with a host in the page or its script.
    for (const f of ["index.html", "ask-demo.js"]) expect(readFileSync(join(out, f), "utf8"), f).not.toMatch(/(?:src|href)=["']?(?:https?:)?\/\//);
  });

  it("is refused when the estate is missing, or is not the one the narration lights", async () => {
    const empty = mkdtempSync(join(tmpdir(), "behold-ask-demo-none-"));
    made.push(empty);
    await expect(buildAskDemoBundle({ narration: NARRATION, estate: empty, out: join(empty, "o") })).rejects.toThrow(/record again with `just ask-demo-record`/);
    const estate = estateFile(JSON.parse(readFileSync(join(estateDir, "graph.json"), "utf8")));
    expect(unlitCards(narration, estate.nodes)).toEqual([]);
    expect(unlitCards({ turns: [{ ...narration.turns[1]!, light: ["dns/zone"] }] }, estate.nodes)).toEqual(["logs-bucket-users: dns/zone"]);
    const other = mkdtempSync(join(tmpdir(), "behold-ask-demo-other-"));
    made.push(other);
    copyFileSync(join(estateDir, GRAPHDB_FILE), join(other, GRAPHDB_FILE));
    writeFileSync(join(other, "graph.json"), JSON.stringify({ ir: { nodes: [{ id: "dns/zone" }] }, svg: "<svg/>" }));
    await expect(buildAskDemoBundle({ narration: NARRATION, estate: other, out: join(other, "o") })).rejects.toThrow(BundleRefusal);
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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;

interface Seen {
  loop: string;
  turn: string;
  phase: string;
  lit: string[];
  answerLit: string[];
  cypher: string;
  params: string;
  readOnly: boolean;
  terminal: string;
  rows: string;
  sources: string;
}

const seenScript = `(() => {
  const d = document.documentElement.dataset;
  const split = (s) => (s ? s.split("\\n") : []);
  return {
    loop: d.loop || "", turn: d.turn || "", phase: d.phase || "",
    lit: split(d.lit), answerLit: split(d.answerLit),
    domLit: [...document.querySelectorAll('#ad-estate [data-node-id][data-kl="lit"]')].map((g) => g.getAttribute("data-node-id")),
    domAnswerLit: [...document.querySelectorAll("#g-draw .g-node.lit")].map((g) => g.getAttribute("data-key")),
    cypher: document.getElementById("g-cypher").value, params: document.getElementById("g-params").value,
    readOnly: document.getElementById("g-cypher").readOnly,
    terminal: document.getElementById("k-ask").innerText,
    rows: document.getElementById("g-rows").innerText,
    sources: document.getElementById("g-sources").textContent,
  };
})()`;

async function waitFor(page: Page, what: string, test: (s: Seen & { domLit: string[]; domAnswerLit: string[] }) => boolean, ms = 60_000): Promise<Seen & { domLit: string[]; domAnswerLit: string[] }> {
  const until = Date.now() + ms;
  let last: (Seen & { domLit: string[]; domAnswerLit: string[] }) | undefined;
  while (Date.now() < until) {
    last = await page.evaluate(seenScript);
    if (test(last!)) return last!;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`waited ${ms} ms for ${what}; the page showed ${JSON.stringify(last).slice(0, 1500)}`);
}

/** Play every loop once, checking each turn as its reply starts and the terminal once the loop is over. */
async function playAll(page: Page, reduced: boolean) {
  const qs = narration.turns.filter((t) => t.kind === "question");
  for (let i = 0; i < qs.length; i++) {
    const loop = loopOf(narration, i);
    const load = loop.load;
    const q = loop.question;
    const atLoad = await waitFor(page, `loop ${i}'s load turn`, (s) => s.loop === String(i) && (s.turn === "load" || s.turn === q.id));
    if (atLoad.turn === "load") {
      expect(atLoad.lit.sort()).toEqual([...load.light].sort());
      expect(atLoad.cypher).toBe("");
      expect(atLoad.readOnly).toBe(true);
    }
    const atQ = await waitFor(page, `loop ${i}'s question ${q.id}`, (s) => s.loop === String(i) && s.turn === q.id);
    // The Cypher box fills with the turn's query as its reply starts, and the answer draws at once.
    expect(atQ.cypher).toBe(q.cypher);
    expect(atQ.params).toBe(Object.keys(q.params).length ? JSON.stringify(q.params) : "");
    // Read-only while the reply prints; under reduced motion it prints at once, and the box is the visitor's.
    if (!reduced) expect([atQ.phase, atQ.readOnly]).toEqual(["playing", true]);
    expect(atQ.lit).toEqual(q.light);
    expect(atQ.domLit.sort()).toEqual([...q.light].sort());
    const drawn = drawLight(recordedAnswer(q).body);
    expect(atQ.answerLit).toEqual(drawn);
    expect(atQ.domAnswerLit.sort()).toEqual([...drawn].sort());
    for (const s of q.sources) expect(atQ.sources).toContain(s.readAt);
    for (const r of q.rows) for (const v of Object.values(r)) expect(atQ.rows).toContain(String(v));
    const after = await waitFor(page, `loop ${i} to finish`, (s) => s.loop === String(i) && s.phase === "after");
    for (const text of [load.prompt, load.reply, q.prompt, q.reply]) expect(after.terminal.replace(/\s+/g, " "), text).toContain(text.replace(/\s+/g, " "));
    expect(after.terminal).toContain(load.busy.replace(/(\.{1,3}|…)\s*$/, "").trim());
    expect(after.readOnly).toBe(false);
    if (i + 1 < qs.length) await page.click("#ad-next");
  }
}

describe.runIf(peer.ok)("the page, in a headless browser", () => {
  it("plays every loop with motion and under reduced motion, lights by key, fills the Cypher box, answers a visitor's query in WebAssembly, and asks only the bundle", { timeout: 240_000 }, async () => {
    const launched = await browserOrNull();
    if (!launched) {
      console.warn("ask-demo-page: no browser launches here, so the page did not play");
      return;
    }
    const url = await serveDir(out);
    const origin = new URL(url).origin;
    const browser = launched.browser as unknown as { newContext(o?: object): Promise<any>; close(): Promise<void> };
    const requests: string[] = [];
    const errors: string[] = [];
    try {
      for (const reducedMotion of ["no-preference", "reduce"] as const) {
        const context = await browser.newContext({ reducedMotion, viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.on("request", (r: { url(): string }) => requests.push(r.url()));
        page.on("pageerror", (e: Error) => errors.push(e.message));
        try {
          await page.goto(`${url}?pace=8`, { waitUntil: "domcontentloaded" });
          await playAll(page, reducedMotion === "reduce");
          if (reducedMotion === "reduce") continue;
          // After a loop the box is the visitor's: their query runs on the recorded rows in LadybugDB's WebAssembly build.
          const q = narration.turns[1]!;
          await page.fill("#g-cypher", q.cypher!);
          await page.fill("#g-params", JSON.stringify(q.params));
          await page.waitForFunction(() => document.documentElement.dataset.engine === "ready", null, { timeout: 120_000 });
          await page.click("#g-ask");
          await page.waitForFunction(() => document.documentElement.dataset.visitor === "1", null, { timeout: 60_000 });
          const s = await waitFor(page, "the visitor's answer", (x) => x.answerLit.length > 0);
          expect(s.lit.sort()).toEqual([...q.light].sort());
          expect(s.answerLit.sort()).toEqual([...q.keys].sort());
          for (const r of q.rows) for (const v of Object.values(r)) expect(s.rows).toContain(String(v));
          // The visitor holds the loop: it does not move on while they read.
          expect(s.phase).toBe("after");
          expect(await page.evaluate(() => document.documentElement.dataset.held)).toBe("1");
        } finally {
          await context.close();
        }
      }
      expect(errors).toEqual([]);
      const outside = requests.filter((r) => !r.startsWith(origin) && !r.startsWith("data:") && !r.startsWith("blob:"));
      expect(outside).toEqual([]);
      const missing = requests
        .filter((r) => r.startsWith(origin))
        .map((r) => decodeURIComponent(new URL(r).pathname))
        .filter((p) => p !== "/" && p !== "/favicon.ico" && !files.some((f) => `/${f.path}` === p));
      expect(missing).toEqual([]);
      expect(requests.some((r) => r.endsWith("/lbug_wasm_worker.js"))).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
