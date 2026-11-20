import { describe, expect, it, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { GraphIR } from "@intentius/chant";
import { checkGraphDocument, GRAPH_DOCUMENT_SCHEMA, GRAPH_DOCUMENT_SCHEMA_URL, type GraphDocument } from "./graph-document.ts";
import { toDocument, type GraphSnapshot } from "./to-document.ts";
import { documentOptions, documentScrubber } from "./graph-document-context.ts";
import { createApp } from "./server.ts";
import { drawnMembers, readWorkspace } from "./workspace.ts";

const HERE = import.meta.dirname;
const FIX = join(HERE, "__fixtures__", "graph-document");
const SCHEMA_FILE = join(HERE, "..", "schemas", "graph", "v1", "graph.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

// Captured by `behold export example-terraform-estate`: the detail 2 and 3
// graph snapshots without their SVG, and the bundle's /api/project.
const snapshot = (name: string): GraphSnapshot => JSON.parse(readFileSync(join(FIX, `terraform-estate-${name}.json`), "utf8")) as GraphSnapshot;
const project = JSON.parse(readFileSync(join(FIX, "terraform-estate-project.json"), "utf8")) as { workspace: { members: Array<{ name: string; dir: string }> } };
// What src/graph-document-context.ts works out for this estate: each member is itself one root.
const MEMBERS = Object.fromEntries(project.workspace.members.map((m) => [m.name, { dir: m.dir, roots: { [m.name]: "." } }]));
const OPTS = { generator: { behold: "0.31.0", chant: "0.124.58" }, origin: { dir: "example-terraform-estate" }, members: MEMBERS };

const valid = (doc: unknown): string[] => (validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`));

/** Every string in a value, keys included. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) out.push(k), strings(x, out);
  return out;
}

describe("toDocument on behold export example-terraform-estate (#1066)", () => {
  for (const name of ["detail-2", "detail-3"]) {
    it(`${name}: validates against the behold-graph/1 schema`, () => {
      const doc = toDocument(snapshot(name), OPTS);
      expect(valid(doc)).toEqual([]);
      expect(doc.schema).toBe(GRAPH_DOCUMENT_SCHEMA);
      expect(doc.nodes).toHaveLength(snapshot(name).ir.nodes.length);
    });

    it(`${name}: every edge's source and target names a node in the document`, () => {
      const doc = toDocument(snapshot(name), OPTS);
      const ids = new Set(doc.nodes.map((n) => n.id));
      expect(ids.size).toBe(doc.nodes.length);
      expect(doc.edges.length).toBeGreaterThan(0);
      for (const e of doc.edges) {
        expect(ids.has(e.source), e.id).toBe(true);
        expect(ids.has(e.target), e.id).toBe(true);
      }
      expect(new Set(doc.edges.map((e) => e.id)).size).toBe(doc.edges.length);
    });

    it(`${name}: the same snapshot converts to byte-identical JSON twice`, () => {
      expect(JSON.stringify(toDocument(snapshot(name), OPTS))).toBe(JSON.stringify(toDocument(snapshot(name), OPTS)));
    });
  }

  it("carries the export's IR in node graph field names, with files from the repository root", () => {
    const doc = toDocument(snapshot("detail-2"), OPTS);
    expect(doc.generator).toEqual({ behold: "0.31.0", chant: "0.124.58" });
    expect(doc.origin).toEqual({ dir: "example-terraform-estate" });
    expect(doc.cut).toEqual({ kind: "whole" });
    expect(doc.groups).toEqual([
      { id: "stack:prod", title: "prod", kind: "stack" },
      { id: "stack:platform", title: "platform", kind: "stack" },
    ]);
    const igw = doc.nodes.find((n) => n.id === "prod/prod/aws_internet_gateway.main")!;
    expect(igw).toMatchObject({
      title: "prod/aws_internet_gateway.main",
      subtitle: "terraform",
      kind: "aws_internet_gateway",
      lexicon: "terraform",
      box: "stack:prod",
      file: "example-terraform-estate/envs/prod/network.tf",
      line: 9,
      detail__member: "prod",
      detail__root: "prod",
    });
    const key = doc.nodes.find((n) => n.id === "platform/platform/aws_kms_key.estate")!;
    expect(key.file).toMatch(/^example-terraform-estate\/platform\/[a-z]+\.tf$/);
    const stack = doc.nodes.find((n) => n.id === "prod/aws_subnet ×3")!;
    expect(stack.stackOf).toEqual(["prod/prod/aws_subnet.private_a", "prod/prod/aws_subnet.public_a", "prod/prod/aws_subnet.public_b"]);
    expect(stack.secondarystat).toBe("3 cards");
    expect(doc.edges[0]).toEqual({ id: "prod/prod/aws_internet_gateway.main->prod/prod/aws_vpc.main:ref:vpc_id", source: "prod/prod/aws_internet_gateway.main", target: "prod/prod/aws_vpc.main", kind: "ref", inferred: false, via: "vpc_id" });
    expect(doc.notes).toEqual([{ kind: "view", text: snapshot("detail-2").meta!.note, short: snapshot("detail-2").meta!.noteShort }]);
  });

  it("leaves attrs.source out unless it is asked for", () => {
    const has = (doc: GraphDocument) => doc.nodes.some((n) => "source" in n.attrs);
    expect(snapshot("detail-2").ir.nodes.some((n) => "source" in n.attrs)).toBe(true);
    expect(has(toDocument(snapshot("detail-2"), OPTS))).toBe(false);
    expect(has(toDocument(snapshot("detail-2"), { ...OPTS, source: true }))).toBe(true);
  });

  it("names no file it cannot place under the repository root", () => {
    const doc = toDocument(snapshot("detail-2"), { generator: { behold: "x" } });
    expect(doc.nodes.filter((n) => n.file !== undefined)).toEqual([]);
    expect(doc.origin).toEqual({ dir: "." });
  });
});

