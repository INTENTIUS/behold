import { describe, expect, it } from "vitest";
import { FAILURE_LEAD_MS, FILL_CAP, applyJobs, cycleTrack, failureAt, hereWords, seekMs, trackModel, waitingSpec } from "./kiosk-track.js";

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
    // behold#778: and names the step in words, for a phone whose segments are too narrow for their labels.
    expect(m.here).toBe("Step: applying, in 3 The fix");
  });
  it("names no step when the cycle stands at none (behold#778)", () => {
    expect(hereWords([{ title: "1 The change", segments: [{ label: "opened" }] }], { chapter: 0, segment: -1 })).toBeNull();
    expect(hereWords([{ title: "1 The change", segments: [{ label: "opened" }] }], { chapter: 0, segment: 0 })).toBe("Step: opened, in 1 The change");
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

// behold#774: on demo.intentius.io "Waiting on the pipeline to start the apply" stayed up about 2 minutes while
// apply-wave-3 ran: the run view moves a wave only once its job reports. The run's own jobs say it first.
describe("the apply's jobs end the wait (behold#774)", () => {
  const track = cycleTrack(cycle);
  const now = Date.parse(T("40:00"));
  const C = "c27888c42a093b72166e924a339cf6f01a739547";
  const doc = (jobs, commit = C) => ({ commit, jobs: jobs.map(([name, status]) => ({ name, status })) });
  const run = doc([["check", "success"], ["plan", "skipped"], ["apply-comment", "skipped"], ["apply-wave-1", "success"], ["apply-wave-2", "success"], ["apply-wave-3", "running"], ["tips", "queued"]]);
  it("reads the started apply jobs of this step's commit, by wave", () => {
    expect(applyJobs(run, { commit: C })).toEqual([
      { job: "apply-wave-1", wave: 1, status: "success" },
      { job: "apply-wave-2", wave: 2, status: "success" },
      { job: "apply-wave-3", wave: 3, status: "running" },
    ]);
    // A short commit either way matches.
    expect(applyJobs(run, { commit: C.slice(0, 8) })).toHaveLength(3);
    expect(applyJobs(doc([["apply-wave-1", "running"]], C.slice(0, 8)), { commit: C })).toHaveLength(1);
  });
  it("is empty for another commit's run, a queued job, or no run", () => {
    expect(applyJobs(run, { commit: "298a730c2764cbbcc29b75360d12e8e5d03a8406" })).toEqual([]);
    expect(applyJobs(doc([["apply-wave-1", "queued"]]), { commit: C })).toEqual([]);
    expect(applyJobs(run, { commit: null })).toEqual([]);
    expect(applyJobs(null, { commit: C })).toEqual([]);
    expect(applyJobs({ commit: C }, { commit: C })).toEqual([]);
  });
  it("says which wave is applying, and opens no Waiting modal, once a job runs", () => {
    const at = (step, jobs) => trackModel(track, { demo: { step, pull: 12, commit: C }, pulls: [12], since: now - 1_000, now, jobs });
    const m = at("applying", applyJobs(run, { commit: C }));
    expect(m.now).toMatchObject({ text: "Wave 3 is applying", waiting: null });
    expect(waitingSpec(m, { quietMs: 60_000 })).toBeNull();
    // The merged step, its first job already started.
    expect(at("merged", [{ job: "apply-wave-1", wave: 1, status: "running" }]).now.text).toBe("Wave 1 is applying");
    // Jobs that started and finished, none running now: under way.
    expect(at("applying", [{ job: "apply-wave-1", wave: 1, status: "success" }]).now).toMatchObject({ text: "The apply is under way", waiting: null });
    // No job yet: the wait stands.
    expect(waitingSpec(at("applying", []), { quietMs: 5_000 }).what).toBe("the pipeline to start the apply");
  });
});

describe("a past step replays from its start (behold#787)", () => {
  const ch = (n, short) => ({ n, of: 4, headline: short, short });
  const chapters = [ch(1, "The change goes out"), ch(2, "cluster-a breaks"), ch(3, "The fix"), ch(4, "Done")];
  const of = (step, i) => (step === "failed" ? chapters[1] : ["applied", "reset"].includes(step) ? chapters[3] : i < 6 ? chapters[0] : chapters[2]);
  const track = cycleTrack({ ...cycle, steps: cycle.steps.map((s, i) => ({ ...s, chapter: of(s.step, i) })) });
  const now = Date.parse(T("40:00"));

  it("gives each segment already past its first step's time, and each chapter its first segment's", () => {
    const m = trackModel(track, { demo: { step: "planned", pull: 13, chapter: chapters[2] }, pulls: [12, 13], since: now, now });
    expect(m.chapters[0].segments.map((g) => g.seek)).toEqual([T("18:49"), T("19:01"), T("19:14"), T("19:27"), T("19:30")]);
    expect(m.chapters.map((c) => c.seek)).toEqual([T("18:49"), T("19:49"), T("20:10"), null]);
    // The current step and those ahead have no seek in the live cycle.
    expect(m.chapters[2].segments.map((g) => g.seek)).toEqual([T("20:10"), null, null, null, null]);
  });

  it("lets a replay seek to any step but the one it shows, and never to the reset", () => {
    const m = trackModel(track, { demo: { step: "failed", pull: 12, chapter: chapters[1] }, pulls: [12], since: now, now, replay: true });
    expect(m.chapters[1].segments[0]).toMatchObject({ state: "current", seek: null });
    expect(m.chapters[2].segments[4]).toMatchObject({ state: "ahead", seek: T("20:37") });
    expect(m.chapters[3].segments.map((g) => [g.label, g.seek])).toEqual([["done", T("20:56")], ["reset", null]]);
  });

  it("measures a seek from the cycle's first step", () => {
    expect(seekMs(cycle, T("19:49"))).toBe(60_000);
    expect(seekMs(cycle, "2026-10-18T17:00:00Z")).toBe(0);
    expect(seekMs(null, T("19:49"))).toBe(0);
  });

  it("starts a replay of the failure in the apply's last stretch, never before the apply", () => {
    // The apply took 19 s, under the lead: the replay starts with it.
    expect(failureAt(cycle)).toBe(new Date(T("19:30")).toISOString());
    const long = { ...cycle, steps: cycle.steps.map((s) => (s.step === "applying" && s.pull === 641 ? { ...s, at: "2026-10-18T18:17:00Z" } : s)) };
    expect(Date.parse(failureAt(long))).toBe(Date.parse(T("19:49")) - FAILURE_LEAD_MS);
    expect(failureAt({ ...cycle, steps: cycle.steps.filter((s) => s.step !== "failed") })).toBeNull();
    expect(failureAt(null)).toBeNull();
  });
});
