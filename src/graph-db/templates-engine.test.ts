// behold#1121: every Cypher template behold offers, run on the real engine over disjoint copies of
// one small estate, with the answer for each copy worked out by hand. LadybugDB 0.21.2 and 0.22.0
// return one row where a mixed-direction multi-hop MATCH should return one per copy (chant#4361),
// and its relationship patterns do not require distinct relationships, so a `->()<-` step can come
// back over the edge it went out on. A template whose answer depends on either shows here as a wrong
// count. Runs when the optional peer is installed (beside behold or `npm i -g @ladybugdb/core`);
// otherwise it skips, as the real-engine cases in db.test.ts do, unless BEHOLD_REQUIRE_LADYBUG=1 (CI), which fails.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GraphDb } from "./db.ts";
import { realLadybug } from "./fake-lbug.ts";
import type { LbugModule } from "./peer.ts";
import { emptyRows, finishRows, rowsFromChantIr } from "./rows.ts";
import { chantCatalog, expandTemplate } from "./templates.ts";

const TEMPLATES = chantCatalog().templates;

const readAt = "2026-11-16T12:00:00.000Z";

/**
 * Copy k of the estate: three members, one bucket declared twice (app and net, one cloud id),
 * read from ops by reference and from net through its own copy, and a two-role cycle.
 *
 *   ops/batch -> app/data <- app/web      app/data -> app/a <-> app/b
 *   net/reader -> net/data                app/data and net/data share cloud id data-<k>
 */
function estate(copies: number) {
  const nodes: object[] = [];
  const edges: object[] = [];
  for (let k = 0; k < copies; k++) {
    const id = (m: string, n: string) => `${m}${k}/${n}`;
    nodes.push(
      { id: id("app", "aws_s3_bucket.data"), kind: "aws_s3_bucket", lexicon: "terraform", attrs: {}, physicalId: `data-${k}` },
      { id: id("app", "aws_instance.web"), kind: "aws_instance", lexicon: "terraform", attrs: {} },
      { id: id("app", "aws_iam_role.a"), kind: "aws_iam_role", lexicon: "terraform", attrs: {} },
      { id: id("app", "aws_iam_role.b"), kind: "aws_iam_role", lexicon: "terraform", attrs: {} },
      { id: id("net", "aws_s3_bucket.data"), kind: "aws_s3_bucket", lexicon: "terraform", attrs: {}, physicalId: `data-${k}` },
      { id: id("net", "aws_lambda_function.reader"), kind: "aws_lambda_function", lexicon: "terraform", attrs: {} },
      { id: id("ops", "aws_instance.batch"), kind: "aws_instance", lexicon: "terraform", attrs: {} },
    );
    const ref = (from: string, to: string, viaAttr: string) => ({ from, to, kind: "ref", viaAttr });
    edges.push(
      ref(id("app", "aws_instance.web"), id("app", "aws_s3_bucket.data"), "bucket"),
      ref(id("ops", "aws_instance.batch"), id("app", "aws_s3_bucket.data"), "bucket"),
      ref(id("net", "aws_lambda_function.reader"), id("net", "aws_s3_bucket.data"), "bucket"),
      ref(id("app", "aws_s3_bucket.data"), id("app", "aws_iam_role.a"), "role"),
      ref(id("app", "aws_iam_role.a"), id("app", "aws_iam_role.b"), "next"),
      ref(id("app", "aws_iam_role.b"), id("app", "aws_iam_role.a"), "next"),
    );
  }
  const members = [...Array(copies).keys()].flatMap((k) => [`app${k}`, `net${k}`, `ops${k}`]);
  return finishRows(rowsFromChantIr({ version: 1, nodes, edges, groups: {} } as never, { members, readAt, from: "x" }));
}

/** The answer for copy k, by hand: the template, its node, and the sorted keys (or row count) it returns. */
const EXPECTED: Array<{ template: string; node: string; keys?: string[]; rows?: number }> = [
  { template: "dependents-all", node: "app{k}/aws_s3_bucket.data", keys: ["app{k}/aws_instance.web", "ops{k}/aws_instance.batch"] },
  {
    template: "dependents-all",
    node: "app{k}/aws_iam_role.a",
    keys: ["app{k}/aws_iam_role.a", "app{k}/aws_iam_role.b", "app{k}/aws_instance.web", "app{k}/aws_s3_bucket.data", "ops{k}/aws_instance.batch"],
  },
  { template: "dependencies-all", node: "app{k}/aws_instance.web", keys: ["app{k}/aws_iam_role.a", "app{k}/aws_iam_role.b", "app{k}/aws_s3_bucket.data"] },
  { template: "dependencies-all", node: "app{k}/aws_iam_role.a", keys: ["app{k}/aws_iam_role.a", "app{k}/aws_iam_role.b"] },
  { template: "same-object", node: "app{k}/aws_s3_bucket.data", keys: ["net{k}/aws_s3_bucket.data"] },
  { template: "same-object", node: "app{k}/aws_instance.web", keys: [] },
  // The second branch joins through the cloud id, and can come back to app/data over the edge it left by; UNION keeps one row.
  { template: "readers", node: "app{k}/aws_s3_bucket.data", keys: ["net{k}/aws_lambda_function.reader", "ops{k}/aws_instance.batch"] },
  { template: "readers", node: "net{k}/aws_s3_bucket.data", keys: ["app{k}/aws_instance.web", "ops{k}/aws_instance.batch"] },
  { template: "ownership", node: "app{k}/aws_s3_bucket.data", rows: 1 },
  { template: "history", node: "app{k}/aws_s3_bucket.data", rows: 1 },
];

