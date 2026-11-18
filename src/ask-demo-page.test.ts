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
// build. Every request the page makes must be for a file in the bundle, and the page is served
// under the bundle's content security policy (behold#1164). Skipped, saying so, where no
// browser launches.
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
import { ASK_DEMO_CSP, BundleRefusal, WORKER_NAME, buildAskDemoBundle, estateFile, unlitCards } from "../scripts/ask-demo/bundle.ts";
import { checkFiles, cspDirectives, outsideRequests, sameCsp, serveBundle, verdictText } from "../scripts/ask-demo/check.ts";
import { validateNarration, type Narration } from "../scripts/ask-demo/narration.ts";
import { narrationSchema } from "../scripts/ask-demo/record.ts";
import { cardIndex, frameBox, lightKeys, viewShare } from "../web/key-light.js";
// @ts-expect-error the kiosk is plain browser ESM
import { WHAT_ASK_DEMO } from "../web/kiosk.js";
// @ts-expect-error the docs site's data module is plain ESM
import { ASK_DEMO } from "../docs/src/data/live.mjs";
// @ts-expect-error the page's module is plain browser ESM
import { drawLight, knownResources, loopOf, questionsOf, recordedAnswer } from "../ask-demo/page/play.js";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "src", "graph-db", "__fixtures__");
const NARRATION = join(ROOT, "ask-demo", "fixtures", "page", "narration.json");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".css": "text/css", ".png": "image/png" };

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
// behold#1175: the recording itself, over the estate it was recorded from, for the zoom.
const RECORDING = join(ROOT, "ask-demo", "narration.json");
const RECORDED_ESTATE = join(ROOT, "ask-demo", "estate");

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
      // behold#1164: under the policy the Worker serves the bundle with (its _headers).
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": ASK_DEMO_CSP });
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
let recordedOut = "";
/** behold#1190: the resources the fixture estate loaded, as the page knows them for drawing an answer. */
let known = new Map();

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
  known = knownResources(JSON.parse(readFileSync(join(estateDir, GRAPHDB_FILE), "utf8")));
  out = join(mkdtempSync(join(tmpdir(), "behold-ask-demo-out-")), "site");
  made.push(join(out, ".."));
  files = (await buildAskDemoBundle({ narration: NARRATION, estate: estateDir, out })).files;
  recordedOut = join(mkdtempSync(join(tmpdir(), "behold-ask-demo-rec-")), "site");
  made.push(join(recordedOut, ".."));
  await buildAskDemoBundle({ narration: RECORDING, estate: RECORDED_ESTATE, out: recordedOut });
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
    for (const f of ["index.html", "ask-demo.js", "narration.json", "estate.json", "graphdb.json", "graph-db-wasm.js", "lbug-wasm.js", "lbug_wasm_worker.js", "graph.html", "graph-static.js", "graph-query.js", "engine-badge.js", "index-diff.js", "vendors/ladybugdb.png", "LICENSE", "wrangler.jsonc", ".assetsignore", "_headers"]) {
      expect(paths, f).toContain(f);
    }
    for (const f of files) expect(f.bytes, f.path).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(JSON.parse(readFileSync(join(out, "wrangler.jsonc"), "utf8"))).toMatchObject({ name: "behold-ask-demo", assets: { directory: "." } });
    // The page loads the engine on its own: the page's script does not hold it.
    const js = readFileSync(join(out, "ask-demo.js"), "utf8");
    expect(js).toContain("./graph-db-wasm.js");
    expect(js).not.toContain("setWorkerPath");
    // Nothing loads from outside the bundle: no URL with a host in the page or its script, but for
    // a link a visitor follows (behold#1182: LadybugDB's badge opens ladybugdb.com in a new tab).
    for (const f of ["index.html", "graph.html", "ask-demo.js"]) {
      const text = readFileSync(join(out, f), "utf8").replace(/<a\b[^>]*\bhref="https:\/\/ladybugdb\.com\/"[^>]*>/g, "<a>");
      expect(text, f).not.toMatch(/(?:src|href)=["']?(?:https?:)?\/\//);
    }
  });

  it("gives every path the content security policy in _headers, and the static server serves it so (#1164)", async () => {
    const headers = readFileSync(join(out, "_headers"), "utf8");
    expect(headers.split("\n")[0]).toBe("/*");
    expect(headers).toContain(`Content-Security-Policy: ${ASK_DEMO_CSP}`);
    const csp = cspDirectives(ASK_DEMO_CSP);
    expect(csp.get("default-src")).toBe("'self'");
    expect(csp.get("connect-src")).toBe("'self'");
    expect(csp.get("script-src")).not.toMatch(/'unsafe-inline'|https?:|\*/);
    expect(sameCsp("connect-src 'self';  default-src 'self'", "default-src 'self'; connect-src 'self'")).toBe(true);
    expect(sameCsp("default-src 'self'", "default-src 'self'; connect-src 'self'")).toBe(false);
    expect(sameCsp(null, ASK_DEMO_CSP)).toBe(false);

    const served = await serveBundle(out, "static");
    try {
      const verdicts = await checkFiles(served.base, out);
      expect(verdicts.filter((v) => !v.ok).map(verdictText)).toEqual([]);
      expect(verdicts.map(verdictText).join("\n")).toMatch(/GET narration\.json 200[\s\S]*GET lbug_wasm_worker\.js 200[\s\S]*GET wrangler\.jsonc 404/);
    } finally {
      served.stop();
    }
  });

  it("is linked at the Worker's address from the kiosk and the docs site (#1164)", () => {
    expect(ASK_DEMO).toBe(`https://${WORKER_NAME}.intentius.workers.dev/`);
    expect(WHAT_ASK_DEMO.url).toBe(ASK_DEMO);
    expect(`${WHAT_ASK_DEMO.text}${WHAT_ASK_DEMO.note}`).not.toMatch(/\blive\b/i);
  });

  it("names a request that leaves the bundle's origin (#1164)", () => {
    const o = "http://127.0.0.1:4600";
    expect(outsideRequests([`${o}/`, `${o}/lbug_wasm_worker.js`, "blob:http://127.0.0.1:4600/1-2", "data:image/png;base64,AA", "https://fonts.example/x.woff2", "http://127.0.0.1:4601/"], o)).toEqual([
      "https://fonts.example/x.woff2",
      "http://127.0.0.1:4601/",
    ]);
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
  estate: string;
  pane: string;
  held: string;
  foldHeight: number;
  estateHeight: number;
  svgHeight: number;
  control: { hidden: boolean; expanded: string | null; text: string; height: number; bottom: number };
  foldMotion: string;
  inert: boolean;
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
    estate: d.estate || "",
    pane: d.pane || "", held: d.held || "",
    foldHeight: document.getElementById("ad-ask-fold").getBoundingClientRect().height,
    estateHeight: document.getElementById("ad-estate").getBoundingClientRect().height,
    svgHeight: (document.querySelector("#ad-estate-graph svg") || document.body).getBoundingClientRect().height,
    control: (() => {
      const b = document.getElementById("ad-convo");
      const r = b.getBoundingClientRect();
      return { hidden: b.hidden, expanded: b.getAttribute("aria-expanded"), text: b.textContent, height: r.height, bottom: r.bottom };
    })(),
    foldMotion: getComputedStyle(document.getElementById("ad-ask-fold")).transitionDuration,
    inert: document.getElementById("ad-ask-fold").inert,
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
    // Each loop starts with the estate pane empty: the agent has loaded nothing yet.
    const before = await waitFor(page, `loop ${i}'s start`, (s) => s.loop === String(i));
    if (!before.turn) expect(before.estate).toBe("empty");
    const atLoad = await waitFor(page, `loop ${i}'s load turn`, (s) => s.loop === String(i) && (s.turn === "load" || s.turn === q.id));
    if (atLoad.turn === "load") {
      expect(atLoad.estate).toBe("loaded");
      expect(atLoad.lit.sort()).toEqual([...load.light].sort());
      expect(atLoad.cypher).toBe("");
      expect(atLoad.readOnly).toBe(true);
    }
    const atQ = await waitFor(page, `loop ${i}'s question ${q.id}`, (s) => s.loop === String(i) && s.turn === q.id);
    expect(atQ.estate).toBe("loaded");
    // behold#1183: the agent's pane is open while the turns print, and nothing offers to close it.
    // Under reduced motion the question's reply prints at once, so its beat may already be running.
    for (const s of reduced ? [before, atLoad] : [before, atLoad, atQ]) expect([s.pane, s.inert, s.control.hidden], s.turn).toEqual(["open", false, true]);
    expect((reduced ? atLoad : atQ).foldHeight).toBeGreaterThan(100);
    // The Cypher box fills with the turn's query as its reply starts, and the answer draws at once.
    expect(atQ.cypher).toBe(q.cypher);
    expect(atQ.params).toBe(Object.keys(q.params).length ? JSON.stringify(q.params) : "");
    // Read-only while the reply prints; under reduced motion it prints at once, and the box is the visitor's.
    if (!reduced) expect([atQ.phase, atQ.readOnly]).toEqual(["playing", true]);
    expect(atQ.lit).toEqual(q.light);
    expect(atQ.domLit.sort()).toEqual([...q.light].sort());
    const drawn = drawLight(recordedAnswer(q).body, known);
    expect(atQ.answerLit).toEqual(drawn);
    expect(atQ.domAnswerLit.sort()).toEqual([...drawn].sort());
    for (const s of q.sources) expect(atQ.sources).toContain(s.readAt);
    for (const r of q.rows) for (const v of Object.values(r)) expect(atQ.rows).toContain(String(v));
    const after = await waitFor(page, `loop ${i} to finish`, (s) => s.loop === String(i) && s.phase === "after");
    for (const text of [load.prompt, load.reply, q.prompt, q.reply]) expect(after.terminal.replace(/\s+/g, " "), text).toContain(text.replace(/\s+/g, " "));
    expect(after.terminal).toContain(load.busy.replace(/(\.{1,3}|…)\s*$/, "").trim());
    expect(after.readOnly).toBe(false);
    await checkPaneCloses(page, i, reduced, atQ);
    if (i + 1 < qs.length) await page.click("#ad-next");
  }
}

