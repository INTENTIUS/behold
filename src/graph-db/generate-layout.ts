/**
 * behold#1031: writes and checks the graph pane's generated layout.
 *
 *   tsx src/graph-db/generate-layout.ts               write ./layout.generated.ts from the vendored schema (`npm run build` runs this)
 *   tsx src/graph-db/generate-layout.ts --check       the drift check (./layout.ts `checkDrift`); exits 1 on drift
 *       [--chant <dir>]                               compare with this chant package or checkout (default: $CHANT_DIR, else the installed chant)
 *   tsx src/graph-db/generate-layout.ts --sync <dir>  copy the schema and fixtures from a chant checkout or package, record its commit and sha256s, then write
 *
 * `npm run generate:graph-layout` and `npm run check:graph-layout` are the
 * package scripts for the first two.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "./layout-gen.ts";
import { CHANT_SCHEMA_PATHS, GENERATED_LAYOUT, GRAPH_DB_DIR, VENDORED_SCHEMA, VENDORED_SOURCE, checkDrift, chantSchemaPath, readVendoredSource, renderVendored, type VendoredSource } from "./layout.ts";

function write(dir: string): void {
  const src = readVendoredSource(dir);
  const got = sha256(readFileSync(VENDORED_SCHEMA(dir), "utf8"));
  if (got !== src.sha256) throw new Error(`chant-schema/graph.schema.json (sha256 ${got}) is not the copy source.json records (${src.sha256}); re-copy it with --sync <chant dir>`);
  const text = renderVendored(dir);
  const out = GENERATED_LAYOUT(dir);
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) writeFileSync(out, text);
}

function sync(dir: string, chantDir: string): void {
  const schema = chantSchemaPath(chantDir);
  if (!schema) throw new Error(`${chantDir} holds none of ${CHANT_SCHEMA_PATHS.join(", ")}`);
  const prev = readVendoredSource(dir);
  let commit = prev.commit;
  let ref = prev.ref;
  try {
    commit = execFileSync("git", ["-C", chantDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    ref = execFileSync("git", ["-C", chantDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // a package directory, not a checkout: name it by its version
    for (const p of [join(chantDir, "package.json")]) {
      try {
        const v = (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version;
        if (v) {
          commit = `v${v}`;
          ref = `v${v}`;
        }
      } catch {
        // keep the previous record
      }
    }
  }
  copyFileSync(schema, VENDORED_SCHEMA(dir));
  const fixtureDir = schema.replace(/graph\.schema\.json$/, "fixtures");
  const fixtures: Record<string, string> = {};
  for (const name of Object.keys(prev.fixtures ?? {})) {
    const from = join(fixtureDir, name);
    if (existsSync(from)) copyFileSync(from, join(dir, "__fixtures__", name));
    fixtures[name] = sha256(readFileSync(join(dir, "__fixtures__", name)));
  }
  const next: VendoredSource = { ...prev, ref, commit, sha256: sha256(readFileSync(VENDORED_SCHEMA(dir), "utf8")), fixtures };
  writeFileSync(VENDORED_SOURCE(dir), `${JSON.stringify(next, null, 2)}\n`);
  write(dir);
}

export function main(argv: readonly string[], dir: string = GRAPH_DB_DIR): number {
  const at = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i < 0 ? undefined : argv[i + 1];
  };
  if (argv.includes("--sync")) {
    const chantDir = at("--sync");
    if (!chantDir) {
      console.error("--sync takes a chant checkout or package directory");
      return 2;
    }
    sync(dir, resolve(chantDir));
    console.log(`graph layout: vendored chant's schema from ${chantDir} and regenerated layout.generated.ts`);
    return 0;
  }
  if (argv.includes("--check")) {
    const chantDir = at("--chant") ?? process.env.CHANT_DIR;
    const r = checkDrift({ dir, ...(chantDir ? { chantDir: resolve(chantDir) } : {}) });
    for (const s of r.skipped) console.log(`graph layout: skipped: ${s}`);
    for (const p of r.problems) console.error(`graph layout: drift: ${p}`);
    if (r.problems.length) return 1;
    console.log(`graph layout: no drift (vendored chant ${readVendoredSource(dir).commit.slice(0, 12)}${r.chant ? `, same as ${r.chant.schema}` : ""})`);
    return 0;
  }
  write(dir);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`graph layout: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
