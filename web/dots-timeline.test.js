// A recorded replay's timeline: wall-clock time one to one, an idle stretch
// played as a break that says how long it really was, ticks at the
// recording's own times, marks that name their line, and a label and a speed
// that always say this is a recording.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { recordedClock, wallTicks, recordedLabel, speedWords, skippedWords, recordedMarks, clockWords, GAPS, RECORDED_SPEEDS } from "./dots-timeline.js";
import { readCarve, carveShow } from "./dots-recording.js";
import { parentsOf } from "./dots-layout.js";
import { replayClock } from "./dots-scene.js";

const T = Date.parse("2026-09-22T16:38:15Z");

describe("the recorded clock", () => {
  it("plays wall-clock time one to one", () => {
    const c = recordedClock([T + 1_000, T + 4_000], T, T + 6_000);
    expect(c.length).toBe(6_000);
    expect(c.toReplay(T + 4_000)).toBe(4_000);
    expect(c.toReal(2_500)).toBe(T + 2_500);
    expect(c.breaks).toEqual([]);
  });

  it("plays an idle stretch as a break that keeps the real gap's length", () => {
    const c = recordedClock([T + 1_000, T + 61_000], T, T + 62_000);
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0].skipped).toBe(60_000 - GAPS.keep);
    expect(c.length).toBe(62_000 - c.breaks[0].skipped);
    // Before the gap and after it, one to one.
    expect(c.toReplay(T + 61_000) - c.toReplay(T + 61_000 - 500)).toBe(500);
    expect(c.toReal(c.toReplay(T + 61_500))).toBe(T + 61_500);
    expect(skippedWords(c.breaks[0].skipped)).toBe("+58 s skipped");
    expect(skippedWords(125_000)).toBe("+2 min 5 s skipped");
  });

  it("holds at a time for the ms asked, and recorded time stands still there", () => {
    const c = recordedClock([T + 1_000, T + 61_000], T, T + 62_000, { holds: [{ at: T + 1_000, ms: 5_000 }] });
    expect(c.holds).toEqual([{ p: 1_000, real: T + 1_000, ms: 5_000 }]);
    expect(c.toReal(1_000)).toBe(T + 1_000);
    expect(c.toReal(4_000)).toBe(T + 1_000);
    expect(c.toReal(6_500)).toBe(T + 1_500);
    expect(c.toReplay(T + 1_000)).toBe(1_000);
    expect(c.length).toBe(62_000 - c.breaks[0].skipped + 5_000);
  });

  it("ticks at the recording's own wall-clock times, never 0:00", () => {
    // A write every 5 s for ten minutes: no stretch is idle, so none is skipped.
    const c = recordedClock(Array.from({ length: 120 }, (_, i) => T + i * 5_000), T, T + 10 * 60_000);
    expect(c.breaks).toEqual([]);
    const ticks = wallTicks(c, 6);
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks[0].label).toMatch(/^16:\d\d$/);
    for (const t of ticks) expect(clockWords(t.real)).toBe(t.label);
  });
});

describe("what the timeline says", () => {
  it("says it is a recording, when and from what, and shortens on a phone", () => {
    const facts = { t0: T, t1: T + 34 * 60_000 + 44_000, source: "behold-terralith-14", plan: "domains" };
    expect(recordedLabel(facts)).toMatch(/^Recorded 22 Sept? 2026, 16:38:15–17:12:59 UTC from behold-terralith-14 · plan domains$/);
    expect(recordedLabel({ t0: T, t1: T + 60_000 })).not.toMatch(/from/);
    expect(recordedLabel(facts, { short: true })).toBe("Recorded 16:38–17:12 UTC");
  });

  it("always says the speed in words", () => {
    expect(speedWords(1)).toBe("1x real time");
    expect(speedWords(0.1)).toBe("slowed ×10");
    expect(speedWords(4)).toBe("sped up ×4");
    expect(RECORDED_SPEEDS[0]).toBe(1);
  });
});

describe("the committed recording on its own clock", () => {
  const text = gunzipSync(readFileSync(fileURLToPath(new URL("../scripts/dot-bench/carve-terralith-14.jsonl.gz", import.meta.url)))).toString("utf8");
  const rec = readCarve(text);
  const show = carveShow(rec, parentsOf(rec.roster));

  it("replays on the recording's clock, with a break for each listing pause", () => {
    const clock = replayClock(show);
    expect(clock.recorded).toBe(true);
    expect(clock.length).toBe(show.timeline.length);
    expect(show.timeline.breaks.length).toBeGreaterThan(0);
    for (const b of show.timeline.breaks) expect(b.skipped).toBeGreaterThan(0);
  });

  it("marks the first and last move and each keyframe, each naming its line and time", () => {
    const marks = recordedMarks(show, show.timeline, "carve-terralith-14.jsonl");
    expect(marks.find((m) => m.kind === "first").record).toMatch(/^carve-terralith-14\.jsonl line \d+ · 2026-09-22T/);
    expect(marks.filter((m) => m.kind === "keyframe")).toHaveLength(rec.keyframes.length);
    for (const m of marks) expect(m.p).toBeGreaterThanOrEqual(0);
  });
});