const ir = (over: Partial<GraphIR>): GraphIR => ({ nodes: [], edges: [], groups: {}, ...over }) as GraphIR;
const node = (id: string, attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, kind: "K", lexicon: "aws", attrs, ...extra });

describe("toDocument: the fields an overlay paints and a join draws", () => {
  it("takes status, colour and words from the drift paint, and change from the plan", () => {
    const doc = toDocument(
      {
        ir: ir({
          nodes: [
            node("a", { _status: "warn", _drift: { status: "drifted", read: "plan", label: "drifted (plan)" } }),
            node("b", { _plan: { source: "plan", action: "replace" } }),
            node("c", { _plan: { source: "plan", action: "no-op" }, _status: "bogus" }),
          ] as never,
        }),
      },
      { generator: { behold: "x" } },
    );
    expect(valid(doc)).toEqual([]);
    expect(doc.nodes[0]).toMatchObject({ status: "warn", color: "#FF5A5F", mainstat: "drifted (plan)" });
    expect(doc.nodes[1]).toMatchObject({ change: "replace", mainstat: "replace" });
    expect(doc.nodes[2]).not.toHaveProperty("change");
    expect(doc.nodes[2]).not.toHaveProperty("status");
  });

  it("names the rule behind an inferred edge, behold's pass or chant's catalog rule", () => {
    const doc = toDocument(
      {
        ir: ir({
          nodes: [node("a"), node("b")] as never,
          edges: [
            { from: "a", to: "b", kind: "ref", viaAttr: "Name", inferred: true, join: "estate-member" },
            { from: "a", to: "b", kind: "ref", viaAttr: "Name", origin: "derived", rule: "aws:Role:Tags.Value" },
            { from: "a", to: "b", kind: "ref", viaAttr: "Name" },
          ] as never,
        }),
      },
      { generator: { behold: "x" } },
    );
    expect(doc.edges.map((e) => [e.id, e.inferred, e.rule])).toEqual([
      ["a->b:ref:Name", true, "behold:estate-member"],
      ["a->b:ref:Name#2", true, "aws:Role:Tags.Value"],
      ["a->b:ref:Name#3", false, undefined],
    ]);
  });

  it("leaves out an edge to a card the view does not draw, and says so in notes", () => {
    const doc = toDocument({ ir: ir({ nodes: [node("a")] as never, edges: [{ from: "a", to: "gone", kind: "ref" }] as never }) }, { generator: { behold: "x" } });
    expect(doc.edges).toEqual([]);
    expect(doc.notes).toEqual([{ kind: "edges-left-out", text: "1 edge named a card this view does not draw and was left out", count: 1 }]);
  });

  it("nests pipelines and live containers, and puts each card in its innermost box", () => {
    const doc = toDocument(
      {
        ir: ir({
          nodes: [node("m/wf"), node("m/job"), node("m/vpc"), node("m/subnet"), node("m/vm")] as never,
          groups: { byStack: { m: ["m/wf", "m/job", "m/vpc", "m/subnet", "m/vm"] }, byPipeline: { ci: ["m/wf", "m/job"] }, byContainer: { "m/vpc": ["m/subnet"], "m/subnet": ["m/vm"] } } as never,
        }),
      },
      { generator: { behold: "x" } },
    );
    expect(doc.groups).toEqual([
      { id: "stack:m", title: "m", kind: "stack" },
      { id: "pipeline:ci", title: "ci", kind: "pipeline", parent: "stack:m" },
      { id: "container:m/vpc", title: "m/vpc", kind: "container", parent: "stack:m" },
      { id: "container:m/subnet", title: "m/subnet", kind: "container", parent: "container:m/vpc" },
    ]);
    expect(Object.fromEntries(doc.nodes.map((n) => [n.id, n.box]))).toEqual({ "m/wf": "pipeline:ci", "m/job": "pipeline:ci", "m/vpc": "stack:m", "m/subnet": "container:m/vpc", "m/vm": "container:m/subnet" });
  });

  it("reads owner hints: namespace and Helm release on a Kubernetes object", () => {
    const doc = toDocument(
      { ir: ir({ nodes: [{ id: "web", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { metadata: { namespace: "shop", annotations: { "meta.helm.sh/release-name": "storefront" } } } }] as never }) },
      { generator: { behold: "x" } },
    );
    expect(doc.nodes[0]).toMatchObject({ subtitle: "kubernetes", detail__namespace: "shop", detail__release: "storefront" });
  });

  it("drops a sourceLoc that is absolute or leaves the repository", () => {
    const doc = toDocument(
      { ir: ir({ nodes: [node("a", {}, { sourceLoc: { file: "/home/me/x.ts" } }), node("b", {}, { sourceLoc: { file: "../../x.ts" } }), node("c", {}, { sourceLoc: { file: "src/c.ts", line: 4 } })] as never }) },
      { generator: { behold: "x" }, origin: { dir: "infra" } },
    );
    expect(doc.nodes.map((n) => [n.file, n.line])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      ["infra/src/c.ts", 4],
    ]);
  });
});

