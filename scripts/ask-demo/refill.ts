/**
 * behold#1174: fill the ask demo's replies again from the templates, without
 * booting the emulators.
 *
 *   just ask-demo-refill [file ...]
 *
 * Each question turn's prompt, reading line and reply in
 * ask-demo/narration.json (or the files given), and the load turn's reply
 * (behold#1191) and busy line (behold#1206), are rebuilt from ./questions.ts and the turn's recorded
 * columns and rows. Turns match by id; a turn whose question is gone from
 * questions.ts is dropped, and the command says so. Nothing else in the file changes. The
 * result is checked against ask-demo/narration.schema.json before it is
 * written, and the command fails naming a turn whose template no longer fills.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refillNarration, validateNarration } from "./narration.ts";
import { LOAD, QUESTIONS } from "./questions.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((a) => resolve(a)) : [join(ROOT, "ask-demo", "narration.json")];
  const schema = JSON.parse(readFileSync(join(ROOT, "ask-demo", "narration.schema.json"), "utf8")) as object;
  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, "utf8")) as Parameters<typeof refillNarration>[0];
    const { doc: next, dropped } = refillNarration(doc, QUESTIONS, LOAD);
    const problems = validateNarration(next, schema);
    if (problems.length) throw new Error(`${file} does not meet ask-demo/narration.schema.json:\n  ${problems.join("\n  ")}`);
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    for (const id of dropped) console.log(`dropped turn ${id}: it is no longer in scripts/ask-demo/questions.ts`);
    console.log(`refilled ${next.turns.filter((t) => t.kind === "question" || t.kind === "load").length} replies in ${file}`);
  }
}

try {
  main();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
