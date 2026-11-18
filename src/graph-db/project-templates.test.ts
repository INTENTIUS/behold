// behold#1142: a project's own investigation templates, from .chant/templates.json through chant's
// templateCatalog(dir). Listed with their origin by GET /api/graphdb/templates, offered by resolve and
// run through `behold mcp ask` with resource and template; a malformed entry refused with its file and
// field; a Cypher template the engine cannot bind moved to `refused` when the database opens. The
// real-engine cases run when the optional peer is installed, as in templates-engine.test.ts, and fail
// without it under BEHOLD_REQUIRE_LADYBUG=1 (CI).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphIR } from "@intentius/chant";
import { TOOLS, callTool, locateServe, type Context, type Fetch } from "../mcp.ts";
import { GraphDb } from "./db.ts";
import { fakeLbug, realLadybug } from "./fake-lbug.ts";
import { mountGraphPane, type GraphPaneDeps } from "./pane.ts";
import type { LbugModule, PeerImport } from "./peer.ts";
import { emptyRows, finishRows, rowsFromChantIr } from "./rows.ts";
import { catalogFor, expandTemplate } from "./templates.ts";

const readAt = "2026-11-17T12:00:00.000Z";
const FILE = ".chant/templates.json";
const node = (description: string) => ({ name: "node", kind: "resource", description });

/** Who references a bucket, offered on buckets only. */
const BUCKET_USERS = {
  id: "bucket-users",
  title: "Who uses this bucket",
  question: "Which resources reference this bucket?",
  kinds: ["aws_s3_bucket"],
  inputs: [node("the bucket")],
  reads: "session",
  query: { kind: "cypher", text: "MATCH (u:Resource)-[:REF]->(b:Resource {key: $key}) RETURN u.key AS key ORDER BY key" },
};

/** A path template whose scope input is not named env. */
const IN_STAGE = {
  id: "in-stage",
  title: "This resource in a stage",
  question: "What is this resource in one stage?",
  inputs: [node("the resource"), { name: "stage", kind: "scope", description: "the stage to read" }],
  reads: "live",
  query: { kind: "path", text: "{{node}}" },
};

/** No title: chant's shape check refuses it. */
const UNTITLED = { ...BUCKET_USERS, id: "untitled", title: "" };

/** Holds to the shape, but reads a property the graph does not have. */
const MISSPELT = {
  ...BUCKET_USERS,
  id: "misspelt",
  title: "Bucket owner",
  kinds: undefined,
  query: { kind: "cypher", text: "MATCH (b:Resource {key: $key}) RETURN b.ownr AS owner" },
};

const FILE_ENTRIES = [BUCKET_USERS, UNTITLED, IN_STAGE, MISSPELT];

function project(entries: unknown[] = FILE_ENTRIES): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-project-templates-"));
  mkdirSync(join(dir, ".chant"));
  writeFileSync(join(dir, FILE), JSON.stringify({ version: 1, templates: entries }, null, 2));
  return dir;
}

/** app/data is read by app/web and ops/batch; net/data, the same bucket, by net/reader. */
const IR: GraphIR = {
  version: 1,
  nodes: [
    { id: "app/aws_s3_bucket.data", kind: "aws_s3_bucket", lexicon: "terraform", attrs: {}, physicalId: "data-1" },
    { id: "app/aws_instance.web", kind: "aws_instance", lexicon: "terraform", attrs: {} },
    { id: "ops/aws_instance.batch", kind: "aws_instance", lexicon: "terraform", attrs: {} },
    { id: "net/aws_s3_bucket.data", kind: "aws_s3_bucket", lexicon: "terraform", attrs: {}, physicalId: "data-1" },
    { id: "net/aws_lambda_function.reader", kind: "aws_lambda_function", lexicon: "terraform", attrs: {} },
  ],
  edges: [
    { from: "app/aws_instance.web", to: "app/aws_s3_bucket.data", kind: "ref" },
    { from: "ops/aws_instance.batch", to: "app/aws_s3_bucket.data", kind: "ref" },
    { from: "net/aws_lambda_function.reader", to: "net/aws_s3_bucket.data", kind: "ref" },
  ],
  groups: {},
} as never;
const MEMBERS = ["app", "net", "ops"];

