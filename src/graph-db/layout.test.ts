// behold#1031: the graph pane's layout is generated from chant's graph schema
// (chant#4527), checked for drift, and the loaders fill it as before over
// chant's fixtures (./__fixtures__, copies source.json records the sha256 of).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GraphDb } from "./db.ts";
import { fakeLbug } from "./fake-lbug.ts";
import { main } from "./generate-layout.ts";
import { LayoutError, generateLayout, sha256, type GraphLayout, type LayoutColumn } from "./layout-gen.ts";
import { GRAPH_LAYOUT } from "./layout.generated.ts";
import { GRAPH_DB_DIR, VENDORED_LAYOUT, activeLayout, chantSchemaPath, checkDrift, installedChantDir, layoutSource, readVendoredSource } from "./layout.ts";
import { emptyRows, finishRows, rowsFromEngineGraph, rowsFromIndex, type LoadedRows } from "./rows.ts";
import type { EngineGraphDocument, IndexDocument } from "./types.ts";

type Json = Record<string, any>;
const FIXTURES = ["choudoufu.engine-graph.json", "plunge.engine-graph.json", "index.json"] as const;
const vendoredText = readFileSync(join(GRAPH_DB_DIR, "chant-schema", "graph.schema.json"), "utf8");
const vendored = (): Json => JSON.parse(vendoredText) as Json;
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(GRAPH_DB_DIR, "__fixtures__", name), "utf8")) as T;
const readAt = "2026-10-26T13:00:00.000Z";
const source = layoutSource(readVendoredSource());

/** A copy of the files the drift check reads, to break one at a time. */
function copyDir(): string {
  const d = mkdtempSync(join(tmpdir(), "behold-layout-"));
  cpSync(join(GRAPH_DB_DIR, "chant-schema"), join(d, "chant-schema"), { recursive: true });
  mkdirSync(join(d, "__fixtures__"));
  for (const f of FIXTURES) cpSync(join(GRAPH_DB_DIR, "__fixtures__", f), join(d, "__fixtures__", f));
  cpSync(join(GRAPH_DB_DIR, "layout.generated.ts"), join(d, "layout.generated.ts"));
  return d;
}

/** A directory laid out as an installed chant package holding `schema`. */
function chantPackage(schema: Json | string, version = "0.124.60"): string {
  const d = mkdtempSync(join(tmpdir(), "behold-chant-"));
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@intentius/chant", version }));
  mkdirSync(join(d, "src", "graph-schema"), { recursive: true });
  writeFileSync(join(d, "src", "graph-schema", "graph.schema.json"), typeof schema === "string" ? schema : `${JSON.stringify(schema, null, 2)}\n`);
  return d;
}

/** The vendored schema with a field chant might add: `IRNode.region` and `IREdge.weight`. */
function withNewFields(): Json {
  const s = vendored();
  s.$defs.IRNode.properties.region = { type: "string" };
  s.$defs.IREdge.properties.weight = { type: "number" };
  return s;
}

const cols = (layout: GraphLayout, table: string): readonly LayoutColumn[] => layout.tables.find((t) => t.name === table)!.columns;

function fixtureRows(layout?: GraphLayout): LoadedRows {
  const rows = emptyRows(layout);
  rowsFromEngineGraph(fixture<EngineGraphDocument>("choudoufu.engine-graph.json"), { readAt, from: "choudoufu" }, rows);
  rowsFromEngineGraph(fixture<EngineGraphDocument>("plunge.engine-graph.json"), { member: "app", readAt, from: "plunge" }, rows);
  rowsFromIndex(fixture<IndexDocument>("index.json"), { version: "v1", readAt, from: "index" }, rows);
  return finishRows(rows);
}

