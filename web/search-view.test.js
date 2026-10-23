import { describe, expect, it } from "vitest";
import { queryLine, queryMarks, searchKey, searchUrl, uncapturedLine } from "./search-view.js";

// behold#913: how the page draws a query's answer (GET /api/search's `draw`).

const answer = (draw, document = {}) => ({ q: "q", document, draw: { lit: [], onPath: [], edges: [], unobserved: {}, nearMisses: [], provenance: "declared only · no observation", failure: null, notSearched: [], ...draw } });
const cards = ["web", "subnet", "vpc", "db", "cache"];
const edges = [
  { from: "web", to: "subnet" },
  { from: "vpc", to: "subnet" }, // drawn the other way round from the hop
  { from: "db", to: "cache" },
  { from: "web", to: "db" },
];

describe("searchUrl and searchKey", () => {
  it("asks for the query in the view's env and snapshot, and keys the answer on all three", () => {
    expect(searchUrl({ q: "->kind:aws_vpc" })).toBe("/api/search?q=-%3Ekind%3Aaws_vpc");
    expect(searchUrl({ q: "a", env: "prod", snapshot: "latest" })).toBe("/api/search?env=prod&q=a&snapshot=latest");
    expect(searchUrl({ q: "a", snapshot: "latest" })).toBe("/api/search?q=a");
    expect(searchKey({ q: null })).toBeNull();
    expect(searchKey({ q: "a", env: "prod" })).not.toBe(searchKey({ q: "a" }));
  });
});

describe("queryMarks", () => {
  it("lights the matches, keeps the path at full weight, and dims the rest; nothing is hidden", () => {
    const m = queryMarks(answer({ lit: ["web"], onPath: ["subnet", "vpc"], edges: [{ from: "web", to: "subnet" }, { from: "subnet", to: "vpc" }] }), cards, edges);
    expect(Object.fromEntries(m.cardMarks)).toEqual({ web: "lit", subnet: "path", vpc: "path", db: "dim", cache: "dim" });
    expect(m.edgeMarks).toEqual(["path", "path", "dim", "dim"]);
    expect(m.state).toBe("drawn");
  });

  it("before paths (chant#4359), an edge between two lit cards stays lit but is not a path", () => {
    const m = queryMarks(answer({ lit: ["web", "db"] }), cards, edges);
    expect(m.edgeMarks).toEqual(["dim", "dim", "dim", "lit"]);
    expect([...m.cardMarks.values()].filter((x) => x === "path")).toEqual([]);
  });

  it("no matches dims the whole graph and outlines the near-misses, never an empty stage", () => {
    const m = queryMarks(answer({ nearMisses: [{ id: "db", fails: "kind:nope" }, { id: "gone", fails: "kind:nope" }] }), cards, edges);
    expect([...m.cardMarks.values()].every((x) => x === "dim")).toBe(true);
    expect(m.cardMarks.size).toBe(cards.length);
    expect(Object.fromEntries(m.near)).toEqual({ db: "kind:nope" });
    expect(m.state).toBe("no-matches");
  });

  it("a failed live read lights the rows with the unobserved ring and reports failed", () => {
    const m = queryMarks(answer({ lit: ["web"], unobserved: { web: "read-failed" }, failure: { kind: "live", message: "live read failed (terraform: denied)" } }), cards, edges);
    expect(m.cardMarks.get("web")).toBe("lit");
    expect([...m.unobserved]).toEqual(["web"]);
    expect(m.state).toBe("failed");
  });

  it("a query chant refuses, or a refusal, lights and dims nothing", () => {
    const refused = queryMarks(answer({ failure: { kind: "query", code: "query-invalid", message: "not a term" } }), cards, edges);
    expect(refused.cardMarks.size).toBe(0);
    expect(refused.state).toBe("failed");
    const old = queryMarks({ error: "Search needs chant 0.124.46 or newer.", code: "chant-too-old" }, cards, edges);
    expect(old.cardMarks.size).toBe(0);
    expect(old.edgeMarks).toEqual([null, null, null, null]);
  });
});

describe("queryLine", () => {
  const view = { q: "kind:aws_instance" };

  it("says the query and chant's provenance in one line", () => {
    const a = answer({ lit: ["web", "gone"], edges: [{ from: "web", to: "subnet" }] });
    const l = queryLine(view, a, queryMarks(a, cards, edges));
    expect(l.text).toBe('"kind:aws_instance": 2 matches, 1 not drawn at this zoom, path edges drawn · declared only · no observation');
    expect(l.tone).toBe("ok");
  });

  it("no matches says so, with the universe count", () => {
    const a = answer({ nearMisses: [{ id: "db", fails: "kind:aws_instance" }] }, { explain: { universe: { matched: 0, of: 64, kinds: [] } } });
    const l = queryLine(view, a, queryMarks(a, cards, edges));
    expect(l.text).toContain('no matches for "kind:aws_instance", 0 of 64 nodes; near misses outlined (1)');
    expect(l.tone).toBe("empty");
  });

  it("a failed live read is a failure, naming the lexicon", () => {
    const a = answer({ lit: ["web"], failure: { kind: "live", message: "live read failed (terraform: denied): 1/1 rows unobserved. The rows shown are what the source declares." } });
    const l = queryLine(view, a, queryMarks(a, cards, edges));
    expect(l.tone).toBe("failed");
    expect(l.text).toMatch(/^live read failed \(terraform: denied\)/);
  });

  it("names the members chant did not search on a second line", () => {
    const a = answer({ lit: ["east/web"], notSearched: [{ member: "west", status: "failed", code: "member-chant-too-old", message: "old chant" }] });
    expect(queryLine(view, a, queryMarks(a, cards, edges)).notSearched).toBe("not searched: west (member-chant-too-old: old chant)");
  });

  it("a refused query carries chant's message and hint; a refusal its error and remedy", () => {
    const a = answer({ failure: { kind: "query", message: "not a term", hint: "say attr:x=y" } });
    expect(queryLine(view, a, null).text).toBe('"kind:aws_instance" was refused by chant: not a term. say attr:x=y');
    expect(queryLine(view, { error: "Search needs chant 0.124.46 or newer.", remedy: "Upgrade." }, null)).toMatchObject({ tone: "failed", text: '"kind:aws_instance" not searched: Search needs chant 0.124.46 or newer. Upgrade.' });
  });

  it("an export names the queries it captured when asked for another", () => {
    expect(uncapturedLine("b", ["a", "c"])).toBe('"b" not searched: this export answers 2 captured queries, and this is not one of them: "a", "c".');
    expect(uncapturedLine("b", undefined)).toMatch(/captured no queries/);
  });
});
