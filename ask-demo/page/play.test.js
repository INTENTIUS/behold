// behold#1163: the ask demo page's playback, lighting and Cypher box fill, without a page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BEAT_GAP_MS, playback } from "../../web/kiosk-ask.js";
import { answerDrawing } from "../../web/graph-query.js";
import {
  DEMO_DOCS,
  DOCS,
  LINKS,
  LOOP_MS,
  answerHeadline,
  pairedKeys,
  resourceDetails,
  resourceFacts,
  rowKeys,
  MAX_ZOOM,
  MIN_DWELL_MS,
  PANE_BEAT_MS,
  REDUCED_READ_MS,
  beatOf,
  callLine,
  callTitle,
  cypherFill,
  keepInside,
  drawLight,
  knownResources,
  loadRows,
  loopOf,
  loopTiming,
  narrationProblems,
  paneOpen,
  panView,
  parseParams,
  recordedAnswer,
  recordedDate,
  recordedTime,
  recordedWords,
  sourceTitle,
  sourceWords,
  zoomView,
} from "./play.js";

const HERE = import.meta.dirname;
const read = (p) => JSON.parse(readFileSync(join(HERE, "..", p), "utf8"));
const FIXTURE = read("fixtures/page/narration.json");
const RECORDING = read("narration.json");
const KNOWN = knownResources(read("estate/graphdb.json"));

describe("the narrations this page plays", () => {
  it("are well formed, the recording and both fixtures", () => {
    expect(narrationProblems(FIXTURE)).toEqual([]);
    expect(narrationProblems(RECORDING)).toEqual([]);
    expect(narrationProblems(read("fixtures/narration.fixture.json"))).toEqual([]);
  });
  it("names what is wrong with one it cannot play", () => {
    expect(narrationProblems(null)).toEqual(["the narration is not a JSON object"]);
    const problems = narrationProblems({ format: "x", recordedAt: "never", turns: [{ id: "q", kind: "question", prompt: "p", busy: "b" }] });
    expect(problems).toContain('format is "x", not behold-ask-demo-narration/1');
    expect(problems).toContain("recordedAt is not a timestamp");
    expect(problems).toContain("the first turn is not the load turn");
    expect(problems).toContain("there is no question turn");
    expect(problems).toContain("turn q lacks a prompt, a busy line or a reply");
  });
});

describe("loops", () => {
  it("are the load turn and then one question, the next loop taking the next question and coming round", () => {
    const qs = FIXTURE.turns.slice(1).map((t) => t.id);
    const ids = [0, 1, 2, 3, -1].map((i) => loopOf(FIXTURE, i));
    expect(ids.map((l) => l.question.id)).toEqual([qs[0], qs[1], qs[2], qs[0], qs[2]]);
    for (const l of ids) {
      expect(l.load.id).toBe("load");
      expect(l.of).toBe(3);
      expect(l.steps.map((s) => s.step)).toEqual(["load", l.question.id]);
      expect(new Set(l.steps.map((s) => s.cycle)).size).toBe(1);
    }
    expect(loopOf(FIXTURE, 0).steps[0].cycle).not.toBe(loopOf(FIXTURE, 1).steps[0].cycle);
  });

  it("give the prompt pane a beat per turn that types the prompt, shows the busy line and types the reply, carrying its turn", () => {
    const turn = FIXTURE.turns[1];
    const beat = beatOf(turn);
    expect(beat).toEqual({ prompt: turn.prompt, reading: turn.reading, status: turn.busy, reply: turn.reply, turn });
    expect(beatOf({ ...turn, reading: undefined })).not.toHaveProperty("reading");
    const pb = playback([beat], 1e9);
    expect(pb.done).toBe(true);
    expect(pb.frames[0]).toMatchObject({ text: turn.prompt, replied: true, replyChars: turn.reply.length });
    const reading = playback([beat], 600 + turn.prompt.length * 90 + 80).frames[0];
    expect(reading).toMatchObject({ busy: false, replied: false, readingTyping: true });
    const busy = playback([beat], 600 + turn.prompt.length * 90 + turn.reading.length * 35 + 10).frames[0];
    expect(busy).toMatchObject({ busy: true, replied: false });
  });

  it("take about a minute each with the recording, the question following the load turn's words", () => {
    for (let i = 0; i < RECORDING.turns.length - 1; i++) {
      const l = loopOf(RECORDING, i);
      const t = loopTiming(l);
      expect(t.questionAt).toBe(playback(l.steps[0].asks, 0).end + BEAT_GAP_MS);
      expect(t.playMs).toBeGreaterThan(20_000);
      expect(t.dwellMs).toBeGreaterThanOrEqual(MIN_DWELL_MS);
      expect(t.totalMs).toBeGreaterThanOrEqual(LOOP_MS);
      expect(t.totalMs).toBeLessThan(LOOP_MS + 15_000);
    }
  });

  it("under reduced motion show each turn's words at once, the question a while after the load turn", () => {
    const t = loopTiming(loopOf(RECORDING, 0), { reduced: true });
    expect(t).toEqual({ questionAt: REDUCED_READ_MS, playMs: REDUCED_READ_MS, dwellMs: LOOP_MS - REDUCED_READ_MS, totalMs: LOOP_MS });
  });
});

