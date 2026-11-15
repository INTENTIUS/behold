import { transform } from "esbuild";
import { defineConfig } from "vitest/config";

// Its own config, so the run does not pick up behold's (a parent directory's).
// TypeScript is stripped here with an explicit tsconfig: the shared model sits
// in ../headlamp-behold, whose tsconfig extends a file that folder's own npm
// install provides, and vite would otherwise try to read it.
export default defineConfig({
  esbuild: false,
  plugins: [
    {
      name: "strip-types",
      enforce: "pre",
      async transform(code, id) {
        if (!/\.tsx?$/.test(id.split("?")[0])) return null;
        const out = await transform(code, { loader: "ts", sourcefile: id, sourcemap: true, tsconfigRaw: {} });
        return { code: out.code, map: out.map };
      },
    },
  ],
  test: { include: ["src/**/*.test.ts"] },
});