/**
 * behold#1183: a short beat after the question's reply the agent's pane closes, sliding (or at
 * once under reduced motion), and the estate graph takes its room; the control at its edge opens
 * it again and holds the loop, and closing it again is allowed. It is left closed, so the next
 * loop's checks (open while the turns print) show that a new loop opens it.
 */
async function checkPaneCloses(page: Page, i: number, reduced: boolean, open: Seen) {
  const shut = await waitFor(page, `loop ${i}'s pane to close`, (s) => s.loop === String(i) && s.pane === "closed" && s.foldHeight < 1, 10_000);
  expect(shut.phase).toBe("after");
  expect(shut.foldMotion).toBe(reduced ? "0s" : "0.5s");
  expect(shut.inert).toBe(true);
  expect(shut.control).toMatchObject({ hidden: false, expanded: "false", text: "Show the conversation" });
  // Findable at the bottom edge, and small.
  expect(shut.control.height).toBeLessThan(40);
  expect(shut.control.bottom).toBeGreaterThan(900 - 40);
  // The estate graph uses the room: its pane grows by what the agent's pane gave up, and the drawing fills it.
  expect(shut.estateHeight).toBeGreaterThan(open.estateHeight + open.foldHeight - 60);
  expect(Math.abs(shut.svgHeight - shut.estateHeight)).toBeLessThan(2);
  // Still the visitor's to read in the page's text, though closed.
  expect(shut.terminal.replace(/\s+/g, " ")).toContain(loopOf(narration, i).question.prompt.replace(/\s+/g, " "));
  await page.click("#ad-convo");
  const reopened = await waitFor(page, `loop ${i}'s pane to open again`, (s) => s.pane === "open" && s.foldHeight > 100, 10_000);
  expect(reopened.loop).toBe(String(i));
  expect(reopened.control).toMatchObject({ hidden: false, expanded: "true", text: "Hide the conversation" });
  expect(reopened.held).toBe("1");
  expect(reopened.inert).toBe(false);
  // It stays open: the beat has long passed.
  await new Promise((r) => setTimeout(r, 400));
  expect((await waitFor(page, "the pane still open", () => true)).pane).toBe("open");
  await page.click("#ad-convo");
  await waitFor(page, `loop ${i}'s pane to close again`, (s) => s.pane === "closed" && s.foldHeight < 1, 10_000);
}

