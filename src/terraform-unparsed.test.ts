import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { readGraph } from "./read-graph.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";
import { addUnparsedRootCards, parseUnparsedRoots, unparsedNote } from "./terraform-unparsed.ts";

// behold#1053: a root chant cannot parse is one visible card, never an empty graph.

const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const gate = !(resolvedVersion(TERRAFORM_LEXICON_PKG) && resolvedVersion(HCL_PARSER_PKG)) && !REQUIRE_PEERS;

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const HEADER = 'provider "aws" {\n  region = "us-east-1"\n}\n';
/** Two attributes on one line inside a block: the shape the parser refuses. */
const BAD = `${HEADER}\nresource "aws_s3_bucket" "logs" {\n  bucket = "logs" acl = "private"\n}\n`;
const GOOD = `${HEADER}\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n`;

function estate(roots: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-1053-"));
  made.push(dir);
  for (const [name, tf] of Object.entries(roots)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "main.tf"), tf);
  }
  return dir;
}

describe("chant's parse warning", () => {
  const line = "\x1b[33mwarning\x1b[0m: terraform.roots.app: could not parse /tmp/x/estate/app, parse config: [main.tf:8,19-22: Missing newline after argument; An argument definition must end with a newline.]";

  it("gives the root, file, line and the parser's words", () => {
    expect(parseUnparsedRoots(`${line}\nsomething else\n`)).toEqual([
      { root: "app", file: "main.tf", line: 8, detail: "Missing newline after argument; An argument definition must end with a newline." },
    ]);
  });

  it("keeps a message of another shape whole", () => {
    expect(parseUnparsedRoots("terraform.roots.net: could not parse /x/net, hcl2json failed")).toEqual([{ root: "net", detail: "hcl2json failed" }]);
  });

  it("ignores the module and directory warnings", () => {
    expect(parseUnparsedRoots("terraform.roots.app: directory not found at /x, no entities contributed")).toEqual([]);
    expect(parseUnparsedRoots("terraform.roots.app/module.x: could not parse module.x at /y, bad")).toEqual([]);
  });

  it("adds one card, and none for a root that has nodes", () => {
    const ir = { nodes: [{ id: "net/aws_vpc.main", kind: "Terraform::Resource", lexicon: "terraform", attrs: { root: "net" } }], edges: [], groups: {} } as unknown as GraphIR;
    addUnparsedRootCards(ir, [{ root: "app", file: "main.tf", line: 8, detail: "bad" }, { root: "net", detail: "stale" }]);
    expect(ir.nodes.map((n) => n.id)).toEqual(["net/aws_vpc.main", "app/unreadable"]);
    expect(ir.nodes[1].attrs).toMatchObject({ file: "main.tf", line: 8, root: "app", _unreadable: { code: "terraform-parse", message: "main.tf:8: bad" } });
  });

  it("says how many roots", () => {
    expect(unparsedNote([{ root: "app", file: "main.tf", line: 8 }], 2)).toEqual({
      note: "1 of 2 roots could not be parsed (app: main.tf:8)",
      noteShort: "1 of 2 roots not parsed",
    });
    expect(unparsedNote([], 2)).toEqual({});
  });
});

describe("readGraph on a root that does not parse (#1053)", () => {
  it.skipIf(gate)("draws the good root's nodes and one card for the bad root", { timeout: 180_000 }, async () => {
    const r = await readGraph(estate({ app: BAD, net: GOOD }));
    const ids = r.ir.nodes.map((n) => n.id);
    expect(ids.filter((i) => i.includes("/net/"))).toHaveLength(1);
    const card = r.ir.nodes.find((n) => n.kind === "UnreadableMember")!;
    expect(card.id).toMatch(/\/app\/unreadable$/);
    expect(card.attrs).toMatchObject({ file: "main.tf", line: 6, root: "app", _unreadable: { code: "terraform-parse" } });
    expect(r.ir.nodes.filter((n) => n.kind === "UnreadableMember")).toHaveLength(1);
    expect(r.meta.note).toContain("1 of 2 roots could not be parsed (app: main.tf:6)");
    expect(r.meta.noteShort).toContain("1 of 2 roots not parsed");
    expect(Object.keys(r.ir.groups.byStack ?? {}).sort()).toEqual(["app", "net"]);
  });

  it.skipIf(gate)("a folder whose only root fails draws exactly one card", { timeout: 180_000 }, async () => {
    const dir = estate({});
    writeFileSync(join(dir, "main.tf"), BAD);
    const r = await readGraph(dir);
    expect(r.ir.nodes).toHaveLength(1);
    expect(r.ir.nodes[0]).toMatchObject({ kind: "UnreadableMember", attrs: { file: "main.tf", line: 6 } });
    expect(r.meta.note).toContain("1 of 1 root could not be parsed");
  });
});