/** chant#4361's repro in behold's tables: copies of a six-node chain, three hops out and three back, a property filter on each REF. */
function chains(copies: number) {
  const nodes: object[] = [];
  const edges: object[] = [];
  const steps: Array<[string, string, string]> = [["i", "s", "subnet"], ["a", "s", "subnet"], ["a", "t", "table"], ["r", "t", "table"], ["r", "g", "gateway"]];
  for (let k = 0; k < copies; k++) {
    for (const [n, kind] of [["i", "Instance"], ["s", "Subnet"], ["a", "Assoc"], ["t", "Table"], ["r", "Route"], ["g", "Igw"]]) nodes.push({ id: `c${k}/${n}`, kind, lexicon: "x", attrs: {} });
    for (const [f, t, via] of steps) edges.push({ from: `c${k}/${f}`, to: `c${k}/${t}`, kind: "ref", viaAttr: via });
  }
  return finishRows(rowsFromChantIr({ version: 1, nodes, edges, groups: {} } as never, { members: [...Array(copies).keys()].map((k) => `c${k}`), readAt, from: "x" }));
}

const SIX_HOPS =
  "MATCH (:Resource {kind: 'Instance'})-[:REF {viaAttr: 'subnet'}]->(:Resource {kind: 'Subnet'})<-[:REF {viaAttr: 'subnet'}]-(:Resource {kind: 'Assoc'})" +
  "-[:REF {viaAttr: 'table'}]->(:Resource {kind: 'Table'})<-[:REF {viaAttr: 'table'}]-(:Resource {kind: 'Route'})-[:REF {viaAttr: 'gateway'}]->(:Resource {kind: 'Igw'}) RETURN count(*) AS n";

const peer = await realLadybug();

// The floor in package.json (LADYBUG_RANGE) is the first release that answers this: 0.21.2 and 0.22.0 count 1 for any number of copies past 2.
describe.runIf(peer.ok)("the installed LadybugDB answers a multi-hop MATCH once per copy (chant#4361)", () => {
  it("counts every copy of the chain", async () => {
    const db = await GraphDb.build((peer as { lbug: LbugModule }).lbug, chains(10), mkdtempSync(join(tmpdir(), "behold-graph-")));
    try {
      expect((await db.query(SIX_HOPS)).rows).toEqual([{ n: 10 }]);
    } finally {
      await db.close();
    }
  });
});

describe.runIf(peer.ok)("every Cypher template, on the real engine, over disjoint copies", () => {
  const COPIES = 12;
  let db: GraphDb;
  beforeAll(async () => {
    db = await GraphDb.build((peer as { lbug: LbugModule }).lbug, estate(COPIES), mkdtempSync(join(tmpdir(), "behold-graph-")));
  });
  afterAll(async () => db?.close());

  it("the table covers every Cypher template chant ships", () => {
    const cypher = TEMPLATES.filter((t) => t.language === "cypher").map((t) => t.name);
    expect([...new Set(EXPECTED.map((e) => e.template))].sort()).toEqual([...cypher].sort());
  });

  it("each copy gets its own answer, whichever copy it is", async () => {
    const wrong: string[] = [];
    for (let k = 0; k < COPIES; k++) {
      for (const e of EXPECTED) {
        const node = e.node.replace("{k}", String(k));
        const x = expandTemplate(TEMPLATES, e.template, { key: node, source: "chant" });
        const a = await db.query(x.query, x.params);
        if (e.rows !== undefined) {
          if (a.rows.length !== e.rows) wrong.push(`${e.template}(${node}): ${a.rows.length} rows, want ${e.rows}`);
          continue;
        }
        const got = a.rows.map((r) => String(r.key)).sort();
        const want = e.keys!.map((s) => s.replace("{k}", String(k)));
        if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${e.template}(${node}): ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("ownership names the other copy of the same object, and only that one", async () => {
    const x = expandTemplate(TEMPLATES, "ownership", { key: "app3/aws_s3_bucket.data", source: "chant" });
    const a = await db.query(x.query, x.params);
    expect(a.rows[0]?.sameObject).toEqual(["net3/aws_s3_bucket.data"]);
  });
});
