// A recorded cycle played condensed (behold#571): a cycle-86-shaped
// terralith cycle (31 steps over 425 s) plays in 60 to 90 s on the tour
// file's own settings, each chapter stays up long enough to read, every cut
// is a break that says its real gap, the split's moves play at their real
// pace, and nothing in the replay's path reads or waits on the wall clock.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cycleClock, createPlayhead, replayFrame, replaySettings, stepIndexAt, cycleMarks, chapterStarts, cycleEvents, REPLAY } from "./cycle-replay.js";
import { cycle86, carve86 } from "./cycle-86.fixture.js";
import { chapterAt } from "./tour-player.js";
import { tourNow } from "./dots-tour.js";
import { quietWords } from "./kiosk-watch.js";
import { recordedClock } from "./dots-timeline.js";

const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const tourFile = JSON.parse(read("./tours/terralith.json"));
// The carve read of cycle 86 with the shipped tour's chapters and replay settings, as the server resolves them.
const answer = { ...carve86, tour: { ...carve86.tour, chapters: tourFile.chapters, replay: tourFile.replay, steps: tourFile.steps, step: "reset" } };
const real = (s) => Date.parse(s.at);

describe("the fixture is cycle 86's shape", () => {
  it("has 31 steps over 425 s, and the gaps the lead measured", () => {
    expect(cycle86.steps).toHaveLength(31);
    expect((Date.parse(cycle86.ended) - Date.parse(cycle86.started)) / 1000).toBe(425);
    // The steps alone: about 112 s with gaps over 10 s cut to 2 s, about 47 s with gaps over 3 s cut to 1.5 s.
    const ts = cycle86.steps.map(real);
    expect(recordedClock(ts, ts[0], ts[30], { maxGap: 10_000, keep: 2_000 }).length / 1000).toBeCloseTo(112, -1);
    expect(recordedClock(ts, ts[0], ts[30], { maxGap: 3_000, keep: 1_500 }).length / 1000).toBeCloseTo(47, -1);
  });
});

describe("a recorded terralith cycle, condensed", () => {
  const cc = cycleClock(cycle86, answer);
  const set = replaySettings(answer.tour);

  it("takes the tour file's replay settings over the defaults", () => {
    expect(set).toEqual({ ...REPLAY, ...tourFile.replay });
  });

  it("plays its 425 s in 60 to 90 s, and holds the closing card before it starts again", () => {
    expect(cc.condensed).toBeGreaterThanOrEqual(60_000);
    expect(cc.condensed).toBeLessThanOrEqual(90_000);
    expect(cc.endHold).toBe(set.endHoldMs);
    expect(cc.length).toBe(cc.condensed + set.endHoldMs);
    // The closing card: the last chapter is "This cycle, in numbers", and the hold is on it.
    const last = cc.chapters[cc.chapters.length - 1];
    expect(last.id).toBe("epilogue");
    expect(chapterAt(answer.tour, answer.tour.events, cc.real(cc.length - 1)).chapter.id).toBe("epilogue");
  });

  it("gives every chapter at least its minimum on screen", () => {
    expect(cc.chapters.map((c) => c.id)).toEqual(tourFile.chapters.map((c) => c.id));
    for (const c of cc.chapters) expect(c.len).toBeGreaterThanOrEqual(set.chapterMinMs);
  });

  it("marks every cut as a break that keeps the real gap", () => {
    const b = cc.clock.breaks;
    expect(b.length).toBeGreaterThan(10);
    for (const x of b) {
      expect(x.skipped).toBeGreaterThan(0);
      expect(x.real1 - x.real0).toBe(x.skipped);
    }
    // What was cut and what was played add up to the cycle, less any hold, which plays and records nothing.
    const held = cc.clock.holds.reduce((n, h) => n + h.ms, 0);
    expect(cc.length - held + b.reduce((n, x) => n + x.skipped, 0)).toBe(cc.t1 - cc.t0);
  });

  it("plays the split's moves at their real pace, and each write's flight whole", () => {
    const moves = carve86.migrations.find((m) => m.name === "split").lines.map(real);
    const a = Math.min(...moves);
    const z = Math.max(...moves) + set.flightMs;
    expect(cc.at(z) - cc.at(a)).toBe(z - a);
    for (const t of carve86.migrations.flatMap((m) => m.lines.map(real))) expect(cc.at(t + set.flightMs) - cc.at(t)).toBe(set.flightMs);
  });

  it("reaches the reset at the end of the condensed length, and every step on the way", () => {
    expect(stepIndexAt(cycle86, cc.real(0))).toBe(0);
    expect(cycle86.steps[stepIndexAt(cycle86, cc.real(cc.condensed))].step).toBe("reset");
    const seen = new Set();
    for (let p = 0; p <= cc.length; p += 100) seen.add(stepIndexAt(cycle86, cc.real(p)));
    expect(seen.size).toBe(31);
  });

  it("marks each chapter on the timeline, where its chapter starts", () => {
    const marks = cycleMarks(cc, cycle86, answer);
    const ch = marks.filter((m) => m.kind === "chapter");
    expect(ch).toHaveLength(tourFile.chapters.length);
    for (const m of ch) expect(chapterAt(answer.tour, answer.tour.events, cc.real(m.p)).chapter.title).toBe(m.words.replace(/^chapter \d+: /, ""));
  });

  it("tells the tour at the replay's time, not at the cycle's end", () => {
    const starts = chapterStarts(answer.tour, cycleEvents(cycle86, answer.tour));
    const split = starts.find((c) => c.id === "split");
    const tn = tourNow(answer, split.at, "pull-request");
    expect(tn.at.chapter.id).toBe("split");
    expect(tourNow(answer).at.chapter.id).toBe("epilogue");
  });
});

