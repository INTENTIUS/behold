// behold#1161: the ask demo's recorder, its pure half against a stubbed
// `behold mcp`, and the narration's schema against the committed fixture and
// the committed recording.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool, type Context, type Fetch } from "./mcp.ts";
import { Dropped, ReplyError, answerOf, askAll, askArguments, cardIndex, checkQuestions, fillReply, joinList, lightKeys, loadTurn, questionReply, refillNarration, refuseEmpty, validateNarration, type GraphAnswer, type Narration, type Question } from "../scripts/ask-demo/narration.ts";
import { LOAD, QUESTIONS } from "../scripts/ask-demo/questions.ts";
import { MIN_QUESTIONS, RECORD_COMMAND, narrationSchema } from "../scripts/ask-demo/record.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const SERVE = "http://localhost:4999";

/**
 * A `behold mcp` whose serve is stubbed: the real ask tool, with a fetch that
 * answers the graph pane's routes from `routes` (path to body), so a question
 * goes through the same argument handling, resolve-then-template and note as
 * a real call.
 */
function stubbedMcp(routes: Record<string, (q: URLSearchParams) => { status?: number; body: unknown }>): { ask: (args: Record<string, string>) => Promise<CallToolResult>; asked: string[] } {
  const projectDir = mkdtempSync(join(tmpdir(), "behold-ask-demo-"));
  const asked: string[] = [];
  const fetch: Fetch = async (url) => {
    const u = new URL(url);
    const route = routes[u.pathname];
    asked.push(`${u.pathname}?${u.searchParams}`);
    if (!route) return new Response(JSON.stringify({ error: `no stub for ${u.pathname}` }), { status: 404 });
    const r = route(u.searchParams);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const ctx: Context = {
    projectDir,
    projectGiven: false,
    fetch,
    clientName: () => "ask-demo-test",
    findServe: async () => ({ url: SERVE, via: "url", serves: projectDir, ours: true }),
    localShot: async () => {
      throw new Error("no shot expected");
    },
    localSearch: async () => {
      throw new Error("no search expected");
    },
    localCapabilities: async () => {
      throw new Error("no capabilities read expected");
    },
  };
  return { ask: (args) => callTool(TOOLS, "ask", args, ctx), asked };
}

const stamp = { scopeKey: "chant/dns", source: "chant", name: "chant", readAt: "2026-11-18T12:00:00.000Z", observedAt: null, nodes: 3, edges: 2 };
const answer = (rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  columns: rows.length ? Object.keys(rows[0]!) : ["key"],
  rows,
  keys: rows.map((r) => r.key).filter((k): k is string => typeof k === "string"),
  truncated: false,
  draw: { nodes: [], edges: [] },
  sources: [stamp],
  ...extra,
});

const CARDS = cardIndex([
  { id: "dns/zone" },
  { id: "dns/RecordSet ×2", attrs: { _stackOf: [{ id: "dns/gcpRecord" }, { id: "dns/awsRecord" }] } },
  { id: "gcp/webRule" },
]);

describe("fillReply", () => {
  const rows = [
    { key: "dns/gcpRecord", record: "www", reaches: "gcp/webRule", n: 2 },
    { key: "dns/gcpRecord", record: "www", reaches: "gcp/webProxy", n: 3 },
    { key: "dns/gcpOrigin", record: "gcp", reaches: "gcp/webRule", n: 1 },
  ];
  const a = { columns: ["key", "record", "reaches", "n"], rows };

  it("fills counts, sums, lists, first values and per-row patterns from the rows", () => {
    expect(fillReply("{{count}} rows, {{count:record}} records, {{sum:n}} in all", a)).toBe("3 rows, 2 records, 6 in all");
    expect(fillReply("{{list:reaches}}; first {{first:record}}", a)).toBe("gcp/webRule and gcp/webProxy; first www");
    expect(fillReply("{{each:{record} reaches {reaches}}}", a)).toBe("www reaches gcp/webRule, www reaches gcp/webProxy and gcp reaches gcp/webRule");
    expect(joinList(["a"])).toBe("a");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
  });

  it("refuses a placeholder that names a missing column, prints nothing, or is unknown", () => {
    expect(() => fillReply("{{list:nope}}", a)).toThrow(ReplyError);
    expect(() => fillReply("{{each:{record} {nope}}}", a)).toThrow(/nope/);
    expect(() => fillReply("{{list:x}}", { columns: ["x"], rows: [{ x: null }] })).toThrow(/empty in every row/);
    expect(() => fillReply("{{sum:record}}", a)).toThrow(/not a number/);
    expect(() => fillReply("{{median:n}}", a)).toThrow(/not a placeholder/);
  });

  it("fills every reply in questions.ts from rows holding the columns its query returns", () => {
    checkQuestions(QUESTIONS);
    for (const q of QUESTIONS) {
      const names = [...q.reply.matchAll(/\{\{(?:count|list|first|sum):([A-Za-z]+)\}\}/g)].map((m) => m[1]!);
      for (const m of q.reply.matchAll(/\{\{each:([^}]*(?:\}[^}][^}]*)*)\}\}/g)) for (const c of m[1]!.matchAll(/\{([A-Za-z]+)\}/g)) names.push(c[1]!);
      if ("cypher" in q.ask) for (const n of names) expect(q.ask.cypher, `${q.id} returns ${n}`).toMatch(new RegExp(`AS ${n}\\b`));
    }
    expect(fillReply(LOAD.reply, { columns: ["scopeKey", "nodes"], rows: [{ scopeKey: "chant/dns", nodes: 3 }] })).toBe("Loaded 3 resources from 1 sources: the dns member (3).");
  });
});

