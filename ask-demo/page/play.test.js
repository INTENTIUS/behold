// behold#1163: the ask demo page's playback, lighting and Cypher box fill, without a page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BEAT_GAP_MS, playback } from "../../web/kiosk-ask.js";
import {
  LOOP_MS,
  MAX_ZOOM,
  MIN_DWELL_MS,
  REDUCED_READ_MS,
  beatOf,
  callLine,
  cypherFill,
  keepInside,
  drawLight,
  loopOf,
  loopTiming,
  narrationProblems,
  panView,
  parseParams,
  recordedAnswer,
  recordedDate,
  recordedWords,
  sourceWords,
  zoomView,
} from "./play.js";

const HERE = import.meta.dirname;
const read = (p) => JSON.parse(readFileSync(join(HERE, "..", p), "utf8"));
const FIXTURE = read("fixtures/page/narration.json");
const RECORDING = read("narration.json");

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
    expect(beat).toEqual({ prompt: turn.prompt, status: turn.busy, reply: turn.reply, turn });
    const pb = playback([beat], 1e9);
    expect(pb.done).toBe(true);
    expect(pb.frames[0]).toMatchObject({ text: turn.prompt, replied: true, replyChars: turn.reply.length });
    const busy = playback([beat], 600 + turn.prompt.length * 90 + 10).frames[0];
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

describe("the Cypher box fill", () => {
  it("is a question's query and its parameters as JSON, and the call it made", () => {
    const q = FIXTURE.turns[1];
    expect(cypherFill(q)).toEqual({ cypher: q.cypher, params: '{"key":"aws_s3_bucket.logs"}', call: "ask cypher=<the query below> params={\"key\":\"aws_s3_bucket.logs\"}" });
    expect(cypherFill(FIXTURE.turns[2]).params).toBe("");
  });
  it("is empty for the load turn, whose call is the commands that loaded the estate", () => {
    const fill = cypherFill(FIXTURE.turns[0]);
    expect(fill).toEqual({ cypher: "", params: "", call: "$ behold serve app --port 4674" });
  });
  it("names a template call's resource and template", () => {
    const t = RECORDING.turns.find((x) => x.call.arguments && x.call.arguments.template);
    expect(callLine(t)).toBe(`ask resource=${t.call.arguments.resource} template=${t.call.arguments.template} (behold ran it as the query below)`);
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
  it("says when each source was read, and that a declared source was not observed", () => {
    expect(sourceWords(FIXTURE.turns[0].sources)).toEqual([
      "chant/. (chant): declared, not observed; read 2026-11-18T12:00:00.000Z, 2 nodes, 1 edges",
      "engine/choudoufu/web (choudoufu): observed 2026-10-26T12:00:00Z; read 2026-11-18T12:00:00.000Z, 6 nodes, 2 edges",
      "engine/plunge/app/dev (plunge): observed 2026-10-26T12:00:00Z; read 2026-11-18T12:00:00.000Z, 4 nodes, 3 edges",
      "cloud/aws/000000000000/9bd41033bb42 (behold-lister): observed 2026-10-26T12:00:00Z; read 2026-11-18T12:00:00.000Z, 1 nodes, 0 edges",
    ]);
    expect(sourceWords([{ scopeKey: "s", name: "n", readAt: "r", observedAt: null }])).toEqual(["s (n): declared, not observed; read r"]);
  });
});

describe("the page's words", () => {
  it("say the answers are a recording from a real run on emulators, with its date, and give the command that records it", () => {
    const w = recordedWords(RECORDING);
    expect(w.line).toBe("Recorded 18 November 2026 from a real run on emulators. Every answer is behold's, replayed as it came back.");
    expect(w.command).toBe("just ask-demo-record");
    expect(w.versions).toContain("behold ");
    expect(`${w.line} ${RECORDING.note}`).not.toMatch(/\blive\b/i);
    expect(recordedDate("2026-01-02T23:59:59Z")).toBe("2 January 2026");
    expect(recordedDate("nope")).toBe("");
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
