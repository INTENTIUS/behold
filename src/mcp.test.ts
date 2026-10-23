// behold#916: `behold mcp`, a thin client of a running serve's HTTP API, with show and shot.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type ServerOptions } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import type { ShotBrowser, ShotChromium, ShotDeps, ShotPage, ShotRequest, ShotResult } from "./shot.ts";
import { ShotRefusal } from "./shot.ts";
import { assertNoWrites, callTool, checkArgs, DEFAULT_SERVE_URL, locateServe, parseMcpArgs, refusal, serveCommand, serveMcp, TOOLS, writeWord, type Context, type Fetch, type McpOptions, type Tool } from "./mcp.ts";
import { realDir } from "./serve-registry.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-mcp-"));
  made.push(dir);
  const path = join(dir, "chant.config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ lexicons: ["aws"], environments: ["dev", "prod"] }));
  return realDir(dir);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A stand-in browser for the serve's GET /api/shot. */
function fakeBrowser(): ShotDeps & { launches: number } {
  const page: ShotPage = {
    goto: async () => undefined,
    waitForFunction: async () => undefined,
    evaluate: (async () => ({ state: "drawn", cards: 3, lit: 1, viewBox: "0 0 100 60" })) as ShotPage["evaluate"],
    screenshot: async () => PNG,
  };
  const browser: ShotBrowser = { newPage: async () => page, close: async () => undefined };
  const out = { launches: 0, chromium: (): ShotChromium => ({ launch: async () => (out.launches++, browser) }) };
  return out;
}

const SERVE = "http://127.0.0.1:4600";

/** behold's app for `dir`, and a fetch that reaches it as a serve on SERVE would be reached. Every request is recorded. */
function serveOf(dir: string, extra: Partial<ServerOptions> = {}) {
  const broadcaster = new Broadcaster();
  const app = createApp({ projectDir: dir, port: 0, ...extra }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    if (u.origin !== SERVE) throw new TypeError(`fetch failed: connect ECONNREFUSED ${u.host}`);
    return app.request(url, { ...init, headers: { host: "127.0.0.1:4600", ...(init?.headers ?? {}) } });
  };
  return { app, fetch, calls };
}

const nothingListens: Fetch = async (url) => {
  throw new TypeError(`fetch failed: connect ECONNREFUSED ${new URL(url).host}`);
};

function ctxOf(o: { projectDir: string; fetch: Fetch; url?: string; projectGiven?: boolean; registry?: McpOptions["registry"]; localShot?: Context["localShot"]; localSearch?: Context["localSearch"]; client?: string }): Context {
  return {
    projectDir: o.projectDir,
    projectGiven: o.projectGiven ?? true,
    fetch: o.fetch,
    clientName: () => o.client ?? "claude-code",
    findServe: () => locateServe({ projectDir: o.projectDir, projectGiven: o.projectGiven ?? true, fetch: o.fetch, registry: o.registry ?? (() => undefined), ...(o.url ? { url: o.url } : {}) }),
    localShot: o.localShot ?? (async () => { throw new Error("no local shot expected"); }),
    localSearch: o.localSearch ?? (async () => { throw new Error("no local search expected"); }),
  };
}

const textOf = (r: CallToolResult): string => (r.content.find((c) => c.type === "text") as { text: string }).text;
const jsonOf = (r: CallToolResult): Record<string, unknown> => JSON.parse(textOf(r)) as Record<string, unknown>;

describe("the tools behold mcp serves", () => {
  it("are ask, show and shot, and nothing else: a new tool fails here until it is read for writes and listed", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["ask", "show", "shot"]);
  });

  it("each lists every argument, takes no other, carries annotations, and is never destructive", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.annotations.openWorldHint).toBe(false);
      expect(writeWord(t.name)).toBeUndefined();
      // No tool takes a mode chant search would read ambiently, or a gate.
      for (const k of ["live", "at", "ambient", "src", "failOnDrift", "fail-on-drift", "check"]) expect(Object.keys(t.inputSchema.properties)).not.toContain(k);
    }
    expect(TOOLS.find((t) => t.name === "show")!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(TOOLS.find((t) => t.name === "shot")!.annotations.readOnlyHint).toBe(true);
    expect(TOOLS.find((t) => t.name === "ask")!.annotations.readOnlyHint).toBe(true);
  });

  it("each description says which chant search options it takes and which it doesn't", () => {
    for (const t of TOOLS) {
      expect(t.description).toContain("--live --env");
      expect(t.description).toContain("--snapshot");
      expect(t.description).toContain("--explain");
      expect(t.description).toContain("no --check-live");
      expect(t.description).toContain("workspace-search");
      expect(t.description).toContain("INTENTIUS/chant#4361");
    }
  });
});

