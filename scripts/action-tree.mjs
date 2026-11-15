#!/usr/bin/env node
/**
 * Builds the tree that the `behold-action` repository holds (INTENTIUS/behold#1063)
 * from this repository's `action/` folder, or checks that it can be built.
 *
 *   node scripts/action-tree.mjs <dir>     write the tree into <dir> (absent or empty)
 *   node scripts/action-tree.mjs --check   build in a temporary directory and verify it
 *
 * The tree is `action.yml`, `README.md`, `LICENSE`, `src/`, `gitlab/` and `forgejo/`.
 * `action/test/` stays in behold (it imports behold's source) and so does
 * `action/MAINTAINERS.md`. A short list of path rewrites turns the layout
 * `<repo>/action/...` into `<repo>/...`; each must match exactly as often as it
 * says, so a change in the source that the rewrite no longer covers fails here.
 *
 * The check fails when the tree is incomplete, when anything in it reaches a file
 * outside it, or when the Marketplace's stated requirements are not met.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "action");

/** Entries of action/ that belong in the tree, and the ones that stay in behold. */
const COPIED = ["action.yml", "README.md", "src", "gitlab", "forgejo"];
const STAYS = ["test", "MAINTAINERS.md"];

const REWRITES = [
  { file: "gitlab/behold.gitlab-ci.yml", from: "/INTENTIUS/behold/<sha>/action/gitlab/", to: "/INTENTIUS/behold-action/<sha>/gitlab/", count: 1 },
  { file: "gitlab/behold.gitlab-ci.yml", from: "https://github.com/INTENTIUS/behold.git", to: "https://github.com/INTENTIUS/behold-action.git", count: 1 },
  { file: "gitlab/behold.gitlab-ci.yml", from: "/tmp/behold-action/action/src/main.mjs", to: "/tmp/behold-action/src/main.mjs", count: 2 },
  { file: "gitlab/behold.gitlab-ci.yml", from: 'all in action/README.md under "GitLab"', to: 'all in README.md under "GitLab"', count: 1 },
  { file: "README.md", from: "/INTENTIUS/behold/<sha>/action/gitlab/", to: "/INTENTIUS/behold-action/<sha>/gitlab/", count: 1 },
];

