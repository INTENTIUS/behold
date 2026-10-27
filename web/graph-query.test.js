// behold#1027: the graph pane page's pure helpers.
import { describe, expect, it } from "vitest";
import { circleLayout, drawSvg, queryUrl, refusalText, resolveUrl, rowsTable, sourceLines, templateUrl } from "./graph-query.js";

describe("the routes the page asks", () => {
  it("are GETs with the query in the URL", () => {
    expect(queryUrl("MATCH (r) RETURN r", { k: "x" })).toBe(`/api/graphdb/query?${new URLSearchParams({ cypher: "MATCH (r) RETURN r", params: '{"k":"x"}' })}`);
    expect(queryUrl("MATCH (r) RETURN r")).not.toContain("params");
    expect(resolveUrl("arn:aws:s3:::b")).toBe("/api/graphdb/resolve?ref=arn%3Aaws%3As3%3A%3A%3Ab");
    expect(templateUrl("paths-to-kind", "web/a", { kind: "aws_vpc" })).toBe("/api/graphdb/template?name=paths-to-kind&node=web%2Fa&in.kind=aws_vpc");
  });
});

describe("what an answer shows", () => {
  it("one line per source, saying when it was observed or that it is declared", () => {
    const lines = sourceLines([
      { scopeKey: "chant/web", source: "chant", name: "chant", member: "web", observedAt: null, readAt: "r", nodes: 2, edges: 1 },
      { scopeKey: "engine/choudoufu/web", source: "engine", name: "choudoufu", version: "0.33.0", observedAt: "2026-10-26T12:00:00Z", readAt: "r", nodes: 6, edges: 2 },
    ]);
    expect(lines[0]).toMatch(/^web: chant .*declared source, not observed/);
    expect(lines[1]).toMatch(/choudoufu 0.33.0 .*observed 2026-10-26T12:00:00Z/);
  });

  it("draws nodes and the edges among them, derived edges dashed with their rule", () => {
    const svg = drawSvg({
      nodes: [
        { key: "a", kind: "k", name: "a", source: "chant", scopeKey: "chant/x" },
        { key: "b", kind: "k", name: "b", source: "engine", scopeKey: "engine/y" },
      ],
      edges: [{ from: "a", to: "b", viaAttr: "arn", origin: "derived", rule: "identity:arn" }],
    });
    expect(svg).toContain('class="g-edge derived"');
    expect(svg).toContain("identity:arn");
    expect(svg.match(/<circle/g)).toHaveLength(2);
    expect(drawSvg({ nodes: [], edges: [] })).toBe("");
    expect(Object.keys(circleLayout([{ key: "a" }, { key: "b" }, { key: "c" }]))).toEqual(["a", "b", "c"]);
  });

  it("escapes what it draws", () => {
    expect(rowsTable(["k"], [{ k: "<script>" }])).toContain("&lt;script&gt;");
    expect(drawSvg({ nodes: [{ key: "<x>", kind: "k", name: "<x>", source: "chant", scopeKey: "s" }], edges: [] })).not.toContain("<x>");
  });

  it("a refusal without the peer shows the install line and what still works", () => {
    const t = refusalText({ error: "needs the peer", code: "graph-peer-missing", install: "npm i -g @ladybugdb/core", stillWorks: ["chant search"] });
    expect(t).toContain("Install: npm i -g @ladybugdb/core");
    expect(t).toContain("Still works: chant search");
  });
});