describe("the agent's pane (#1183)", () => {
  it("stays open while the turns print, however long they take", () => {
    expect(paneOpen({ phase: "playing" })).toBe(true);
    expect(paneOpen({ phase: "playing", sinceDoneMs: 60_000 })).toBe(true);
    expect(paneOpen({ phase: "playing", chosen: false })).toBe(true);
  });

  it("closes a short beat after the question's reply has printed", () => {
    expect(PANE_BEAT_MS).toBeGreaterThanOrEqual(1_000);
    expect(PANE_BEAT_MS).toBeLessThan(MIN_DWELL_MS / 2);
    expect(paneOpen({ phase: "after", sinceDoneMs: 0 })).toBe(true);
    expect(paneOpen({ phase: "after", sinceDoneMs: PANE_BEAT_MS - 1 })).toBe(true);
    expect(paneOpen({ phase: "after", sinceDoneMs: PANE_BEAT_MS })).toBe(false);
    expect(paneOpen({ phase: "after", sinceDoneMs: MIN_DWELL_MS })).toBe(false);
  });

  it("follows the visitor once the reply has printed, open or closed", () => {
    expect(paneOpen({ phase: "after", sinceDoneMs: MIN_DWELL_MS, chosen: true })).toBe(true);
    expect(paneOpen({ phase: "after", sinceDoneMs: 0, chosen: false })).toBe(false);
    expect(paneOpen({ phase: "after", sinceDoneMs: MIN_DWELL_MS, chosen: null })).toBe(false);
  });
});

describe("the Cypher box fill", () => {
  it("is a question's query and its parameters as JSON, and the call it made", () => {
    const q = FIXTURE.turns[1];
    expect(cypherFill(q)).toEqual({ cypher: q.cypher, params: '{"key":"aws_s3_bucket.logs"}', call: "The agent asked behold this query through its ask tool, with the parameters below it." });
    expect(cypherFill(FIXTURE.turns[2]).call).toBe("The agent asked behold this query through its ask tool.");
    // The call as the agent made it stays on hover.
    expect(callTitle(q)).toBe(`ask ${JSON.stringify(q.call.arguments)}`);
    expect(cypherFill(FIXTURE.turns[2]).params).toBe("");
  });
  it("is empty for the load turn, which says what it loaded, with the commands on hover (#1191)", () => {
    const fill = cypherFill(FIXTURE.turns[0]);
    expect(fill).toEqual({ cypher: "", params: "", call: "The agent loaded the estate into behold: 4 sources, each one a row below. No query has run yet." });
    expect(callTitle(FIXTURE.turns[0])).toBe("$ behold serve app --port 4674");
    expect(callTitle({})).toBe("");
    const rows = loadRows(RECORDING.turns[0]);
    expect(rows.columns).toEqual(["what", ...RECORDING.turns[0].columns]);
    expect(rows.rows.map((r) => r.what)).toContain("the AWS account's index");
    expect(rows.rows.every((r, i) => r.scopeKey === RECORDING.turns[0].rows[i].scopeKey)).toBe(true);
  });
  it("names a template call's resource and template", () => {
    const t = RECORDING.turns.find((x) => x.call.arguments && x.call.arguments.template);
    expect(callLine(t)).toBe(`The agent asked behold, through its ask tool, to run the ${t.call.arguments.template} template on ${t.call.arguments.resource}. behold ran it as this query.`);
    expect(callLine({ call: { tool: "ask", arguments: { resource: "r", template: "t", inputs: '{"kind":"x"}' } } })).toBe('The agent asked behold, through its ask tool, to run the t template on r, with the inputs {"kind":"x"}. behold ran it as this query.');
    // No wire format above a recorded query.
    for (const turn of RECORDING.turns) expect(callLine(turn), turn.id).not.toMatch(/=|<the query|\$ /);
    expect(cypherFill(t).cypher).toBe(t.cypher);
  });
});

