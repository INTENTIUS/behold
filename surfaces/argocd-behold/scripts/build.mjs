// Bundles src/index.tsx into one file Argo CD loads, with react and
// react/jsx-runtime resolved to the host's globals (window.React,
// window.ReactJSXRuntime), as Argo CD 3.5's React 19 upgrade notes require.
// The output sits where the extension installer expects it:
// dist/resources/extension-behold.js/extension-behold.js
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const globals = { react: "React", "react/jsx-runtime": "ReactJSXRuntime", "react-dom": "ReactDOM" };

const hostGlobals = {
  name: "host-globals",
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/jsx-runtime)?$/ }, (a) => ({ path: a.path, namespace: "host-global" }));
    b.onLoad({ filter: /.*/, namespace: "host-global" }, (a) => ({
      contents: `module.exports = window.${globals[a.path]};`,
      loader: "js",
    }));
  },
};

export async function bundle() {
  const out = join(root, "dist", "resources", "extension-behold.js", "extension-behold.js");
  await build({
    entryPoints: [join(root, "src", "index.tsx")],
    outfile: out,
    bundle: true,
    format: "iife",
    target: "es2020",
    jsx: "automatic",
    minify: false,
    legalComments: "none",
    plugins: [hostGlobals],
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
    logLevel: "warning",
  });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await bundle());
