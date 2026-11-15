// behold#1073: the graph tool of `behold mcp`: text, Mermaid and link for every host, a view for MCP Apps hosts.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GRAPH_DOCUMENT_SCHEMA, type GraphDocument } from "./graph-document.ts";
import { callTool, serveMcp, TOOLS, type Context, type Fetch } from "./mcp.ts";
import { GraphToolError, TEXT_CHARS, rootCount, type GraphCutRead } from "./mcp-graph.ts";
import { realDir } from "./serve-registry.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";
import { APP_MIME, loadViewer, PLACEHOLDER_HTML, VIEWER_BUILD, VIEWER_URI } from "./viewer-resource.ts";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratch = (): string => {
  const d = realDir(mkdtempSync(join(tmpdir(), "behold-1073-")));
  made.push(d);
  return d;
};

const nothingListens: Fetch = async (url) => {
  throw new TypeError(`fetch failed: connect ECONNREFUSED ${new URL(url).host}`);
};

/** A document of `roots` boxes, each with `per` cards chained to the next, every card titled `card-<root>-<n>`. */
function estate(roots: number, per: number): GraphDocument {
  const doc: GraphDocument = { schema: GRAPH_DOCUMENT_SCHEMA, generator: { behold: "0" }, origin: { dir: "." }, cut: { kind: "whole" }, nodes: [], edges: [], groups: [], notes: [] };
  for (let r = 0; r < roots; r++) {
    doc.groups.push({ id: `stack:root-${r}`, title: `root-${r}`, kind: "stack" });
    for (let n = 0; n < per; n++) {
      doc.nodes.push({ id: `root-${r}/card-${r}-${n}`, title: `card-${r}-${n}`, subtitle: "terraform", kind: "google_thing", lexicon: "terraform", box: `stack:root-${r}`, attrs: { secretish: `value-${r}-${n}` } });
      if (n > 0) doc.edges.push({ id: `e-${r}-${n}`, source: `root-${r}/card-${r}-${n}`, target: `root-${r}/card-${r}-${n - 1}`, kind: "ref", inferred: false });
    }
  }
  return doc;
}

const read = (doc: GraphDocument): GraphCutRead => ({ document: doc, whole: { cards: doc.nodes.length, edges: doc.edges.length, roots: rootCount(doc) } });

function ctxOf(dir: string, readGraphCut: Context["readGraphCut"], serveUrl?: string): Context {
  const fetch: Fetch = serveUrl
    ? async (url) => {
        if (new URL(url).pathname === "/api/project") return new Response(JSON.stringify({ projectDir: dir, projectDirs: [] }), { headers: { "content-type": "application/json" } });
        throw new TypeError("unexpected");
      }
    : nothingListens;
  return {
    projectDir: dir,
    projectGiven: true,
    fetch,
    clientName: () => "test",
    findServe: async () => (serveUrl ? { url: serveUrl, via: "url" as const, serves: dir, ours: true } : undefined),
    localShot: async () => {
      throw new Error("no shot");
    },
    localSearch: async () => {
      throw new Error("no search");
    },
    localCapabilities: async () => {
      throw new Error("no capabilities");
    },
    ...(readGraphCut ? { readGraphCut } : {}),
  };
}

const text = (r: CallToolResult): string => (r.content.find((c) => c.type === "text") as { text: string }).text;

