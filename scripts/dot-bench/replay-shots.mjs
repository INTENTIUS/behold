#!/usr/bin/env node
// Screenshot the replay prototype at chosen points of a recording (#457).
//
//   node scripts/dot-bench/replay-shots.mjs <recording.jsonl> <out-dir> [0,0.5,1]
//
// Writes replay-<pct>.png per point, and prints the dot and move counts the
// page read, so a screenshot in the design note can be traced to its file.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const [recording, outDir, points = "0,0.5,1", dpr = "1"] = process.argv.slice(2);
if (!recording || !outDir) { console.error("usage: replay-shots.mjs <recording.jsonl> <out-dir> [0,0.5,1]"); process.exit(2); }
const rec = resolve(recording);
mkdirSync(outDir, { recursive: true });

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".jsonl": "application/x-ndjson", ".gz": "application/gzip" };
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const file = path === "/rec" ? rec : join(HERE, path.slice(1));
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: Number(dpr) });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/replay.html?rec=/rec${rec.endsWith(".gz") ? "&gz=1" : ""}`);
  await page.waitForFunction(() => window.replay, null, { timeout: 60_000 });
  const counts = await page.evaluate(() => window.replay.count());
  console.log(`dots ${counts.dots} · moves ${counts.moves}`);
  for (const p of points.split(",").map(Number)) {
    await page.evaluate((k) => window.replay.seek(Math.round(k * window.replay.count().moves)), p);
    await page.waitForTimeout(200);
    const file = join(outDir, `replay-${Math.round(p * 100)}.png`);
    await page.screenshot({ path: file });
    console.log(`  ${file}`);
  }
} finally {
  await browser.close();
  server.close();
}
