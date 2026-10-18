import { describe, expect, it } from "vitest";
import { FILL_CAP, cycleTrack, trackModel, waitingSpec } from "./kiosk-track.js";

// behold#631: chant-fanout's last finished cycle as cycles/chant-fanout/latest.json had it (cycle 499):
// fifteen steps, two pull requests, from the change's open to the reset.
const T = (s) => `2026-10-18T18:${s}Z`;
const step = (at, s, pull, label = "", next = null) => ({ at: T(at), step: s, pull, label, ...(next ? { next } : {}) });
const cycle = {
  cycle: 499,
  started: T("18:48"),
  ended: T("21:10"),
  steps: [
    step("18:49", "pull-request", 641, "Pull request 641 is open."),
    step("19:01", "planned", 641),
    step("19:14", "waiting", 641, "The plan waits for a reviewer's approval."),
    step("19:27", "approved", 641),
    step("19:27", "merged", 641),
    step("19:30", "applying", 641),
    step("19:49", "failed", 641),
    step("20:10", "pull-request", 642),
    step("20:22", "planned", 642),
    step("20:26", "waiting", 642),
    step("20:36", "approved", 642),
    step("20:36", "merged", 642),
    step("20:37", "applying", 642),
    step("20:56", "applied", 642),
    step("21:10", "reset", null),
  ],
};

describe("the projected cycle track (behold#631)", () => {
  const track = cycleTrack(cycle);

  it("lays the last cycle out as two chapters of plainly labelled segments, as long as each step took", () => {
    expect(track.chapters.map((c) => c.segments.map((g) => g.label))).toEqual([
      ["opened", "planned", "review", "merged", "applying", "failed"],
      ["fix opened", "planned", "review", "merged", "applying", "done", "reset"],
    ]);
    // The review holds the wait and the approval: 13 s from waiting to the merge.
    expect(track.chapters[0].segments[2]).toMatchObject({ steps: ["waiting", "approved"], ms: 13_000 });
    expect(track.chapters[0].segments[4].ms).toBe(19_000);
  });

  it("fills what is past, fills the current step as its time passes, and leaves the rest outlined", () => {
    const now = Date.parse(T("40:00"));
    const m = trackModel(track, { demo: { step: "waiting", pull: 12, cycle: 7, label: "The plan waits for a reviewer's approval." }, pulls: [12], since: now - 6_500, now });
    expect(m.chapters.map((c) => c.title)).toEqual(["The change (PR #12)", "The fix"]);
    const segs = m.chapters[0].segments;
    expect(segs.slice(0, 2).map((g) => [g.state, g.fill])).toEqual([["done", 1], ["done", 1]]);
    expect(segs[2]).toMatchObject({ state: "current", label: "review" });
    expect(segs[2].fill).toBeCloseTo(0.5, 1);
    expect(m.chapters[1].segments.every((g) => g.state === "ahead" && g.fill === 0)).toBe(true);
    expect(m.now.text).toBe("Waiting for the reviewer · usually about 13 s");
  });

  it("caps the fill and says so when a step runs long", () => {
    const now = Date.parse(T("40:00"));
    // 12 s usual: still "usually" at 19 s (under 12 + 8), long at 21 s.
    const early = trackModel(track, { demo: { step: "pull-request", pull: 12 }, pulls: [12], since: now - 19_000, now });
    expect(early.chapters[0].segments[0].fill).toBe(FILL_CAP);
    expect(early.now.text).toBe("The pipeline is starting the plan job · usually about 12 s");
    const m = trackModel(track, { demo: { step: "pull-request", pull: 12 }, pulls: [12], since: now - 21_000, now });
    expect(m.chapters[0].segments[0].fill).toBe(FILL_CAP);
    expect(m.now.text).toBe("The pipeline is starting the plan job · taking longer than usual…");
  });

  it("colours a failure red and the end green, and puts the fix's own pull request number on its chapter", () => {
    const now = Date.parse(T("40:00"));
    const m = trackModel(track, { demo: { step: "applied", pull: 13 }, pulls: [12, 13], since: now, now });
    expect(m.chapters.map((c) => c.title)).toEqual(["The change (PR #12)", "The fix (PR #13)"]);
    expect(m.chapters[0].segments[5]).toMatchObject({ label: "failed", tone: "bad", fill: 1 });
    expect(m.chapters[1].segments[5]).toMatchObject({ label: "done", tone: "ok", state: "current" });
  });

  it("lights the apply's waves inside its segment, and says which one applies", () => {
    const now = Date.parse(T("40:00"));
    const waves = [{ wave: 1, state: "applied" }, { wave: 2, state: "running" }, { wave: 3, state: "waiting" }];
    const m = trackModel(track, { demo: { step: "applying", pull: 12 }, pulls: [12], since: now - 4_000, now, waves });
    expect(m.chapters[0].segments[4].ticks).toEqual(waves);
    expect(m.now.text).toBe("Wave 2 is applying");
  });

  it("says the fix's countdown", () => {
    const now = Date.parse(T("40:00"));
    const m = trackModel(track, { demo: { step: "failed", pull: 12, next: { action: "open the fix", at: T("40:14") } }, pulls: [12], since: now, now });
    expect(m.now.text).toBe("The fix opens in 14 s");
  });

  it("is nothing without a last cycle, so the chip strip stays", () => {
    expect(cycleTrack(null)).toBeNull();
    expect(cycleTrack({ steps: [] })).toBeNull();
  });
});

