/**
 * behold#1072: package the built extension as a .vsix and hold it to its size
 * budget.
 *
 *   node scripts/package.mjs [--out <file>] [--no-check]
 *
 * Prints the VSIX size and the largest entries, and fails above BUDGET_BYTES.
 * The budget is set from the first build (see budget.json): 15 percent over
 * what it measured, rounded up to the next 0.5 MB, so a new dependency shows
 * but ordinary growth does not.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const manifest = JSON.parse(readFileSync(join(ext, "package.json"), "utf8"));
const budget = JSON.parse(readFileSync(join(ext, "budget.json"), "utf8"));
const out = resolve(arg("--out") ?? join(ext, `${manifest.name}-${manifest.version}.vsix`));

const vsce = join(ext, "node_modules", ".bin", "vsce");
const r = spawnSync(vsce, ["package", "--no-dependencies", "--allow-missing-repository", "--out", out], { cwd: ext, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const list = spawnSync("unzip", ["-l", out], { encoding: "utf8" });
const rows = (list.stdout ?? "")
  .split("\n")
  .map((l) => l.trim().match(/^(\d+)\s+\S+\s+\S+\s+(.+)$/))
  .filter(Boolean)
  .map((m) => ({ size: Number(m[1]), name: m[2] }))
  .sort((a, b) => b.size - a.size);
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const size = statSync(out).size;
console.log(`vsix: ${out}`);
console.log(`vsix: ${mb(size)} packed, ${mb(rows.reduce((n, x) => n + x.size, 0))} unpacked, ${rows.length} files`);
for (const x of rows.slice(0, 5)) console.log(`  ${mb(x.size).padStart(9)}  ${x.name}`);
console.log(`vsix: budget ${mb(budget.vsixBytes)} (budget.json)`);
if (!process.argv.includes("--no-check") && size > budget.vsixBytes) {
  console.error(`vsix: ${mb(size)} is over the ${mb(budget.vsixBytes)} budget. Raise budget.json in the same change if the growth is wanted.`);
  process.exit(1);
}
