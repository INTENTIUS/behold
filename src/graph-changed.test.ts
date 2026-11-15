import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGraph } from "./graph-cli.ts";
import { cutChanged } from "./graph-changed.ts";
import { GRAPH_DOCUMENT_SCHEMA, type GraphDocument, type GraphDocumentNode } from "./graph-document.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";

// behold#1059: the cut of what changed between two revisions. The unit tests
// run cutChanged over hand-made documents; the CLI tests build a throwaway git
// repository and read it through the real chant, so they wait on the
// Terraform reader as the other Terraform read tests do.

const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const gate = !(resolvedVersion(TERRAFORM_LEXICON_PKG) && resolvedVersion(HCL_PARSER_PKG)) && !REQUIRE_PEERS;

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

// ---------------------------------------------------------------------------
// cutChanged over documents
// ---------------------------------------------------------------------------

const node = (id: string, attrs: Record<string, unknown> = {}, box = "stack:app"): GraphDocumentNode => ({
  id,
  title: id,
  subtitle: "terraform",
  kind: "aws_thing",
  lexicon: "terraform",
  box,
  attrs: { address: id, file: "main.tf", line: 1, ...attrs },
});

function doc(nodes: GraphDocumentNode[], refs: Array<[string, string]> = []): GraphDocument {
  const boxes = [...new Set(nodes.map((n) => n.box!))];
  return {
    schema: GRAPH_DOCUMENT_SCHEMA,
    generator: { behold: "0.0.0-test" },
    origin: { dir: "." },
    cut: { kind: "whole" },
    nodes,
    edges: refs.map(([source, target]) => ({ id: `${source}->${target}:ref`, source, target, kind: "ref", inferred: false })),
    groups: boxes.map((b) => ({ id: b, title: b.replace(/^stack:/, ""), kind: "stack" })),
    notes: [],
  };
}

const diffs = (d: GraphDocument): Record<string, string | undefined> => Object.fromEntries(d.nodes.map((n) => [n.id, n.diff]));

