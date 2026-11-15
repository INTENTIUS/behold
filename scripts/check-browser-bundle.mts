/**
 * behold#1069: the painter bundles for a browser.
 *
 *   tsx scripts/check-browser-bundle.mts [--out <file>]
 *
 * Bundles src/render.ts (renderGraph and everything it imports, pinhole
 * included) with esbuild for `--platform=browser`, minified. Exits 1 when any
 * module in the bundle imports a Node built-in, naming the chain from
 * src/render.ts to the import. Otherwise prints the minified and gzipped sizes
 * and the inputs that take the most of it. `--out` also writes the bundle.
 * `npm run check:browser-bundle` runs it, and so does CI.
 */
import { builtinModules } from "node:module";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build, type Metafile, type Plugin } from "esbuild";

const ENTRY = "src/render.ts";
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
const out = outAt >= 0 ? argv[outAt + 1] : undefined;

const found: Array<{ path: string; importer: string }> = [];
const noNode: Plugin = {
  name: "no-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (!args.path.startsWith("node:") && !BUILTIN.has(args.path)) return undefined;
      found.push({ path: args.path, importer: args.importer });
      return { path: args.path, external: true };
    });
  },
};

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "browser",
  format: "esm",
  minify: true,
  write: false,
  metafile: true,
  logLevel: "error",
  outfile: "render.browser.js",
  plugins: [noNode],
});

/** The import chain from the entry to `file`, through the metafile's inputs. */
function chainTo(meta: Metafile, file: string): string[] {
  const parent = new Map<string, string>();
  const queue = [ENTRY];
  const seen = new Set(queue);
  while (queue.length) {
    const f = queue.shift()!;
    for (const i of meta.inputs[f]?.imports ?? []) {
      if (seen.has(i.path)) continue;
      seen.add(i.path);
      parent.set(i.path, f);
      queue.push(i.path);
    }
  }
  const chain = [file];
  while (parent.has(chain[0])) chain.unshift(parent.get(chain[0])!);
  return chain;
}

if (found.length) {
  const cwd = `${process.cwd()}/`;
  console.error(`browser bundle: ${ENTRY} imports Node built-ins (${found.length}):`);
  for (const f of found) {
    const importer = f.importer.startsWith(cwd) ? f.importer.slice(cwd.length) : f.importer;
    console.error(`  ${f.path}  via  ${chainTo(result.metafile, importer).join(" > ")}`);
  }
  process.exit(1);
}

const code = result.outputFiles[0].contents;
const gz = gzipSync(code, { level: 9 }).length;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
console.log(`browser bundle: ${ENTRY}, no Node built-ins`);
console.log(`browser bundle: minified ${kb(code.length)} (${code.length} bytes), gzipped ${kb(gz)} (${gz} bytes)`);
const inputs = Object.entries(result.metafile.outputs)[0][1].inputs;
const top = Object.entries(inputs)
  .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
  .slice(0, 8);
for (const [file, { bytesInOutput }] of top) console.log(`  ${kb(bytesInOutput).padStart(9)}  ${file}`);
if (out) {
  writeFileSync(out, code);
  console.log(`browser bundle: wrote ${out}`);
}
