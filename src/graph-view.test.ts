import { afterAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { graphView, viewNote } from "./graph-view.ts";
import { createApp } from "./server.ts";
import { localServeOptions } from "./shot-cli.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";

// behold#1058: `graphView` is the source picture `/api/graph` draws for an
// estate, so the CLI and the browser answer the same graph. Held against the
// route itself: the same cards, edges and note for the same query.

const HERE = dirname(fileURLToPath(import.meta.url));
const ESTATE = join(HERE, "..", "example-terraform-estate");
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const gate = !(resolvedVersion(TERRAFORM_LEXICON_PKG) && resolvedVersion(HCL_PARSER_PKG)) && !REQUIRE_PEERS;

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("viewNote", () => {
  it("joins the clauses in the route's order and gives a short form only when it is shorter", () => {
    expect(viewNote({ pass: { note: "2 roots — a, b", noteShort: "2 roots" }, dangling: "3 references", shaped: "alike: 4 cards" })).toEqual({
      note: "2 roots — a, b · 3 references · alike: 4 cards",
      noteShort: "2 roots · 3 references · alike: 4 cards",
    });
    expect(viewNote({ fallback: () => "edgeless", shaped: "x" })).toEqual({ note: "edgeless · x" });
    expect(viewNote({ pass: { note: "n" }, fallback: () => "never" })).toEqual({ note: "n" });
    expect(viewNote({})).toEqual({});
  });
});

describe("graphView against /api/graph (#1058)", () => {
  const cases: Array<[string, string, Parameters<typeof graphView>[1]]> = [
    ["resources", "", {}],
    ["attributes", "?detail=3", { detail: 3 }],
    ["every card", "?alike=0", { alike: false }],
    ["collapsed", "?collapse=1", { collapse: true }],
  ];

  for (const [shape, prepare] of [
    ["a declared workspace", (): string => ESTATE],
    [
      "a bare folder of .tf files",
      (): string => {
        const dir = join(mkdtempSync(join(tmpdir(), "behold-1058-view-")), "bare-estate");
        made.push(dirname(dir));
        cpSync(ESTATE, dir, { recursive: true });
        rmSync(join(dir, "chant.workspace.json"));
        return dir;
      },
    ],
  ] as const) {
    it.skipIf(gate)(`${shape}: the same cards, edges and note`, { timeout: 300_000 }, async () => {
      const dir = prepare();
      const app = createApp(await localServeOptions(dir));
      for (const [name, q, opts] of cases) {
        const body = (await (await app.request(`http://localhost/api/graph${q}`)).json()) as { ir: { nodes: unknown[]; edges: unknown[] }; meta: { note?: string; noteShort?: string } };
        const view = await graphView(dir, opts);
        expect(view.ir.nodes, name).toEqual(body.ir.nodes);
        expect(view.ir.edges, name).toEqual(body.ir.edges);
        expect(view.meta.note, name).toBe(body.meta.note);
        expect(view.meta.noteShort, name).toBe(body.meta.noteShort);
      }
    });
  }
});

describe("the install stays lean (#1058)", () => {
  const root = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
    devDependencies: Record<string, string>;
  };

  it("lists the Kubernetes client and the MCP SDK as optional peers, kept in devDependencies for the tests", () => {
    for (const name of ["@intentius/chant-k8s-client", "@modelcontextprotocol/sdk"]) {
      expect(root.dependencies[name], name).toBeUndefined();
      expect(root.peerDependencies[name], name).toBeDefined();
      expect(root.peerDependenciesMeta[name]?.optional, name).toBe(true);
      expect(root.devDependencies[name], name).toBeDefined();
    }
  });

  it("keeps hono as a normal dependency", () => {
    expect(root.dependencies.hono).toBeDefined();
    expect(root.dependencies["@hono/node-server"]).toBeDefined();
  });

  it("loads the MCP server only when `behold mcp` runs", () => {
    const cli = readFileSync(join(HERE, "cli.ts"), "utf8");
    expect(cli).not.toMatch(/^import[^\n]*["']\.\/mcp\.ts["']/m);
    expect(cli).toMatch(/await import\("\.\/mcp\.ts"\)/);
  });
});