describe("the write guard", () => {
  const tool = (name: string): Tool => ({ ...TOOLS[0], name });

  it("refuses at start any tool whose name says it would deploy, apply, approve, run an Op, roll back or write", () => {
    for (const name of ["deploy", "apply_plan", "approveGate", "run_op", "opRun", "runs", "rollback", "roll_back", "write_layout", "sync_now", "delete_stack"]) {
      expect(() => assertNoWrites([tool(name)]), name).toThrow(/never deploys/);
    }
    expect(() => assertNoWrites(TOOLS)).not.toThrow();
  });

  it("refuses a server built with such a tool before it serves anything", async () => {
    const [, server] = InMemoryTransport.createLinkedPair();
    await expect(serveMcp({ projectDir: tmpdir(), tools: [...TOOLS, tool("deploy")] }, server)).rejects.toThrow(/deploy/);
  });

  it("answers a call of an unserved tool with a refusal, naming the write", async () => {
    const r = await callTool(TOOLS, "approve", {}, ctxOf({ projectDir: tmpdir(), fetch: nothingListens }));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("approve would approve");
    expect(refusal("search_all")).toContain("there is no tool search_all");
    expect(refusal("search_all")).toContain("workspace-search");
  });
});

describe("arguments", () => {
  const show = TOOLS.find((t) => t.name === "show")!;
  const shot = TOOLS.find((t) => t.name === "shot")!;

  it("refuses a credential-named argument by name, and any argument not listed", () => {
    expect(() => checkArgs(show, { query: "x", token: "t" })).toThrow(/takes no token: behold mcp never takes a credential/);
    expect(() => checkArgs(show, { query: "x", apiKey: "t" })).toThrow(/never takes a credential/);
    expect(() => checkArgs(show, { query: "x", at: "HEAD" })).toThrow(/takes no argument at/);
    expect(() => checkArgs(show, { query: "x", live: "1" })).toThrow(/takes no argument live/);
  });

  it("checks types and bounds", () => {
    expect(() => checkArgs(show, { query: 3 })).toThrow(/must be a string/);
    expect(() => checkArgs(shot, { node: "a", width: 10 })).toThrow(/from 320 to 4096/);
    expect(checkArgs(shot, { node: "a", width: 800 })).toEqual({ node: "a", width: 800 });
  });

  it("refuses snapshot without env", async () => {
    const r = await callTool(TOOLS, "show", { query: "x", snapshot: "latest" }, ctxOf({ projectDir: tmpdir(), fetch: nothingListens }));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("snapshot needs env");
  });
});

describe("parseMcpArgs", () => {
  it("reads project-dir, --url and --port", () => {
    expect(parseMcpArgs([], "/w")).toEqual({ projectDir: "/w", projectGiven: true });
    expect(parseMcpArgs(["est"], "/w")).toEqual({ projectDir: "/w/est", projectGiven: true });
    expect(parseMcpArgs(["--port", "4700"], "/w")).toEqual({ projectDir: "/w", projectGiven: false, url: "http://127.0.0.1:4700" });
    expect(parseMcpArgs(["est", "--url", "http://h:1"], "/w")).toEqual({ projectDir: "/w/est", projectGiven: true, url: "http://h:1" });
    expect(() => parseMcpArgs(["--url", "ftp://x"])).toThrow(/http/);
    expect(() => parseMcpArgs(["--url", "http://a", "--port", "1"])).toThrow(/not both/);
    expect(() => parseMcpArgs(["--port", "x"])).toThrow(/port number/);
  });
});