describe("cutChanged (#1059)", () => {
  const before = doc([node("a", { body: { x: 1 } }), node("b"), node("old"), node("far"), node("far2")], [["a", "b"], ["old", "b"], ["far", "far2"]]);
  const after = doc([node("a", { body: { x: 2 } }), node("b"), node("new"), node("far"), node("far2")], [["a", "b"], ["new", "b"], ["far", "far2"]]);

  it("marks the added, removed and changed cards and keeps their one-hop neighbours", () => {
    const cut = cutChanged(before, after, { base: "A", head: "B" });
    expect(diffs(cut)).toEqual({ a: "changed", b: "neighbour", new: "added", old: "removed" });
    expect(cut.nodes.find((n) => n.id === "a")?.changedAttrs).toEqual(["body"]);
    expect(cut.cut).toMatchObject({ kind: "changed", base: "A", head: "B", depth: 1, counts: { added: 1, removed: 1, changed: 1 } });
    // The removed card's edge is kept, marked as removed; the added one's as added.
    expect(Object.fromEntries(cut.edges.map((e) => [e.id, e.diff]))).toEqual({ "a->b:ref": undefined, "new->b:ref": "added", "old->b:ref": "removed" });
    expect(cut.notes.find((n) => n.kind === "changed")?.text).toBe("1 added, 1 removed, 1 changed between A..B");
  });

  it("depth 0 keeps only the changed cards, and a deeper cut keeps what is further out", () => {
    expect(Object.keys(diffs(cutChanged(before, after, { depth: 0 }))).sort()).toEqual(["a", "new", "old"]);
    const chain = doc([node("a", { v: 1 }), node("b"), node("c"), node("d")], [["a", "b"], ["b", "c"], ["c", "d"]]);
    const edited = doc([node("a", { v: 2 }), node("b"), node("c"), node("d")], [["a", "b"], ["b", "c"], ["c", "d"]]);
    expect(Object.keys(diffs(cutChanged(chain, edited, { depth: 2 }))).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not count where a block sits in a file, or the file's text, as a change", () => {
    const moved = doc([node("a", { body: { x: 1 }, line: 40, file: "other.tf", source: "# reformatted\n" }), node("b")], [["a", "b"]]);
    const was = doc([node("a", { body: { x: 1 } }), node("b")], [["a", "b"]]);
    const cut = cutChanged(was, moved);
    expect(cut.nodes).toEqual([]);
    expect(cut.notes.at(-1)).toMatchObject({ kind: "changed", count: 0 });
    // Key order inside a value is not a change either.
    const reordered = doc([node("a", { body: { y: 2, x: 1 } }), node("b")]);
    const ordered = doc([node("a", { body: { x: 1, y: 2 } }), node("b")]);
    expect(cutChanged(ordered, reordered).nodes).toEqual([]);
  });

  it("marks both ends of a reference that moved between two cards present in both revisions", () => {
    const x = doc([node("a"), node("b"), node("c")], [["a", "b"]]);
    const y = doc([node("a"), node("b"), node("c")], [["a", "c"]]);
    expect(diffs(cutChanged(x, y, { depth: 0 }))).toEqual({ a: "changed", b: "changed", c: "changed" });
  });

  it("folds neighbours into a count per box past the budget, then into a table of counts", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `n${i}`);
    const base = doc(ids.map((id) => node(id, { v: 1 }, "stack:one")).concat(Array.from({ length: 10 }, (_, i) => node(`m${i}`, {}, "stack:two"))), ids.map((id, i) => [id, `m${i}`]));
    const head = doc(ids.map((id) => node(id, { v: 2 }, "stack:one")).concat(Array.from({ length: 10 }, (_, i) => node(`m${i}`, {}, "stack:two"))), ids.map((id, i) => [id, `m${i}`]));
    expect(cutChanged(base, head, { budget: 100 }).nodes).toHaveLength(16);

    const folded = cutChanged(base, head, { budget: 10 });
    expect(folded.nodes.map((n) => n.diff)).toEqual(Array(8).fill("changed"));
    expect(folded.cut).toMatchObject({ folded: "neighbours", budget: 10 });
    const note = folded.notes.find((n) => n.kind === "changed-folded");
    expect(note).toMatchObject({ box: "stack:two", count: 8 });
    expect(note?.text).toContain("over the budget of 10");
    expect(folded.edges).toEqual([]);

    const table = cutChanged(base, head, { budget: 5 });
    expect(table.nodes).toEqual([]);
    expect(table.cut).toMatchObject({ folded: "table" });
    expect(table.notes.filter((n) => n.kind === "changed-table").map((n) => n.text)).toEqual(["one: 8 changed"]);
    expect(table.notes.find((n) => n.kind === "changed")?.text).toContain("over the budget of 5");
  });
});

// ---------------------------------------------------------------------------
// behold graph --changed over a git repository
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

const HEADER = 'provider "aws" {\n  region = "us-east-1"\n}\n\n';
const FIRST = `${HEADER}resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_kms_key" "logs" {
  description = "logs"
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs"
  kms    = aws_kms_key.logs.arn
}

resource "aws_s3_bucket" "far" {
  bucket = "far"
}

resource "aws_s3_bucket" "farther" {
  bucket = "farther"
  other  = aws_s3_bucket.far.arn
}
`;
// Adds aws_security_group.web, changes aws_subnet.a's cidr_block, removes aws_s3_bucket.logs.
const SECOND = FIRST.replace('"10.0.1.0/24"', '"10.0.2.0/24"')
  .replace(/resource "aws_s3_bucket" "logs" \{[^}]*\}\n\n/, "")
  .concat('\nresource "aws_security_group" "web" {\n  vpc_id = aws_vpc.main.id\n}\n');
// The same resources as FIRST, written differently.
const REFORMATTED = FIRST.replace(/ {2}(\w+) += /g, "      $1=").replace(/\n\n/g, "\n\n\n\n");

/** A repository whose folder is `estate` (the member name every card id starts with), with `commits` applied in order. */
function repo(commits: string[]): string {
  const dir = join(mkdtempSync(join(tmpdir(), "behold-1059-")), "estate");
  made.push(join(dir, ".."));
  mkdirSync(join(dir, "net"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const text of commits) {
    writeFileSync(join(dir, "net", "main.tf"), text);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "c");
  }
  return dir;
}

async function graph(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runGraph(argv, { version: "0.0.0-test", stdout: (t) => void (out += String(t)), stderr: (t) => void (err += t) });
  return { code, out, err };
}