describe("a question asked of a stubbed behold mcp", () => {
  const cypherQ: Question = { id: "cross", prompt: "What crosses?", reading: "I'll look for what crosses.", ask: { cypher: "MATCH (r:Resource {kind: $k}) RETURN r.key AS key, r.name AS name", params: { k: "AWS::Route53::RecordSet" } }, reply: "{{count}} cross: {{list:name}}." };
  const templateQ: Question = { id: "deps", prompt: "What depends on webRule?", reading: "I'll look for what depends on webRule.", ask: { resource: "webRule", template: "dependents-all" }, reply: "{{count}} depend on it: {{list:key}}." };

  it("records the call, the Cypher, the rows, the cards to light, the sources and the filled reply", async () => {
    const mcp = stubbedMcp({
      "/api/graphdb/query": (q) => ({ body: { cypher: q.get("cypher"), ...answer([{ key: "dns/gcpRecord", name: "www" }, { key: "dns/zone", name: "zone" }]) } }),
    });
    const { turns, verdicts } = await askAll([cypherQ], mcp.ask, CARDS, SERVE);
    expect(verdicts.map((v) => v.ok)).toEqual([true]);
    expect(verdicts[0]!.line).toMatch(/^ok {4}cross: 2 rows, 2 cards lit\. behold's query ran and returned 2 rows\. 2 cross: www and zone\. /);
    const t = turns[0]!;
    expect(t).toMatchObject({ id: "cross", kind: "question", cypher: "cypher" in cypherQ.ask ? cypherQ.ask.cypher : "", params: { k: "AWS::Route53::RecordSet" }, columns: ["key", "name"], keys: ["dns/gcpRecord", "dns/zone"], reply: "behold's query ran and returned 2 rows. 2 cross: www and zone. The Cypher it ran is in the Cypher pane; you can edit it there once I'm done." });
    expect(t.call).toEqual({ tool: "ask", arguments: askArguments(cypherQ.ask) });
    expect(JSON.parse((t.call as unknown as { arguments: { params: string } }).arguments.params)).toEqual({ k: "AWS::Route53::RecordSet" });
    expect(t.light).toEqual(["dns/RecordSet ×2", "dns/zone"]);
    expect(t.sources).toEqual([stamp]);
    expect(new URLSearchParams(mcp.asked[0]!.split("?")[1]).get("params")).toBe('{"k":"AWS::Route53::RecordSet"}');
  });

  it("a template resolves, runs on the one node, and records the expanded query as the Cypher", async () => {
    const query = "MATCH (o:Resource)-[:REF*1..6]->(r:Resource {key: $key}) RETURN DISTINCT o.key AS key";
    const mcp = stubbedMcp({
      "/api/graphdb/resolve": () => ({ body: { resolved: true, candidates: [{ key: "gcp/webRule" }], templates: [], sources: [stamp] } }),
      "/api/graphdb/template": (q) => ({ body: { expanded: { template: q.get("name"), language: "cypher", query, params: { key: q.get("node") } }, ...answer([{ key: "dns/gcpRecord" }]) } }),
    });
    const { turns } = await askAll([templateQ], mcp.ask, CARDS, SERVE);
    expect(mcp.asked.map((a) => a.split("?")[0])).toEqual(["/api/graphdb/resolve", "/api/graphdb/template"]);
    expect(turns[0]).toMatchObject({ cypher: query, params: { key: "gcp/webRule" }, call: { tool: "ask", arguments: { resource: "webRule", template: "dependents-all" } }, light: ["dns/RecordSet ×2"], reply: "behold's query ran and returned 1 row. 1 depend on it: dns/gcpRecord. The Cypher it ran is in the Cypher pane; you can edit it there once I'm done." });
  });

  it("drops a question whose answer is empty, naming it, and keeps the rest", async () => {
    const mcp = stubbedMcp({
      "/api/graphdb/query": () => ({ body: answer([]) }),
      "/api/graphdb/resolve": () => ({ body: { candidates: [{ key: "gcp/webRule" }] } }),
      "/api/graphdb/template": (q) => ({ body: { expanded: { template: "dependents-all", language: "cypher", query: "MATCH (o) RETURN o.key AS key", params: { key: q.get("node") } }, ...answer([{ key: "dns/gcpRecord" }]) } }),
    });
    const { turns, verdicts } = await askAll([cypherQ, templateQ], mcp.ask, CARDS, SERVE);
    expect(turns.map((t) => t.id)).toEqual(["deps"]);
    expect(verdicts.map((v) => v.line)).toEqual([expect.stringMatching(/^DROP {2}cross: the answer has no rows$/), expect.stringMatching(/^ok {4}deps: /)]);
  });

  it("drops a question the tool refuses, a route error, a truncated answer, and an unfillable reply", async () => {
    const refused = stubbedMcp({ "/api/graphdb/query": () => ({ status: 400, body: { error: "a query that writes is refused", code: "cypher-write" } }) });
    expect((await askAll([cypherQ], refused.ask, CARDS, SERVE)).verdicts[0]!.line).toMatch(/^DROP {2}cross: ask refused: .*writes is refused/);
    const ambiguous = stubbedMcp({ "/api/graphdb/resolve": () => ({ body: { candidates: [{ key: "a/webRule" }, { key: "b/webRule" }] } }) });
    expect((await askAll([templateQ], ambiguous.ask, CARDS, SERVE)).verdicts[0]!.line).toMatch(/^DROP {2}deps: ask refused: webRule resolves to 2 nodes/);
    const truncated = stubbedMcp({ "/api/graphdb/query": () => ({ body: answer([{ key: "dns/zone", name: "z" }], { truncated: true }) }) });
    expect((await askAll([cypherQ], truncated.ask, CARDS, SERVE)).verdicts[0]!.line).toMatch(/truncated/);
    const unfillable = stubbedMcp({ "/api/graphdb/query": () => ({ body: answer([{ key: "dns/zone" }]) }) });
    expect((await askAll([cypherQ], unfillable.ask, CARDS, SERVE)).verdicts[0]!.line).toMatch(/^DROP {2}cross: the reply cannot be filled: .*name/);
  });

  it("drops an answer behold made in the tool's own process instead of through the serve", () => {
    const local: CallToolResult = { content: [{ type: "text", text: JSON.stringify(answer([{ key: "dns/zone" }])) }, { type: "text", text: "Nothing is drawn: no behold serve of /x was running, so behold answered in this process." }] };
    expect(() => answerOf(local, "q", SERVE)).toThrow(Dropped);
    expect(answerOf(local, "q").rows).toHaveLength(1);
    expect(() => refuseEmpty({ columns: [], rows: [], keys: [], sources: [] } as GraphAnswer, "q")).toThrow(/no rows/);
  });
});

describe("the cards to light", () => {
  it("are answer keys and row cells that name a card, or a resource folded into a stacked one; indexed objects light nothing", () => {
    expect(lightKeys({ keys: ["cloud/aws/x/i-1", "dns/awsRecord"], rows: [{ declaredAs: "gcp/webRule", other: 3 }] }, CARDS)).toEqual(["dns/RecordSet ×2", "gcp/webRule"]);
    expect(lightKeys({ keys: ["cloud/aws/x/i-1"], rows: [] }, CARDS)).toEqual([]);
  });

  it("the load turn lists each source's counts and lights every card", () => {
    const t = loadTurn({ prompt: LOAD.prompt, busy: LOAD.busy, commands: ["behold serve three-cloud --port 4674"], reply: LOAD.reply, sources: [stamp, { ...stamp, scopeKey: "cloud/aws/1/d", source: "index", name: "chant-lister", observedAt: "2026-11-18T11:00:00.000Z", nodes: 4 }], cards: CARDS });
    expect(t.rows).toEqual([
      { scopeKey: "chant/dns", source: "chant", name: "chant", nodes: 3, edges: 2 },
      { scopeKey: "cloud/aws/1/d", source: "index", name: "chant-lister", nodes: 4, edges: 2 },
    ]);
    expect(t.reply).toBe("Loaded 7 resources from 2 sources: the dns member (3) and the AWS account's index (4).")
    // behold#1206: the busy line says what happens in words; the command stays in the call.
    expect(t.busy).toBe(LOAD.busy);
    expect(t.busy).not.toMatch(/--port|behold serve/);
    expect(t.call).toEqual({ commands: ["behold serve three-cloud --port 4674"] });
    expect(t.light).toEqual(["dns/zone", "dns/RecordSet ×2", "gcp/webRule"]);
    expect(t.call).toEqual({ commands: ["behold serve three-cloud --port 4674"] });
    expect(() => loadTurn({ prompt: "p", busy: "b", commands: ["c"], reply: LOAD.reply, sources: [], cards: CARDS })).toThrow(/no source/);
  });
});

describe("ask-demo/narration.json and its schema", () => {
  const schema = narrationSchema();

  it("the fixture meets the schema", () => {
    expect(validateNarration(read("ask-demo/fixtures/narration.fixture.json"), schema)).toEqual([]);
  });

  it("refuses a narration out of shape: no load turn first, an extra field, too few questions", () => {
    const fixture = read("ask-demo/fixtures/narration.fixture.json") as Narration;
    expect(validateNarration({ ...fixture, turns: [fixture.turns[1], fixture.turns[0], ...fixture.turns.slice(2)] }, schema)).not.toEqual([]);
    expect(validateNarration({ ...fixture, live: true }, schema)).not.toEqual([]);
    expect(validateNarration({ ...fixture, turns: fixture.turns.slice(0, 3) }, schema)).not.toEqual([]);
    expect(validateNarration({ ...fixture, turns: fixture.turns.map((t, i) => (i === 1 ? { ...t, observed: 1 } : t)) }, schema)).not.toEqual([]);
  });

  it("the committed recording meets the schema, with the load turn and at least three answered questions", () => {
    const file = "ask-demo/narration.json";
    expect(existsSync(join(ROOT, file)), `${file} is recorded by ${RECORD_COMMAND}`).toBe(true);
    const doc = read(file) as Narration;
    expect(validateNarration(doc, schema)).toEqual([]);
    expect(doc.recordCommand).toBe(RECORD_COMMAND);
    expect(doc.turns[0]!.kind).toBe("load");
    const questions = doc.turns.slice(1);
    expect(questions.length).toBeGreaterThanOrEqual(MIN_QUESTIONS);
    for (const t of questions) {
      expect(t.rows.length, t.id).toBeGreaterThan(0);
      expect(t.cypher, t.id).toBeTruthy();
      expect(QUESTIONS.map((q) => q.id)).toContain(t.id);
    }
    expect(doc.note).not.toMatch(/\blive\b/i);
  });
});

describe("the reply frame and the refill (behold#1174)", () => {
  it("says the query ran and how many rows, then the template, then where the Cypher is", () => {
    const rows = [{ name: "a" }, { name: "b" }];
    expect(questionReply("{{list:name}} match.", { columns: ["name"], rows })).toBe("behold's query ran and returned 2 rows. a and b match. The Cypher it ran is in the Cypher pane; you can edit it there once I'm done.");
    expect(questionReply("{{count}} match.", { columns: ["name"], rows: [rows[0]!] })).toMatch(/^behold's query ran and returned 1 row\. /);
  });

  const qs: Question[] = [{ id: "q", prompt: "p", reading: "r", ask: { cypher: "RETURN 1" }, reply: "{{list:name}} match." }];
  const doc = {
    recordedAt: "t",
    turns: [
      { id: "load", kind: "load", prompt: "l", columns: ["x"], rows: [{ x: 1 }], reply: "Loaded." },
      { id: "q", kind: "question", prompt: "old prompt", columns: ["name"], rows: [{ name: "a" }], reply: "old" },
    ],
  };

  it("fills the question turns again by id: prompt, reading line and reply, nothing else", () => {
    const { doc: next, dropped } = refillNarration(doc, [{ ...qs[0]!, prompt: "new prompt", reading: "I'll look." }]);
    expect(dropped).toEqual([]);
    expect(next.turns[0]).toEqual(doc.turns[0]);
    expect(next.turns[1]).toEqual({ ...doc.turns[1], prompt: "new prompt", reading: "I'll look.", reply: questionReply("{{list:name}} match.", doc.turns[1]!) });
    expect(next.recordedAt).toBe("t");
    expect(doc.turns[1]!.reply).toBe("old");
    expect(doc.turns[1]).not.toHaveProperty("reading");
  });

  it("fills the load turn again too when given its template, each source in words (behold#1191)", () => {
    const load = { ...doc, turns: [{ id: "load", kind: "load", prompt: "l", columns: ["scopeKey", "nodes"], rows: [{ scopeKey: "cloud/kubernetes/kind-x/ab12", nodes: 4 }], reply: "old" }, doc.turns[1]!] };
    const { doc: next } = refillNarration(load, qs, { reply: "From {{each:{scopeKey|source} ({nodes})}}; {{first:scopeKey|source}}." });
    expect(next.turns[0]!.reply).toBe("From the kind cluster's index (4); the kind cluster's index.");
    expect(refillNarration(load, qs).doc.turns[0]!.reply).toBe("old");
    // behold#1206: and its busy line, when the template gives one.
    const busy = refillNarration({ ...load, turns: [{ ...load.turns[0]!, busy: "behold serve x --port 1: loading" }, load.turns[1]!] } as typeof load, qs, { reply: "r", busy: "behold is reading x" });
    expect((busy.doc.turns[0] as { busy?: string }).busy).toBe("behold is reading x");
    expect((refillNarration({ ...load, turns: [{ ...load.turns[0]!, busy: "kept" }, load.turns[1]!] } as typeof load, qs, { reply: "r" }).doc.turns[0] as { busy?: string }).busy).toBe("kept");
    expect(() => refillNarration(load, qs, { reply: "{{list:gone}}" })).toThrow(/turn load: the reply cannot be filled.*gone/);
    expect(fillReply("{{list:scopeKey|source}}", { columns: ["scopeKey"], rows: [{ scopeKey: "chant/aws" }, { scopeKey: "somewhere" }] })).toBe("the aws member and somewhere");
    expect(() => fillReply("{{list:scopeKey|loud}}", { columns: ["scopeKey"], rows: [{ scopeKey: "chant/aws" }] })).toThrow(ReplyError);
  });

  it("fills a question's headline from the rows too (behold#1198)", () => {
    const { doc: next } = refillNarration(doc, [{ ...qs[0]!, headline: "{{count}} found" }]);
    expect((next.turns[1] as { headline?: string }).headline).toBe("1 found");
    expect("headline" in refillNarration(doc, qs).doc.turns[1]!).toBe(false);
    expect(() => refillNarration(doc, [{ ...qs[0]!, headline: "{{list:gone}}" }])).toThrow(/turn q: the reply cannot be filled.*gone/);
  });

  it("names the turn whose template no longer fills", () => {
    expect(() => refillNarration(doc, [{ ...qs[0]!, reply: "{{list:gone}}" }])).toThrow(/turn q: the reply cannot be filled.*gone/);
  });

  it("drops a turn whose question is gone from questions.ts and says which", () => {
    const two = { ...doc, turns: [...doc.turns, { ...doc.turns[1]!, id: "gone" }] };
    const { doc: next, dropped } = refillNarration(two, qs);
    expect(dropped).toEqual(["gone"]);
    expect(next.turns.map((t) => t.id)).toEqual([doc.turns[0]!.id, "q"]);
  });

  it("leaves the committed recording and fixture as the templates fill them", () => {
    for (const f of ["ask-demo/narration.json", "ask-demo/fixtures/narration.fixture.json"]) {
      const n = read(f) as Narration;
      const { doc: next, dropped } = refillNarration(n, QUESTIONS, LOAD);
      expect(dropped, f).toEqual([]);
      expect(next.turns.map((t) => [t.prompt, t.reading, t.reply, t.headline]), f).toEqual(n.turns.map((t) => [t.prompt, t.reading, t.reply, t.headline]));
    }
  });
});
