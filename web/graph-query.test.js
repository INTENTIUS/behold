// behold#1027: the graph pane page's pure helpers.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { STATIC_SEARCH_LINE, candidateItems, circleLayout, drawSvg, queryUrl, refusalText, resolveUrl, rowsTable, sourceLines, templateControl, templateUrl } from "./graph-query.js";

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
    // behold#1163: each node carries its key, and the keys asked for are lit.
    const lit = drawSvg({ nodes: [{ key: "a", kind: "k", name: "a", source: "chant", scopeKey: "s" }, { key: "b", kind: "k", name: "b", source: "index", scopeKey: "s" }], edges: [] }, 520, ["b"]);
    expect(lit).toContain('<g class="g-node chant" data-key="a">');
    expect(lit).toContain('<g class="g-node index lit" data-key="b">');
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

describe("the resolve answer's candidates", () => {
  const cand = (key, source) => ({ key, kind: "aws:ec2/subnet:Subnet", source, matchedBy: "cloud-id" });
  it("can each be opened when a cloud id names several nodes, and not when it lands on one", () => {
    const many = candidateItems({ resolved: false, candidates: [cand("aws/aws/subnet", "chant"), cand("aws/plunge/subnet", "engine")] });
    expect(many).toEqual([
      { key: "aws/aws/subnet", label: "aws/aws/subnet (aws:ec2/subnet:Subnet, chant, matched by cloud-id)", open: true },
      { key: "aws/plunge/subnet", label: "aws/plunge/subnet (aws:ec2/subnet:Subnet, engine, matched by cloud-id)", open: true },
    ]);
    expect(candidateItems({ resolved: true, candidates: [cand("aws/aws/subnet", "chant")] })[0].open).toBe(false);
    expect(candidateItems({ resolved: false, candidates: [] })).toEqual([]);
  });
});

describe("a template's button (behold#1180)", () => {
  const search = { name: "dependents", title: "What depends on it", language: "search", available: true, inputs: [], expanded: { query: "->*web/aws_instance.web" } };
  const cypher = { name: "same-cloud-id", title: "Same cloud id", language: "cypher", available: true, inputs: [] };
  const missing = { ...cypher, available: false, refusal: "LadybugDB is not installed.", install: "npm i @ladybugdb/core" };

  it("on the server, runs every available template as before, search ones too", () => {
    expect(templateControl(search, undefined)).toEqual({ label: "What depends on it", disabled: false, title: "", staticSearch: false });
    expect(templateControl(cypher, undefined)).toEqual({ label: "Same cloud id (Cypher)", disabled: false, title: "", staticSearch: false });
    expect(templateControl(missing, undefined)).toMatchObject({ disabled: true, title: "LadybugDB is not installed. npm i @ladybugdb/core" });
    expect(templateControl({ ...cypher, origin: "project" }, undefined).label).toBe("Same cloud id (Cypher), this project's");
  });

  it("in a bundle, runs Cypher, and disables a search the estate view was not captured for", () => {
    const plain = { estate: { href: "./" }, searches: [] };
    expect(templateControl(cypher, plain)).toMatchObject({ disabled: false, staticSearch: false });
    const off = templateControl(search, plain);
    expect(off).toMatchObject({ disabled: true, staticSearch: true });
    expect(off.title).toMatch(/^Runs on behold serve; the Cypher templates run in this page\./);
    expect(off.title).toContain('behold export --q "->*web/aws_instance.web"');
    // No estate view (the ask demo): no capture hint, as nothing would open it.
    expect(templateControl(search, { estate: null, searches: ["->*web/aws_instance.web"] })).toMatchObject({ disabled: true, title: "Runs on behold serve; the Cypher templates run in this page." });
    // A template with inputs expands only when asked, so a bundle cannot know it was captured.
    expect(templateControl({ ...search, inputs: [{ name: "kind" }], expanded: undefined }, { estate: { href: "./" }, searches: ["x"] })).toMatchObject({ disabled: true, staticSearch: true });
    expect(STATIC_SEARCH_LINE).toBe("Search templates run on behold serve; the Cypher templates run in this page.");
  });

  it("in a bundle with an estate view, opens a search --q captured", () => {
    expect(templateControl(search, { estate: { href: "./" }, searches: ["->*web/aws_instance.web"] })).toMatchObject({ disabled: false, staticSearch: false, title: expect.stringMatching(/estate view/) });
  });
});

describe("the server's /graph page (behold#1180)", () => {
  it("starts the pane and the diff with no bundle options, keeps the diff section, and links back to /", () => {
    const html = readFileSync(new URL("./graph.html", import.meta.url), "utf8");
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    expect(script).toMatch(/initGraphPane\(\);/);
    expect(script).toMatch(/initIndexDiff\(\);/);
    expect(html).toContain('<div id="d-section">');
    expect(html).toContain('<a id="g-back" href="/">Back to the estate</a>');
    expect(html).not.toContain("g-bundle");
  });
});
