// Copies the three browser-safe modules the plugin runs from behold's web/
// into src/behold/, so the folder builds on its own and can move to its own
// repository. `node scripts/sync-behold.mjs --check` fails when a copy has
// drifted from the source (it runs as a test while the folder lives in behold).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "..", "web");
const target = join(here, "..", "src", "behold");
const FILES = ["cut-around.js", "neighbourhood.js", "outside-refs.js"];

export function drift() {
  const out = [];
  for (const f of FILES) {
    const from = join(source, f);
    const to = join(target, f);
    if (!existsSync(from)) return out; // the folder has left behold; nothing to compare
    if (!existsSync(to) || readFileSync(from, "utf8") !== readFileSync(to, "utf8")) out.push(f);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const d = drift();
    if (d.length) {
      console.error(`src/behold is out of date with web/: ${d.join(", ")}. Run node scripts/sync-behold.mjs`);
      process.exit(1);
    }
  } else {
    for (const f of FILES) writeFileSync(join(target, f), readFileSync(join(source, f)));
    console.log(`copied ${FILES.join(", ")}`);
  }
}