describe("the track in the story's four chapters (behold#631)", () => {
  const ch = (n, headline, short) => ({ n, of: 4, headline, ...(short ? { short } : {}) });
  const chapters = [ch(1, "A change to the shared network goes out to all 15 stacks", "The change goes out"), ch(2, "cluster-a breaks, and only its six apps wait", "cluster-a breaks"), ch(3, "The fix applies only the seven left", "The fix"), ch(4, "All fifteen are in", "Done")];
  const of = (step) => (["failed"].includes(step) ? chapters[1] : ["applied", "reset"].includes(step) ? chapters[3] : null);
  const told = { ...cycle, steps: cycle.steps.map((s, i) => ({ ...s, chapter: of(s.step) || (i < 6 ? chapters[0] : chapters[2]) })) };
  const track = cycleTrack(told);
  it("groups the segments by chapter, each titled with its number and short name", () => {
    expect(track.byStory).toBe(true);
    expect(track.chapters.map((c) => [c.n, c.short, c.segments.map((g) => g.label)])).toEqual([
      [1, "The change goes out", ["opened", "planned", "review", "merged", "applying"]],
      [2, "cluster-a breaks", ["failed"]],
      [3, "The fix", ["fix opened", "planned", "review", "merged", "applying"]],
      [4, "Done", ["done", "reset"]],
    ]);
  });
  it("finds where the cycle is by the step's own chapter, and lights that chapter's title", () => {
    const now = Date.parse(T("40:00"));
    const m = trackModel(track, { demo: { step: "applying", pull: 13, chapter: chapters[2] }, pulls: [12, 13], since: now - 2_000, now });
    expect(m.chapters.map((c) => [c.title, c.state])).toEqual([["1 The change goes out", "done"], ["2 cluster-a breaks", "done"], ["3 The fix", "current"], ["4 Done", "ahead"]]);
    expect(m.chapters[2].segments[4]).toMatchObject({ label: "applying", state: "current" });
  });
  it("names a chapter from its headline when the driver gives no short name", () => {
    const plain = cycleTrack({ ...cycle, steps: told.steps.map((s) => ({ ...s, chapter: { n: s.chapter.n, of: 4, headline: s.chapter.headline } })) });
    expect(plain.chapters[1].short).toBe("cluster-a breaks");
  });
  it("keeps one chapter per pull request for a cycle whose steps carry no chapter", () => {
    expect(cycleTrack(cycle).byStory).toBe(false);
  });
});

describe("the Waiting on… modal (behold#631)", () => {
  const track = cycleTrack(cycle);
  const now = Date.parse(T("40:00"));
  const at = (demo, ago) => trackModel(track, { demo, pulls: [12], since: now - ago, now });
  it("shows after 3 s with nothing new, for what the step waits on, with the usual time", () => {
    const m = at({ step: "pull-request", pull: 12, label: "Pull request 12 is open. Network changes." }, 4_000);
    expect(waitingSpec(m, { quietMs: 2_000 })).toBeNull();
    const w = waitingSpec(m, { quietMs: 3_500 });
    expect(w).toMatchObject({ what: "the pipeline to start the plan", why: "Pull request 12 is open.", words: "usually about 12 s" });
    expect(w.fraction).toBeCloseTo(4 / 12, 2);
  });
  it("covers the reviewer, the apply starting and the fix's countdown, and says when a step runs long", () => {
    expect(waitingSpec(at({ step: "waiting", pull: 12 }, 1_000), { quietMs: 5_000 }).what).toBe("the reviewer to approve the plan");
    expect(waitingSpec(at({ step: "merged", pull: 12 }, 1_000), { quietMs: 5_000 }).what).toBe("the pipeline to start the apply");
    expect(waitingSpec(at({ step: "failed", pull: 12 }, 1_000), { quietMs: 5_000 }).what).toBe("the fix to open");
    expect(waitingSpec(at({ step: "waiting", pull: 12 }, 60_000), { quietMs: 5_000 }).words).toBe("taking longer than usual");
    // Not before half again its usual time and 8 s past it: 14 s into a 13 s review is still usual.
    expect(waitingSpec(at({ step: "waiting", pull: 12 }, 14_000), { quietMs: 5_000 }).words).toBe("usually about 13 s");
  });
  it("never during an apply that is receiving events, or a step that waits on nothing", () => {
    expect(waitingSpec(at({ step: "applying", pull: 12 }, 1_000), { quietMs: 5_000, applyLive: true })).toBeNull();
    expect(waitingSpec(at({ step: "planned", pull: 12 }, 1_000), { quietMs: 5_000 })).toBeNull();
  });
});
