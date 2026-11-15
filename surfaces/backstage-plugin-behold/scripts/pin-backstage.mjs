// Pins every @backstage/* dependency in package.json to what one Backstage
// release shipped, so CI can install the plugin against that release:
//   node scripts/pin-backstage.mjs 1.54.9
// The versions come from the release manifest at versions.backstage.io.
// This rewrites package.json in place; run it on a throwaway checkout.
import { readFileSync, writeFileSync } from "node:fs";

const release = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(release ?? "")) {
  console.error("usage: pin-backstage.mjs <backstage release, for example 1.54.9>");
  process.exit(2);
}
const res = await fetch(`https://versions.backstage.io/v1/releases/${release}/manifest.json`);
if (!res.ok) {
  console.error(`no manifest for Backstage ${release}: HTTP ${res.status}`);
  process.exit(1);
}
const manifest = new Map((await res.json()).packages.map((p) => [p.name, p.version]));

const file = new URL("../package.json", import.meta.url);
const pkg = JSON.parse(readFileSync(file, "utf8"));
for (const section of ["dependencies", "devDependencies"]) {
  for (const name of Object.keys(pkg[section] ?? {})) {
    if (!name.startsWith("@backstage/")) continue;
    const v = manifest.get(name);
    if (!v) {
      console.error(`${name} is not in the Backstage ${release} manifest`);
      process.exit(1);
    }
    pkg[section][name] = v;
    console.log(`${name} ${v}`);
  }
}
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
