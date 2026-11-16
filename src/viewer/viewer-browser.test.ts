/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import type { GraphIR } from "@intentius/chant";
import type { GraphDocument } from "../graph-document.ts";
import { cutDocument } from "../graph-cut.ts";
import { documentOptions } from "../graph-document-context.ts";
import { createApp } from "../server.ts";
import type { Browser, Page } from "playwright-core";
import { launchShotBrowser, ShotRefusal } from "../shot.ts";
import { toDocument } from "../to-document.ts";
import { drawnMembers, readWorkspace } from "../workspace.ts";
import { documentIcons, graphScript } from "./graph-script.ts";

// behold#1070 in a real headless Chrome: the built viewer draws
// example-terraform-estate's document from file:// with a graph.js, and from
// a behold:graph message under the strictest CSP a host is expected to set.
// Skipped where no browser launches, and where the viewer does not build
// because the installed pinhole still imports Node built-ins from its root
// (pinhole 0.5.0; INTENTIUS/pinhole#133 removes them).

const HERE = import.meta.dirname;
const ROOT = join(HERE, "..", "..");
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'";

const made: string[] = [];
let skip: string | null = null;
let out = "";
let doc: GraphDocument;
let serverCards: string[] = [];
let browser: Browser | undefined;

const cardsIn = (svg: string): string[] => [...new Set([...svg.matchAll(/data-node-id="([^"]+)"/g)].map((m) => m[1]!))].sort();

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "behold-viewer-"));
  made.push(out);
  try {
    execFileSync(join(ROOT, "node_modules", ".bin", "tsx"), [join(ROOT, "scripts", "build-viewer.mts"), "--out", out], { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    const err = String((e as { stderr?: Buffer }).stderr ?? e);
    if (/Node built-ins/.test(err) && /@intentius\/pinhole/.test(err)) {
      skip = "the installed pinhole imports Node built-ins from its root (waits on pinhole 0.6.0)";
      return;
    }
    throw new Error(err);
  }
  try {
    // The shot's launcher: the system Chrome, else Playwright's headless shell. It hands back Playwright's browser.
    browser = (await launchShotBrowser()).browser as unknown as Browser;
  } catch (e) {
    skip = `no headless browser: ${e instanceof ShotRefusal ? e.body.error : String(e)}`;
    return;
  }
  // The estate read the way to-document.test.ts reads it: a copy, behold's own node_modules beside it.
  const tmp = mkdtempSync(join(tmpdir(), "behold-1070-"));
  made.push(tmp);
  const root = join(tmp, "estate");
  cpSync(join(ROOT, "example-terraform-estate"), root, { recursive: true });
  symlinkSync(join(ROOT, "node_modules"), join(tmp, "node_modules"));
  const read = await readWorkspace(root);
  if (!read.ok) throw new Error(read.refusal.error);
  const drawn = drawnMembers(read.workspace).map((m) => m.abs);
  const cfg = { projectDir: drawn[0]!, projectDirs: drawn, workspace: read.workspace, port: 0 };
  const res = await createApp(cfg).request("/api/graph");
  const body = (await res.json()) as { ir: GraphIR; svg: string; meta: Record<string, unknown> };
  serverCards = cardsIn(body.svg);
  doc = toDocument({ ir: body.ir, meta: body.meta }, documentOptions({ ...cfg, behold: "0.31.0" }));
}, 180_000);

afterAll(async () => {
  await browser?.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
}, 60_000);

/** The drawn page's cards, once the viewer says it is done. */
async function drawnCards(page: Page): Promise<{ cards: string[]; state: Record<string, unknown> }> {
  await page.waitForFunction(() => /^(drawn|refused)$/.test(document.documentElement.getAttribute("data-behold-viewer") ?? ""), undefined, { timeout: 60_000 });
  return page.evaluate(() => ({
    cards: [...new Set([...document.querySelectorAll("#behold-graph [data-node-id]")].map((e) => e.getAttribute("data-node-id")!))].sort(),
    state: { ...(window as unknown as { __BEHOLD_VIEWER_STATE__: Record<string, unknown> }).__BEHOLD_VIEWER_STATE__ },
  }));
}

