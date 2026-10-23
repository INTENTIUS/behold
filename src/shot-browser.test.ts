import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchShotBrowser, ShotRefusal, takeShot } from "./shot.ts";
import { withLocalServe } from "./shot-cli.ts";

// behold#915 with a real browser: behold's own app started in-process, its own
// page, the system Chrome or Playwright's headless shell. The estate is the
// carve sample report, which draws a real graph with no chant spawned. Skipped
// where no browser launches (src/shot.test.ts covers the logic with a stand-in).

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, "__fixtures__", "carve-sample-estate.json");

let browserReason: string | null = null;
beforeAll(async () => {
  try {
    const { browser } = await launchShotBrowser();
    await browser.close();
  } catch (e) {
    browserReason = e instanceof ShotRefusal ? e.body.error : String(e);
  }
}, 60_000);

/** Every file under `dir` with its size and mtime: what "nothing written" is checked against. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      out.push(`${p} ${s.size} ${s.mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe("behold shot in a real browser (behold#915)", () => {
  let project: string;
  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), "behold-shot-real-"));
    copyFileSync(REPORT, join(project, "report.json"));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  const shoot = (view: Record<string, string>) =>
    withLocalServe({ projectDir: project, carveReport: join(project, "report.json"), port: 0 }, (base) => takeShot(base, { view, width: 1000, height: 640 }, { linkBase: "http://localhost:4600" }));

  it("frames the lit card, dims the rest, and writes nothing in the served project", async (ctx) => {
    if (browserReason) return ctx.skip(`no headless browser: ${browserReason}`);
    const before = listing(project);
    const lit = await shoot({ node: "aws_vpc.main" });
    const none = await shoot({ node: "nothing.here" });
    expect(listing(project)).toEqual(before);

    expect(lit.state).toBe("drawn");
    expect(lit.matched).toBe(1);
    expect(lit.link).toBe("http://localhost:4600/?node=aws_vpc.main");
    // A PNG of the page's size: the signature, then IHDR's width and height.
    expect(lit.png.subarray(1, 4).toString()).toBe("PNG");
    expect([lit.png.readUInt32BE(16), lit.png.readUInt32BE(20)]).toEqual([1000, 640]);

    // No match: the whole graph, dimmed, and a different framing from the lit card's.
    expect(none.state).toBe("no-matches");
    expect(none.matched).toBe(0);
    expect(lit.viewBox).toHaveLength(4);
    expect(none.viewBox).toHaveLength(4);
    const centre = (vb: number[]) => [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2];
    const [lx, ly] = centre(lit.viewBox!);
    const [nx, ny] = centre(none.viewBox!);
    expect(Math.hypot(lx - nx, ly - ny)).toBeGreaterThan(50);
  }, 90_000);

  it("refuses a page that never reports ready, with no picture", async (ctx) => {
    if (browserReason) return ctx.skip(`no headless browser: ${browserReason}`);
    const server: Server = createServer((_req, res) => res.end("<!doctype html><title>not behold</title><p>never ready</p>"));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const { port } = server.address() as AddressInfo;
      const e = await takeShot(`http://127.0.0.1:${port}`, { view: { node: "a" }, timeoutMs: 1500 }).catch((err) => err);
      expect(e).toBeInstanceOf(ShotRefusal);
      expect((e as ShotRefusal).code).toBe("not-ready");
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  }, 60_000);
});

// behold#913 with a real browser and the real chant: the page lights exactly
// the cards GET /api/search answers for the query, draws its path edges, and a
// query with no matches is photographed dimmed, never as an empty stage.
describe("a query's shot in a real browser (behold#913)", async () => {
  const { SEARCH_CONTRACT_CHANT_FLOOR } = await import("./chant-floors.ts");
  const { meetsFloor } = await import("./floor.ts");
  const { resolvedVersion, TERRAFORM_LEXICON_PKG, HCL_PARSER_PKG } = await import("./terraform-member.ts");
  const { localServeOptions } = await import("./shot-cli.ts");
  const { cpSync } = await import("node:fs");
  const gate = !meetsFloor(resolvedVersion("@intentius/chant"), SEARCH_CONTRACT_CHANT_FLOOR) || !resolvedVersion(TERRAFORM_LEXICON_PKG) || !resolvedVersion(HCL_PARSER_PKG);
  let dir = "";
  beforeAll(() => {
    if (gate) return;
    dir = mkdtempSync(join(tmpdir(), "behold-shot-q-"));
    cpSync(join(HERE, "..", "example-terraform-estate"), dir, { recursive: true });
    rmSync(join(dir, "chant.workspace.json"));
  });
  afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

  it.skipIf(gate)(`lights what the search answers, and no matches is dimmed (needs chant ${SEARCH_CONTRACT_CHANT_FLOOR})`, { timeout: 180_000 }, async (ctx) => {
    if (browserReason) return ctx.skip(`no headless browser: ${browserReason}`);
    const cfg = await localServeOptions(dir);
    await withLocalServe(cfg, async (base) => {
      const q = "->kind:aws_kms_key";
      const answer = (await (await fetch(`${base}/api/search?q=${encodeURIComponent(q)}`)).json()) as { draw: { lit: string[]; onPath: string[] } };
      const shot = await takeShot(base, { query: q, view: { zoom: "resources" }, width: 1200, height: 800 }, { linkBase: "http://localhost:4600" });
      expect(shot.state).toBe("drawn");
      // The lit cards are the answer's, less any the resources zoom elides (an output, here).
      expect(shot.matched).toBeGreaterThan(0);
      expect(shot.matched).toBeLessThanOrEqual(answer.draw.lit.length);
      const none = await takeShot(base, { query: "kind:nothing_here", view: { zoom: "resources" }, width: 1200, height: 800 }, { linkBase: "http://localhost:4600" });
      expect(none.state).toBe("no-matches");
      const bad = await takeShot(base, { query: "effectiveIngress:tcp:22", view: { zoom: "resources" }, width: 1200, height: 800 }, { linkBase: "http://localhost:4600" });
      expect(bad.state).toBe("failed");
    });
  });
});
