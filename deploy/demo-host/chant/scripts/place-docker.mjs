// Puts chant's docker build (build/docker/) where demo-host.sh and compose
// read it: ../compose.yaml, ../behold.Dockerfile and ../driver.Dockerfile.
// With --check it writes nothing and exits 1 when a committed file is not
// what the build makes.
//
// Two things are added to chant's output here. Each file gets a header naming
// its source. compose.yaml gets `name: demo-host`, the compose project name,
// which the docker lexicon has no field for (demo-host.sh also passes
// --project-name demo-host).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, "..", "build", "docker");
const host = join(here, "..", "..");
const check = process.argv.includes("--check");

const header = (source) =>
  `# Written by chant from deploy/demo-host/chant/${source}: edit that and run\n` +
  `# \`npm run build:docker\` there. \`npm run check:docker\` fails when this file\n` +
  `# is not what the build makes.\n`;

const files = [
  {
    out: "compose.yaml",
    text: header("src/docker/compose.ts") + "name: demo-host\n\n" + readFileSync(join(built, "compose.yaml"), "utf8"),
  },
  {
    out: "behold.Dockerfile",
    text: header("src/docker/images.ts (beholdImage)") + readFileSync(join(built, "Dockerfile.beholdImage"), "utf8"),
  },
  {
    out: "driver.Dockerfile",
    text: header("src/docker/images.ts (driverImage)") + readFileSync(join(built, "Dockerfile.driverImage"), "utf8"),
  },
];

let stale = 0;
for (const { out, text } of files) {
  const path = join(host, out);
  const body = text.endsWith("\n") ? text : `${text}\n`;
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {}
    if (current !== body) {
      console.error(`deploy/demo-host/${out} is not what chant builds; run npm run build:docker in deploy/demo-host/chant`);
      stale++;
    }
  } else {
    writeFileSync(path, body);
    console.log(`wrote deploy/demo-host/${out}`);
  }
}
if (stale > 0) process.exit(1);
if (check) console.log("compose.yaml, behold.Dockerfile and driver.Dockerfile match the chant build");
