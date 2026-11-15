// Copies the browser-safe modules the plugin runs from behold into
// src/behold/, so the folder builds on its own and can move to its own
// repository. The cut, the graph document type and the Mermaid writer are
// the ones behold's own `behold graph --around` runs, so the tab and the CLI
// cut a graph the same way.
//
// Two imports are rewritten on the way in: `../web/cut-around.js` becomes
// `./cut-around.js`, and a `.ts` extension on a relative import is dropped
// (Backstage's tsconfig does not allow it).
//
// `node scripts/sync-behold.mjs --check` fails when a copy has drifted; the
// test in src/sync.test.ts runs it while the folder lives in behold.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const target = join(here, "..", "src", "behold");

/** [path in behold, name of the copy] */
export const FILES = [
  ["web/cut-around.js", "cut-around.js"],
  ["web/cut-around.d.ts", "cut-around.d.ts"],
  ["src/graph-cut.ts", "graph-cut.ts"],
  ["src/graph-document.ts", "graph-document.ts"],
  ["src/graph-mermaid.ts", "graph-mermaid.ts"],
  ["src/mermaid-budgets.ts", "mermaid-budgets.ts"],
];

export function rewrite(text) {
  return text
    .replace(/(["'])\.\.\/web\/cut-around\.js\1/g, '"./cut-around.js"')
    .replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1$2");
}

export function drift() {
  const out = [];
  for (const [from, name] of FILES) {
    const src = join(root, from);
    if (!existsSync(src)) return []; // the folder has left behold; nothing to compare
    const to = join(target, name);
    if (!existsSync(to) || readFileSync(to, "utf8") !== rewrite(readFileSync(src, "utf8"))) out.push(name);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const d = drift();
    if (d.length) {
      console.error(`src/behold is out of date with behold: ${d.join(", ")}. Run node scripts/sync-behold.mjs`);
      process.exit(1);
    }
  } else {
    for (const [from, name] of FILES) writeFileSync(join(target, name), rewrite(readFileSync(join(root, from), "utf8")));
    console.log(`copied ${FILES.map((f) => f[1]).join(", ")}`);
  }
}
