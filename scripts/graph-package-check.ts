/**
 * behold#1058: install `@intentius/behold-graph` the way a CI job or an
 * editor extension would, and hold it to its budget.
 *
 *   npx tsx scripts/graph-package-check.ts [--keep]
 *
 * Packs packages/graph (built by `npm run build:graph`, which this runs
 * first), installs the tarball into an empty directory under the OS temp
 * directory with npm, then:
 *
 * - prints the installed size (the sum of file sizes under node_modules, so
 *   macOS and Linux agree) and the package count, and fails above
 *   packages/graph/budget.json's `installBytes` or `packages`;
 * - fails when the package's dependencies are not exactly the budget's
 *   `dependencies` allowlist, so a new dependency is a change to that file;
 * - fails when `npm ls --all` in the install names any package on the
 *   budget's `refused` list (the server's HTTP stack, the MCP SDK, the
 *   Kubernetes client);
 * - runs the installed `behold-graph` bin on a bare folder of .tf files
 *   copied from example-terraform-estate and fails unless it prints a
 *   behold-graph/1 document with cards in it.
 *
 * The temp directory is removed afterwards unless `--keep` is given.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Budget {
  installBytes: number;
  packages: number;
  dependencies: string[];
  refused: string[];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "packages", "graph");
const budget = JSON.parse(readFileSync(join(PKG, "budget.json"), "utf8")) as Budget;
const keep = process.argv.includes("--keep");
const failures: string[] = [];
const say = (line: string): void => void process.stdout.write(`${line}\n`);

function sizeOf(dir: string): { bytes: number } {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) bytes += sizeOf(p).bytes;
    else bytes += lstatSync(p).size;
  }
  return { bytes };
}

interface LsNode {
  dependencies?: Record<string, LsNode>;
}
function namesIn(tree: LsNode, into = new Set<string>()): Set<string> {
  for (const [name, child] of Object.entries(tree.dependencies ?? {})) {
    into.add(name);
    namesIn(child, into);
  }
  return into;
}

const mb = (n: number): string => `${(n / 1_000_000).toFixed(1)} MB`;

const work = mkdtempSync(join(tmpdir(), "behold-graph-pkg-"));
try {
  execFileSync("npm", ["run", "build:graph"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: PKG, encoding: "utf8" })) as Array<{ filename: string; size: number; unpackedSize: number }>;
  const tarball = join(work, packed[0]!.filename);
  say(`packed ${packed[0]!.filename}: ${mb(packed[0]!.size)} (${mb(packed[0]!.unpackedSize)} unpacked)`);

  const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const deps = Object.keys(manifest.dependencies ?? {}).sort();
  const allowed = [...budget.dependencies].sort();
  if (deps.join(",") !== allowed.join(",")) failures.push(`dependencies are ${deps.join(", ")}; the allowlist in packages/graph/budget.json is ${allowed.join(", ")}`);

  const install = join(work, "install");
  mkdirSync(install);
  writeFileSync(join(install, "package.json"), `${JSON.stringify({ name: "behold-graph-install-check", private: true }, null, 2)}\n`);
  const started = Date.now();
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error", tarball], { cwd: install, stdio: ["ignore", "ignore", "inherit"] });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const tree = JSON.parse(execFileSync("npm", ["ls", "--all", "--json"], { cwd: install, encoding: "utf8" })) as LsNode;
  const names = namesIn(tree);
  const { bytes } = sizeOf(join(install, "node_modules"));
  say(`installed size: ${mb(bytes)} (${bytes} bytes), ${names.size} packages, in ${seconds} s`);
  say(`budget: ${mb(budget.installBytes)}, ${budget.packages} packages`);
  if (bytes > budget.installBytes) failures.push(`installed size ${bytes} bytes is over the budget of ${budget.installBytes}`);
  if (names.size > budget.packages) failures.push(`${names.size} packages installed, over the budget of ${budget.packages}`);

  const ls = execFileSync("npm", ["ls", "--all"], { cwd: install, encoding: "utf8" });
  const refused = budget.refused.filter((name) => names.has(name) || ls.includes(` ${name}@`));
  say(`npm ls --all names none of ${budget.refused.join(", ")}: ${refused.length ? `no, it names ${refused.join(", ")}` : "yes"}`);
  if (refused.length) failures.push(`the install holds ${refused.join(", ")}`);

  // A bare folder of .tf files: the estate without its workspace declaration.
  const bare = join(work, "bare-estate");
  cpSync(join(ROOT, "example-terraform-estate"), bare, { recursive: true });
  rmSync(join(bare, "chant.workspace.json"));
  const bin = join(install, "node_modules", ".bin", "behold-graph");
  const run = spawnSync(bin, [bare, "--json"], { cwd: work, encoding: "utf8" });
  if (run.status !== 0) {
    failures.push(`behold-graph exited ${run.status}: ${run.stderr.trim()}`);
  } else {
    const doc = JSON.parse(run.stdout) as { schema?: string; nodes?: unknown[] };
    say(`behold-graph ${bare.slice(work.length + 1)} --json: schema ${doc.schema}, ${doc.nodes?.length ?? 0} nodes`);
    if (doc.schema !== "behold-graph/1" || !doc.nodes?.length) failures.push("behold-graph did not print a behold-graph/1 document with cards in it");
    if (run.stdout.includes(work)) failures.push("the document names the temp directory it was read from");
  }
} finally {
  if (keep) say(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  for (const f of failures) process.stderr.write(`graph package check: ${f}\n`);
  process.exit(1);
}
say("graph package check: ok");
