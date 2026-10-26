// behold#1005: write the files that follow CHANT_RELEASE (src/chant-release.ts).
//
//   npx tsx scripts/chant-release.ts           write every file that disagrees with the switch
//   npx tsx scripts/chant-release.ts --check   list them and exit 1, writing nothing
//
// The files and what each holds are in src/chant-release-sync.ts. After a
// write that touched a package.json, run `npm install` (here, and in
// example-three-cloud when its package.json moved) so the lockfiles follow.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANT_RELEASE } from "../src/chant-release.ts";
import { chantReleaseFiles, writeChantRelease } from "../src/chant-release-sync.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = `chant ${CHANT_RELEASE.version}, ${CHANT_RELEASE.released ? "released" : "not released (local build)"}`;

if (process.argv.includes("--check")) {
  const off = chantReleaseFiles(repo).filter((f) => f.differs);
  for (const f of off) process.stdout.write(`${f.file} does not follow CHANT_RELEASE (${mode})\n`);
  if (off.length) {
    process.stdout.write("run: npx tsx scripts/chant-release.ts\n");
    process.exit(1);
  }
  process.stdout.write(`every file follows CHANT_RELEASE (${mode})\n`);
} else {
  const written = writeChantRelease(repo);
  for (const f of written) process.stdout.write(`wrote ${f}\n`);
  process.stdout.write(`${written.length ? "" : "nothing to write: "}every file follows CHANT_RELEASE (${mode})\n`);
  if (written.some((f) => f.endsWith("package.json"))) process.stdout.write("now run npm install where a package.json moved\n");
}
