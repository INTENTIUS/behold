import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";

// #489: `behold export` died on web/icons (a directory) while export.test.ts
// only ever tested the pieces. This runs the whole export, in-process through
// the same handlers serve uses, with chant's read as the one seam mocked.
vi.mock("./chant.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chant.ts")>()),
  graphIr: vi.fn(),
}));
import { graphIr } from "./chant.ts";
import { runExport } from "./export.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (): GraphIR => JSON.parse(readFileSync(join(HERE, "__fixtures__", "terraform-ir-two-roots.json"), "utf8")) as GraphIR;

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("runExport, end to end (#489)", () => {
  it("writes a bundle that carries the SPA, its icon directories, the snapshots and the notices", { timeout: 60_000 }, async () => {
    vi.mocked(graphIr).mockImplementation((async () => fixture()) as never);
    const project = mkdtempSync(join(tmpdir(), "behold-export-src-"));
    const out = join(mkdtempSync(join(tmpdir(), "behold-export-out-")), "bundle");
    made.push(project, dirname(out));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runExport({ projectDir: project, port: 0 }, out);
    } finally {
      write.mockRestore();
    }

    for (const f of ["index.html", "app.js", "manifest.json", "README.md", "wrangler.jsonc", "LICENSE"]) expect(existsSync(join(out, f))).toBe(true);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("window.__BEHOLD_STATIC__ = true");
    // The directory that broke it, copied whole.
    expect(statSync(join(out, "icons")).isDirectory()).toBe(true);
    expect(readdirSync(join(out, "icons"), { recursive: true }).length).toBeGreaterThan(10);
    // The SPA's own tests are not part of a bundle.
    expect(readdirSync(out).filter((f) => f.endsWith(".test.js"))).toEqual([]);

    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { keyToFile: Record<string, string> };
    const graph = JSON.parse(readFileSync(join(out, manifest.keyToFile["/api/graph?detail=2"]!), "utf8")) as { ir: GraphIR };
    expect(graph.ir.nodes.length).toBeGreaterThan(0);
  });
});