/**
 * behold#1182: a log of LadybugDB's badge, kept in the page from before it boots: each time it
 * starts or stops moving, with the animations it runs then, and the pane's busy lines and the
 * replies that draw an answer, all on the page's performance clock.
 */
const badgeLogScript = `(() => {
  const log = (globalThis.__badge = []);
  const now = () => performance.now();
  const loop = () => document.documentElement.dataset.loop || "";
  addEventListener("behold:ask-busy", (e) => log.push({ ev: "busy", busy: !!(e.detail && e.detail.busy), step: e.detail && e.detail.step, loop: loop(), t: now() }));
  addEventListener("behold:ask-light", (e) => log.push({ ev: "light", turn: e.detail && e.detail.ask && e.detail.ask.turn && e.detail.ask.turn.id, loop: loop(), t: now() }));
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("g-engine-badge");
    if (!el) return;
    let was = false;
    new MutationObserver(() => {
      const active = el.hasAttribute("data-active");
      if (active === was) return;
      was = active;
      const img = el.querySelector("img");
      log.push({ ev: "badge", active, loop: loop(), t: now(), anim: [getComputedStyle(el).animationName, getComputedStyle(img).animationName], running: el.getAnimations({ subtree: true }).length, ring: getComputedStyle(el).boxShadow });
    }).observe(el, { attributes: true, attributeFilter: ["data-active"] });
  });
})()`;

