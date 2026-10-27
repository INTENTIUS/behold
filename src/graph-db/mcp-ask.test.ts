// behold#1027: `behold mcp ask` with cypher or resource, through the graph pane's routes.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, assertNoWrites, callTool, locateServe, type Context, type Fetch, type GraphPath } from "../mcp.ts";

const nothingListens: Fetch = async () => {
  throw new Error("ECONNREFUSED");
};

function ctxOf(localGraph: Context["localGraph"]): Context {
  const projectDir = mkdtempSync(join(tmpdir(), "behold-mcp-graph-"));
  return {
    projectDir,
    projectGiven: true,
    fetch: nothingListens,
    clientName: () => "test",
    findServe: () => locateServe({ projectDir, projectGiven: true, fetch: nothingListens, registry: () => undefined }),
    localShot: async () => {
      throw new Error("no shot expected");
    },
    localSearch: async () => {
      throw new Error("no search expected: cypher and resource go to the graph routes");
    },
    localCapabilities: async () => {
      throw new Error("no capabilities read expected");
    },
    ...(localGraph ? { localGraph } : {}),
  };
}

const textOf = (r: CallToolResult): string => (r.content.find((c) => c.type === "text") as { text: string }).text;

describe("ask with cypher", () => {
  it("goes to GET /api/graphdb/query with the query and its params, and hands back the route's answer", async () => {
    const asked: Array<[GraphPath, string]> = [];
    const ctx = ctxOf(async (path, q) => (asked.push([path, q.toString()]), { status: 200, body: { columns: ["key"], rows: [{ key: "web/a" }], keys: ["web/a"], sources: [{ scopeKey: "chant/web", readAt: "t" }], link: "l" } }));
    const r = await callTool(TOOLS, "ask", { cypher: "MATCH (r:Resource {kind: $k}) RETURN r.key AS key", params: JSON.stringify({ k: "aws_s3_bucket" }) }, ctx);
    expect(r.isError).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]![0]).toBe("query");
    const q = new URLSearchParams(asked[0]![1]);
    expect(q.get("cypher")).toContain("MATCH (r:Resource");
    expect(JSON.parse(q.get("params")!)).toEqual({ k: "aws_s3_bucket" });
    expect(JSON.parse(textOf(r))).toMatchObject({ keys: ["web/a"], sources: [{ readAt: "t" }], drawn: false });
  });

  it("passes the pane's refusal through, the install line included", async () => {
    const ctx = ctxOf(async () => ({ status: 503, body: { error: "The graph pane needs the optional peer @ladybugdb/core", code: "graph-peer-missing", install: "npm i -g @ladybugdb/core" } }));
    const r = await callTool(TOOLS, "ask", { cypher: "MATCH (r) RETURN r" }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("npm i -g @ladybugdb/core");
  });

  it("takes one of query, cypher and resource, and no search options beside cypher", async () => {
    const ctx = ctxOf(async () => ({ status: 200, body: {} }));
    expect((await callTool(TOOLS, "ask", { cypher: "MATCH (r) RETURN r", query: "kind:x" }, ctx)).isError).toBe(true);
    expect((await callTool(TOOLS, "ask", { cypher: "MATCH (r) RETURN r", env: "prod" }, ctx)).isError).toBe(true);
    expect((await callTool(TOOLS, "ask", { cypher: "MATCH (r) RETURN r", params: "[1]" }, ctx)).isError).toBe(true);
    expect((await callTool(TOOLS, "ask", { query: "kind:x", params: "{}" }, ctx)).isError).toBe(true);
  });
});

describe("ask with resource", () => {
  it("resolves through GET /api/graphdb/resolve", async () => {
    const asked: GraphPath[] = [];
    const ctx = ctxOf(async (path) => (asked.push(path), { status: 200, body: { resolved: true, candidates: [{ key: "web/a" }], templates: [] } }));
    const r = await callTool(TOOLS, "ask", { resource: "arn:aws:s3:::web-logs" }, ctx);
    expect(r.isError).toBeUndefined();
    expect(asked).toEqual(["resolve"]);
  });

  it("with a template, resolves first and runs the template on the one node, with its inputs", async () => {
    const asked: Array<[GraphPath, string]> = [];
    const ctx = ctxOf(async (path, q) => {
      asked.push([path, q.toString()]);
      return path === "resolve" ? { status: 200, body: { candidates: [{ key: "web/a" }] } } : { status: 200, body: { expanded: { template: "paths-to-kind" } } };
    });
    const r = await callTool(TOOLS, "ask", { resource: "a", template: "paths-to-kind", inputs: JSON.stringify({ kind: "aws_internet_gateway" }) }, ctx);
    expect(r.isError).toBeUndefined();
    expect(asked.map((a) => a[0])).toEqual(["resolve", "template"]);
    const q = new URLSearchParams(asked[1]![1]);
    expect([q.get("name"), q.get("node"), q.get("in.kind")]).toEqual(["paths-to-kind", "web/a", "aws_internet_gateway"]);
  });

  it("refuses a template when the resource is ambiguous, naming the candidates", async () => {
    const ctx = ctxOf(async () => ({ status: 200, body: { candidates: [{ key: "a/x" }, { key: "b/x" }] } }));
    const r = await callTool(TOOLS, "ask", { resource: "x", template: "ownership" }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("b/x");
  });
});

describe("the tool list", () => {
  it("is unchanged, and still passes the write-word guard", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["ask", "show", "shot", "capabilities"]);
    expect(() => assertNoWrites(TOOLS)).not.toThrow();
    const ask = TOOLS.find((t) => t.name === "ask")!;
    expect(Object.keys(ask.inputSchema.properties)).toEqual(expect.arrayContaining(["query", "cypher", "params", "resource", "template", "inputs"]));
    expect(ask.annotations.readOnlyHint).toBe(true);
  });
});
