// behold#1027: the graph pane's routes. The refusal without the peer, what still works without
// it, Cypher through the route against a stand-in engine, the sources every answer carries, and
// that no route of the pane acts.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { createApp } from "../server.ts";
import { fakeLbug } from "./fake-lbug.ts";
import { GRAPH_ROUTES, mountGraphPane, type GraphPaneDeps } from "./pane.ts";
import { LADYBUG_INSTALL, loadLadybug } from "./peer.ts";
import { LOCAL_INDEX_DIR } from "./sources.ts";

const FIXTURES = join(import.meta.dirname, "__fixtures__");

const missingPeer = async () => {
  throw Object.assign(new Error("Cannot find package '@ladybugdb/core'"), { code: "ERR_MODULE_NOT_FOUND" });
};

const chantIr: GraphIR = {
  version: 1,
  nodes: [
    { id: "aws_s3_bucket.logs", kind: "aws_s3_bucket", lexicon: "terraform", attrs: { name: "logs" }, physicalId: "web-logs" },
    { id: "aws_instance.web", kind: "aws_instance", lexicon: "terraform", attrs: { name: "web" } },
  ],
  edges: [{ from: "aws_instance.web", to: "aws_s3_bucket.logs", kind: "ref" }],
  groups: {},
};

/** A project with a choudoufu document beside it and an index version in its local store. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-pane-"));
  copyFileSync(join(FIXTURES, "choudoufu.engine-graph.json"), join(dir, "engine-graph.json"));
  mkdirSync(join(dir, ".behold", "graph"), { recursive: true });
  copyFileSync(join(FIXTURES, "plunge.engine-graph.json"), join(dir, ".behold", "graph", "plunge.json"));
  writeFileSync(join(dir, ".behold", "graph", "notes.json"), JSON.stringify({ something: "else" }));
  const idx = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8")) as { stamp: { scopeKey: string } };
  const scopeDir = join(dir, LOCAL_INDEX_DIR, ...idx.stamp.scopeKey.split("/"));
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(join(scopeDir, "20261025T120000Z-000000000000.json"), JSON.stringify({ ...idx, graph: { version: 1, nodes: [], edges: [], groups: {} } }));
  writeFileSync(join(scopeDir, "20261026T120000Z-e2f92b265a4d.json"), JSON.stringify(idx));
  return dir;
}

function pane(over: Partial<GraphPaneDeps> = {}) {
  const dir = project();
  const app = new Hono();
  const graphDir = mkdtempSync(join(tmpdir(), "behold-pane-db-"));
  const deps: GraphPaneDeps = {
    projectDir: () => dir,
    members: () => [{ name: "web", dir, kind: "chant" }],
    readChant: async () => ({ ir: chantIr, from: "chant graph --format ir" }),
    git: () => {
      throw new Error("not a git repository");
    },
    peer: missingPeer,
    dbDir: graphDir,
    env: { BEHOLD_INDEX_DIR: join(dir, "no-user-index") },
    now: () => new Date("2026-10-26T13:00:00Z"),
    ...over,
  };
  mountGraphPane(app, deps);
  return { app, dir, graphDir };
}

const get = async (app: Hono, path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("without the optional peer", () => {
  it("a Cypher query refuses with the install line, and says what still works", async () => {
    const { app } = pane();
    const r = await get(app, `/api/graphdb/query?${new URLSearchParams({ cypher: "MATCH (r:Resource) RETURN r.key" })}`);
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "graph-peer-missing", install: LADYBUG_INSTALL });
    expect(r.body.error).toContain("@ladybugdb/core");
    expect(r.body.stillWorks.join(" ")).toMatch(/chant search/);
    expect(r.body.sources.length).toBeGreaterThan(0);
  });

  it("a peer that is installed but whose addon fails to load refuses the same way, with what it said", async () => {
    const { app } = pane({ peer: async () => { throw new Error("dlopen failed: wrong architecture"); } });
    const r = await get(app, `/api/graphdb/query?cypher=${encodeURIComponent("MATCH (r) RETURN r")}`);
    expect(r.status).toBe(503);
    expect(r.body.detail).toMatch(/wrong architecture/);
  });

  it("status, resolve, the catalog and a search template still answer", async () => {
    const { app } = pane();
    const s = await get(app, "/api/graphdb");
    expect(s.status).toBe(200);
    expect(s.body.peer).toMatchObject({ available: false, refusal: { install: LADYBUG_INSTALL } });
    const r = await get(app, "/api/graphdb/resolve?ref=aws_instance.web");
    expect(r.status).toBe(200);
    expect(r.body.resolved).toBe(true);
    const deps = r.body.templates.find((t: { name: string }) => t.name === "dependents");
    expect(deps).toMatchObject({ language: "search", available: true, expanded: { query: "->*aws_instance.web" } });
    const own = r.body.templates.find((t: { name: string }) => t.name === "ownership");
    expect(own).toMatchObject({ language: "cypher", available: false, install: LADYBUG_INSTALL });
    expect((await get(app, "/api/graphdb/templates")).status).toBe(200);
    const t = await get(app, "/api/graphdb/template?name=dependents&node=aws_instance.web");
    expect(t.status).toBe(200);
    expect(t.body.search).toBe(`/api/search?${new URLSearchParams({ q: "->*aws_instance.web" })}`);
  });

  it("the peer loader never throws", async () => {
    await expect(loadLadybug(missingPeer)).resolves.toMatchObject({ ok: false, refusal: { code: "graph-peer-missing" } });
    await expect(loadLadybug(async () => ({ nothing: true }))).resolves.toMatchObject({ ok: false });
  });
});

describe("what the pane loads, and the read times every answer carries", () => {
  it("chant's IR, the engine documents beside the project and under .behold/graph, and the latest index version only", async () => {
    const { app } = pane();
    const s = await get(app, "/api/graphdb");
    const by = Object.fromEntries((s.body.sources as Array<{ scopeKey: string }>).map((x) => [x.scopeKey, x]));
    expect(by["chant/."]).toMatchObject({ source: "chant", observedAt: null, readAt: "2026-10-26T13:00:00.000Z" });
    expect(by["engine/choudoufu/web"]).toMatchObject({ observedAt: "2026-10-26T12:00:00Z", from: "engine-graph.json" });
    expect(by["engine/plunge/app/dev"]).toMatchObject({ observedAt: "2026-10-26T12:00:00Z" });
    const idx = (s.body.sources as Array<{ source: string; nodes: number }>).filter((x) => x.source === "index");
    expect(idx).toHaveLength(1);
    expect(idx[0]!.nodes).toBe(1);
    expect((s.body.notes as string[]).some((n) => n.includes("notes.json"))).toBe(true);
  });

  it("a choudoufu member runs live-graph -json, and a choudoufu without it is a note", async () => {
    const asked: string[][] = [];
    const { app } = pane({
      members: () => [{ name: "web", dir: mkdtempSync(join(tmpdir(), "behold-cdf-")), kind: "choudoufu" }],
      choudoufu: async (args) => (asked.push(args), { code: 2, stdout: "", stderr: "unknown command \"live-graph\"" }),
    });
    const s = await get(app, "/api/graphdb");
    expect(asked).toEqual([["live-graph", "-json", "."]]);
    expect((s.body.notes as string[]).some((n) => n.includes("no live-graph"))).toBe(true);
  });
});

describe("Cypher through the route, against a stand-in engine", () => {
  it("answers rows, the keys, the subgraph to draw, a view link and every source's read time", async () => {
    const { module } = fakeLbug(() => [{ key: "aws_instance.web" }, { key: "aws_s3_bucket.logs" }]);
    const { app } = pane({ peer: async () => module });
    const r = await get(app, `/api/graphdb/query?${new URLSearchParams({ cypher: "MATCH (r:Resource) RETURN r.key AS key" })}`);
    expect(r.status).toBe(200);
    expect(r.body.keys).toEqual(["aws_instance.web", "aws_s3_bucket.logs"]);
    expect(r.body.draw.edges).toEqual([expect.objectContaining({ from: "aws_instance.web", to: "aws_s3_bucket.logs" })]);
    expect(r.body.link).toMatch(/\?node=aws_instance.web$/);
    expect(r.body.sources.every((s: { readAt?: string }) => typeof s.readAt === "string")).toBe(true);
  });

  it("refuses a write with 400, before the engine sees it", async () => {
    const { module, log } = fakeLbug();
    const { app } = pane({ peer: async () => module });
    const r = await get(app, `/api/graphdb/query?${new URLSearchParams({ cypher: "MATCH (r:Resource) DETACH DELETE r" })}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("cypher-write");
    expect(log.executed.some((e) => e.statement.includes("DETACH"))).toBe(false);
  });

  it("refuses params that are not a JSON object of plain values", async () => {
    const { module } = fakeLbug();
    const { app } = pane({ peer: async () => module });
    for (const params of ["[1]", "nope", JSON.stringify({ a: { b: 1 } }), JSON.stringify({ "bad name": 1 })]) {
      expect((await get(app, `/api/graphdb/query?${new URLSearchParams({ cypher: "MATCH (r) RETURN r", params })}`)).status, params).toBe(400);
    }
  });

  it("builds the database once per session, in behold's own directory, and nowhere else", async () => {
    const { module, log } = fakeLbug();
    const { app, graphDir, dir } = pane({ peer: async () => module });
    const before = readdirSync(dir).sort();
    for (let i = 0; i < 3; i++) await get(app, `/api/graphdb/query?cypher=${encodeURIComponent("MATCH (r:Resource) RETURN r.key")}`);
    expect(log.opened.filter((o) => !o.readOnly)).toHaveLength(1);
    expect(log.opened.every((o) => o.path!.startsWith(graphDir))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("refuses the pane on a public serve", async () => {
    const { app } = pane({ public: true });
    expect((await get(app, "/api/graphdb")).status).toBe(403);
    expect((await get(app, "/api/graphdb/resolve?ref=x")).status).toBe(403);
  });
});

describe("no action route is reachable from the pane", () => {
  it("mounts GET routes only", () => {
    const { app } = pane();
    expect(app.routes.map((r) => r.method).every((m) => m === "GET")).toBe(true);
    expect(GRAPH_ROUTES.every((r) => r.method === "GET")).toBe(true);
  });

  it("in behold's app, every route under /api/graphdb and /graph is a GET, and any other method is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-pane-app-"));
    const app = createApp({ projectDir: dir, port: 0, graph: { peer: missingPeer, readChant: async () => ({ ir: chantIr, from: "test" }), git: () => "" } });
    const mine = app.routes.filter((r) => r.path.startsWith("/api/graphdb") || r.path === "/graph");
    expect(mine.length).toBeGreaterThanOrEqual(GRAPH_ROUTES.length);
    expect(mine.filter((r) => r.method !== "GET" && r.method !== "ALL")).toEqual([]);
    for (const { path } of GRAPH_ROUTES) {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const res = await app.request(path, { method, headers: { host: "127.0.0.1", origin: "http://127.0.0.1" } });
        expect(res.status, `${method} ${path}`).not.toBe(200);
        expect([403, 404, 405], `${method} ${path}`).toContain(res.status);
      }
    }
  });

  it("imports nothing that acts: no Op runner, apply, adopt, approver, rollback or executor", () => {
    const src = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");
    for (const f of readdirSync(import.meta.dirname).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const imports = [...src(f).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/op-runner|apply|adopt|approver|rollback|executor|operator|autosync|reconcile/);
    }
    // The only process the pane starts is a read: git ls-tree/show and choudoufu live-graph.
    expect(src("sources.ts")).not.toMatch(/\bspawn\(|exec\(/);
    expect(src("sources.ts").match(/execFileSync\("git"/g)).toHaveLength(1);
  });
});