describe("checkGraphDocument: a reader refuses a version it does not know", () => {
  it("reads behold-graph/1 and refuses behold-graph/2 by name", () => {
    const doc = toDocument(snapshot("detail-2"), OPTS);
    expect(checkGraphDocument(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
    expect(checkGraphDocument({ ...doc, schema: "behold-graph/2" })).toEqual({ ok: false, error: "behold-graph/2 is a graph document version this reader does not know; it reads behold-graph/1" });
    expect(checkGraphDocument({ ir: {} })).toEqual({ ok: false, error: "not a behold graph document: no `schema` field" });
    expect(checkGraphDocument({ ...doc, edges: undefined })).toMatchObject({ ok: false });
    expect(valid({ ...doc, schema: "behold-graph/2" })).not.toEqual([]);
  });

  it("keeps fields it does not know, and the schema allows them", () => {
    const doc = { ...toDocument(snapshot("detail-2"), OPTS), later: { added: true } };
    expect(valid(doc)).toEqual([]);
    expect(checkGraphDocument(doc)).toMatchObject({ ok: true, document: { later: { added: true } } });
  });

  it("imports nothing, so a browser host loads it as it is", () => {
    expect(readFileSync(join(HERE, "graph-document.ts"), "utf8")).not.toMatch(/^\s*import\s/m);
  });
});

describe("the schema is published where other repositories fetch it", () => {
  it("ships in the package and on the docs site, the same bytes, under its $id", () => {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("schemas");
    expect(readFileSync(join(HERE, "..", "docs", "public", "schemas", "graph", "v1", "graph.schema.json"), "utf8")).toBe(readFileSync(SCHEMA_FILE, "utf8"));
    expect(schema.$id).toBe(GRAPH_DOCUMENT_SCHEMA_URL);
    // The docs site is published at intentius.io/behold, and public/ is its root.
    expect(GRAPH_DOCUMENT_SCHEMA_URL).toBe("https://intentius.io/behold/schemas/graph/v1/graph.schema.json");
  });
});

describe("documentScrubber", () => {
  it("rewrites served paths to repository-relative ones, then home and the temporary directory", () => {
    const s = documentScrubber("/r", ["/r/infra", "/r/infra/envs/prod"], "/home/me", "/tmpdir");
    expect(s("/r/infra/envs/prod/main.tf and /r/infra/x and /r/README and /home/me/.kube and /tmpdir/behold-1")).toBe("infra/envs/prod/main.tf and infra/x and README and ~/.kube and $TMPDIR/behold-1");
  });
});

// A real read, from a copy of the estate in the OS temporary directory: the
// document names none of that directory, though chant and behold read it there.
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("a document read from a fixture in the OS temp directory", () => {
  it("contains no string with that path", { timeout: 120_000 }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "behold-1066-"));
    made.push(tmp);
    const root = join(tmp, "estate");
    cpSync(join(HERE, "..", "example-terraform-estate"), root, { recursive: true });
    // The estate pins the terraform lexicon, which resolves from behold's own install, as it does for the checked-in example.
    symlinkSync(join(HERE, "..", "node_modules"), join(tmp, "node_modules"));
    const read = await readWorkspace(root);
    if (!read.ok) throw new Error(read.refusal.error);
    const drawn = drawnMembers(read.workspace).map((m) => m.abs);
    expect(drawn).toHaveLength(2);
    const cfg = { projectDir: drawn[0]!, projectDirs: drawn, workspace: read.workspace, port: 0 };
    const res = await createApp(cfg).request("/api/graph?detail=3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GraphSnapshot;
    const opts = documentOptions({ ...cfg, behold: "0.31.0", rev: "abc123" });
    const doc = toDocument({ ir: body.ir, meta: body.meta }, { ...opts, source: true });

    expect(valid(doc)).toEqual([]);
    expect(doc.nodes.length).toBeGreaterThan(20);
    const paths = [tmp, realpathSync(tmp), tmpdir(), realpathSync(tmpdir())];
    const leaks = strings(doc).filter((s) => paths.some((p) => s.includes(p)));
    expect(leaks).toEqual([]);
    // Not a repository, so the estate is its own root; members and roots come from the disk.
    expect(doc.origin).toEqual({ dir: ".", rev: "abc123" });
    expect(opts.members).toEqual({ prod: { dir: "envs/prod", roots: { prod: "." } }, platform: { dir: "platform", roots: { platform: "." } } });
    expect(doc.nodes.find((n) => n.id === "prod/prod/aws_vpc.main")?.file).toBe("envs/prod/network.tf");
  });
});