describe("the generated layout", () => {
  it("is #1027's hand-written layout, with chant's and the engine's ownership in two columns (behold#906 Q4)", () => {
    expect(GRAPH_LAYOUT.ddl).toEqual([
      "CREATE NODE TABLE Resource(key STRING, source STRING, scopeKey STRING, version STRING, id STRING, kind STRING, lexicon STRING, listedType STRING, location STRING, nativeId STRING, name STRING, address STRING, ownership STRING, engineOwnership STRING, attrs STRING, tags STRING, facts STRING, observedAt STRING, PRIMARY KEY(key))",
      "CREATE NODE TABLE CloudId(value STRING, kind STRING, PRIMARY KEY(value))",
      "CREATE REL TABLE KNOWN_AS(FROM Resource TO CloudId)",
      "CREATE REL TABLE REF(FROM Resource TO Resource, kind STRING, viaAttr STRING, toAttr STRING, grain STRING, origin STRING, rule STRING, relation STRING, ambiguous BOOLEAN)",
    ]);
    expect(GRAPH_LAYOUT.inserts.KNOWN_AS).toBe("MATCH (r:Resource {key: $key}), (c:CloudId {value: $value}) CREATE (r)-[:KNOWN_AS]->(c)");
    expect(GRAPH_LAYOUT.inserts.REF).toBe(
      "MATCH (a:Resource {key: $from}), (b:Resource {key: $to}) CREATE (a)-[:REF {kind: $kind, viaAttr: $viaAttr, toAttr: $toAttr, grain: $grain, origin: $origin, rule: $rule, relation: $relation, ambiguous: $ambiguous}]->(b)",
    );
  });

  it("takes each column's type and values from the schema, and names the chant commit and sha256 it came from", () => {
    const r = cols(VENDORED_LAYOUT, "Resource");
    expect(r.find((c) => c.name === "ownership")).toEqual({ name: "ownership", type: "STRING", from: "IRNode.ownership", values: ["foreign", "owned"] });
    expect(r.find((c) => c.name === "engineOwnership")).toEqual({ name: "engineOwnership", type: "STRING", from: "behold", values: ["bound", "foreign", "pending", "unowned"] });
    expect(r.find((c) => c.name === "facts")).toMatchObject({ from: "IRNode.facts", json: true });
    expect(r.find((c) => c.name === "tags")).toMatchObject({ from: "IRNode.tags", json: true });
    expect(cols(VENDORED_LAYOUT, "REF").find((c) => c.name === "grain")).toMatchObject({ values: ["block", "instance", "property"] });
    expect(VENDORED_LAYOUT.source).toEqual({ ...source, sha256: sha256(vendoredText) });
    expect(VENDORED_LAYOUT.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the drift check", () => {
  it("passes on the checked-in files", () => {
    expect(checkDrift({ chantDir: null }).problems).toEqual([]);
  });

  const installed = installedChantDir();
  it.skipIf(!installed || !chantSchemaPath(installed))("passes against the installed chant's schema when it ships one", () => {
    expect(checkDrift({}).problems).toEqual([]);
  });

  it("says when no chant beside behold ships the schema, and does not fail for it", () => {
    const empty = mkdtempSync(join(tmpdir(), "behold-chant-"));
    const r = checkDrift({ chantDir: empty });
    expect(r.problems).toEqual([]);
    expect(r.skipped.join("\n")).toMatch(/ships no graph schema/);
  });

  it("fails when the vendored copy was edited by hand", () => {
    const d = copyDir();
    writeFileSync(join(d, "chant-schema", "graph.schema.json"), vendoredText.replace('"title": "chant-graph/v1"', '"title": "chant-graph/v1 (edited)"'));
    expect(checkDrift({ dir: d, chantDir: null }).problems.join("\n")).toMatch(/edited by hand/);
  });

  it("fails when the generated layout is not the vendored schema's, until it is regenerated", () => {
    const d = copyDir();
    const text = `${JSON.stringify(withNewFields(), null, 2)}\n`;
    writeFileSync(join(d, "chant-schema", "graph.schema.json"), text);
    const src = JSON.parse(readFileSync(join(d, "chant-schema", "source.json"), "utf8")) as Json;
    writeFileSync(join(d, "chant-schema", "source.json"), JSON.stringify({ ...src, sha256: sha256(text) }));
    expect(checkDrift({ dir: d, chantDir: null }).problems.join("\n")).toMatch(/layout\.generated\.ts is not the layout/);
    expect(main([], d)).toBe(0);
    expect(checkDrift({ dir: d, chantDir: null }).problems).toEqual([]);
    expect(readFileSync(join(d, "layout.generated.ts"), "utf8")).toContain("region STRING");
  });

  it("fails when chant's schema is not the vendored copy, and names what the layout would change", () => {
    const r = checkDrift({ chantDir: chantPackage(withNewFields()) });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/is not behold's vendored copy/);
    expect(r.problems[0]).toMatch(/Resource\.region: added/);
    expect(r.problems[0]).toMatch(/REF\.weight: added \(DOUBLE/);
    expect(checkDrift({ chantDir: chantPackage(vendoredText) }).problems).toEqual([]);
  });

  it("fails when a fixture copied from chant is not the recorded one", () => {
    const d = copyDir();
    const f = join(d, "__fixtures__", "index.json");
    writeFileSync(f, readFileSync(f, "utf8").replace("web-logs", "web-logz"));
    expect(checkDrift({ dir: d, chantDir: null }).problems.join("\n")).toMatch(/__fixtures__\/index\.json is not chant's fixture/);
  });

  it("--check exits 1 on drift and 0 without", () => {
    const d = copyDir();
    expect(main(["--check", "--chant", mkdtempSync(join(tmpdir(), "behold-chant-"))], d)).toBe(0);
    writeFileSync(join(d, "layout.generated.ts"), "// stale\n");
    expect(main(["--check", "--chant", mkdtempSync(join(tmpdir(), "behold-chant-"))], d)).toBe(1);
  });

  it("--sync copies a chant's schema, records its sha256, and regenerates", () => {
    const d = copyDir();
    const chant = chantPackage(withNewFields());
    expect(main(["--sync", chant], d)).toBe(0);
    const src = JSON.parse(readFileSync(join(d, "chant-schema", "source.json"), "utf8")) as Json;
    expect(src.sha256).toBe(sha256(readFileSync(join(chant, "src", "graph-schema", "graph.schema.json"))));
    expect(src.commit).toBe("v0.124.60");
    expect(checkDrift({ dir: d, chantDir: chant }).problems).toEqual([]);
  });
});

describe("a schema behold cannot lay out", () => {
  it("refuses one without a field behold reads", () => {
    const s = vendored();
    delete s.$defs.IRNode.properties.listedType;
    expect(() => generateLayout(s, source)).toThrow(LayoutError);
    expect(() => generateLayout(s, source)).toThrow(/IRNode\.listedType/);
  });

  it("refuses a new field that takes the name of one of behold's own columns", () => {
    const s = vendored();
    s.$defs.IRNode.properties.engineOwnership = { type: "string" };
    expect(() => generateLayout(s, source)).toThrow(/takes the name of behold's own Resource\.engineOwnership/);
  });

  it("refuses documents whose nodes are no longer IRNode, and cloud ids no longer EngineCloudId", () => {
    const a = vendored();
    a.$defs.IndexDocument.properties.graph = { type: "object" };
    expect(() => generateLayout(a, source)).toThrow(/IndexDocument\.graph/);
    const b = vendored();
    b.$defs.EngineFacts.properties.cloudIds = { type: "array", items: { type: "string" } };
    expect(() => generateLayout(b, source)).toThrow(/IRNode\.facts\.cloudIds\[\] is an inline shape/);
  });
});

describe("the layout at run time", () => {
  it("without a chant, or with one whose schema is the vendored copy, is the vendored layout", () => {
    expect(activeLayout({ chantDir: null })).toMatchObject({ from: "vendored", notes: [] });
    expect(activeLayout({ chantDir: chantPackage(vendoredText) })).toMatchObject({ from: "vendored", chantVersion: "0.124.60", notes: [] });
    expect(activeLayout({ chantDir: mkdtempSync(join(tmpdir(), "behold-chant-")) }).layout).toBe(VENDORED_LAYOUT);
  });

  it("follows a newer chant's schema, and says what changed", () => {
    const a = activeLayout({ chantDir: chantPackage(withNewFields()) });
    expect(a.from).toBe("chant");
    expect(a.layout.ddl[0]).toContain("observedAt STRING, region STRING, PRIMARY KEY(key)");
    expect(a.notes.join("\n")).toMatch(/chant 0\.124\.60's graph schema .* Resource\.region: added/);
  });

  it("falls back to the vendored layout, with a note, when the installed schema cannot be laid out", () => {
    const s = vendored();
    delete s.$defs.IRNode.properties.nativeId;
    const a = activeLayout({ chantDir: chantPackage(s) });
    expect(a.from).toBe("vendored");
    expect(a.layout).toBe(VENDORED_LAYOUT);
    expect(a.notes.join("\n")).toMatch(/could not be laid out .*IRNode\.nativeId/);
  });
});

describe("the loaders over chant's fixtures fill the layout", () => {
  const typeOk = (c: LayoutColumn, v: unknown): boolean => (c.type === "BOOLEAN" ? typeof v === "boolean" : c.type === "STRING" ? typeof v === "string" : typeof v === "number");

  it("every row holds exactly the layout's columns, each of its column's type, enums inside the schema's values", () => {
    const rows = fixtureRows();
    expect(rows.resources.length).toBeGreaterThan(0);
    const resource = cols(VENDORED_LAYOUT, "Resource");
    for (const r of rows.resources) {
      expect(Object.keys(r).sort()).toEqual(resource.map((c) => c.name).sort());
      for (const c of resource) {
        const v = (r as unknown as Record<string, unknown>)[c.name];
        expect(typeOk(c, v), `${r.key}.${c.name}`).toBe(true);
        if (c.json && v !== "") expect(() => JSON.parse(v as string)).not.toThrow();
        if (c.values && v !== "") expect(c.values).toContain(v);
      }
    }
    const ref = cols(VENDORED_LAYOUT, "REF");
    expect(rows.refs.length).toBeGreaterThan(0);
    for (const e of rows.refs) {
      expect(Object.keys(e).sort()).toEqual([...ref.map((c) => c.name), "from", "to"].sort());
      for (const c of ref) if (c.values && (e as unknown as Record<string, string>)[c.name] !== "") expect(c.values).toContain((e as unknown as Record<string, string>)[c.name]);
    }
    for (const c of rows.cloudIds) expect(cols(VENDORED_LAYOUT, "CloudId").find((x) => x.name === "kind")!.values).toContain(c.kind);
  });

  it("an engine's verdict goes to engineOwnership, chant's to ownership (behold#906 Q4)", () => {
    const rows = fixtureRows();
    const bucket = rows.resources.find((r) => r.id === "aws_s3_bucket.logs" && r.source === "engine")!;
    expect(bucket).toMatchObject({ engineOwnership: "bound", ownership: "" });
    const queue = rows.resources.find((r) => r.id === "aws_sqs_queue.jobs")!;
    expect(queue.engineOwnership).toBe("foreign");
  });

  it("a newer chant's layout leaves every vendored column as it was, and fills the new fields from the documents", () => {
    const newer = activeLayout({ chantDir: chantPackage(withNewFields()) }).layout;
    const index = fixture<IndexDocument>("index.json");
    (index.graph.nodes[0] as unknown as Json).region = "us-east-1";
    const before = fixtureRows();
    const rows = emptyRows(newer);
    rowsFromEngineGraph(fixture<EngineGraphDocument>("choudoufu.engine-graph.json"), { readAt, from: "choudoufu" }, rows);
    rowsFromEngineGraph(fixture<EngineGraphDocument>("plunge.engine-graph.json"), { member: "app", readAt, from: "plunge" }, rows);
    rowsFromIndex(index, { version: "v1", readAt, from: "index" }, rows);
    finishRows(rows);
    expect(rows.resources.map((r) => {
      const { region: _r, ...rest } = r as unknown as Json;
      return rest;
    })).toEqual(before.resources);
    expect(rows.resources.find((r) => r.source === "index")).toMatchObject({ region: "us-east-1" });
    expect(rows.resources.filter((r) => r.source === "engine").every((r) => (r as unknown as Json).region === "")).toBe(true);
    expect(rows.refs.every((e) => (e as unknown as Json).weight === 0)).toBe(true);
  });

  it("the database is built with the rows' layout", async () => {
    const newer = activeLayout({ chantDir: chantPackage(withNewFields()) }).layout;
    const { module, log } = fakeLbug();
    const db = await GraphDb.build(module, emptyRows(newer), mkdtempSync(join(tmpdir(), "behold-graph-")));
    for (const ddl of newer.ddl) expect(log.statements).toContain(ddl);
    expect(log.statements).not.toContain(VENDORED_LAYOUT.ddl[0]);
    await db.close();
  });
});
