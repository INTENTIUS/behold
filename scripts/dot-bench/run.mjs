#!/usr/bin/env node
// Drive scripts/dot-bench/bench.html in Chromium over every renderer, size and
// scenario, and print one row per run (#457).
//
//   node scripts/dot-bench/run.mjs                       # the full matrix, headless
//   node scripts/dot-bench/run.mjs --headed              # a real window (real GPU compositing)
//   node scripts/dot-bench/run.mjs --sizes 1000 --renderers canvas2d,webgl-raw --scenarios travel
//   node scripts/dot-bench/run.mjs --throttle 4          # CPU slowed 4x, a slower laptop
//   node scripts/dot-bench/run.mjs --out results.json    # also write the raw results
//
// regl and PixiJS are installed at the pinned versions below into a temporary
// prefix on first run, never into behold's own node_modules: behold ships no
// renderer, and whichever one it picks is a decision the design note makes,
// not this script. Playwright is behold's own dev dependency.

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const PINS = { regl: "2.1.1", "pixi.js": "8.21.0" };
const LIB_FILES = { "regl.min.js": ["regl", "dist/regl.min.js"], "pixi.min.js": ["pixi.js", "dist/pixi.min.js"] };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);

const sizes = list(arg("sizes", "300,1000,5000,10000")).map(Number);
const renderers = list(arg("renderers", "svg-replace,svg-mutate,canvas2d,webgl-raw,regl,pixi"));
const scenarios = list(arg("scenarios", "recolour,travel,orbit"));
const frames = Number(arg("frames", 240));
const headed = arg("headed", false) === true;
const out = arg("out", null);
const width = Number(arg("width", 1600));
const height = Number(arg("height", 1000));
const scale = Number(arg("scale", 2));
// The installed Google Chrome by default: it is what a person opens behold in,
// and Playwright's bundled Chromium may not be downloaded. `--channel chromium`
// uses the bundled one instead.
const channel = arg("channel", "chrome");
// CPU slowdown through the DevTools protocol (Emulation.setCPUThrottlingRate):
// 4 stands in for a laptop a few years older than the one measuring. It slows
// script, style, layout and paint on the main thread; it does not slow the GPU.
const throttle = Number(arg("throttle", 1));

function ensureLibs() {
  const prefix = join(tmpdir(), `behold-dot-bench-${PINS.regl}-${PINS["pixi.js"]}`);
  const lib = join(prefix, "lib");
  if (!Object.keys(LIB_FILES).every((f) => existsSync(join(lib, f)))) {
    console.error(`  installing regl@${PINS.regl} pixi.js@${PINS["pixi.js"]} into ${prefix}`);
    mkdirSync(prefix, { recursive: true });
    execFileSync("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--no-package-lock",
      ...Object.entries(PINS).map(([p, v]) => `${p}@${v}`)], { stdio: ["ignore", "ignore", "inherit"] });
    mkdirSync(lib, { recursive: true });
    for (const [file, [pkg, path]] of Object.entries(LIB_FILES)) copyFileSync(join(prefix, "node_modules", pkg, path), join(lib, file));
  }
  return lib;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
function serve(lib) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const file = path.startsWith("/lib/") ? join(lib, path.slice(5)) : join(HERE, path === "/" ? "bench.html" : path.slice(1));
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    // Cross-origin isolated, so performance.now() is not coarsened to 100µs:
    // the fast renderers' frames are well under a tenth of a millisecond.
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const fmt = (x, d = 1) => (x === undefined || x === null ? "-" : Number(x).toFixed(d));

async function main() {
  const lib = ensureLibs();
  const server = await serve(lib);
  const base = `http://127.0.0.1:${server.address().port}/bench.html`;
  const browser = await chromium.launch({ headless: !headed, ...(channel === "chromium" ? {} : { channel }), args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal", "--disable-frame-rate-limit=false"] });
  const results = [];
  console.log("| renderer | n | scenario | create ms | js p50 | js p95 | frame p50 | frame p95 | fps | dropped | hit µs |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  try {
    for (const n of sizes) {
      for (const scenario of scenarios) {
        for (const renderer of renderers) {
          const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
          if (throttle > 1) {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
          }
          await page.goto(`${base}?renderer=${renderer}&n=${n}&scenario=${scenario}&frames=${frames}`);
          await page.waitForFunction(() => window.benchResult, null, { timeout: 600_000, polling: 250 });
          const r = await page.evaluate(() => window.benchResult);
          await page.close();
          results.push(r);
          if (r.error) { console.log(`| ${renderer} | ${n} | ${scenario} | error: ${r.error.split("\n")[0]} |`); continue; }
          console.log(`| ${renderer} | ${n} | ${scenario} | ${fmt(r.create, 0)} | ${fmt(r.js.p50, 2)} | ${fmt(r.js.p95, 2)} | ${fmt(r.interval.p50)} | ${fmt(r.interval.p95)} | ${fmt(r.fps, 0)} | ${r.dropped}/${r.frames} | ${fmt(r.hitMs * 1000, 1)} |`);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  const first = results.find((r) => !r.error);
  if (first) console.error(`\n  chromium ${browser.version?.() ?? ""} · ${first.w}x${first.h} CSS px at dpr ${first.dpr} · refresh ${fmt(first.refresh)} ms · GL: ${first.glRenderer} · ${headed ? "headed" : "headless"}${throttle > 1 ? ` · CPU throttled ${throttle}x` : ""}`);
  if (out) writeFileSync(out, JSON.stringify({ headed, throttle, width, height, scale, frames, results }, null, 2) + "\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
