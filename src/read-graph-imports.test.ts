import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// behold#1057: src/read-graph.ts is what a CLI or another host calls to read a
// directory with no server, so nothing it loads may pull in the server's HTTP
// stack. This walks its module graph from the source, type imports included,
// and fails on any `hono` or `@hono/*` import. It also checks the packages the
// graph reaches, one level down: none of them may depend on hono either.

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "read-graph.ts");
const SPECIFIER = /(?:^|[^\w.])(?:import|export)\s*(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const isHono = (spec: string): boolean => spec === "hono" || spec.startsWith("hono/") || spec.startsWith("@hono/");
const packageOf = (spec: string): string => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
// Comments name modules in prose ("import ... from" in a sentence); only code counts.
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function moduleGraph(entry: string): { files: Map<string, string[]>; packages: Set<string> } {
  const files = new Map<string, string[]>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    const specs = [...code(readFileSync(file, "utf8")).matchAll(SPECIFIER)].map((m) => (m[1] ?? m[2])!);
    files.set(file, specs);
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        const found = [target, `${target}.ts`, `${target}.js`, join(target, "index.ts")].find((p) => statSync(p, { throwIfNoEntry: false })?.isFile());
        if (found && /\.(ts|js|mjs)$/.test(found)) queue.push(found);
      } else if (!spec.startsWith("node:") && PACKAGE_NAME.test(packageOf(spec))) {
        packages.add(packageOf(spec));
      }
    }
  }
  return { files, packages };
}

describe("src/read-graph.ts loads no hono (#1057)", () => {
  const { files, packages } = moduleGraph(ENTRY);

  it("walks the estate read and its passes", () => {
    // A walk that stopped at the entry would pass for the wrong reason.
    for (const m of ["estate.ts", "workspace.ts", "member-kind.ts", "chant-edges.ts", "k8s-edges.ts"]) {
      expect([...files.keys()].some((f) => f.endsWith(`/${m}`)), m).toBe(true);
    }
  });

  it("imports nothing from hono, anywhere in its module graph", () => {
    const offenders = [...files].flatMap(([file, specs]) => specs.filter(isHono).map((s) => `${file.slice(HERE.length + 1)} imports ${s}`));
    expect(offenders).toEqual([]);
    expect([...files.keys()].some((f) => f.endsWith("/server.ts"))).toBe(false);
  });

  it("reaches no package that depends on hono", () => {
    const require = createRequire(ENTRY);
    const dependsOnHono = [...packages].filter((name) => {
      let manifest: string;
      try {
        manifest = require.resolve(`${name}/package.json`);
      } catch {
        return false; // a package with no exported manifest; its imports are not walked
      }
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
      return Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).some(isHono);
    });
    expect(packages.has("hono")).toBe(false);
    expect(dependsOnHono).toEqual([]);
  });
});