interface BadgeEntry {
  ev: "busy" | "light" | "badge";
  busy?: boolean;
  step?: string;
  turn?: string;
  active?: boolean;
  loop: string;
  t: number;
  anim?: string[];
  running?: number;
  ring?: string;
}

/** The linger at `?pace=8`: LINGER_MS of the page's clock, in real ms. */
const PACED_LINGER = 3000 / 8;

/**
 * Each loop's question moves the badge from its busy line (or, where none shows, its answer)
 * until about LINGER_MS after the answer draws, without a stop in between; with motion it
 * spins and pulses, under reduced motion it runs no animation and shows a ring.
 */
function checkBadgeLog(log: BadgeEntry[], reduced: boolean) {
  const qs = narration.turns.filter((t) => t.kind === "question");
  for (let i = 0; i < qs.length; i++) {
    const q = loopOf(narration, i).question;
    const light = log.findIndex((e) => e.ev === "light" && e.turn === q.id && e.loop === String(i));
    expect(light, `loop ${i}: ${q.id}'s answer drew`).toBeGreaterThanOrEqual(0);
    const busy = log.findIndex((e) => e.ev === "busy" && e.busy && e.step === q.id && e.loop === String(i));
    if (!reduced) expect(busy, `loop ${i}: ${q.id}'s busy line showed`).toBeGreaterThanOrEqual(0);
    const from = busy >= 0 && busy < light ? busy : light;
    // It starts as the busy line shows (or the answer draws) ...
    const on = log.findIndex((e, k) => k > from && e.ev === "badge");
    expect(log[on], `loop ${i}: the badge starts`).toMatchObject({ active: true });
    if (busy >= 0 && busy < light) expect(on, `loop ${i}: the badge moves before the answer draws`).toBeLessThan(light);
    expect(log[on]!.t - log[from]!.t, `loop ${i}: at once`).toBeLessThan(100);
    // ... and stops once, about LINGER_MS after the answer, unless the next loop started first.
    const off = log.findIndex((e, k) => k > on && e.ev === "badge");
    expect(log[off], `loop ${i}: the badge stops`).toMatchObject({ active: false });
    expect(off, `loop ${i}: no stop before the answer`).toBeGreaterThan(light);
    const after = log[off]!.t - log[light]!.t;
    expect(after, `loop ${i}: stops soon after the answer`).toBeLessThan(PACED_LINGER + 600);
    if (log[off]!.loop === String(i)) expect(after, `loop ${i}: lingers after the answer`).toBeGreaterThan(PACED_LINGER - 60);
    const moving = log[on]!;
    if (reduced) {
      expect(moving.anim, `loop ${i}: no animation under reduced motion`).toEqual(["none", "none"]);
      expect(moving.running).toBe(0);
      expect(moving.ring).not.toBe("none");
    } else {
      expect(moving.anim).toEqual(["engine-pulse", "engine-spin"]);
      expect(moving.running).toBe(2);
    }
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
    const badgeChecked: string[] = [];
    try {
      for (const reducedMotion of ["no-preference", "reduce"] as const) {
        const context = await browser.newContext({ reducedMotion, viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        page.on("request", (r: { url(): string }) => requests.push(r.url()));
        page.on("pageerror", (e: Error) => errors.push(e.message));
        await page.addInitScript(badgeLogScript);
        try {
          await page.goto(`${url}?pace=8`, { waitUntil: "domcontentloaded" });
          await playAll(page, reducedMotion === "reduce");
          // Long enough for the last loop's linger to run out.
          await new Promise((r) => setTimeout(r, PACED_LINGER + 600));
          checkBadgeLog(await page.evaluate("globalThis.__badge"), reducedMotion === "reduce");
          badgeChecked.push(reducedMotion);
          if (reducedMotion === "reduce") continue;
          // After a loop the box is the visitor's: their query runs on the recorded rows in LadybugDB's WebAssembly build.
          const q = narration.turns[1]!;
          await page.fill("#g-cypher", q.cypher!);
          await page.fill("#g-params", JSON.stringify(q.params));
          await page.waitForFunction(() => document.documentElement.dataset.engine === "ready", null, { timeout: 120_000 });
          const clickedAt = (await page.evaluate("performance.now()")) as number;
          await page.click("#g-ask");
          await page.waitForFunction(() => document.documentElement.dataset.visitor === "1", null, { timeout: 60_000 });
          // behold#1182: the visitor's query moves the badge, and it stops after the linger.
          await page.waitForFunction(() => !document.getElementById("g-engine-badge")!.hasAttribute("data-active"), null, { timeout: 10_000 });
          const visitorBadge = ((await page.evaluate("globalThis.__badge")) as BadgeEntry[]).filter((e) => e.ev === "badge" && e.t >= clickedAt);
          expect(visitorBadge.map((e) => e.active)).toEqual([true, false]);
          expect(visitorBadge[1]!.t - visitorBadge[0]!.t).toBeGreaterThan(PACED_LINGER - 60);
          const s = await waitFor(page, "the visitor's answer", (x) => x.answerLit.length > 0);
          expect(s.lit.sort()).toEqual([...q.light].sort());
          // behold#1190: both ends of each row, as the recorded turn drew them.
          expect(s.answerLit.sort()).toEqual([...drawLight(recordedAnswer(q).body, known)].sort());
          for (const k of q.keys) expect(s.answerLit).toContain(k);
          for (const r of q.rows) for (const v of Object.values(r)) expect(s.rows).toContain(String(v));
          // The visitor holds the loop: it does not move on while they read.
          expect(s.phase).toBe("after");
          expect(await page.evaluate(() => document.documentElement.dataset.held)).toBe("1");
        } finally {
          await context.close();
        }
      }
      expect(errors).toEqual([]);
      expect(badgeChecked).toEqual(["no-preference", "reduce"]);
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

describe.runIf(peer.ok)("the bundle's /graph page, in a headless browser (behold#1180)", () => {
  it("links back to the demo, hides the estate link, starts with the first question's query, and answers it", { timeout: 240_000 }, async () => {
    const launched = await browserOrNull();
    if (!launched) {
      console.warn("ask-demo-page: no browser launches here, so the bundle's /graph page did not run");
      return;
    }
    const url = await serveDir(out);
    const browser = launched.browser as unknown as { newPage(): Promise<Page>; close(): Promise<void> };
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.addInitScript(() => {
      (globalThis as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => (globalThis as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    const first = narration.turns.find((t) => t.kind === "question")!;
    expect(first.rows.length).toBeGreaterThan(0);
    try {
      await page.goto(`${url}graph.html`, { waitUntil: "domcontentloaded" });
      const head = await page.evaluate(() => ({
        back: document.getElementById("g-back")?.getAttribute("href"),
        label: document.getElementById("g-back")?.textContent,
        diff: Boolean(document.getElementById("d-section")),
        cypher: (document.getElementById("g-cypher") as HTMLTextAreaElement).value,
        params: (document.getElementById("g-params") as HTMLInputElement).value,
      }));
      expect(head).toEqual({ back: "./", label: "Back to the demo", diff: false, cypher: first.cypher, params: Object.keys(first.params).length ? JSON.stringify(first.params) : "" });
      await page.waitForFunction(() => document.querySelector("#g-cypher-form button")?.textContent === "Ask", null, { timeout: 120_000 });
      await page.click("#g-cypher-form button");
      await page.waitForFunction((n: number) => document.querySelectorAll("#g-rows tbody tr").length === n, first.rows.length, { timeout: 30_000 });
      const rows = await page.evaluate(() => document.getElementById("g-rows")!.innerText);
      for (const r of first.rows) for (const v of Object.values(r)) expect(rows).toContain(String(v));
      expect(await page.evaluate(() => (document.getElementById("g-link") as HTMLAnchorElement).hidden)).toBe(true);
      expect(await page.evaluate(() => (globalThis as unknown as { __csp: string[] }).__csp)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});

type Box = { x: number; y: number; width: number; height: number };

/** Each card the estate graph draws, by id, to its box: the first rect in its group. */
function cardBoxes(svg: string): Map<string, Box> {
  const out = new Map<string, Box>();
  const re = /<g[^>]*data-node-id="([^"]+)"[^>]*>\s*<rect([^>]*)>/g;
  for (const m of svg.matchAll(re)) {
    const n = (a: string) => Number(new RegExp(`\\s${a}="([-\\d.]+)"`).exec(m[2]!)?.[1]);
    out.set(m[1]!, { x: n("x"), y: n("y"), width: n("width"), height: n("height") });
  }
  return out;
}

const viewBoxOf = (page: Page): Promise<Box> =>
  page.evaluate(() => {
    const [x, y, width, height] = document.querySelector("#ad-estate-graph svg")!.getAttribute("viewBox")!.split(/[\s,]+/).map(Number);
    return { x, y, width, height };
  });
const inside = (b: Box, v: Box) => b.x >= v.x - 0.5 && b.y >= v.y - 0.5 && b.x + b.width <= v.x + v.width + 0.5 && b.y + b.height <= v.y + v.height + 0.5;

describe.runIf(peer.ok)("the estate pane's zoom and the answer, on the recording (#1175, #1190)", () => {
  it("frames both ends of a spread-out answer, draws its rows as labelled edges with the table above the fold, and the visitor's buttons and wheel move the view and hold the loop", { timeout: 120_000 }, async () => {
    const launched = await browserOrNull();
    if (!launched) {
      console.warn("ask-demo-page: no browser launches here, so the zoom was not checked");
      return;
    }
    const rec = JSON.parse(readFileSync(RECORDING, "utf8")) as Narration;
    const graph = JSON.parse(readFileSync(join(RECORDED_ESTATE, "graph.json"), "utf8")) as { svg: string };
    const [fx, fy, fw, fh] = /viewBox="([^"]+)"/.exec(graph.svg)![1]!.split(/[\s,]+/).map(Number);
    const full: Box = { x: fx!, y: fy!, width: fw!, height: fh! };
    const boxes = cardBoxes(graph.svg);
    // dns-cross-cloud: the records sit in a stack at the top of the estate, the GCP cards they reach near the bottom.
    const qs = questionsOf(rec) as Narration["turns"];
    const spread = qs.findIndex((t) => t.id === "dns-cross-cloud");
    expect(spread).toBeGreaterThanOrEqual(0);
    const q = qs[spread]!;
    expect(viewShare(frameBox(q.light.map((id) => boxes.get(id)!), full), full)).toBeGreaterThan(0.6);
    const url = await serveDir(recordedOut);
    const browser = launched.browser as unknown as { newContext(o?: object): Promise<any>; close(): Promise<void> };
    const errors: string[] = [];
    try {
      const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.on("pageerror", (e: Error) => errors.push(e.message));
      await page.goto(`${url}?pace=2&loop=${spread}`, { waitUntil: "domcontentloaded" });
      await waitFor(page, `the question ${q.id}`, (s) => s.turn === q.id);
      // Every lit card is in view, a record's card and the GCP cards alike, and the view is no larger than the graph.
      const at = await viewBoxOf(page);
      expect(at.width).toBeLessThan(full.width);
      expect(at.height).toBeLessThan(full.height);
      for (const id of q.light) expect(inside(boxes.get(id)!, at), `${id} in ${JSON.stringify(at)}`).toBe(true);
      expect(q.light.some((id) => id.startsWith("dns/"))).toBe(true);
      expect(q.light.some((id) => id.startsWith("gcp/"))).toBe(true);
      // The answer drawing has both ends of each row: an edge from each record to what it reaches, labelled reaches.
      const drawing = await page.evaluate(() => ({
        labels: [...document.querySelectorAll("#g-draw line.g-edge.row")].map((l) => l.getAttribute("data-label")),
        words: [...document.querySelectorAll("#g-draw text.g-edge-label")].map((t) => t.textContent),
        nodes: [...document.querySelectorAll("#g-draw .g-node")].map((g) => g.getAttribute("data-key")),
      }));
      expect(drawing.labels.length).toBe(q.rows.length);
      expect(new Set(drawing.labels)).toEqual(new Set(["reaches"]));
      expect(drawing.words.length).toBeGreaterThan(0);
      for (const r of q.rows) for (const k of [r.key, r.reaches]) expect(drawing.nodes).toContain(k);
      // The rows table's first row shows without scrolling, at 1440x900 with the conversation open.
      const fold = await page.evaluate(() => {
        const pane = document.getElementById("ad-pane")!;
        const row = document.querySelector("#g-rows tbody tr")!.getBoundingClientRect();
        return { row: row.bottom, pane: pane.getBoundingClientRect().bottom, scrolled: pane.scrollTop, height: innerHeight };
      });
      expect(fold.scrolled).toBe(0);
      expect(fold.row).toBeLessThanOrEqual(Math.min(fold.pane, fold.height));
      // The buttons: zoom in about the middle, fit the whole graph, and no further out than that.
      await page.click("#ad-zoom-in");
      const zin = await viewBoxOf(page);
      expect(zin.width).toBeCloseTo(at.width / 1.5, 3);
      expect(zin.height).toBeCloseTo(at.height / 1.5, 3);
      expect(zin.x + zin.width / 2).toBeCloseTo(at.x + at.width / 2, 3);
      await page.click("#ad-zoom-fit");
      expect(await viewBoxOf(page)).toEqual(full);
      await page.click("#ad-zoom-out");
      expect(await viewBoxOf(page)).toEqual(full);
      // The wheel zooms in about the pointer.
      const pane = await page.evaluate(() => {
        const r = document.getElementById("ad-estate-graph")!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.move(pane.x, pane.y);
      await page.mouse.wheel(0, -300);
      await page.waitForFunction((w: number) => Number(document.querySelector("#ad-estate-graph svg")!.getAttribute("viewBox")!.split(" ")[2]) < w, full.width, { timeout: 5_000 });
      // The visitor zoomed while the loop played, so once the answer has printed the loop holds for them.
      const after = await waitFor(page, "the loop to finish", (s) => s.phase === "after");
      expect(after.turn).toBe(q.id);
      expect(await page.evaluate(() => document.documentElement.dataset.held)).toBe("1");
      await context.close();
    } finally {
      await browser.close();
    }
    expect(errors).toEqual([]);
  });
});