describe("the recorded answer", () => {
  it("is the turn's rows, keys, drawing and sources, as the query route answers", () => {
    const q = FIXTURE.turns[3];
    expect(recordedAnswer(q)).toEqual({ status: 200, body: { columns: q.columns, rows: q.rows, keys: q.keys, draw: q.draw, sources: q.sources } });
  });
  it("draws a turn's keys alone, named by their last segment, with no edges, when the recorder kept no drawing", () => {
    const q = FIXTURE.turns[2];
    expect(q.draw).toBeUndefined();
    expect(recordedAnswer(q).body.draw).toEqual({ nodes: q.keys.map((key) => ({ key, kind: "", name: key.split("/").pop(), source: "", scopeKey: "" })), edges: [] });
  });
  it("lights its keys in the drawing, so an answer the estate graph has no card for still lights somewhere", () => {
    for (const q of [...FIXTURE.turns.slice(1), ...RECORDING.turns.slice(1)]) {
      const lit = drawLight(recordedAnswer(q).body);
      expect(lit.length, q.id).toBeGreaterThan(0);
      for (const k of lit) expect(q.keys).toContain(k);
    }
    const indexOnly = RECORDING.turns.filter((t) => t.kind === "question" && !t.light.length);
    expect(indexOnly.length).toBeGreaterThan(0);
  });
  it("draws both ends of each recorded row that pairs two keys, from the rows the recording loaded (#1190)", () => {
    expect(KNOWN.get("gcp/webRule")).toEqual({ key: "gcp/webRule", kind: "GCP::Compute::ForwardingRule", name: "webRule", source: "chant", scopeKey: "chant/gcp" });
    expect(knownResources(null).size).toBe(0);
    const q = RECORDING.turns.find((t) => t.id === "dns-cross-cloud");
    const lit = drawLight(recordedAnswer(q).body, KNOWN);
    for (const r of q.rows) for (const k of [r.key, r.reaches]) expect(lit, k).toContain(k);
    const sa = RECORDING.turns.find((t) => t.id === "serviceaccount-roles");
    const roles = drawLight(recordedAnswer(sa).body, KNOWN);
    for (const r of sa.rows) for (const k of [r.key, r.roleKey]) expect(roles, k).toContain(k);
  });
  it("names each source in words, says when it was read, and keeps the scope key for hover (#1191)", () => {
    expect(sourceWords(FIXTURE.turns[0].sources)).toEqual([
      "The project: 2 resources and 1 edge as declared; loaded into behold 18 November 2026, 12:00 UTC",
      "Choudoufu's graph of web: 6 resources and 2 edges as indexed 26 October 2026, 12:00 UTC; loaded into behold 18 November 2026, 12:00 UTC",
      "Plunge's graph of app/dev: 4 resources and 3 edges as indexed 26 October 2026, 12:00 UTC; loaded into behold 18 November 2026, 12:00 UTC",
      "The AWS account's index: 1 resource and 0 edges as indexed 26 October 2026, 12:00 UTC; loaded into behold 18 November 2026, 12:00 UTC",
    ]);
    expect(sourceWords([{ scopeKey: "s", name: "n", readAt: "r", observedAt: null }])).toEqual(["S: its resources as declared; loaded into behold r"]);
    expect(sourceTitle(FIXTURE.turns[0].sources[3])).toBe("cloud/aws/000000000000/9bd41033bb42 (behold-lister), loaded 2026-11-18T12:00:00.000Z, observed 2026-10-26T12:00:00Z");
    expect(sourceTitle({ scopeKey: "chant/.", name: "chant", readAt: "r", observedAt: null })).toBe("chant/. (chant), loaded r, declared, not observed");
    expect(recordedTime("2026-11-18T17:20:15.866Z")).toBe("18 November 2026, 17:20 UTC");
    // The recording's lines and replies print no scope key or emulator account id.
    for (const t of RECORDING.turns) {
      for (const line of sourceWords(t.sources)) expect(line, t.id).not.toMatch(/000000000000|cloud\/|engine\/|chant\//);
      expect(t.reply, t.id).not.toMatch(/000000000000|cloud\/aws|cloud\/kubernetes|engine\/|chant\//);
    }
  });
});

describe("the page's words", () => {
  it("say the answers are a recording from a real run on emulators, with its date, and give the command that records it", () => {
    const w = recordedWords(RECORDING);
    expect(w.line).toBe("Recorded 18 November 2026 from a real run on emulators. Every answer is behold's, replayed as it came back.");
    expect(w.line).toBe(`${w.date} ${w.replay}`);
    expect(w.command).toBe("just ask-demo-record");
    expect(w.versions).toContain("behold ");
    expect(`${w.line} ${RECORDING.note}`).not.toMatch(/\blive\b/i);
    expect(recordedDate("2026-01-02T23:59:59Z")).toBe("2 January 2026");
    expect(recordedDate("nope")).toBe("");
  });
});

describe("the header (#1188)", () => {
  const page = readFileSync(join(HERE, "index.html"), "utf8");
  const head = page.slice(page.indexOf('<header id="ad-head">'), page.indexOf("</header>"));
  it("says what behold is and what the loop shows, who asks whom, and never that it is live", () => {
    const text = head.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("A coding agent asks behold about an estate");
    expect(text).toContain("behold reads infrastructure code, cloud accounts and clusters into one graph.");
    expect(text).toMatch(/the agent asks behold, which answers in Cypher/);
    expect(text).not.toMatch(/\blive\b/i);
  });
  it("links to behold's docs, this demo's page and running the loop on your own estate, and gives no repository recipe", () => {
    expect(DEMO_DOCS.startsWith(DOCS)).toBe(true);
    for (const l of LINKS) expect(head).toContain(`<a id="${l.id}" href="${l.href}">${l.text}</a>`);
    expect(head).not.toContain("just ask-demo");
    // The recipe moved to About this recording, which links the docs page's section on it.
    const about = page.slice(page.indexOf("<summary>About this recording</summary>"));
    expect(about).toContain('<code id="ad-command">just ask-demo-record</code>');
  });
  it("links docs sections that exist", () => {
    const mdx = readFileSync(join(HERE, "..", "..", "docs", "src", "content", "docs", "using", "ask-demo.mdx"), "utf8");
    const slugs = [...mdx.matchAll(/^## (.+)$/gm)].map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"));
    for (const [, slug] of page.matchAll(/https:\/\/intentius\.io\/behold\/using\/ask-demo\/#([a-z0-9-]+)/g)) expect(slugs).toContain(slug);
  });
});

describe("a visitor's parameters", () => {
  it("are none when empty, and otherwise a JSON object", () => {
    expect(parseParams("")).toEqual({ ok: true, params: undefined });
    expect(parseParams(' {"k": 1} ')).toEqual({ ok: true, params: { k: 1 } });
    expect(parseParams("[1]")).toEqual({ ok: false, error: "Parameters are a JSON object." });
    expect(parseParams("{")).toEqual({ ok: false, error: "Parameters are a JSON object." });
  });
});

describe("the visitor's zoom (#1175)", () => {
  const full = { x: 0, y: 0, width: 2000, height: 3000 };
  it("zooms about a point that stays put, and back out to the full graph", () => {
    const v = zoomView(full, full, 2, { x: 500, y: 600 });
    expect(v).toEqual({ x: 250, y: 300, width: 1000, height: 1500 });
    expect(zoomView(v, full, 0.5, { x: 500, y: 600 })).toEqual(full);
  });
  it("stops at the full graph and at MAX_ZOOM", () => {
    expect(zoomView(full, full, 0.5)).toEqual(full);
    const deep = zoomView(full, full, 1000);
    expect(deep.height).toBeCloseTo(3000 / MAX_ZOOM);
    expect(zoomView(deep, full, 2)).toEqual(deep);
  });
  it("zooms a frame that is not the graph's shape by its larger side", () => {
    const frame = { x: 100, y: 100, width: 1500, height: 300 };
    const out = zoomView(frame, full, 0.25);
    expect(out.width).toBe(2000);
    expect(out.height).toBe(400);
    expect(out.x).toBe(0);
  });
  it("pans inside the graph", () => {
    const v = { x: 100, y: 100, width: 500, height: 500 };
    expect(panView(v, full, -400, 50)).toEqual({ x: 0, y: 150, width: 500, height: 500 });
    expect(panView(v, full, 5000, 5000)).toEqual({ x: 1500, y: 2500, width: 500, height: 500 });
    expect(keepInside({ x: 0, y: 0, width: 2400, height: 100 }, full)).toEqual({ x: -200, y: 0, width: 2400, height: 100 });
  });
});

describe("what the answer found, and one of its resources (#1198)", () => {
  const GRAPHDB = read("estate/graphdb.json");
  const ESTATE = read("estate/graph.json");
  const facts = resourceFacts(GRAPHDB, ESTATE.ir.nodes);
  const q = RECORDING.turns.find((t) => t.id === "dns-cross-cloud");
  const body = recordedAnswer(q).body;
  const picture = answerDrawing(body, KNOWN);

  it("heads a recorded turn with its headline, and a visitor's query with a count", () => {
    expect(answerHeadline(q, body, picture)).toBe(q.headline);
    expect(q.headline).toMatch(/^2 Route 53 records depend on 4 resources/);
    expect(answerHeadline(null, body, picture)).toBe(`7 rows, ${picture.nodes.length} resources`);
    expect(answerHeadline(null, { rows: [{ x: 1 }] }, { nodes: [] })).toBe("1 row");
    expect(answerHeadline(null, { rows: [{ x: 1 }] }, { nodes: [{ key: "a" }] })).toBe("1 row, 1 resource");
  });

  it("selects a row's two ends, or a resource with every key it is paired with", () => {
    expect(rowKeys(body, picture, 0)).toEqual([q.rows[0].key, q.rows[0].reaches]);
    expect(rowKeys(body, picture, 99)).toEqual([]);
    expect(rowKeys(recordedAnswer(RECORDING.turns[0]).body, { keyColumns: [] }, 0)).toEqual([]);
    const ends = pairedKeys(body, picture, "dns/gcpRecord");
    expect(ends[0]).toBe("dns/gcpRecord");
    expect(ends.slice(1).sort()).toEqual(q.rows.filter((r) => r.key === "dns/gcpRecord").map((r) => r.reaches).sort());
    expect(pairedKeys(body, picture, "nowhere")).toEqual(["nowhere"]);
  });

  it("details a resource from what the page holds: kind, name, source in words, where it is declared, its cloud id", () => {
    expect(resourceDetails("gcp/webRule", facts)).toEqual({
      key: "gcp/webRule",
      name: "webRule",
      rows: [["Kind", "GCP::Compute::ForwardingRule"], ["Name", "webRule"], ["Source", "the gcp member"], ["Declared", "in the gcp member, src/site.ts"]],
      note: "",
    });
    const role = resourceDetails("cloud/aws/000000000000/db1d7f66ad8c/aws/000000000000/global/AWS::IAM::Role/orders-reader", facts);
    expect(role.rows).toContainEqual(["Source", "the AWS account's index"]);
    expect(role.rows).toContainEqual(["Cloud id", "arn:aws:iam::000000000000:role/orders-reader"]);
    expect(role.note).toBe("The workspace declares nothing for it.");
    // An indexed resource carrying the aws member's ownership marker says so, rather than that nothing declares it.
    const subnet = resourceDetails("cloud/aws/000000000000/db1d7f66ad8c/aws/000000000000/us-east-1/AWS::EC2::Subnet/subnet-33900fa9", facts);
    expect(subnet.rows).toContainEqual(["Owner marker", "aws:ec2/subnet:Subnet::network-private-subnet-1 (three-cloud-aws/local)"]);
    expect(subnet.note).toBe("");
    // Declared through a shared cloud id.
    const f = resourceFacts(
      { rows: { resources: [{ key: "c/x", source: "chant", scopeKey: "chant/web", name: "logs", kind: "k" }, { key: "i/x", source: "index", scopeKey: "cloud/aws/1/h", name: "web-logs", kind: "k", nativeId: "web-logs" }], knownAs: [{ key: "c/x", value: "web-logs" }, { key: "i/x", value: "web-logs" }] } },
      [{ id: "c/x", sourceLoc: { file: "main.tf" } }],
    );
    expect(resourceDetails("i/x", f).rows).toContainEqual(["Declared", "as logs in the web member, main.tf"]);
    expect(resourceDetails("gone/key", f)).toEqual({ key: "gone/key", name: "key", rows: [], note: "This page holds nothing more about it." });
    expect(resourceFacts(null, null).resources.size).toBe(0);
  });
});
