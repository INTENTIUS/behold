/**
 * behold#1072: build the extension into dist/.
 *
 *   node scripts/build.mjs
 *
 *   dist/extension.js   the extension host side: src/extension.ts with the
 *                       reader (@intentius/behold) bundled in
 *   dist/viewer/        viewer.js and viewer.css, from the behold viewer build
 *   dist/node_modules/  the part of chant that reads Terraform (stage-chant.mjs)
 *
 * It builds the viewer from ../../src/viewer, which needs the repository's own
 * install (npm ci at the repository root) and a pinhole whose root entry bundles
 * for a browser (0.6.0).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, "..");
const root = resolve(ext, "..", "..");
const dist = join(ext, "dist");

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// The viewer: built into a scratch directory under dist, two files kept.
const scratch = join(dist, ".viewer-build");
run(join(root, "node_modules", ".bin", "tsx"), [join(root, "scripts", "build-viewer.mts"), "--out", scratch], { cwd: root });
mkdirSync(join(dist, "viewer"), { recursive: true });
for (const f of ["viewer.js", "viewer.css"]) copyFileSync(join(scratch, f), join(dist, "viewer", f));

// The extension host bundle. `import.meta.url` has no meaning in CommonJS, so the
// bundled modules that read it (src/chant.ts) get the bundle's own file URL.
await build({
  entryPoints: [join(ext, "src", "extension.ts")],
  outfile: join(dist, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  external: ["vscode", "@intentius/chant-k8s-client", "@kubernetes/client-node"],
  banner: { js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__importMetaUrl" },
  logLevel: "warning",
});

run(process.execPath, [join(here, "stage-chant.mjs")]);
