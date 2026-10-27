// behold#1027: the session database. The read-only rules, the build against a stand-in of
// @ladybugdb/core, and Cypher over a loaded fixture against the real engine when the optional
// peer is installed (`npm i -g @ladybugdb/core` or beside behold; otherwise those cases skip).
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CypherRefused, GraphDb, SCHEMA, checkReadQuery, graphDbDir, plain, writeClause } from "./db.ts";
import { fakeLbug } from "./fake-lbug.ts";
import { loadLadybug } from "./peer.ts";
import { emptyRows, finishRows, rowsFromChantIr, rowsFromEngineGraph, rowsFromIndex } from "./rows.ts";
import type { EngineGraphDocument, IndexDocument } from "./types.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8"));
const readAt = "2026-10-26T13:00:00.000Z";

function fixtureRows() {
  const rows = emptyRows();
  rowsFromChantIr(
    {
      version: 1,
      nodes: [
        { id: "aws_s3_bucket.logs", kind: "aws_s3_bucket", lexicon: "terraform", attrs: { name: "logs" }, physicalId: "web-logs" },
        { id: "aws_instance.web", kind: "aws_instance", lexicon: "terraform", attrs: { name: "web", logs: "arn:aws:s3:::web-logs" } },
      ],
      edges: [{ from: "aws_instance.web", to: "aws_s3_bucket.logs", kind: "ref", viaAttr: "logs" }],
      groups: {},
    },
    { member: "web", readAt, from: "x" },
    rows,
  );
  rowsFromEngineGraph(fixture("choudoufu.engine-graph.json") as EngineGraphDocument, { readAt, from: "x" }, rows);
  rowsFromEngineGraph(fixture("plunge.engine-graph.json") as EngineGraphDocument, { readAt, from: "x" }, rows);
  rowsFromIndex(fixture("index.json") as IndexDocument, { version: "v", readAt, from: "x" }, rows);
  return finishRows(rows);
}

describe("a query that writes is refused before it runs", () => {
  it("refuses every write clause, whatever its case", () => {
    for (const q of [
      "CREATE (:Resource {key: 'x'})",
      "MATCH (r:Resource) SET r.kind = 'x'",
      "match (r:Resource) detach delete r",
      "MATCH (r) MERGE (r)-[:REF]->(r)",
      "COPY (MATCH (r:Resource) RETURN r.key) TO '/tmp/out.csv'",
      "LOAD FROM '/etc/passwd' RETURN *",
      "INSTALL httpfs",
      "ATTACH '/tmp/other.lbdb' AS o",
      "EXPORT DATABASE '/tmp/dump'",
      "CALL show_tables() RETURN *",
      "DROP TABLE Resource",
    ]) {
      expect(() => checkReadQuery(q), q).toThrow(CypherRefused);
    }
  });

  it("reads a word inside a string, a comment or a property name as no clause", () => {
    expect(writeClause("MATCH (r:Resource) WHERE r.kind = 'CREATE' RETURN r.key")).toBeUndefined();
    expect(writeClause("MATCH (r:Resource) // delete nothing\nRETURN r.set")).toBeUndefined();
    expect(writeClause("MATCH (r:Resource) RETURN r.key AS `delete`")).toBeUndefined();
    expect(checkReadQuery("  MATCH (r:Resource) RETURN r.key  ")).toBe("MATCH (r:Resource) RETURN r.key");
  });

  it("refuses an empty query and one past the length limit", () => {
    expect(() => checkReadQuery("   ")).toThrow(/empty/);
    expect(() => checkReadQuery(`MATCH (r) RETURN r.key ${" ".repeat(9000)}x`)).toThrow(/at most/);
  });
});

describe("where the database lives", () => {
  it("is behold's own directory: BEHOLD_GRAPH_DIR, else the XDG data home, else ~/.local/share", () => {
    expect(graphDbDir({ BEHOLD_GRAPH_DIR: "/g" }, "/h")).toBe("/g");
    expect(graphDbDir({ XDG_DATA_HOME: "/x" }, "/h")).toBe(join("/x", "behold", "graph"));
    expect(graphDbDir({}, "/h")).toBe(join("/h", ".local", "share", "behold", "graph"));
  });
});