describe("the graph tool's answer (#1073)", () => {
  it("is a summary, the cut, a Mermaid block and a start line when the cut fits and no serve runs", async () => {
    const dir = scratch();
    const r = await callTool(TOOLS, "graph", {}, ctxOf(dir, async () => read(estate(2, 3))));
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain("2 top-level boxes (roots and members), 6 cards, 4 edges in all.");
    expect(t).toContain("The whole graph.");
    expect(t).toContain("```mermaid\nflowchart");
    expect(t).toContain("No behold serve of this project is running. Start `npx @intentius/behold serve");
    expect(t).toContain("http://localhost:4600/");
  });

  it("links the running serve, at the card the cut was around", async () => {
    const dir = scratch();
    let asked: unknown;
    const doc = estate(1, 3);
    const r = await callTool(TOOLS, "graph", { around: "root-0/card-0-1", depth: 2, direction: "up" }, ctxOf(dir, async (req) => ((asked = req), read(doc)), "http://127.0.0.1:4711"));
    expect(asked).toMatchObject({ around: ["root-0/card-0-1"], depth: 2, direction: "up" });
    expect(text(r)).toContain("Cut around root-0/card-0-1, 2 hops what they depend on");
    expect(text(r)).toContain("Open it in behold: http://127.0.0.1:4711/?node=root-0%2Fcard-0-1");
  });

  it("links a box by focus", async () => {
    const r = await callTool(TOOLS, "graph", { around: "stack:root-0" }, ctxOf(scratch(), async () => read(estate(1, 2)), "http://127.0.0.1:4711"));
    expect(text(r)).toContain("?focus=stack%3Aroot-0");
  });

  it("holds no node list: no document JSON, and on an estate too big to draw not one card's title", async () => {
    const dir = scratch();
    const doc = estate(49, 30);
    const r = await callTool(TOOLS, "graph", {}, ctxOf(dir, async () => read(doc)));
    const t = text(r);
    expect(t).toContain("49 top-level boxes (roots and members), 1470 cards");
    expect(t).toContain("does not fit in this answer");
    expect(t).toContain("| Root | Cards |");
    expect(t).not.toContain("card-");
    expect(t).not.toContain("value-");
    expect(t).not.toMatch(/"nodes"|"edges"|behold-graph\/1/);
    expect(t.length).toBeLessThanOrEqual(TEXT_CHARS);
    // The structured result the view and the host get has the request and counts, not the cards.
    const sc = r.structuredContent as Record<string, unknown>;
    expect(Object.keys(sc).sort()).toEqual(["cards", "edges", "link", "roots", "view", "wholeCards", "wholeEdges"]);
    expect(JSON.stringify(sc)).not.toContain("card-");
    expect(r.content).toHaveLength(1);
  });

  it("stays under the text budget however the diagram falls", async () => {
    for (const [roots, per] of [[1, 5], [3, 40], [10, 10], [49, 3], [2, 400]] as const) {
      const r = await callTool(TOOLS, "graph", {}, ctxOf(scratch(), async () => read(estate(roots, per))));
      expect(text(r).length, `${roots}x${per}`).toBeLessThanOrEqual(TEXT_CHARS);
    }
  });

  it("refuses a folder outside the project, a missing one, and two cuts", async () => {
    const dir = scratch();
    const ctx = ctxOf(dir, async () => read(estate(1, 1)));
    const out = await callTool(TOOLS, "graph", { dir: ".." }, ctx);
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("outside the project");
    expect((await callTool(TOOLS, "graph", { dir: "nope" }, ctx)).isError).toBe(true);
    const two = await callTool(TOOLS, "graph", { around: "a", changed: "x..y" }, ctxOf(dir, async () => { throw new GraphToolError("around and changed are two cuts; give one"); }));
    expect(two.isError).toBe(true);
    expect(text(two)).toContain("two cuts");
    expect(text(await callTool(TOOLS, "graph", { around: " , " }, ctx))).toContain("around is empty");
  });

  it("takes no credential or other argument", async () => {
    const r = await callTool(TOOLS, "graph", { token: "x" }, ctxOf(scratch(), async () => read(estate(1, 1))));
    expect(r.isError).toBe(true);
  });
});

describe("naming a box by its title (#1073)", () => {
  it("takes a root's title as the table prints it, and leaves an unknown id for the cut to refuse", async () => {
    const { namedBoxes } = await import("./mcp-graph.ts");
    const doc = estate(2, 1);
    expect(namedBoxes(doc, ["root-1", "stack:root-0", "root-0/card-0-0", "nope"])).toEqual(["stack:root-1", "stack:root-0", "root-0/card-0-0", "nope"]);
  });
});

