/**
 * behold#1058: the `behold-graph` bin of `@intentius/behold-graph`. The same
 * command as `behold graph`; the version in the document is this package's.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGraph } from "./graph-cli.ts";

function packageVersion(): string {
  try {
    // dist/ in the package, src/ under tsx: one level under the package root either way.
    const here = dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  return runGraph(argv, { version: packageVersion(), prog: "behold-graph" });
}