describe("finding the serve", () => {
  it("uses --url alone when given, and confirms it through GET /api/project", async () => {
    const dir = project();
    const s = serveOf(dir);
    const found = await locateServe({ projectDir: dir, projectGiven: true, url: SERVE, fetch: s.fetch, registry: () => { throw new Error("the registry is not read with --url"); } });
    expect(found).toEqual({ url: SERVE, via: "url", serves: dir, ours: true });
    expect(s.calls).toEqual(["GET /api/project"]);
  });

  it("takes the registry's serve of this project, then the default port", async () => {
    const dir = project();
    const s = serveOf(dir);
    expect(await locateServe({ projectDir: dir, projectGiven: true, fetch: s.fetch, registry: () => ({ url: SERVE, projectDir: dir }) })).toMatchObject({ via: "registry", ours: true });
    expect(await locateServe({ projectDir: dir, projectGiven: true, fetch: s.fetch, registry: () => undefined })).toMatchObject({ url: DEFAULT_SERVE_URL, via: "default", ours: true });
  });

  it("says a serve of another project isn't ours, and that nothing answering is no serve", async () => {
    const mine = project();
    const s = serveOf(project());
    expect(await locateServe({ projectDir: mine, projectGiven: true, fetch: s.fetch })).toMatchObject({ ours: false });
    expect(await locateServe({ projectDir: mine, projectGiven: true, fetch: nothingListens })).toBeUndefined();
  });

  it("with --url and no project named, takes the serve's project", async () => {
    const s = serveOf(project());
    expect(await locateServe({ projectDir: project(), projectGiven: false, url: SERVE, fetch: s.fetch })).toMatchObject({ ours: true });
  });
});

describe("ask: GET /api/search (behold#913, #916)", () => {
  const document = { $schema: "https://intentius.io/chant/schemas/workspace/search/v1/search.schema.json", contract: 1, chant: "0.124.46", at: null, query: "->kind:aws_vpc", source: { kind: "declared" }, matches: [{ id: "web", displayId: "web", kind: "K", paths: [] }], provenance: "declared only" };
  const answer = { q: "->kind:aws_vpc", env: null, snapshot: null, document, draw: { lit: ["web"] }, link: `${SERVE}/?q=-%3Ekind%3Aaws_vpc` };
  /** A serve of `dir` whose search route answers `body` with `status`, recording what it was asked. */
  const searchServe = (dir: string, status = 200, body: Record<string, unknown> = answer) => {
    const asked: string[] = [];
    const fetch: Fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/project") return Response.json({ projectDir: dir, projectDirs: [] });
      if (u.pathname === "/api/search") return asked.push(u.search), Response.json(body, { status });
      return new Response("{}", { status: 404 });
    };
    return { fetch, asked };
  };

  it("returns what the route answers: chant's document as it is, then link and drawn false", async () => {
    const dir = project();
    const s = searchServe(dir);
    const r = await callTool(TOOLS, "ask", { query: "->kind:aws_vpc", env: "prod", show: "cidr" }, ctxOf({ projectDir: dir, fetch: s.fetch, url: SERVE }));
    expect(r.isError).toBeUndefined();
    expect(s.asked).toEqual(["?q=-%3Ekind%3Aaws_vpc&env=prod&show=cidr"]);
    expect(textOf(r)).toBe(JSON.stringify({ ...document, link: answer.link, drawn: false }));
    expect((r.content[1] as { text: string }).text).toMatch(/ask never moves the tab/);
  });

  it("with no serve, asks the same route of behold started in this process", async () => {
    const dir = project();
    const asked: string[] = [];
    const r = await callTool(TOOLS, "ask", { query: "a" }, ctxOf({ projectDir: dir, fetch: nothingListens, localSearch: async (q) => (asked.push(q.toString()), { status: 200, body: answer }) }));
    expect(asked).toEqual(["q=a"]);
    expect(jsonOf(r)).toEqual({ ...document, link: answer.link, drawn: false });
    expect((r.content[1] as { text: string }).text).toContain(serveCommand(dir));
  });

  it("a query chant refuses is chant's document, marked as an error; a refusal with no document is the route's", async () => {
    const dir = project();
    const refused = { ...document, matches: undefined, error: { code: "query-invalid", message: "not a term", hint: "say attr:" } };
    const r = await callTool(TOOLS, "ask", { query: "x:y" }, ctxOf({ projectDir: dir, fetch: searchServe(dir, 400, { error: "not a term", code: "query", document: refused, link: "l" }).fetch, url: SERVE }));
    expect(r.isError).toBe(true);
    expect(jsonOf(r)).toMatchObject({ error: { code: "query-invalid" }, link: "l", drawn: false });
    const old = await callTool(TOOLS, "ask", { query: "a" }, ctxOf({ projectDir: dir, fetch: searchServe(dir, 422, { error: "Search needs chant 0.124.46 or newer.", code: "chant-too-old", remedy: "Upgrade." }).fetch, url: SERVE }));
    expect(old.isError).toBe(true);
    expect(jsonOf(old)).toMatchObject({ code: "chant-too-old", status: 422 });
  });

  it("needs a query, and takes no at", async () => {
    const dir = project();
    expect((await callTool(TOOLS, "ask", {}, ctxOf({ projectDir: dir, fetch: nothingListens }))).isError).toBe(true);
    expect(textOf(await callTool(TOOLS, "ask", { query: "a", at: "HEAD" }, ctxOf({ projectDir: dir, fetch: nothingListens })))).toMatch(/takes no argument at/);
  });
});

