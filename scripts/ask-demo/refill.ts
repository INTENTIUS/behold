/**
 * behold#1174: fill the ask demo's replies again from the templates, without
 * booting the emulators.
 *
 *   just ask-demo-refill [file ...]
 *
 * Each question turn's reply in ask-demo/narration.json (or the files given)
 * is rebuilt from its template in ./questions.ts and the turn's recorded
 * columns and rows. Turns match by id. Nothing else in the file changes. The
 * result is checked against ask-demo/narration.schema.json before it is
 * written, and the command fails naming a turn whose template no longer fills.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refillNarration, validateNarration } from "./narration.ts";
import { QUESTIONS } from "./questions.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((a) => resolve(a)) : [join(ROOT, "ask-demo", "narration.json")];
  const schema = JSON.parse(readFileSync(join(ROOT, "ask-demo", "narration.schema.json"), "utf8")) as object;
  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, "utf8")) as Parameters<typeof refillNarration>[0];
    const next = refillNarration(doc, QUESTIONS);
    const problems = validateNarration(next, schema);
    if (problems.length) throw new Error(`${file} does not meet ask-demo/narration.schema.json:\n  ${problems.join("\n  ")}`);
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`refilled ${next.turns.filter((t) => t.kind === "question").length} replies in ${file}`);
  }
}

try {
  main();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