function pane(dir: () => string, peer: PeerImport) {
  const app = new Hono();
  const deps: GraphPaneDeps = {
    projectDir: dir,
    members: () => [],
    readChant: async () => ({ ir: IR, members: MEMBERS, from: "test" }),
    git: () => {
      throw new Error("not a git repository");
    },
    peer,
    dbDir: mkdtempSync(join(tmpdir(), "behold-project-templates-db-")),
    env: { BEHOLD_INDEX_DIR: join(tmpdir(), "behold-project-templates-no-index") },
    now: () => new Date(readAt),
  };
  mountGraphPane(app, deps);
  return app;
}

const get = async (app: Hono, path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const missingPeer: PeerImport = async () => {
  throw Object.assign(new Error("Cannot find package '@ladybugdb/core'"), { code: "ERR_MODULE_NOT_FOUND" });
};

const nothingListens: Fetch = async () => {
  throw new Error("ECONNREFUSED");
};

/** `behold mcp ask` answered by `app`'s graph routes, as with no serve running. */
function askVia(app: Hono, projectDir: string): Context {
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
      throw new Error("no search expected");
    },
    localCapabilities: async () => {
      throw new Error("no capabilities read expected");
    },
    localGraph: (path, q) => get(app, `/api/graphdb/${path}?${q}`),
  };
}

const textOf = (r: CallToolResult): string => (r.content.find((c) => c.type === "text") as { text: string }).text;
const names = (ts: Array<{ name: string }>) => ts.map((t) => t.name);

describe("the project's catalog", () => {
  it("lists chant's templates, then the project's, each with its origin, and refuses a malformed entry with its file and field", () => {
    const cat = catalogFor(project());
    expect(cat.templates.filter((t) => t.origin === "chant").length).toBeGreaterThan(0);
    expect(cat.templates.filter((t) => t.origin === "project").map((t) => t.name)).toEqual(["bucket-users", "in-stage", "misspelt"]);
    expect(cat.refused).toEqual([
      { id: "untitled", file: FILE, field: "templates[1].title", message: `${FILE} templates[1].title: template untitled: needs a title`, by: "chant" },
    ]);
  });

  it("refuses an id chant already uses, naming both files", () => {
    const cat = catalogFor(project([{ ...IN_STAGE, id: "dependents" }]));
    expect(cat.templates.filter((t) => t.origin === "project")).toEqual([]);
    expect(cat.refused[0]).toMatchObject({ id: "dependents", file: FILE, field: "templates[0].id" });
    expect(cat.refused[0]!.message).toContain("@intentius/chant/capabilities/templates.json");
  });

  it("keeps each input's kind, and a scope input becomes the env whatever its name", () => {
    const { templates } = catalogFor(project());
    expect(templates.find((t) => t.name === "in-stage")!.inputs).toEqual([{ name: "stage", kind: "scope", description: "the stage to read" }]);
    const x = expandTemplate(templates, "in-stage", { key: "app/aws_instance.web", source: "chant", kind: "aws_instance", scopeKey: "chant/app" }, { stage: "prod" });
    expect(x).toMatchObject({ language: "search", query: "aws_instance.web", env: "prod" });
    expect(() => expandTemplate(templates, "in-stage", { key: "app/aws_instance.web", source: "chant" }, { stage: "prod; rm" })).toThrow(/not an environment/);
  });

  it("offers a template naming kinds only on a node of one of them", () => {
    const { templates } = catalogFor(project());
    expect(expandTemplate(templates, "bucket-users", { key: "app/aws_s3_bucket.data", source: "chant", kind: "aws_s3_bucket" }).params).toEqual({ key: "app/aws_s3_bucket.data" });
    expect(() => expandTemplate(templates, "bucket-users", { key: "app/aws_instance.web", source: "chant", kind: "aws_instance" })).toThrow(/applies to aws_s3_bucket/);
  });

  it("refuses a project template with two scope inputs, since behold reads one as the env", () => {
    const two = { ...IN_STAGE, id: "two-scopes", inputs: [...IN_STAGE.inputs, { name: "region", kind: "scope", description: "a region" }] };
    const cat = catalogFor(project([two]));
    expect(cat.refused).toEqual([expect.objectContaining({ id: "two-scopes", field: "templates[0].inputs", by: "behold" })]);
  });

  it("is chant's alone when the project has no file", () => {
    const cat = catalogFor(mkdtempSync(join(tmpdir(), "behold-project-templates-none-")));
    expect(cat.templates.every((t) => t.origin === "chant")).toBe(true);
    expect(cat.refused).toEqual([]);
  });
});

