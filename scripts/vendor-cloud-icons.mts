#!/usr/bin/env -S npx tsx
/**
 * vendor-cloud-icons.mts — copy the AWS, Azure and Google Cloud architecture
 * icons a card can use (#872) out of the vendors' own icon packs.
 *
 * The packs are downloaded by hand from the vendors' pages (THIRD_PARTY.md
 * names each one and its release) and unpacked anywhere; this script takes the
 * three directories, finds each file `src/cloud-icons.ts` names by its file
 * name, and writes it to `web/icons/<vendor>/<slug>.svg` through the same
 * sanitizer the CNCF and Kubernetes icons go through (ids and classes
 * namespaced, editor state and anything executable dropped, geometry
 * untouched). Only the icons a kind can reach are copied, never the packs.
 *
 *   npx tsx scripts/vendor-cloud-icons.mts --aws <dir> --azure <dir> --gcp <dir>
 *   ... --check    # compare, write nothing (exit 1 on drift)
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_SOURCES, referencedIcons } from "../src/cloud-icons.ts";
// @ts-expect-error: a plain .mjs script with no types
import { sanitizeSvg } from "./vendor-icons.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under `dir`, by name (the first one found wins; packs repeat a few across categories). */
async function index(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === "__MACOSX") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".svg") && !out.has(e.name)) out.set(e.name, p);
    }
  };
  await walk(dir);
  return out;
}

async function main(): Promise<void> {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0 || !process.argv[i + 1]) throw new Error(`--${name} <unpacked pack directory> is required`);
    return process.argv[i + 1];
  };
  const check = process.argv.includes("--check");
  const packs = { aws: await index(arg("aws")), azure: await index(arg("azure")), gcp: await index(arg("gcp")) };
  const missing: string[] = [];
  const drift: string[] = [];
  for (const rel of referencedIcons()) {
    const source = ICON_SOURCES[rel];
    const vendor = rel.split("/")[0] as keyof typeof packs;
    const path = source && packs[vendor].get(source);
    if (!path) {
      missing.push(`${rel} (${source ?? "no source named"})`);
      continue;
    }
    const out = `${sanitizeSvg(await readFile(path, "utf8"), `${rel.replace("/", "-")}-`)}\n`;
    const dest = join(ROOT, "web", "icons", `${rel}.svg`);
    if (check) {
      const have = await readFile(dest, "utf8").catch(() => null);
      if (have !== out) drift.push(rel);
    } else {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, out);
    }
  }
  if (missing.length) throw new Error(`not found in the packs:\n  ${missing.join("\n  ")}`);
  if (drift.length) {
    console.error(`drift:\n  ${drift.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`${check ? "checked" : "wrote"} ${referencedIcons().length} icons`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