describe("the build, against a stand-in", () => {
  it("creates the three tables of behold#1025, loads every row, then reopens the file read-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-graph-"));
    const { module, log } = fakeLbug();
    const rows = fixtureRows();
    const db = await GraphDb.build(module, rows, dir);
    for (const ddl of SCHEMA) expect(log.statements).toContain(ddl);
    const created = (what: string) => log.executed.filter((e) => e.statement.includes(what)).length;
    expect(created("CREATE (:Resource")).toBe(rows.resources.length);
    expect(created("CREATE (:CloudId")).toBe(rows.cloudIds.length);
    expect(created("[:KNOWN_AS]")).toBe(rows.knownAs.length);
    expect(created("[:REF")).toBe(rows.refs.length);
    expect(log.opened.map((o) => o.readOnly)).toEqual([false, true]);
    expect(log.opened[0]!.path).toBe(log.opened[1]!.path);
    expect(log.opened[0]!.path!.startsWith(dir)).toBe(true);
    await db.close();
  });

  it("prepares every query first: a statement the engine cannot parse is refused as invalid", async () => {
    const { module } = fakeLbug();
    const db = await GraphDb.build(module, emptyRows(), mkdtempSync(join(tmpdir(), "behold-graph-")));
    await expect(db.query("MATCH (r:Resource) RETURN r.key")).resolves.toMatchObject({ rows: [] });
    await expect(db.query("MATCH (r:Resource) SYNTAX ERROR")).rejects.toMatchObject({ code: "cypher-invalid" });
    await db.close();
  });

  it("refuses a query LadybugDB calls a write, even one the clause check let through", async () => {
    const { module, log } = fakeLbug(() => [], { readOnly: (s) => !s.includes("sneaky") });
    const db = await GraphDb.build(module, emptyRows(), mkdtempSync(join(tmpdir(), "behold-graph-")));
    await expect(db.query("MATCH (r:Resource) RETURN sneaky(r)")).rejects.toMatchObject({ code: "cypher-write" });
    expect(log.executed.some((e) => e.statement.includes("sneaky"))).toBe(false);
    await db.close();
  });

  it("answers rows as JSON, and collects every Resource key an answer holds", async () => {
    const { module } = fakeLbug(() => [{ "r.key": "web/aws_instance.web", n: { _label: "Resource", _id: { offset: 1, table: 0 }, key: "web/aws_s3_bucket.logs" }, c: 3n }]);
    const db = await GraphDb.build(module, emptyRows(), mkdtempSync(join(tmpdir(), "behold-graph-")));
    const a = await db.query("MATCH (r:Resource) RETURN r.key");
    expect(a.rows[0]).toEqual({ "r.key": "web/aws_instance.web", n: { label: "Resource", key: "web/aws_s3_bucket.logs" }, c: 3 });
    expect(a.keys.sort()).toEqual(["web/aws_instance.web", "web/aws_s3_bucket.logs"]);
    await db.close();
  });

  it("removes its own file on close, and nothing beside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-graph-"));
    const { module } = fakeLbug();
    const db = await GraphDb.build(module, emptyRows(), dir);
    await db.close();
    expect(readdirSync(dir)).toEqual([]);
    expect(plain(2n ** 60n)).toBe((2n ** 60n).toString());
  });
});

const peer = await loadLadybug();

describe.runIf(peer.ok)("Cypher over a loaded fixture, on the real engine", () => {
  const build = async () => GraphDb.build((peer as { lbug: Parameters<typeof GraphDb.build>[0] }).lbug, fixtureRows(), mkdtempSync(join(tmpdir(), "behold-graph-")));

  it("answers the cross-source join: the bucket chant declares, choudoufu binds and the index lists is one CloudId", async () => {
    const db = await build();
    const a = await db.query(
      "MATCH (a:Resource)-[:KNOWN_AS]->(c:CloudId {value: $v})<-[:KNOWN_AS]-(b:Resource) WHERE a.key < b.key RETURN a.key AS a, b.key AS b ORDER BY a, b",
      { v: "web-logs" },
    );
    expect(a.rows).toHaveLength(3);
    expect(a.keys).toEqual(expect.arrayContaining(["web/aws_s3_bucket.logs", "engine/choudoufu/web/aws_s3_bucket.logs"]));
    await db.close();
  });

  it("walks REF edges with their grain, and finds the derived identity edge with its rule", async () => {
    const db = await build();
    const grains = await db.query("MATCH (a:Resource)-[e:REF]->(b:Resource) WHERE a.scopeKey = 'engine/plunge/app/dev' RETURN e.grain AS grain ORDER BY grain");
    expect(grains.rows.map((r) => r.grain)).toEqual(["instance", "instance", "property"]);
    const derived = await db.query("MATCH (a:Resource {key: 'web/aws_instance.web'})-[e:REF]->(b:Resource) WHERE e.origin = 'derived' RETURN b.key AS key, e.rule AS rule");
    expect(derived.rows).toContainEqual({ key: "engine/choudoufu/web/aws_s3_bucket.logs", rule: "identity:arn" });
    await db.close();
  });

  it("is read-only: a write is refused and the database is unchanged", async () => {
    const db = await build();
    const before = await db.query("MATCH (r:Resource) RETURN count(r) AS n");
    await expect(db.query("CREATE (:Resource {key: 'x'})")).rejects.toThrow(CypherRefused);
    const after = await db.query("MATCH (r:Resource) RETURN count(r) AS n");
    expect(after.rows).toEqual(before.rows);
    await db.close();
  });
});