const cutOf = (out: string): GraphDocument => JSON.parse(out) as GraphDocument;
const ID = (name: string): string => `estate/net/${name}`;

describe("behold graph --changed, arguments (#1059)", () => {
  it("refuses a range that is not one, and the flags that do not go together", async () => {
    expect((await graph([".", "--changed", "HEAD"])).err).toContain("is not a revision range");
    expect((await graph([".", "--changed", "a..b", "--around", "x"])).err).toContain("two cuts");
    expect((await graph([".", "--changed", "a..b", "--ir"])).err).toContain("--ir is always the whole view");
    expect((await graph([".", "--depth", "2"])).err).toContain("go with --changed or --around");
    expect((await graph([".", "--changed", "a..b", "--depth", "x"])).code).toBe(2);
  });

  it("names the repository it needs when the directory is in none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-1059-"));
    made.push(dir);
    const r = await graph([dir, "--changed", "HEAD~1..HEAD"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not inside a git repository");
  });

  it("names a revision the clone does not hold, with the fetch that brings it", async () => {
    const dir = repo([FIRST]);
    const r = await graph([dir, "--changed", "nope..HEAD"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('revision "nope" is not in this repository');
    expect(r.err).toContain("git fetch");
  });
});

describe("behold graph --changed on a repository (#1059)", () => {
  // Each test reads its revisions under a temp root of its own, so the
  // "no stray behold-rev-* directory" check sees only this test's, never a
  // directory another test file or process has open in the shared tmpdir.
  const shared = process.env.TMPDIR;
  beforeEach(() => {
    process.env.TMPDIR = mkdtempSync(join(tmpdir(), "behold-changed-test-"));
  });
  afterEach(() => {
    const own = process.env.TMPDIR!;
    if (shared === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = shared;
    rmSync(own, { recursive: true, force: true });
  });
  it.skipIf(gate)("marks the one resource added, the one changed and the one removed, and their one-hop neighbours", { timeout: 240_000 }, async () => {
    const dir = repo([FIRST, SECOND]);
    const before = git(dir, "status", "--porcelain", "--ignored");
    const heads = git(dir, "for-each-ref");
    const r = await graph([dir, "--changed", "HEAD~1..HEAD", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const d = cutOf(r.out);
    expect(Object.fromEntries(d.nodes.map((n) => [n.id, n.diff]))).toEqual({
      [ID("aws_security_group.web")]: "added",
      [ID("aws_subnet.a")]: "changed",
      [ID("aws_s3_bucket.logs")]: "removed",
      // One hop: the VPC (named by the new group and the subnet), and the KMS key the removed bucket named.
      [ID("aws_vpc.main")]: "neighbour",
      [ID("aws_kms_key.logs")]: "neighbour",
    });
    expect(d.nodes.find((n) => n.id === ID("aws_subnet.a"))?.changedAttrs).toEqual(["body"]);
    expect(d.cut).toMatchObject({ kind: "changed", base: "HEAD~1", head: "HEAD", depth: 1, counts: { added: 1, removed: 1, changed: 1 } });
    expect(d.origin.rev).toMatch(/^[0-9a-f]{40}$/);
    expect(d.edges.every((e) => d.nodes.some((n) => n.id === e.source) && d.nodes.some((n) => n.id === e.target))).toBe(true);
    // Nothing of this machine's temporary directories, and nothing outside the cut.
    expect(r.out).not.toContain(tmpdir());
    expect(r.out).not.toContain("behold-rev-");
    expect(d.nodes.some((n) => n.id === ID("aws_s3_bucket.far"))).toBe(false);

    // Depth 0 is the three alone.
    const flat = cutOf((await graph([dir, "--changed", "HEAD~1..HEAD", "--depth", "0"])).out);
    expect(flat.nodes.map((n) => n.diff).sort()).toEqual(["added", "changed", "removed"]);

    // The checkout was not touched: same status, same refs, no worktree, no stray directory beside it.
    expect(git(dir, "status", "--porcelain", "--ignored")).toBe(before);
    expect(git(dir, "for-each-ref")).toBe(heads);
    expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual([".git", "net"]);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("behold-rev-"))).toEqual([]);
  });

  it.skipIf(gate)("a commit that only reformats the file changes no card", { timeout: 240_000 }, async () => {
    const dir = repo([FIRST, REFORMATTED]);
    expect(git(dir, "diff", "--stat", "HEAD~1..HEAD")).not.toBe("");
    const r = await graph([dir, "--changed", "HEAD~1..HEAD"]);
    expect(r.code).toBe(0);
    const d = cutOf(r.out);
    expect(d.nodes).toEqual([]);
    expect(d.cut).toMatchObject({ kind: "changed", counts: { added: 0, removed: 0, changed: 0 } });
    expect(d.notes.at(-1)?.text).toBe("no card was added, removed or changed between HEAD~1..HEAD");
  });

  it.skipIf(gate)("folds past the budget and says so in its notes", { timeout: 240_000 }, async () => {
    const dir = repo([FIRST, SECOND]);
    const folded = cutOf((await graph([dir, "--changed", "HEAD~1..HEAD", "--budget", "4"])).out);
    expect(folded.cut).toMatchObject({ folded: "neighbours", budget: 4 });
    expect(folded.nodes.map((n) => n.diff).sort()).toEqual(["added", "changed", "removed"]);
    expect(folded.notes.filter((n) => n.kind === "changed-folded").map((n) => n.count)).toEqual([2]);
    expect(folded.notes.find((n) => n.kind === "changed-folded")?.text).toContain("over the budget of 4");

    const table = cutOf((await graph([dir, "--changed", "HEAD~1..HEAD", "--budget", "2"])).out);
    expect(table.nodes).toEqual([]);
    expect(table.cut).toMatchObject({ folded: "table" });
    expect(table.notes.filter((n) => n.kind === "changed-table").map((n) => n.text)).toEqual(["net: 1 added, 1 removed, 1 changed"]);
  });

  it.skipIf(gate)("works from a shallow clone with the base fetched, and never reads the working tree", { timeout: 240_000 }, async () => {
    const origin = repo([FIRST, SECOND]);
    const clone = join(mkdtempSync(join(tmpdir(), "behold-1059-")), "estate");
    made.push(join(clone, ".."));
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin}`, clone]);
    const sha = git(origin, "rev-parse", "HEAD~1");
    // Base is not in the clone yet.
    const missing = await graph([clone, "--changed", `${sha}..HEAD`]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("shallow clone");
    git(clone, "fetch", "-q", "--depth=1", "origin", sha);
    // An edit in the working tree is not in either revision.
    writeFileSync(join(clone, "net", "main.tf"), `${HEADER}resource "aws_vpc" "scratch" {\n}\n`);
    const r = await graph([clone, "--changed", `${sha}..HEAD`]);
    expect(r.code).toBe(0);
    expect(cutOf(r.out).nodes.filter((n) => n.diff !== "neighbour").map((n) => n.id).sort()).toEqual(
      [ID("aws_s3_bucket.logs"), ID("aws_security_group.web"), ID("aws_subnet.a")].sort(),
    );
  });
});

describe("behold graph --around (#1067)", () => {
  it.skipIf(gate)("cuts around an id and exits 1 on one the graph does not hold", { timeout: 240_000 }, async () => {
    const dir = repo([FIRST]);
    const r = await graph([dir, "--around", ID("aws_vpc.main"), "--json"]);
    expect(r.code).toBe(0);
    const d = cutOf(r.out);
    expect(d.cut).toMatchObject({ kind: "around", ids: [ID("aws_vpc.main")], depth: 1, direction: "both" });
    expect(d.nodes.map((n) => n.id).sort()).toEqual([ID("aws_subnet.a"), ID("aws_vpc.main")]);
    const up = cutOf((await graph([dir, "--around", ID("aws_subnet.a"), "--up"])).out);
    expect(up.nodes.map((n) => n.id).sort()).toEqual([ID("aws_subnet.a"), ID("aws_vpc.main")]);
    const down = cutOf((await graph([dir, "--around", ID("aws_subnet.a"), "--down"])).out);
    expect(down.nodes.map((n) => n.id)).toEqual([ID("aws_subnet.a")]);
    const missing = await graph([dir, "--around", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toBe("");
    expect(missing.err).toContain('the graph holds no card or box "nope"');
  });
});
