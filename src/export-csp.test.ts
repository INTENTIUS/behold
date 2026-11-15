import { afterAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";

// behold#1068: an export loads under the policy a webview applies to a page,
// which blocks inline scripts. The load test serves a bundle over HTTP twice,
// with and without the policy, in a real headless Chrome through the
// playwright-core peer `behold shot` uses, and compares what each draws. It
// skips, saying so, where no browser launches.
vi.mock("./chant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chant.ts")>()),
  graphIr: vi.fn(),
}));
import { graphIr } from "./chant.ts";
import { runExport } from "./export.ts";
import { launchShotBrowser } from "./shot.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
const CARDS = 'document.querySelectorAll("#graph [data-node-id]").length';
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".css": "text/css", ".md": "text/plain" };

const made: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function serveDir(dir: string, csp: string | null, seen: string[]): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      seen.push(path);
      let file = normalize(join(dir, path === "/" ? "index.html" : path));
      try {
        if (!file.startsWith(dir) || !statSync(file).isFile()) throw new Error("no");
      } catch {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...(csp ? { "content-security-policy": csp } : {}) });
      res.end(readFileSync(file));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/`));
  });
}

async function browserOrNull() {
  try {
    return await launchShotBrowser();
  } catch {
    return null;
  }
}

describe("an export under a webview content security policy (#1068)", () => {
  it("draws the same cards as with no policy, reports no violation and asks for no history.json", { timeout: 120_000 }, async () => {
    const launched = await browserOrNull();
    if (!launched) {
      console.warn("export-csp: no browser launches here, so the load test did not run");
      return;
    }
    vi.mocked(graphIr).mockImplementation((async () => JSON.parse(readFileSync(join(HERE, "__fixtures__", "terraform-ir-two-roots.json"), "utf8")) as GraphIR) as never);
    const project = mkdtempSync(join(tmpdir(), "behold-csp-src-"));
    const out = join(mkdtempSync(join(tmpdir(), "behold-csp-out-")), "bundle");
    made.push(project, dirname(out));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runExport({ projectDir: project, port: 0 }, out);
    } finally {
      write.mockRestore();
    }

    const load = async (csp: string | null) => {
      const requests: string[] = [];
      const url = await serveDir(out, csp, requests);
      const page = await (launched.browser as unknown as { newPage(o: object): Promise<any> }).newPage({ viewport: { width: 1400, height: 900 } });
      const violations: string[] = [];
      page.on("console", (m: { text(): string }) => {
        if (/content security policy/i.test(m.text())) violations.push(m.text());
      });
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(CARDS + " > 0", undefined, { timeout: 30_000 }).catch(() => undefined);
      const cards: number = await page.evaluate(CARDS);
      await page.close();
      return { cards, violations, requests };
    };

    try {
      const open = await load(null);
      const strict = await load(POLICY);
      expect(open.cards).toBeGreaterThan(0);
      expect(strict.cards).toBe(open.cards);
      expect(strict.violations).toEqual([]);
      expect(strict.requests.filter((r) => r.endsWith("history.json"))).toEqual([]);
      expect(open.requests.filter((r) => r.endsWith("history.json"))).toEqual([]);
    } finally {
      await launched.browser.close();
    }
  });
});
