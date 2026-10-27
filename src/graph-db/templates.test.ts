// behold#1027: resolve-from-resource and the template catalog (behold#1022's design and rulings).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyRows, finishRows, rowsFromChantIr, rowsFromEngineGraph, rowsFromIndex } from "./rows.ts";
import { TEMPLATES, TemplateError, expandTemplate, resolveResource } from "./templates.ts";
import type { EngineGraphDocument, IndexDocument } from "./types.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8"));
const readAt = "2026-10-26T13:00:00.000Z";

function loaded() {
  const rows = emptyRows();
  rowsFromChantIr(
    {
      version: 1,
      nodes: [
        { id: "aws_s3_bucket.logs", kind: "aws_s3_bucket", lexicon: "terraform", attrs: { name: "logs" }, physicalId: "web-logs" },
        { id: "aws_instance.web", kind: "aws_instance", lexicon: "terraform", attrs: { name: "web" } },
      ],
      edges: [],
      groups: {},
    },
    { member: "web", readAt, from: "x" },
    rows,
  );
  rowsFromEngineGraph(fixture("choudoufu.engine-graph.json") as EngineGraphDocument, { readAt, from: "x" }, rows);
  rowsFromIndex(fixture("index.json") as IndexDocument, { version: "v", readAt, from: "x" }, rows);
  return finishRows(rows);
}

describe("resolve", () => {
  it("an exact key is one node", () => {
    const c = resolveResource(loaded(), "web/aws_s3_bucket.logs");
    expect(c).toEqual([expect.objectContaining({ key: "web/aws_s3_bucket.logs", matchedBy: "key", source: "chant" })]);
  });

  it("a cloud id lands on every node known by it, across sources", () => {
    const c = resolveResource(loaded(), "web-logs");
    expect(c.map((x) => x.matchedBy)).toEqual(["cloud-id", "cloud-id", "cloud-id"]);
    expect(c.map((x) => x.source).sort()).toEqual(["chant", "engine", "index"]);
  });

  it("an ARN resolves the engine node that carries it", () => {
    expect(resolveResource(loaded(), "arn:aws:s3:::web-logs").map((x) => x.key)).toEqual(["engine/choudoufu/web/aws_s3_bucket.logs"]);
  });

  it("an IR id or an engine address matches by id, before any name", () => {
    const c = resolveResource(loaded(), "aws_s3_bucket.logs");
    expect(c.map((x) => x.matchedBy)).toEqual(["id", "id"]);
    expect(c.map((x) => x.key).sort()).toEqual(["engine/choudoufu/web/aws_s3_bucket.logs", "web/aws_s3_bucket.logs"]);
  });

  it("a name alone is the weakest match, and nothing matches nothing", () => {
    expect(resolveResource(loaded(), "web").map((x) => [x.key, x.matchedBy])).toEqual([["web/aws_instance.web", "name"]]);
    expect(resolveResource(loaded(), "no-such-thing")).toEqual([]);
    expect(resolveResource(loaded(), "  ")).toEqual([]);
  });

  it("an ARM id resolves whatever its case, because Resource Graph lowercases", () => {
    const rows = emptyRows();
    const arm = "/subscriptions/0000/resourceGroups/RG/providers/Microsoft.Storage/storageAccounts/acct";
    rowsFromChantIr({ version: 1, nodes: [{ id: "acct", kind: "k", lexicon: "azure", attrs: {}, physicalId: arm }], edges: [], groups: {} }, { member: "az", readAt, from: "x" }, rows);
    finishRows(rows);
    expect(resolveResource(rows, arm.toLowerCase()).map((x) => x.key)).toEqual(["az/acct"]);
  });
});

describe("templates", () => {
  const chantNode = { key: "web/aws_instance.web", source: "chant" as const };
  const engineNode = { key: "engine/choudoufu/web/aws_s3_bucket.logs", source: "engine" as const };

  it("cover the investigations #1022 lists, and each says its language and what it reads", () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual(expect.arrayContaining(["dependents", "dependencies", "paths-to-kind", "capability", "drift", "ownership", "history", "readers"]));
    for (const t of TEMPLATES) {
      expect(["search", "cypher"]).toContain(t.language);
      expect(["source", "live", "snapshots", "session"]).toContain(t.reads);
    }
  });

  it("a search template fills the node in as chant workspace search names it", () => {
    expect(expandTemplate("dependents", chantNode)).toMatchObject({ language: "search", query: "->*web/aws_instance.web" });
    expect(expandTemplate("paths-to-kind", chantNode, { kind: "aws_internet_gateway" }).query).toBe("web/aws_instance.web ->*kind:aws_internet_gateway");
    expect(expandTemplate("drift", chantNode, { env: "prod" })).toMatchObject({ query: "web/aws_instance.web", env: "prod", reads: "live" });
  });

  it("a Cypher template takes the node and its inputs as parameters, never spliced into the text", () => {
    const x = expandTemplate("ownership", engineNode);
    expect(x.language).toBe("cypher");
    expect(x.query).not.toContain(engineNode.key);
    expect(x.params).toEqual({ key: engineNode.key });
  });

  it("refuses a search input that would be a second term, a missing input, an unknown one, and a node it does not apply to", () => {
    expect(() => expandTemplate("paths-to-kind", chantNode, { kind: "aws_vpc attr:x=1" })).toThrow(TemplateError);
    expect(() => expandTemplate("paths-to-kind", chantNode)).toThrow(/needs kind/);
    expect(() => expandTemplate("dependents", chantNode, { extra: "1" })).toThrow(/takes no input extra/);
    expect(() => expandTemplate("dependents", engineNode)).toThrow(/applies to chant/);
    expect(() => expandTemplate("nope", chantNode)).toThrow(/no template nope/);
    expect(() => expandTemplate("drift", chantNode, { env: "prod; rm" })).toThrow(/not an environment/);
  });
});