describe("the single-file viewer in headless Chrome (behold#1070)", () => {
  it("viewer.html with a graph.js, opened from file://, draws the cards /api/graph draws", { timeout: 120_000 }, async (ctx) => {
    if (skip) return ctx.skip(skip);
    expect(serverCards.length).toBeGreaterThan(20);
    writeFileSync(join(out, "graph.js"), graphScript(doc));
    const page = await browser!.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(pathToFileURL(join(out, "viewer.html")).href);
    const { cards, state } = await drawnCards(page);
    expect(state.error ?? state.state).toBe("drawn");
    expect(cards).toEqual(serverCards);
    // Inlined, the script starts its worker from its own text, which Chrome allows from file://.
    expect(state.where).toBe("worker");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("index.html with a graph.js, opened from file://, draws on the page itself", { timeout: 120_000 }, async (ctx) => {
    if (skip) return ctx.skip(skip);
    writeFileSync(join(out, "graph.js"), graphScript(doc));
    const page = await browser!.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(pathToFileURL(join(out, "index.html")).href);
    const { cards, state } = await drawnCards(page);
    expect(state.error ?? state.state).toBe("drawn");
    expect(cards).toEqual(serverCards);
    // A file:// script URL starts no worker, so the layout ran on the page.
    expect(state.where).toBe("main");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("?focus= cuts the document around the root and draws only the cut", { timeout: 120_000 }, async (ctx) => {
    if (skip) return ctx.skip(skip);
    const cutIds = (root: string) => {
      const c = cutDocument(doc, [root], { depth: 1 });
      if (!c.ok) throw new Error(c.error);
      return c.document.nodes.map((n) => n.id).sort();
    };
    const prod = cutIds("stack:prod");
    expect(prod.length).toBeLessThan(serverCards.length);
    writeFileSync(join(out, "graph.js"), graphScript(doc));
    const page = await browser!.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${pathToFileURL(join(out, "index.html")).href}?focus=prod`);
    const first = await drawnCards(page);
    expect(first.state.error ?? first.state.state).toBe("drawn");
    expect(first.cards).toEqual(prod);
    // The cards are removed, not dimmed.
    expect(await page.evaluate(() => document.querySelectorAll(".behold-dim").length)).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("index.html fed by a behold:graph message draws under the CSP, with no violation, laid out in a worker", { timeout: 120_000 }, async (ctx) => {
    if (skip) return ctx.skip(skip);
    writeFileSync(join(out, "graph.js"), readFileSync(join(HERE, "graph.js"), "utf8"));
    const server: Server = createServer((req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
      const file = join(out, path === "/" ? "index.html" : path);
      try {
        const body = readFileSync(file);
        const type = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" }[extname(file)] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": type, "content-security-policy": CSP });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-security-policy": CSP });
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await browser!.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { __violations: string[] }).__violations = seen;
        document.addEventListener("securitypolicyviolation", (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
      });
      await page.goto(`${origin}/index.html?host=${encodeURIComponent(origin)}&theme=light`);
      await page.waitForFunction(() => document.documentElement.getAttribute("data-behold-viewer") === "waiting");
      const icons = documentIcons(doc);
      await page.evaluate(([d, i]) => window.postMessage({ type: "behold:graph", document: d, icons: i }, location.origin), [doc, icons] as const);
      const { cards, state } = await drawnCards(page);
      expect(state.error ?? state.state).toBe("drawn");
      expect(cards).toEqual(serverCards);
      expect(state.where).toBe("worker");
      expect(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)).toEqual([]);
      expect(errors).toEqual([]);
      // behold:view moves the view: one card lit, the rest dimmed.
      const lit = doc.nodes[0]!.id;
      await page.evaluate((id) => window.postMessage({ type: "behold:view", node: id }, location.origin), lit);
      await page.waitForFunction(() => document.querySelectorAll(".behold-lit").length > 0);
      expect(await page.evaluate(() => [...document.querySelectorAll(".behold-lit")].map((e) => e.getAttribute("data-node-id")))).toEqual([lit]);
      expect(await page.evaluate(() => new Set([...document.querySelectorAll(".behold-dim")].map((e) => e.getAttribute("data-node-id"))).size)).toBe(serverCards.length - 1);
      // A behold:view focus cuts the document again: the cards of that cut are drawn, the others are gone.
      const c = cutDocument(doc, ["stack:prod"], { depth: 1 });
      if (!c.ok) throw new Error(c.error);
      const prod = c.document.nodes.map((n) => n.id).sort();
      await page.evaluate(() => window.postMessage({ type: "behold:view", node: "", focus: "prod" }, location.origin));
      await page.waitForFunction((n) => (window as unknown as { __BEHOLD_VIEWER_STATE__: { cards?: number } }).__BEHOLD_VIEWER_STATE__.cards === n, prod.length, { timeout: 60_000 });
      expect((await drawnCards(page)).cards).toEqual(prod);
      await page.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
