/**
 * behold#1072: copy the part of chant that reads a Terraform folder into
 * dist/node_modules, beside dist/extension.js (where behold's reader looks for
 * `@intentius/chant-lexicon-terraform` and `@cdktn/hcl2json`, and where a dev
 * checkout would otherwise find the repository's own copies by walking up
 * and hide a missing one), so the extension carries it and needs no `node`, no `npx` and
 * no network on the machine it runs on.
 *
 *   node scripts/stage-chant.mjs [--from <dir holding node_modules>] [--out <dir>]
 *
 * The set is `@intentius/chant`, `@intentius/chant-lexicon-terraform` and the
 * runtime dependencies of both, found by resolving each package's
 * `dependencies` the way Node would. Left out: the TypeScript toolchain
 * (typescript, tsx, esbuild and its platform binaries), which chant loads only
 * to evaluate TypeScript source a Terraform folder does not have, and every
 * package's source, type declarations and source maps, which a run never opens.
 * The extension runs the staged `@intentius/chant/dist/cli/main.js` itself
 * (BEHOLD_CHANT_BIN, src/chant.ts), as Node, through the host's own binary.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? resolve(process.argv[i + 1]) : fallback;
};
const FROM = arg("--from", resolve(here, "..", "..", ".."));
const OUT = arg("--out", resolve(here, "..", "dist"));
// zod is the lexicon's peer dependency; hcl2json is a chant development
// dependency that the Terraform read imports at run time. typescript comes in
// as chant's own dependency, the copy nested under it.
const ROOTS = ["@intentius/chant", "@intentius/chant-lexicon-terraform", "zod", "@cdktn/hcl2json"];
// typescript is staged as its parser alone: chant parses source with it and
// opens no program, so the compiler's lib declarations and tools stay out.
const ONLY = { typescript: new Set(["package.json", "LICENSE.txt", "lib/typescript.js"]) };
const LEFT_OUT = new Set(["tsx", "esbuild", "@types/node"]);
const SKIP_DIR = new Set(["src", "test", "tests", "__tests__", ".github", "docs"]);
const SKIP_FILE = /\.(d\.ts|d\.mts|d\.cts|map|md|ts|tsx)$/i; // a .ts file in a package is source or a declaration; dist holds the .js
const KEEP_FILE = /(^|\/)(LICENSE|package\.json)$/i;

/** The package directory `name` resolves to from `fromDir`, found by walking node_modules upward (the exports map hides package.json from require.resolve). */
function locate(name, fromDir) {
  for (let d = fromDir; ; d = dirname(d)) {
    const candidate = join(d, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(d) === d) return undefined;
  }
}

const staged = new Map(); // source dir -> destination dir
const missing = [];
function stage(name, fromDir, destRoot) {
  if (LEFT_OUT.has(name) || name.startsWith("@esbuild/")) return;
  const src = locate(name, fromDir);
  if (!src) return void missing.push(`${name} (from ${relative(FROM, fromDir)})`);
  const dest = join(destRoot, "node_modules", name);
  if (staged.has(src)) return;
  staged.set(src, dest);
  const manifest = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  for (const dep of Object.keys(manifest.dependencies ?? {})) stage(dep, src, destRoot);
}
for (const name of ROOTS) stage(name, FROM, OUT);

const name = (src) => src.split("/node_modules/").pop();
let files = 0;
let bytes = 0;
const count = (path) => {
  files++;
  bytes += statSync(path).size;
  return true;
};
for (const [src, dest] of staged) {
  cpSync(src, dest, {
    recursive: true,
    filter: (path) => {
      if (path === src) return true;
      const rel = relative(src, path);
      const parts = rel.split("/");
      const only = ONLY[name(src)];
      if (only) return statSync(path).isDirectory() ? [...only].some((f) => f.startsWith(`${rel}/`)) : only.has(rel) && count(path);
      if (parts.includes("node_modules")) return false; // a nested copy is staged on its own when it is a dependency
      if (statSync(path).isDirectory()) return !(parts.length === 1 && SKIP_DIR.has(parts[0]));
      if (KEEP_FILE.test(rel)) return count(path);
      if (SKIP_FILE.test(rel)) return false;
      return count(path);
    },
  });
}
mkdirSync(OUT, { recursive: true });
console.log(`stage-chant: ${staged.size} packages, ${files} files, ${(bytes / 1048576).toFixed(1)} MB into ${OUT}`);
if (missing.length) console.log(`stage-chant: not found (optional or peer): ${missing.join(", ")}`);