describe("show: POST /api/view", () => {
  it("answers what POST /api/view answers for the same view, through the route", async () => {
    const dir = project();
    const s = serveOf(dir);
    const r = await callTool(TOOLS, "show", { env: "prod", zoom: "resources", node: "a" }, ctxOf({ projectDir: dir, fetch: s.fetch }));
    // No tab is open: the route's 409 with the link, verbatim, plus the serve.
    expect(r.isError).toBe(true);
    const direct = (await (await s.fetch(`${SERVE}/api/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: { env: "prod", zoom: "resources", node: "a" } }) })).json()) as Record<string, unknown>;
    const { error, status, ...rest } = jsonOf(r);
    expect(status).toBe(409);
    expect({ error, ...rest }).toEqual(direct);
    expect(direct.code).toBe("no-tab");
    expect(s.calls.filter((c) => c === "POST /api/view")).toHaveLength(2);
  });

  it("moves an open tab, labelled with the MCP client's name", async () => {
    const dir = project();
    const s = serveOf(dir);
    const res = await s.fetch(`${SERVE}/api/events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!buf.includes("event: ping")) buf += decoder.decode((await reader.read()).value);
    const r = await callTool(TOOLS, "show", { query: "attr:internetFacing=true", env: "prod" }, ctxOf({ projectDir: dir, fetch: s.fetch, client: "claude-code" }));
    expect(r.isError).toBeFalsy();
    const body = jsonOf(r);
    expect(body).toMatchObject({ sent: 1, view: { q: "attr:internetFacing=true", env: "prod" }, serve: SERVE });
    while (!/event: view\ndata: .*\n/.test(buf)) buf += decoder.decode((await reader.read()).value);
    const event = JSON.parse(buf.match(/event: view\ndata: (.*)\n/)![1]) as { by: string; id: string };
    expect(event.by).toBe("claude-code via behold mcp");
    expect(event.id).toBe(body.id);
    await reader.cancel();
  });

  it("with no serve running, refuses with the command that starts behold", async () => {
    const dir = project();
    const r = await callTool(TOOLS, "show", { query: "kind:Bucket" }, ctxOf({ projectDir: dir, fetch: nothingListens }));
    expect(r.isError).toBe(true);
    expect(jsonOf(r)).toMatchObject({ code: "no-serve", remedy: serveCommand(dir) });
  });

  it("against a serve of another project, refuses and names both", async () => {
    const mine = project();
    const theirs = project();
    const s = serveOf(theirs);
    const r = await callTool(TOOLS, "show", { query: "kind:Bucket" }, ctxOf({ projectDir: mine, fetch: s.fetch }));
    expect(r.isError).toBe(true);
    expect(jsonOf(r)).toMatchObject({ code: "other-project", serves: theirs, project: mine });
    expect(s.calls).not.toContain("POST /api/view");
  });

  it("passes the route's refusal through, as on a public serve", async () => {
    const dir = project();
    const s = serveOf(dir, { public: true });
    const r = await callTool(TOOLS, "show", { node: "a" }, ctxOf({ projectDir: dir, fetch: s.fetch }));
    expect(r.isError).toBe(true);
    expect(jsonOf(r).status).toBeGreaterThanOrEqual(403);
  });
});

describe("shot: GET /api/shot", () => {
  it("returns the route's PNG bytes as MCP image content, then the link", async () => {
    const dir = project();
    const browser = fakeBrowser();
    const s = serveOf(dir, { shotDeps: browser });
    const r = await callTool(TOOLS, "shot", { node: "a", env: "prod", width: 800 }, ctxOf({ projectDir: dir, fetch: s.fetch }));
    expect(r.isError).toBeFalsy();
    const [image, text] = r.content as [{ type: string; data: string; mimeType: string }, { type: string; text: string }];
    expect(image.type).toBe("image");
    expect(image.mimeType).toBe("image/png");
    const route = await s.fetch(`${SERVE}/api/shot?env=prod&node=a&width=800`);
    expect(Buffer.from(image.data, "base64")).toEqual(Buffer.from(await route.arrayBuffer()));
    expect(JSON.parse(text.text)).toEqual({ link: route.headers.get("behold-view-link"), state: "drawn", serve: SERVE });
    expect(s.calls).toContain("GET /api/shot");
  });

  it("passes the route's refusal through with its code and remedy", async () => {
    const dir = project();
    const s = serveOf(dir, { shotDeps: { chromium: () => null } });
    const r = await callTool(TOOLS, "shot", { node: "a" }, ctxOf({ projectDir: dir, fetch: s.fetch }));
    expect(r.isError).toBe(true);
    expect(jsonOf(r)).toMatchObject({ status: 501, code: "no-browser" });
  });

  it("with no serve running, still works: behold runs in this process for the shot", async () => {
    const dir = project();
    const asked: ShotRequest[] = [];
    const localShot = async (req: ShotRequest): Promise<ShotResult> => {
      asked.push(req);
      return { png: PNG, state: "drawn", link: "http://localhost:4600/?node=a", browser: "chrome", ms: 1, matched: 1 };
    };
    const r = await callTool(TOOLS, "shot", { node: "a", env: "prod" }, ctxOf({ projectDir: dir, fetch: nothingListens, localShot }));
    expect(r.isError).toBeFalsy();
    expect(asked).toEqual([{ env: "prod", view: { node: "a" } }]);
    const [image, text] = r.content as unknown as [{ data: string }, { text: string }];
    expect(Buffer.from(image.data, "base64")).toEqual(PNG);
    expect(JSON.parse(text.text)).toMatchObject({ link: "http://localhost:4600/?node=a", serve: null });
    expect(JSON.parse(text.text).note).toContain(serveCommand(dir));
  });

  it("with no serve, a refusal from the local shot comes back structured", async () => {
    const localShot = async (): Promise<ShotResult> => {
      throw new ShotRefusal({ error: "no browser", code: "no-browser", remedy: "install it" });
    };
    const r = await callTool(TOOLS, "shot", { node: "a" }, ctxOf({ projectDir: project(), fetch: nothingListens, localShot }));
    expect(r.isError).toBe(true);
    expect(jsonOf(r)).toEqual({ error: "no browser", code: "no-browser", remedy: "install it" });
  });
});

describe("over the protocol", () => {
  it("lists the tools with their schemas and annotations, and answers calls", async () => {
    const dir = project();
    const s = serveOf(dir);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = await serveMcp({ projectDir: dir, fetch: s.fetch, registry: () => undefined }, serverSide);
    const client = new Client({ name: "test-agent", version: "1" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ask", "show", "shot"]);
    expect(tools[0].annotations).toMatchObject({ destructiveHint: false });
    expect(client.getInstructions()).toContain("workspace-search");
    const r = (await client.callTool({ name: "show", arguments: { node: "a" } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(jsonOf(r).code).toBe("no-tab");
    const no = (await client.callTool({ name: "deploy", arguments: {} })) as CallToolResult;
    expect(no.isError).toBe(true);
    await client.close();
    await server.close();
  });
});

describe("a thin client", () => {
  it("holds no query, view or shot logic: src/mcp.ts reaches behold only through the HTTP routes", () => {
    const src = readFileSync(join(import.meta.dirname, "mcp.ts"), "utf8");
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)].map((m) => ({ type: !!m[1], from: m[2] }));
    const local = imports.filter((i) => i.from.startsWith(".") && !i.type).map((i) => i.from);
    // The registry finds a serve; shot-cli starts behold's own app for a shot with no serve, and the
    // browser reaches that app over HTTP too. Nothing else of behold's: no server.ts, view-url.js,
    // view-move.ts, chant.ts or shot.ts at run time.
    expect(local.sort()).toEqual(["./serve-registry.ts", "./shot-cli.ts"]);
    expect(src).not.toMatch(/child_process|spawn\(|execFile/);
    expect(src).not.toMatch(/\bapp\.request\(/);
  });
});
