import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGraphDocument, cliBehold, rootTable } from "../src/cli-behold.mjs";

// A stand-in for the bin of @intentius/behold: it answers `graph` from a fixed script, so nothing is installed.
function fakeBin(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-cli-"));
  const bin = join(dir, "behold.js");
  writeFileSync(bin, body);
  return bin;
}

describe("the CLI-backed behold of the action (#1062)", () => {
  it("runs `behold graph` and hands back its status and output", async () => {
    const bin = fakeBin(`if (process.argv[2] !== "graph") process.exit(9); process.stdout.write(process.argv.slice(3).join(" ")); process.stderr.write("e"); process.exit(0);`);
    const b = cliBehold({ bin, version: "0.32.0" });
    let out = "";
    let err = "";
    const code = await b.runGraph(["d", "--json"], { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) });
    expect([code, out, err]).toEqual([0, "d --json", "e"]);
  });

  it("draws the diagram `behold graph --mermaid --forge` prints, and falls back to a table when it left cards out", () => {
    const whole = cliBehold({ bin: fakeBin(`process.stdout.write("flowchart TD\\nn0[\\"a\\"]\\n");`), version: "x" });
    whole.useCut({ dir: "d", args: ["--changed", "A..B"] });
    const fc = whole.forgeComment({ nodes: [] }, { forge: "github", marker: "m" });
    expect(fc.kind).toBe("diagram");
    expect(fc.text).toContain("<!-- m -->");
    expect(fc.text).toContain("```mermaid\nflowchart TD");
    const cut = cliBehold({ bin: fakeBin(`process.stdout.write("flowchart TD\\nmore[\\"3 cards not shown\\"]\\n");`), version: "x" });
    expect(cut.forgeComment({ nodes: [] }, { forge: "github", marker: "m" }).kind).toBe("table");
  });

  it("writes a per-root table and checks a document's shape", () => {
    const doc = { groups: [{ id: "g", title: "root-a" }], nodes: [{ id: "1", box: "g", diff: "changed" }, { id: "2", box: "g", diff: "neighbour" }] };
    expect(rootTable(doc as never)).toBe("| Root | Cards | Added | Changed | Removed |\n| --- | ---: | ---: | ---: | ---: |\n| root-a | 2 | 0 | 1 | 0 |\n");
    expect(checkGraphDocument({ schema: "behold-graph/1", nodes: [], edges: [], groups: [], notes: [] }).ok).toBe(true);
    expect(checkGraphDocument({ schema: "x" }).ok).toBe(false);
    expect(readFileSync(fakeBin("1"), "utf8")).toBe("1");
  });
});