describe("through the pane's routes and ask, against a stand-in engine", () => {
  const usersOfData = (statement: string, params: Record<string, unknown>) =>
    statement === BUCKET_USERS.query.text && params.key === "app/aws_s3_bucket.data" ? [{ key: "app/aws_instance.web" }, { key: "ops/aws_instance.batch" }] : [];

  it("lists the project's template with its origin, and resolve offers it on a bucket only", async () => {
    const dir = project();
    const app = pane(() => dir, async () => fakeLbug(usersOfData).module);
    const listing = await get(app, "/api/graphdb/templates");
    expect(listing.status).toBe(200);
    expect(listing.body.templates.find((t: { name: string }) => t.name === "bucket-users")).toMatchObject({ origin: "project", kinds: ["aws_s3_bucket"] });
    expect(listing.body.templates.find((t: { name: string }) => t.name === "dependents")).toMatchObject({ origin: "chant" });
    expect(listing.body.refused).toEqual([expect.objectContaining({ id: "untitled", file: FILE, field: "templates[1].title" })]);
    expect(listing.body.engineChecked).toBe(true);

    const bucket = await get(app, `/api/graphdb/resolve?ref=${encodeURIComponent("app/aws_s3_bucket.data")}`);
    const offered = bucket.body.templates.find((t: { name: string }) => t.name === "bucket-users");
    expect(offered).toMatchObject({ origin: "project", language: "cypher", available: true, expanded: { params: { key: "app/aws_s3_bucket.data" } } });
    expect(bucket.body.refused).toEqual(listing.body.refused);
    const web = await get(app, `/api/graphdb/resolve?ref=${encodeURIComponent("app/aws_instance.web")}`);
    expect(names(web.body.templates)).not.toContain("bucket-users");
    expect(names(web.body.templates)).toContain("in-stage");
  });

  it("runs through ask with resource and template, the same answer the pane's click gets", async () => {
    const dir = project();
    const app = pane(() => dir, async () => fakeLbug(usersOfData).module);
    const r = await callTool(TOOLS, "ask", { resource: "app/aws_s3_bucket.data", template: "bucket-users" }, askVia(app, dir));
    expect(r.isError).toBeUndefined();
    const answer = JSON.parse(textOf(r));
    expect(answer).toMatchObject({ expanded: { template: "bucket-users", language: "cypher" }, keys: ["app/aws_instance.web", "ops/aws_instance.batch"], drawn: false });
    const click = await get(app, `/api/graphdb/template?${new URLSearchParams({ name: "bucket-users", node: "app/aws_s3_bucket.data" })}`);
    expect(click.body.keys).toEqual(answer.keys);
  });

  it("moves a template the engine does not report read-only to refused, with the field", async () => {
    const dir = project([BUCKET_USERS]);
    const { module } = fakeLbug(() => [], { readOnly: (s) => s !== BUCKET_USERS.query.text });
    const app = pane(() => dir, async () => module);
    const listing = await get(app, "/api/graphdb/templates");
    expect(names(listing.body.templates)).not.toContain("bucket-users");
    expect(listing.body.refused).toEqual([
      expect.objectContaining({ id: "bucket-users", file: FILE, field: "templates[0].query.text", by: "engine", message: expect.stringContaining("does not report it read-only") }),
    ]);
  });

  it("without the peer, lists the project's Cypher templates unchecked and offers them as unavailable", async () => {
    const dir = project();
    const app = pane(() => dir, missingPeer);
    const listing = await get(app, "/api/graphdb/templates");
    expect(listing.body.engineChecked).toBe(false);
    expect(names(listing.body.templates)).toEqual(expect.arrayContaining(["bucket-users", "misspelt"]));
    const r = await get(app, `/api/graphdb/resolve?ref=${encodeURIComponent("app/aws_s3_bucket.data")}`);
    expect(r.body.templates.find((t: { name: string }) => t.name === "bucket-users")).toMatchObject({ available: false });
  });

  it("reads the file again on a project switch and on rebuild=1", async () => {
    const first = project([BUCKET_USERS]);
    const second = project([IN_STAGE]);
    let served = first;
    const app = pane(() => served, missingPeer);
    const own = async () => names((await get(app, "/api/graphdb/templates")).body.templates.filter((t: { origin: string }) => t.origin === "project"));
    expect(await own()).toEqual(["bucket-users"]);
    served = second;
    expect(await own()).toEqual(["in-stage"]);
    writeFileSync(join(second, FILE), JSON.stringify({ version: 1, templates: [IN_STAGE, { ...BUCKET_USERS, id: "bucket-readers" }] }));
    expect(await own()).toEqual(["in-stage"]);
    await get(app, "/api/graphdb?rebuild=1");
    expect(await own()).toEqual(["in-stage", "bucket-readers"]);
  });
});

