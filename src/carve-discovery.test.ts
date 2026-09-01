import { describe, it, expect } from "vitest";
import { hasAnyCarveManifest } from "./carve-discovery.ts";

// The scan that keeps chant off the graph path (chant#2038): a project with no
// manifest anywhere never spawns `chant carve status` to be told so.
const io = (files: string[]) => ({
  readdir: (d: string) => {
    const out = new Set<string>();
    for (const f of files) if (f.startsWith(d + "/")) out.add(f.slice(d.length + 1).split("/")[0]);
    if (!out.size) throw new Error("ENOENT");
    return [...out];
  },
  isDirectory: (p: string) => files.some((f) => f.startsWith(p + "/")),
});

describe("hasAnyCarveManifest", () => {
  it("finds a manifest at any depth chant's own walk would reach", () => {
    expect(hasAnyCarveManifest("/p", io(["/p/a/b/c/d/x.carve.json"]))).toBe(true);
    expect(hasAnyCarveManifest("/p", io(["/p/src/main.ts", "/p/carveout/y.carve.json"]))).toBe(true);
  });

  it("never looks inside vendored, build or dot directories — where chant never writes one", () => {
    expect(hasAnyCarveManifest("/p", io(["/p/node_modules/x/y.carve.json", "/p/dist/y.carve.json", "/p/.git/y.carve.json", "/p/.terraform/y.carve.json", "/p/cdk.out/y.carve.json"]))).toBe(false);
  });

  it("is false, never a throw, for a root that isn't there or holds nothing", () => {
    expect(hasAnyCarveManifest("/nope", io([]))).toBe(false);
    expect(hasAnyCarveManifest("/p", io(["/p/src/main.ts"]))).toBe(false);
  });
});