describe("the view (#1073)", () => {
  it("is named by graph's _meta.ui.resourceUri, and graph_document is app-only", () => {
    const graph = TOOLS.find((t) => t.name === "graph")!;
    expect(graph._meta).toMatchObject({ ui: { resourceUri: VIEWER_URI } });
    expect(graph._meta?.["ui"]).not.toHaveProperty("visibility");
    expect(TOOLS.find((t) => t.name === "graph_document")!._meta).toEqual({ ui: { visibility: ["app"] } });
  });

  it("gets the document through graph_document, which says nothing of the cards in its text", async () => {
    const doc = estate(2, 2);
    const r = await callTool(TOOLS, "graph_document", {}, ctxOf(scratch(), async () => read(doc)));
    expect((r.structuredContent as { document: GraphDocument }).document.nodes).toHaveLength(4);
    expect(text(r)).toBe("behold-graph/1 document for the view: 4 cards, 2 edges.");
  });

  it("over the protocol: tools/list carries _meta, resources/list names ui://behold/viewer with the MCP Apps MIME type, and resources/read serves the page", async () => {
    const dir = scratch();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = await serveMcp({ projectDir: dir, fetch: nothingListens, registry: () => undefined, viewer: { html: "<!doctype html><title>v</title>", kind: "viewer" } }, serverSide);
    const client = new Client({ name: "test-agent", version: "1" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "graph")!._meta).toMatchObject({ ui: { resourceUri: "ui://behold/viewer" } });
    expect(tools.find((t) => t.name === "graph_document")!._meta).toEqual({ ui: { visibility: ["app"] } });
    const { resources } = await client.listResources();
    expect(resources).toEqual([expect.objectContaining({ uri: "ui://behold/viewer", mimeType: "text/html;profile=mcp-app" })]);
    const res = await client.readResource({ uri: VIEWER_URI });
    expect(res.contents).toEqual([{ uri: VIEWER_URI, mimeType: APP_MIME, text: "<!doctype html><title>v</title>" }]);
    await expect(client.readResource({ uri: "ui://behold/other" })).rejects.toThrow(/no resource/);
    await client.close();
    await server.close();
  });

  it("serves the placeholder page until #1070's build is in the package, then that build", () => {
    const root = scratch();
    expect(loadViewer(root)).toEqual({ html: PLACEHOLDER_HTML, kind: "placeholder" });
    expect(PLACEHOLDER_HTML).toMatch(/^<!doctype html>/);
    expect(PLACEHOLDER_HTML).not.toMatch(/<script|https?:/);
    mkdirSync(join(root, "dist", "behold-viewer"), { recursive: true });
    writeFileSync(join(root, VIEWER_BUILD), "<!doctype html><title>built</title>");
    expect(loadViewer(root)).toEqual({ html: "<!doctype html><title>built</title>", kind: "viewer" });
  });
});

// The real read, on the example estate: waits on the Terraform reader as the other Terraform read tests do.
const HERE = dirname(fileURLToPath(import.meta.url));
const gate = !(resolvedVersion(TERRAFORM_LEXICON_PKG) && resolvedVersion(HCL_PARSER_PKG)) && process.env.BEHOLD_REQUIRE_PEERS !== "1";

describe.skipIf(gate)("the graph tool on a real read (#1073)", () => {
  it("answers the example Terraform estate, and refuses a cut around an id it does not hold", async () => {
    const dir = realDir(join(HERE, "..", "example-terraform-estate"));
    const whole = await callTool(TOOLS, "graph", {}, ctxOf(dir, undefined));
    expect(whole.isError).toBeFalsy();
    expect(text(whole)).toMatch(/\d+ top-level boxe?s?.*\d+ cards/);
    const missing = await callTool(TOOLS, "graph", { around: "no-such-card" }, ctxOf(dir, undefined));
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("no-such-card");
  });
});
