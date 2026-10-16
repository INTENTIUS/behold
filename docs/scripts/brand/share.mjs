// behold#571: the share image link previews show (LinkedIn, Slack, X), for
// the public demo's pages and the docs site. 1200x630, LinkedIn's size.
//
// The logo is logo.py's grid, drawn as pixel SVG at a whole-number scale with
// crispEdges, so each art pixel lands on 14x14 image pixels with no smoothing.
// Under it the wordmark in Geist tracked caps, as the site's footer writes it,
// and one line. The colours are Sea Shells, the kiosk's default theme
// (web/themes.js).
//
// Run from the repo root (it needs the root's playwright):
//
//     node docs/scripts/brand/share.mjs
//
// It writes docs/public/brand/share.png (the site's og:image) and
// web/share.png (the demo's, served at /share.png). Commit both.
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const out = join(repo, "docs", "public", "brand", "share.png");
const copy = join(repo, "web", "share.png");

const W = 1200;
const H = 630;
const SCALE = 14;
// Sea Shells (web/themes.js): background, foreground, cursor amber, and the
// palette's pale blue for the line.
const BG = "#09141b";
const FG = "#deb88d";
const AMBER = "#fca02f";
const LINE = "#bbe3ee";
const TEXT = "A live infrastructure loop you can watch";

// logo.py's SVG for the logo in FG; its viewBox has one art pixel of air
// around the 26x17 grid, so it is 28x19 art pixels.
const svg = execFileSync("python3", [join(here, "logo.py"), FG, "/dev/stdout"], {
  encoding: "utf8",
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
})
  .trim()
  .replace(/ width="\d+" height="\d+"/, ` width="${28 * SCALE}" height="${19 * SCALE}"`);

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@500;600&display=block">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; background: ${BG}; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: 'Geist', sans-serif; }
  svg { display: block; }
  .word { margin-top: 30px; padding-left: 0.32em; font-size: 76px; font-weight: 600; letter-spacing: 0.32em; color: ${FG}; line-height: 1; }
  .rule { width: 64px; height: 4px; margin: 34px 0 30px; background: ${AMBER}; }
  .line { font-size: 38px; font-weight: 500; color: ${LINE}; line-height: 1; }
</style></head><body>
${svg}
<div class="word">BEHOLD</div>
<div class="rule"></div>
<div class="line">${TEXT}</div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const geist = await page.evaluate(() => document.fonts.check("600 76px Geist"));
  if (!geist) throw new Error("Geist did not load from Google Fonts; the wordmark would fall back to another face");
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: W, height: H } });
} finally {
  await browser.close();
}
copyFileSync(out, copy);
process.stdout.write(`wrote ${out} and ${copy}\n`);
