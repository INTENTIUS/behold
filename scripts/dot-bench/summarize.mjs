#!/usr/bin/env node
// Condense a run.mjs --out file into the tables docs/design/dot-estates.md
// carries (#457): per renderer and size, the scenario that cost the most.
//
//   node scripts/dot-bench/summarize.mjs results.json
//
// "Frame" is rAF to rAF. Headless it is unpaced, so it measures the work a
// frame costs; headed it is paced to the display, so a number over the refresh
// interval is a frame the screen missed. "Dropped" counts frames over 1.5x the
// page's measured refresh interval.

import { readFileSync } from "node:fs";

const file = process.argv[2];
const data = JSON.parse(readFileSync(file, "utf8"));
const rs = data.results.filter((r) => !r.error);
const sizes = [...new Set(rs.map((r) => r.n))].sort((a, b) => a - b);
const renderers = [...new Set(rs.map((r) => r.renderer))];
const f = (x, d = 1) => Number(x).toFixed(d);

const worst = (renderer, n) => {
  const runs = rs.filter((r) => r.renderer === renderer && r.n === n);
  if (!runs.length) return null;
  return runs.reduce((a, b) => (b.interval.p95 > a.interval.p95 ? b : a));
};

console.log(`${data.headed ? "headed" : "headless"}${data.throttle > 1 ? `, CPU ${data.throttle}x slower` : ""} · ${data.width}x${data.height} at dpr ${data.scale} · refresh ${f(rs[0].refresh)} ms · ${rs[0].glRenderer}\n`);
console.log(`| renderer | ${sizes.map((n) => `${n} p50 / p95 ms`).join(" | ")} | dropped at ${sizes.join(" / ")} |`);
console.log(`|---|${sizes.map(() => "---").join("|")}|---|`);
for (const r of renderers) {
  const cells = sizes.map((n) => { const w = worst(r, n); return w ? `${f(w.interval.p50)} / ${f(w.interval.p95)}` : "-"; });
  const dropped = sizes.map((n) => { const runs = rs.filter((x) => x.renderer === r && x.n === n); return runs.length ? Math.max(...runs.map((x) => x.dropped)) : "-"; });
  console.log(`| ${r} | ${cells.join(" | ")} | ${dropped.join(" / ")} |`);
}
console.log(`\nWorst scenario per cell, of ${[...new Set(rs.map((r) => r.scenario))].join(", ")}; ${rs[0].frames} frames each.`);
const create = renderers.map((r) => { const x = rs.find((y) => y.renderer === r && y.n === 1000); return x ? `${r} ${f(x.create, 0)}` : null; }).filter(Boolean);
const hit = renderers.map((r) => { const x = rs.filter((y) => y.renderer === r && y.n === sizes[sizes.length - 1]); return x.length ? `${r} ${f(Math.max(...x.map((y) => y.hitMs * 1000)), 1)}` : null; }).filter(Boolean);
console.log(`First paint at 1000, ms: ${create.join(" · ")}`);
console.log(`Hit test at ${sizes[sizes.length - 1]}, µs per query: ${hit.join(" · ")}`);
const found = [...new Set(rs.map((r) => r.hitFound))].sort();
console.log(`Queries that returned the sampled dot: ${f(Math.min(...found), 3)} to ${f(Math.max(...found), 3)}`);
