import { afterAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGraphDocument } from "./graph-document.ts";
import { graphUsage, runGraph } from "./graph-cli.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";

// behold#1058: `behold graph <dir>` reads a folder and prints, with no server.
// The reads go through the real chant, so they wait on the Terraform reader
// as the other Terraform read tests do.

const HERE = dirname(fileURLToPath(import.meta.url));
const ESTATE = join(HERE, "..", "example-terraform-estate");
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const gate = !(resolvedVersion(TERRAFORM_LEXICON_PKG) && resolvedVersion(HCL_PARSER_PKG)) && !REQUIRE_PEERS;

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-1058-"));
  made.push(dir);
  return dir;
}

/** example-terraform-estate without its declaration: a bare folder of .tf files. */
function bareEstate(): string {
  const dir = join(scratch(), "bare-estate");
  cpSync(ESTATE, dir, { recursive: true });
  rmSync(join(dir, "chant.workspace.json"));
  return dir;
}

async function graph(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runGraph(argv, { version: "0.0.0-test", stdout: (t) => void (out += String(t)), stderr: (t) => void (err += t) });
  return { code, out, err };
}

describe("behold graph, arguments (#1058)", () => {
  it("prints its usage, naming every format flag", async () => {
    const r = await graph(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(graphUsage());
    for (const f of ["--json", "--ir", "--svg", "--mermaid", "-o <file>", "--detail 0..3", "--source"]) expect(r.out).toContain(f);
  });

  it("refuses a detail outside 0 to 3, two formats, and an unknown option", async () => {
    expect((await graph([".", "--detail", "4"])).code).toBe(2);
    expect((await graph([".", "--json", "--ir"])).err).toContain("two formats");
    expect((await graph([".", "--frobnicate"])).err).toContain("unknown option --frobnicate");
  });

  it("answers --svg and --mermaid with what to use until their emitters apply", async () => {
    for (const f of ["--svg", "--mermaid"]) {
      const r = await graph([".", f]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("not in this version");
    }
  });

  it("refuses a path that is not a directory", async () => {
    const r = await graph([join(scratch(), "missing")]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("is not a directory");
  });
});

describe("behold graph on a folder of .tf files (#1058)", () => {
  it.skipIf(gate)("--json prints a behold-graph/1 document with no path of this machine in it", { timeout: 240_000 }, async () => {
    const dir = bareEstate();
    const r = await graph([dir, "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { schema: string; nodes: Array<{ attrs: Record<string, unknown> }>; generator: { behold: string }; origin: { dir: string } };
    expect(doc.schema).toBe("behold-graph/1");
    expect(checkGraphDocument(doc).ok).toBe(true);
    expect(doc.generator.behold).toBe("0.0.0-test");
    expect(doc.nodes.length).toBeGreaterThan(0);
    expect(doc.nodes.some((n) => "source" in n.attrs)).toBe(false);
    expect(r.out).not.toContain(dirname(dir));
    expect(r.out).not.toContain(tmpdir());

    // The default is --json.
    expect((await graph([dir])).out).toBe(r.out);

    // --ir is the same view as the unversioned snapshot: the same cards, the same note.
    const ir = await graph([dir, "--ir"]);
    const snap = JSON.parse(ir.out) as { ir: { nodes: Array<{ id: string; attrs?: Record<string, unknown> }> }; meta: { note?: string; estate: number } };
    expect(snap.ir.nodes.map((n) => n.id)).toEqual((doc.nodes as unknown as Array<{ id: string }>).map((n) => n.id));
    expect(snap.meta.estate).toBe(1);
    expect(snap.ir.nodes.some((n) => n.attrs && "source" in n.attrs)).toBe(false);
    expect(ir.out).not.toContain(dirname(dir));

    // --source keeps the cards' source text.
    const withSource = JSON.parse((await graph([dir, "--ir", "--source"])).out) as typeof snap;
    expect(withSource.ir.nodes.some((n) => n.attrs && "source" in n.attrs)).toBe(true);

    // --every-card turns off stacking, so it draws at least as many cards.
    const every = JSON.parse((await graph([dir, "--ir", "--every-card"])).out) as typeof snap;
    expect(every.ir.nodes.length).toBeGreaterThan(snap.ir.nodes.length);
  });

  it.skipIf(gate)("-o writes the file and prints nothing on stdout", { timeout: 240_000 }, async () => {
    const dir = bareEstate();
    const file = join(scratch(), "graph.json");
    const r = await graph([dir, "-o", file]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^wrote .*graph\.json \(\d+ cards\)\n$/);
    expect(JSON.parse(readFileSync(file, "utf8")).schema).toBe("behold-graph/1");
  });

  it.skipIf(gate)("a root that fails to parse is the unreadable card in the document", { timeout: 240_000 }, async () => {
    const dir = scratch();
    const header = 'provider "aws" {\n  region = "us-east-1"\n}\n';
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "main.tf"), `${header}\nresource "aws_s3_bucket" "logs" {\n  bucket = "logs" acl = "private"\n}\n`);
    mkdirSync(join(dir, "net"));
    writeFileSync(join(dir, "net", "main.tf"), `${header}\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n`);
    const r = await graph([dir, "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { nodes: Array<{ id: string; kind: string; file?: string; line?: number; attrs: Record<string, unknown> }>; notes: Array<{ text: string }> };
    const card = doc.nodes.find((n) => n.kind === "UnreadableMember");
    expect(card?.id).toMatch(/\/app\/unreadable$/);
    expect(card?.attrs).toMatchObject({ file: "main.tf", line: 6, _unreadable: { code: "terraform-parse" } });
    expect(doc.nodes.some((n) => n.id.includes("/net/"))).toBe(true);
    expect(doc.notes.map((n) => n.text).join(" ")).toContain("1 of 2 roots could not be parsed (app: main.tf:6)");
    expect(existsSync(join(dir, "chant.config.ts"))).toBe(false);
  });
});
