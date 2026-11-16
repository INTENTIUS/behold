#!/usr/bin/env node
/**
 * Checks the layout that lets the GitHub Marketplace list the action from this
 * repository (INTENTIUS/behold#1063):
 *
 *   node scripts/action-tree.mjs
 *
 * The repository holds exactly one action metadata file, the root `action.yml`.
 * The code its steps run is under `action/`. The check fails when there is a
 * second metadata file, when a path the action runs is missing, when the
 * name, description or branding would be refused, or when the action uses a
 * local path (`uses: ./`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const COLORS = ["white", "black", "yellow", "blue", "green", "orange", "red", "purple", "gray-dark"];
/** Feather icons GitHub leaves out (metadata syntax page, "branding"). */
const EXCLUDED_ICONS = ["coffee", "columns", "divide-circle", "divide-square", "divide", "frown", "hexagon", "key", "meh", "mouse-pointer", "smile", "tool", "x-octagon"];
const SKIP = new Set(["node_modules", ".git", "dist"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Everything the layout must satisfy; returns a list of problems. */
export function checkLayout(root = ROOT) {
  const problems = [];
  const files = walk(root).map((p) => relative(root, p));
  const has = (f) => existsSync(join(root, f));

  const metadata = files.filter((f) => /(^|\/)action\.ya?ml$/.test(f));
  if (metadata.join() !== "action.yml") problems.push(`the repository must hold one action metadata file, the root action.yml; found: ${metadata.join(", ") || "none"}`);
  if (!has("action.yml")) return problems;

  const yml = readFileSync(join(root, "action.yml"), "utf8");

  // Paths the action runs must exist.
  for (const m of yml.matchAll(/\$GITHUB_ACTION_PATH\/([\w./-]+)/g)) if (!has(m[1])) problems.push(`action.yml runs ${m[1]}, which does not exist`);
  if (/uses:\s*\.\.?\//.test(yml)) problems.push("action.yml uses a local path (uses: ./...)");
  for (const f of files.filter((f) => f.startsWith("action/src/") && f.endsWith(".mjs"))) {
    const src = readFileSync(join(root, f), "utf8");
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']*)["']/g)) {
      const target = relative(root, resolve(root, dirname(f), m[1]));
      if (!has(target)) problems.push(`${f} imports ${m[1]}, which does not exist`);
    }
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

  // action/README.md: the listing copy verbatim, and every input and output named.
  const readme = readFileSync(join(root, "action", "README.md"), "utf8");
  const listing = JSON.parse(readFileSync(join(root, "plugins", "listing.json"), "utf8"));
  for (const key of ["short", "paragraph", "command"]) if (!readme.includes(listing[key])) problems.push(`action/README.md does not hold plugins/listing.json "${key}" verbatim`);
  for (const [section, re] of [["inputs", /^inputs:\n([\s\S]*?)^outputs:/m], ["outputs", /^outputs:\n([\s\S]*?)^runs:/m]]) {
    const block = re.exec(yml)?.[1] ?? "";
    for (const m of block.matchAll(/^  ([\w-]+):/gm)) if (!readme.includes("`" + m[1] + "`")) problems.push(`action/README.md does not name the ${section.slice(0, -1)} ${m[1]}`);
  }
  for (const heading of ["## What it reads", "## Minimal workflow", "## Inputs", "## Outputs"]) if (!readme.includes(heading)) problems.push(`action/README.md has no "${heading}" section`);

  // The entry point loads every module of action/src (an unknown phase is
  // refused after the imports resolve).
  const run = spawnSync(process.execPath, [join(root, "action", "src", "main.mjs"), "nonesuch"], { cwd: tmpdir(), encoding: "utf8" });
  if (run.status !== 1 || !/unknown phase nonesuch/.test(run.stderr)) problems.push(`action/src/main.mjs does not start: ${(run.stderr || run.stdout).slice(0, 300)}`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkLayout();
  if (problems.length) {
    for (const p of problems) process.stderr.write(`action layout: ${p}\n`);
    process.exit(1);
  }
  process.stdout.write("action layout: one action.yml at the root, every path it runs exists\n");
}
