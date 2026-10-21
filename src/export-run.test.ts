import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
import { ExportRefusal, runExport } from "./export.ts";

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

  // #827: a single project is still named after its directory, and the view
  // it opens on rides in the manifest only when the export chose one.
  it("names a single project's bundle after its directory, and writes the opening view it was given", { timeout: 60_000 }, async () => {
    vi.mocked(graphIr).mockImplementation((async () => fixture()) as never);
    const parent = mkdtempSync(join(tmpdir(), "behold-export-src-"));
    const project = join(parent, "my-estate");
    mkdirSync(project);
    const out = join(mkdtempSync(join(tmpdir(), "behold-export-out-")), "bundle");
    const plain = join(dirname(out), "plain");
    made.push(parent, dirname(out));
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runExport({ projectDir: project, port: 0 }, plain);
      await runExport({ projectDir: project, port: 0 }, out, { open: { zoom: "composites" }, note: " Run this yourself: `npx @intentius/behold demo three-cloud` " });
    } finally {
      write.mockRestore();
    }
    const read = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    expect(read(plain, "wrangler.jsonc").name).toBe("behold-my-estate");
    expect(read(plain, "manifest.json").projectDir).toBe("my-estate");
    expect(read(plain, "manifest.json")).not.toHaveProperty("workspace");
    expect(read(plain, "manifest.json")).not.toHaveProperty("opening");
    expect(read(out, "manifest.json").opening).toEqual({ zoom: "composites" });
    // #824: the note rides in the manifest, trimmed, only when one was given.
    expect(read(plain, "manifest.json")).not.toHaveProperty("note");
    expect(read(out, "manifest.json").note).toBe("Run this yourself: `npx @intentius/behold demo three-cloud`");
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain('id="export-note"');
    expect(existsSync(join(out, "export-note.js"))).toBe(true);
  });

  it("refuses a note of more than one line, before it writes anything (#824)", { timeout: 60_000 }, async () => {
    vi.mocked(graphIr).mockImplementation((async () => fixture()) as never);
    const project = mkdtempSync(join(tmpdir(), "behold-export-src-"));
    const out = join(mkdtempSync(join(tmpdir(), "behold-export-out-")), "bundle");
    made.push(project, dirname(out));
    await expect(runExport({ projectDir: project, port: 0 }, out, { note: "one\ntwo" })).rejects.toThrow("--note takes one line");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses an opening env the export doesn't capture, before it writes anything", { timeout: 60_000 }, async () => {
    vi.mocked(graphIr).mockImplementation((async () => fixture()) as never);
    const project = mkdtempSync(join(tmpdir(), "behold-export-src-"));
    const out = join(mkdtempSync(join(tmpdir(), "behold-export-out-")), "bundle");
    made.push(project, dirname(out));
    await expect(runExport({ projectDir: project, port: 0 }, out, { open: { env: "prod" } })).rejects.toThrow(ExportRefusal);
    expect(existsSync(out)).toBe(false);
  });
});
