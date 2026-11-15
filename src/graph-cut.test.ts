import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { GRAPH_DOCUMENT_SCHEMA, type GraphDocument, type GraphDocumentNode } from "./graph-document.ts";
import { cutDocument } from "./graph-cut.ts";
import { toDocument, type GraphSnapshot } from "./to-document.ts";

const HERE = import.meta.dirname;
const FIX = join(HERE, "__fixtures__", "graph-document");
const schema = JSON.parse(readFileSync(join(HERE, "..", "schemas", "graph", "v1", "graph.schema.json"), "utf8")) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

// The export of example-terraform-estate (#1066's fixture): prod and platform roots, 23 cards.
const estate = (): GraphDocument =>
  toDocument(JSON.parse(readFileSync(join(FIX, "terraform-estate-detail-2.json"), "utf8")) as GraphSnapshot, {
    generator: { behold: "0.31.0" },
    origin: { dir: "example-terraform-estate" },
  });
const P = "prod/prod/";
const ids = (d: GraphDocument): string[] => d.nodes.map((n) => n.id).sort();

describe("cutDocument on example-terraform-estate (#1067)", () => {
  it("a resource and its direct neighbours: the VPC has nothing it needs and four cards that need it", () => {
    const r = cutDocument(estate(), [`${P}aws_vpc.main`], { depth: 1 });
    if (!r.ok) throw new Error(r.error);
    // Counted by hand from the edges: igw, route table and security group name the VPC, and so does the
    // three-subnet stack; the VPC itself is the fifth.
    expect(r.document.nodes).toHaveLength(5);
    expect(ids(r.document)).toEqual(
      [`${P}aws_vpc.main`, `${P}aws_internet_gateway.main`, `${P}aws_route_table.public`, `${P}aws_security_group.edge`, "prod/aws_subnet ×3"].sort(),
    );
    // Four edges into the VPC, and the route table's edge to the gateway, both ends kept.
    expect(r.document.edges).toHaveLength(5);
    expect(r.document.cut).toEqual({ kind: "around", ids: [`${P}aws_vpc.main`], depth: 1, direction: "both" });
    expect(r.document.nodes.filter((n) => n.seed).map((n) => n.id)).toEqual([`${P}aws_vpc.main`]);
  });

  it("validates against the behold-graph/1 schema", () => {
    for (const ask of [[`${P}aws_vpc.main`], ["stack:platform"]]) {
      const r = cutDocument(estate(), ask);
      if (!r.ok) throw new Error(r.error);
      expect(validate(r.document) ? [] : validate.errors).toEqual([]);
      expect(r.document.schema).toBe(GRAPH_DOCUMENT_SCHEMA);
    }
  });

  it("a box id keeps every card of that root, and only the root's group", () => {
    const doc = estate();
    const r = cutDocument(doc, ["stack:platform"], { depth: 1 });
    if (!r.ok) throw new Error(r.error);
    const platform = doc.nodes.filter((n) => n.box === "stack:platform").map((n) => n.id).sort();
    expect(platform).toHaveLength(6);
    expect(ids(r.document)).toEqual(platform);
    expect(r.document.nodes.every((n) => n.seed)).toBe(true);
    expect(r.document.groups.map((g) => g.id)).toEqual(["stack:platform"]);
    expect(r.document.cut).toMatchObject({ kind: "around", ids: ["stack:platform"] });
  });

  it("counts, per box, the neighbours the cut left out", () => {
    const r = cutDocument(estate(), [`${P}aws_s3_bucket.artifacts`], { depth: 1, direction: "up" });
    if (!r.ok) throw new Error(r.error);
    // The bucket needs nothing, so it stands alone; the three cards that need it are the neighbours left out.
    expect(ids(r.document)).toEqual([`${P}aws_s3_bucket.artifacts`]);
    expect(r.document.notes).toContainEqual(expect.objectContaining({ kind: "cut-left-out", box: "stack:prod", count: 3 }));
  });

  it("an unknown id is an error that names it", () => {
    const r = cutDocument(estate(), [`${P}aws_vpc.main`, "no-such-id"]);
    expect(r).toMatchObject({ ok: false, missing: ["no-such-id"] });
    if (!r.ok) expect(r.error).toContain("no-such-id");
  });
});

describe("cutDocument direction on a three-node chain (#1067)", () => {
  const node = (id: string): GraphDocumentNode => ({ id, title: id, subtitle: "terraform", kind: "x", lexicon: "terraform", attrs: {} });
  // c needs b, b needs a: a is upstream of b, c is downstream.
  const chain: GraphDocument = {
    schema: GRAPH_DOCUMENT_SCHEMA,
    generator: { behold: "0" },
    origin: { dir: "." },
    cut: { kind: "whole" },
    nodes: [node("a"), node("b"), node("c")],
    edges: [
      { id: "b->a", source: "b", target: "a", kind: "ref", inferred: false },
      { id: "c->b", source: "c", target: "b", kind: "ref", inferred: false },
    ],
    groups: [],
    notes: [],
  };
  const keep = (direction: "up" | "down" | "both", depth = 5): string[] => {
    const r = cutDocument(chain, ["b"], { direction, depth });
    if (!r.ok) throw new Error(r.error);
    return ids(r.document);
  };

  it("up keeps only what the seed depends on", () => expect(keep("up")).toEqual(["a", "b"]));
  it("down keeps only what depends on the seed", () => expect(keep("down")).toEqual(["b", "c"]));
  it("both keeps the chain", () => expect(keep("both")).toEqual(["a", "b", "c"]));
  it("depth bounds the walk", () => {
    const r = cutDocument(chain, ["a"], { direction: "down", depth: 1 });
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.document)).toEqual(["a", "b"]);
  });
});

describe("src/graph-cut.ts imports nothing from node: (#1067)", () => {
  const SPECIFIER = /(?:^|[^\w.])(?:import|export)\s*(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("loads no node: module and no package, anywhere in its module graph", () => {
    const files = new Map<string, string[]>();
    const queue = [join(HERE, "graph-cut.ts")];
    while (queue.length) {
      const file = queue.pop()!;
      if (files.has(file)) continue;
      const specs = [...code(readFileSync(file, "utf8")).matchAll(SPECIFIER)].map((m) => (m[1] ?? m[2])!);
      files.set(file, specs);
      for (const spec of specs.filter((s) => s.startsWith("."))) {
        const target = resolve(dirname(file), spec);
        const found = [target, `${target}.ts`, `${target}.js`].find((p) => statSync(p, { throwIfNoEntry: false })?.isFile());
        if (found && /\.(ts|js)$/.test(found)) queue.push(found);
      }
    }
    expect([...files.keys()].some((f) => f.endsWith("/web/cut-around.js"))).toBe(true);
    expect([...files.keys()].some((f) => f.endsWith("/graph-document.ts"))).toBe(true);
    const bare = [...files].flatMap(([file, specs]) => specs.filter((s) => !s.startsWith(".")).map((s) => `${file.slice(HERE.length + 1)} imports ${s}`));
    expect(bare).toEqual([]);
  });
});