const COLORS = ["white", "black", "yellow", "blue", "green", "orange", "red", "purple", "gray-dark"];
/** Feather icons GitHub leaves out (metadata syntax page, "branding"). */
const EXCLUDED_ICONS = ["coffee", "columns", "divide-circle", "divide-square", "divide", "frown", "hexagon", "key", "meh", "mouse-pointer", "smile", "tool", "x-octagon"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function buildTree(outDir) {
  const problems = [];
  const top = readdirSync(SRC);
  for (const name of top) if (![...COPIED, ...STAYS].includes(name)) problems.push(`action/${name} is neither copied nor listed as staying in behold; add it to COPIED or STAYS in scripts/action-tree.mjs`);
  for (const name of [...COPIED, ...STAYS]) if (!top.includes(name)) problems.push(`action/${name} is missing`);
  if (existsSync(outDir) && readdirSync(outDir).length) problems.push(`${outDir} is not empty`);
  if (problems.length) return problems;
  mkdirSync(outDir, { recursive: true });
  for (const name of COPIED) cpSync(join(SRC, name), join(outDir, name), { recursive: true });
  cpSync(join(ROOT, "LICENSE"), join(outDir, "LICENSE"));
  for (const r of REWRITES) {
    const p = join(outDir, r.file);
    const text = readFileSync(p, "utf8");
    const n = text.split(r.from).length - 1;
    if (n !== r.count) problems.push(`rewrite in ${r.file}: expected ${r.count} of ${JSON.stringify(r.from)}, found ${n}`);
    else writeFileSync(p, text.split(r.from).join(r.to));
  }
  return problems;
}

/** Everything the tree must satisfy; returns a list of problems. */
export function checkTree(dir) {
  const problems = [];
  const files = walk(dir).map((p) => relative(dir, p));
  const has = (f) => files.includes(f);
  const text = (f) => readFileSync(join(dir, f), "utf8");

  // One metadata file, at the root, and nothing else the action does not need.
  const metadata = files.filter((f) => /(^|\/)action\.ya?ml$/.test(f));
  if (metadata.join() !== "action.yml") problems.push(`the tree must hold one action.yml at its root, found: ${metadata.join(", ") || "none"}`);
  for (const f of files) {
    const first = f.split("/")[0];
    if (!["action.yml", "README.md", "LICENSE", "src", "gitlab", "forgejo"].includes(first)) problems.push(`unexpected file in the tree: ${f}`);
  }
  if (files.some((f) => f.startsWith("test/") || f === "MAINTAINERS.md")) problems.push("test/ and MAINTAINERS.md stay in behold");
  if (problems.length || !has("action.yml")) return problems;

  // Files action.yml and the other files name, which must all be in the tree.
  const yml = text("action.yml");
  for (const m of yml.matchAll(/\$GITHUB_ACTION_PATH\/([\w./-]+)/g)) if (!has(m[1])) problems.push(`action.yml runs ${m[1]}, which is not in the tree`);
  if (/uses:\s*\.\.?\//.test(yml)) problems.push("action.yml uses a local path (uses: ./...)");
  for (const f of files.filter((f) => f.endsWith(".mjs"))) {
    const src = text(f);
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']*)["']/g)) {
      const target = relative(dir, resolve(dir, dirname(f), m[1]));
      if (target.startsWith("..")) problems.push(`${f} imports ${m[1]}, outside the tree`);
      else if (!has(target)) problems.push(`${f} imports ${m[1]}, which is not in the tree`);
    }
  }
  // No remaining reference to the behold repository's layout or sources.
  for (const f of files.filter((f) => f !== "LICENSE")) {
    const t = text(f);
    for (const m of t.matchAll(/(?<![\w-])(action\/(?:src|gitlab|forgejo|test|README|MAINTAINERS|action\.yml)\S*|(?:\.\.\/)+src\/\S*|e2e\/\S*|scripts\/\S*|packages\/\S*)/g)) problems.push(`${f} names ${m[1]}, a path outside the tree`);
  }

  // Marketplace requirements (GitHub's publishing and metadata pages).
  const name = /^name:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  if (!name) problems.push("action.yml has no name");
  if (!/^description:\s*\S/m.test(yml)) problems.push("action.yml has no description");
  const icon = /^\s+icon:\s*(\S+)/m.exec(yml)?.[1];
  const color = /^\s+color:\s*(\S+)/m.exec(yml)?.[1];
  if (!icon) problems.push("action.yml has no branding icon");
  else if (!/^[a-z0-9-]+$/.test(icon) || EXCLUDED_ICONS.includes(icon)) problems.push(`branding icon ${icon} is not a usable Feather icon`);
  if (!COLORS.includes(color)) problems.push(`branding color ${color} is not one of ${COLORS.join(", ")}`);
  if (!/^runs:\s*\n\s+using:\s*composite/m.test(yml)) problems.push("action.yml is expected to be a composite action");

  // README: the listing copy verbatim, and every input and output named.
  const readme = text("README.md");
  const listing = JSON.parse(readFileSync(join(ROOT, "plugins", "listing.json"), "utf8"));
  for (const key of ["short", "paragraph", "command"]) if (!readme.includes(listing[key])) problems.push(`README.md does not hold plugins/listing.json "${key}" verbatim`);
  for (const [section, re] of [["inputs", /^inputs:\n([\s\S]*?)^outputs:/m], ["outputs", /^outputs:\n([\s\S]*?)^runs:/m]]) {
    const block = re.exec(yml)?.[1] ?? "";
    for (const m of block.matchAll(/^  ([\w-]+):/gm)) if (!readme.includes("`" + m[1] + "`")) problems.push(`README.md does not name the ${section.slice(0, -1)} ${m[1]}`);
  }
  for (const heading of ["## What it reads", "## Minimal workflow", "## Inputs", "## Outputs"]) if (!readme.includes(heading)) problems.push(`README.md has no "${heading}" section`);

  // The tree runs by itself: the entry point loads every module of src/ with
  // nothing else beside it (an unknown phase is refused after the imports resolve).
  const run = spawnSync(process.execPath, [join(dir, "src", "main.mjs"), "nonesuch"], { cwd: tmpdir(), encoding: "utf8" });
  if (run.status !== 1 || !/unknown phase nonesuch/.test(run.stderr)) problems.push(`src/main.mjs does not start from the tree alone: ${(run.stderr || run.stdout).slice(0, 300)}`);
  return problems;
}

const arg = process.argv[2];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!arg) {
    process.stderr.write("usage: action-tree.mjs <dir> | --check\n");
    process.exit(2);
  }
  const dir = arg === "--check" ? join(mkdtempSync(join(tmpdir(), "behold-action-tree-")), "tree") : resolve(arg);
  const problems = buildTree(dir);
  if (!problems.length) problems.push(...checkTree(dir));
  if (problems.length) {
    for (const p of problems) process.stderr.write(`action tree: ${p}\n`);
    process.exit(1);
  }
  const n = walk(dir).length;
  process.stdout.write(`action tree: ${n} files${arg === "--check" ? ", complete and self-contained" : ` written to ${dir}`}\n`);
}