describe("nothing in replay mode runs on the wall clock", () => {
  const cc = cycleClock(cycle86, answer);
  const at = (w) => ({ cycle: cycle86, cc, player: createPlayhead(cc.length, { at: w }) });

  it("the whole cycle plays in its condensed length of page time, whatever the wall clock says", () => {
    // Page time handed in by the caller is the only clock: 0 here, the epoch, nowhere near the cycle's recorded time.
    let r = at(0);
    let f = replayFrame(r, null, cc.condensed);
    expect(cycle86.steps[f.index].step).toBe("reset");
    expect(f.real).toBe(cc.t1);
    // At four times the speed, a quarter of that.
    r = at(0);
    r.player.setSpeed(4, 0);
    f = replayFrame(r, null, cc.condensed / 4);
    expect(cycle86.steps[f.index].step).toBe("reset");
  });

  it("starts a newer cycle only at the loop's end, never mid-replay", () => {
    const next = { cycle: { ...cycle86, cycle: 87 }, cc, player: createPlayhead(cc.length, { at: 0 }) };
    let f = replayFrame(at(0), next, cc.length / 2);
    expect(f.swapped).toBe(false);
    expect(f.replay.cycle.cycle).toBe(86);
    expect(f.next).toBe(next);
    f = replayFrame(f.replay, f.next, cc.length + 10);
    expect(f.swapped).toBe(true);
    expect(f.replay.cycle.cycle).toBe(87);
    expect(f.p).toBe(0);
    expect(f.next).toBeNull();
  });

  it("loops the same cycle when no newer one was read", () => {
    const f = replayFrame(at(0), null, cc.length + 1);
    expect(f.replay.cycle.cycle).toBe(86);
    expect(f.p).toBeLessThan(10);
  });

  it("a seek and a pause move the playhead, and only the page's time moves it on", () => {
    const r = at(0);
    r.player.seek(30_000, 1_000);
    expect(r.player.position(1_000)).toBe(30_000);
    r.player.play(false, 2_000);
    expect(r.player.position(60_000)).toBe(31_000);
  });

  it("no module of the replay's path reads the wall clock or sets a timer to pace it", () => {
    const src = read("./cycle-replay.js").replace(/\/\/.*$/gm, "");
    for (const call of ["Date.now(", "performance.now(", "setTimeout(", "setInterval(", "requestAnimationFrame("]) expect(src).not.toContain(call);
    // A date it formats is a recorded time; a `new Date()` with nothing in it would be the wall clock.
    expect(src).not.toMatch(/new Date\(\s*\)/);
    // The kiosk paces its replay by the condensed clock alone: the old real-time step player and its 20 s hold are gone from it.
    const kiosk = read("./kiosk.js");
    expect(kiosk).not.toMatch(/\breplayAt\(/);
    expect(kiosk).not.toMatch(/REPLAY_LAST_HOLD_MS/);
    expect(kiosk).toMatch(/replayFrame\(s\.replay, s\.replayNext, now\(\)\.getTime\(\)\)/);
  });

  it("the frame's dots layer tells a recorded cycle at its playhead, with no poll and no live hold", () => {
    const dots = read("./dots.js");
    const body = (name) => {
      const i = dots.indexOf(`function ${name}(`);
      return dots.slice(i, dots.indexOf("\n}\n", i));
    };
    // The playhead's time, the tour at that time, the value's travel at that time, and no live hold or poll for a cycle.
    expect(body("cycleNow")).not.toMatch(/Date\.now\(/);
    expect(body("cycleT")).not.toMatch(/Date\.now\(/);
    expect(body("liveTick")).toMatch(/tourNow\(answer, cy\.real, cy\.step\)/);
    expect(body("liveTick")).toMatch(/!!cy \|\| S\.tourOn/);
    expect(body("drawTour")).toMatch(/\(showNow - fx\.travel\.at\)/);
    expect(body("startLive")).toMatch(/if \(!S\.cyc\) \{\s*const poll = setInterval/);
  });

  it("the quiet line never shows in a replay", () => {
    const d = cycle86.steps.find((x) => x.step === "applying");
    expect(quietWords(d, { now: Date.parse(d.at) + 600_000, lastRecordAt: Date.parse(d.at), stepAt: Date.parse(d.at), replay: true })).toBeNull();
  });
});