const peer = await realLadybug();

describe.runIf(peer.ok)("on the real engine", () => {
  const lbug = () => (peer as { lbug: LbugModule }).lbug;

  it("answers the project's template as worked out by hand", async () => {
    const rows = finishRows(rowsFromChantIr(IR, { members: MEMBERS, readAt, from: "x" }, emptyRows()));
    const db = await GraphDb.build(lbug(), rows, mkdtempSync(join(tmpdir(), "behold-graph-")));
    try {
      const { templates } = catalogFor(project());
      const run = async (key: string) => {
        const x = expandTemplate(templates, "bucket-users", { key, source: "chant", kind: "aws_s3_bucket" });
        return (await db.query(x.query, x.params)).rows.map((r) => r.key);
      };
      expect(await run("app/aws_s3_bucket.data")).toEqual(["app/aws_instance.web", "ops/aws_instance.batch"]);
      expect(await run("net/aws_s3_bucket.data")).toEqual(["net/aws_lambda_function.reader"]);
    } finally {
      await db.close();
    }
  });

  it("moves a template the engine cannot bind to refused, with the engine's message, and runs the rest through ask", async () => {
    const dir = project();
    const app = pane(() => dir, async () => lbug());
    const listing = await get(app, "/api/graphdb/templates");
    expect(listing.body.engineChecked).toBe(true);
    expect(names(listing.body.templates)).toContain("bucket-users");
    expect(names(listing.body.templates)).not.toContain("misspelt");
    const misspelt = listing.body.refused.find((r: { id: string }) => r.id === "misspelt");
    expect(misspelt).toMatchObject({ file: FILE, field: "templates[3].query.text", by: "engine" });
    expect(misspelt.message).toMatch(/^\.chant\/templates\.json templates\[3\]\.query\.text: template misspelt: .*ownr/);
    const r = await callTool(TOOLS, "ask", { resource: "net/aws_s3_bucket.data", template: "bucket-users" }, askVia(app, dir));
    expect(JSON.parse(textOf(r)).keys).toEqual(["net/aws_lambda_function.reader"]);
  });
});
