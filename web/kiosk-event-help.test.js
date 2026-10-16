// behold#571: event-help's events, from what the kiosk already reads. A cycle
// told as facts in order, the news since the last look, the Tips switch, and
// the queues that keep tips and modals calm.
import { describe, expect, it } from "vitest";
import { stripFromSteps } from "./kiosk.js";
import { EH_STORE, cycleFacts, ehSnapshot, ehStore, ehStored, modalQueue, newEvents, storyTrail, tipsQueue, yodelRefusal } from "./kiosk-event-help.js";

const C = "9f3c2a71d04e5b8c6a1f2e3d4c5b6a7980716253";
const P = "1111111111111111111111111111111111111111";
const waves = [{ job: "apply-wave-1", wave: 1, roots: ["network", "other"] }, { job: "apply-wave-2", wave: 2, roots: ["app"] }, { job: "apply-wave-3", wave: 3, roots: ["edge"] }];
const demo = (step, more = {}) => ({ cycle: 7, scenario: "b-waves", step, label: `the ${step} line`, started_at: "2026-10-16T10:00:00Z", pull: 12, commit: step === "pull-request" || step === "planned" ? P : C, ...more });
const answer = { roots: [], pull_request: { run: { pull_request: 12, commit: P }, roots: ["network", "app"], totals: { create: 5 }, reads: [{ root: "app", upstream: "network", outputs: "planned", unknown: ["subnet_id"] }], waves: [] } };
const progress = (states) => ({ run: { present: true, commit: C, updated: "2026-10-16T10:01:00Z" }, states, reads: [] });
const st = (number, state, roots, totals = {}) => ({ number, state, roots, changed: roots.filter((r) => r !== "other"), totals });
const facts = (step, states = [], more = {}) => cycleFacts(ehSnapshot({ demo: demo(step), answer, progress: states.length ? progress(states) : null, waves, ...more }));
const texts = (fs) => storyTrail(fs).map((f) => f.text);

describe("event-help: the Tips switch", () => {
  it("is on by default, off once a viewer turns it off, and on when storage refuses", () => {
    const mem = () => {
      const m = new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
    };
    const shelf = mem();
    expect(ehStored(shelf)).toBe(true);
    ehStore(shelf, false);
    expect(shelf.getItem(EH_STORE)).toBe("off");
    expect(ehStored(shelf)).toBe(false);
    ehStore(shelf, true);
    expect(ehStored(shelf)).toBe(true);
    expect(ehStored({ getItem: () => { throw new Error("denied"); } })).toBe(true);
    expect(() => ehStore({ setItem: () => { throw new Error("denied"); } }, false)).not.toThrow();
    expect(ehStored(null)).toBe(true);
  });
});

describe("event-help: a cycle told in order", () => {
  it("tells the subnet's story, beat by beat, as the steps move", () => {
    expect(texts(facts("pull-request"))).toEqual(["pull request #12 opened"]);
    expect(texts(facts("planned"))).toEqual(["pull request #12 opened", "the plan creates 5"]);
    const held = facts("waiting", [st(1, "applied", ["network", "other"], { create: 1 }), st(2, "waiting", ["app"]), st(3, "not-started", ["edge"])]);
    expect(texts(held)).toEqual(["pull request #12 opened", "the plan creates 5", "pull request #12 merged", "wave 1 applied: 1 created", "subnet_id now known", "wave 2 held, since app's plan uses subnet_id"]);
    const approval = { wave: 2, rows: [{ id: "requested", state: "lit" }, { id: "approved", state: "lit", text: "demo-reviewer approved exactly this plan.", seal: { ok: true, text: "signed; matches the repo's allowed signers" } }, { id: "resumed", state: "lit" }, { id: "spent", state: "dim" }] };
    const done = facts("applied", [st(1, "applied", ["network", "other"], { create: 1 }), st(2, "applied", ["app"], { create: 4 }), st(3, "applied", ["edge"])], { approval });
    expect(texts(done)).toEqual([
      "pull request #12 opened",
      "the plan creates 5",
      "pull request #12 merged",
      "wave 1 applied: 1 created",
      "subnet_id now known",
      "wave 2 held, since app's plan uses subnet_id",
      "approved by demo-reviewer, signed",
      "/terragucci apply ran the waves again",
      "wave 2 applied under demo-reviewer's approval",
      "wave 3 applied",
      "all 3 waves applied",
    ]);
  });

  it("holds the whole change when the gate names no wave (chant's pull-request loop)", () => {
    expect(cycleFacts(ehSnapshot({ demo: demo("waiting"), answer })).find((f) => f.kind === "held")).toMatchObject({ text: "the plan waits for an approval", critical: true });
    // A repo with declared waves waits for the run view to name the held wave: no second, vaguer hold first.
    expect(facts("waiting").some((f) => f.kind === "held")).toBe(false);
  });

  it("counts every wave at applied, even one the run view has not caught up on (behold#571)", () => {
    const behind = facts("applied", [st(1, "applied", ["network", "other"]), st(2, "applied", ["app"]), st(3, "not-started", ["edge"])]);
    expect(behind.find((f) => f.kind === "applied").text).toBe("all 3 waves applied");
    expect(facts("applied", [st(1, "applied", ["network", "other"])]).find((f) => f.kind === "applied").text).toBe("the wave applied");
  });

  it("tells chant's pull-request loop in its own order: the approval before the merge (#631)", () => {
    const strip = stripFromSteps(["pull-request", "planned", "waiting", "approved", "merged", "applying", "applied", "reset"]);
    const chant = (step, approval = null) => cycleFacts(ehSnapshot({ demo: { ...demo(step), scenario: "chant-pr-loop", tool: "chant" }, answer: null, approval, strip }));
    // Waiting for the approval: the pull request is open, not merged.
    expect(storyTrail(chant("waiting")).map((f) => f.text)).toEqual(["pull request #12 opened", "the plan waits for an approval"]);
    const approval = { wave: null, rows: [{ id: "approved", state: "lit", text: "demo-reviewer approved exactly this plan.", seal: { ok: true, text: "signed; matches the repo's allowed signers" } }] };
    expect(storyTrail(chant("applied", approval)).map((f) => f.text)).toEqual(["pull request #12 opened", "the plan waits for an approval", "approved by demo-reviewer, signed", "pull request #12 merged", "the change applied"]);
    // terragucci's waves keep theirs: a wave's hold after the merge.
    expect(storyTrail(facts("waiting", [st(1, "applied", ["network", "other"]), st(2, "waiting", ["app"])])).map((f) => f.kind)).toEqual(["pull-request", "planned", "merged", "applied-wave", "known", "held"]);
  });

  it("names each event's subjects, so the kiosk can place it", () => {
    const held = facts("waiting", [st(1, "applied", ["network", "other"]), st(2, "waiting", ["app"])], { runDoc: { id: 4801, cycle: 7, jobs: [{ name: "apply-wave-2", status: "waiting", steps: [] }] } });
    expect(held.find((f) => f.kind === "held")).toMatchObject({ critical: true, subjects: { roots: ["app"], wave: 2, job: "apply-wave-2", run: 4801 } });
    expect(held.find((f) => f.kind === "known").subjects.roots).toEqual(["network", "app"]);
  });

  it("says SQL Yodeler's refusal from the failed job's own log, and the re-run", () => {
    const log = ["yodel apply: refused: a pre-migration check of 20261016T0521-unique-email failed under the lock", "  step 0, CREATE UNIQUE INDEX CONCURRENTLY users_email_key ON app.users (email), would fail: 1 values of (email) held by more than one row, which a unique index fails on"];
    expect(yodelRefusal(log)).toBe("SQL Yodeler refused, since an email is shared by more than one row");
    expect(yodelRefusal(["dev: apply failed"])).toBeNull();
    const runDoc = { id: 4826, cycle: 7, jobs: [{ name: "apply-wave-2", status: "failure", steps: [{ name: "Apply", status: "failure", log }] }] };
    const failed = facts("failed", [st(1, "applied", ["network", "other"]), st(2, "failed", ["app"])], { runDoc });
    expect(failed.find((f) => f.kind === "refused")).toMatchObject({ text: "SQL Yodeler refused, since an email is shared by more than one row", critical: true, subjects: { wave: 2, job: "apply-wave-2" } });
    // The re-run, once the run view shows the wave applying again in a run where its job no longer failed.
    const again = cycleFacts(ehSnapshot({ demo: demo("resumed"), answer, progress: progress([st(1, "applied", ["network", "other"]), st(2, "applying", ["app"])]), runDoc: { id: 4830, cycle: 7, jobs: [{ name: "apply-wave-2", status: "running", steps: [] }] }, waves }));
    expect(again.some((f) => f.kind === "rerun")).toBe(false); // this snapshot never saw the failure
    // A viewer who arrives after the re-run still gets the refusal, from the cycle's earlier run.
    const later = cycleFacts(ehSnapshot({ demo: demo("waiting"), answer, progress: progress([st(1, "applied", ["network", "other"]), st(2, "waiting", ["app"])]), runDoc: { id: 4830, cycle: 7, jobs: [{ name: "apply-wave-2", status: "waiting", steps: [] }] }, runDocs: [runDoc], waves }));
    expect(storyTrail(later).map((f) => f.kind)).toContain("refused");
    expect(later.find((f) => f.kind === "refused").subjects).toMatchObject({ wave: 2, job: "apply-wave-2", run: 4826 });
    const seenFailing = cycleFacts(ehSnapshot({ demo: demo("resumed"), answer, progress: progress([st(1, "applied", ["network", "other"]), st(2, "applying", ["app"])]), runDoc: { id: 4830, cycle: 7, jobs: [{ name: "apply-wave-2", status: "running", steps: [] }] }, waves, failed: [2] }));
    expect(seenFailing.find((f) => f.kind === "rerun")).toMatchObject({ text: "wave 2 runs again", subjects: { wave: 2 } });
  });

  it("pops a tip when a wave starts or its numbers land, and tells the story's beat when its trace is ready", () => {
    const metrics = { run: { current: true, label: `This run · ${C.slice(0, 8)}`, waves: [{ wave: 1, seconds: "1.6 s", held: null, changed: "1 created" }] } };
    const waveTraces = { 1: { run: "9", job: "apply-wave-1", trace: { wave: 1, ms: 1600, start: 0, spans: [{ id: "r", parent: null, name: "tf-apply", start: 0, ms: 1600, attrs: {} }, { id: "p", parent: "r", name: "plan", start: 0, ms: 1200, attrs: { "terragucci.phase": "plan" } }] } } };
    const fs = facts("applying", [st(1, "applying", ["network", "other"])], { metrics, waveTraces, runDoc: { id: 9, cycle: 7, jobs: [] } });
    expect(fs.filter((f) => !f.trail).map((f) => f.text)).toEqual(["wave 1 started", "wave 1: 1.6 s · 1 created"]);
    // A wave's trace is a beat of the story, its tip saying what the trace shows; a click on it opens the trace.
    expect(fs.find((f) => f.kind === "trace")).toMatchObject({ trail: true, text: "wave 1's trace is ready; it took 1.6 s, 1.2 s of it in the plan", subjects: { wave: 1, job: "apply-wave-1", run: "9" } });
    expect(fs.find((f) => f.kind === "metrics").subjects.wave).toBe(1);
    // An older run's numbers are not this cycle's news.
    expect(facts("applying", [], { metrics: { run: { current: false, waves: metrics.run.waves } } }).some((f) => f.kind === "metrics")).toBe(false);
    // Nor are the last cycle's, still on screen as a new one opens its pull request.
    expect(facts("pull-request", [], { metrics }).some((f) => f.kind === "metrics")).toBe(false);
    expect(facts("applying", [], { metrics: { run: { ...metrics.run, label: "This run · 0badc0de" } } }).some((f) => f.kind === "metrics")).toBe(false);
  });
});

describe("event-help: what is news", () => {
  it("is nothing on a page's first look (the trail has it), then each fact the first time it shows", () => {
    const a = facts("planned");
    expect(newEvents(null, a)).toEqual([]);
    const seen = new Set(a.map((f) => f.id));
    const b = facts("waiting", [st(1, "applied", ["network", "other"]), st(2, "waiting", ["app"])]);
    // A wave's start beside its own next beat is said by the beat.
    expect(newEvents(seen, b).map((f) => f.kind)).toEqual(["merged", "applied-wave", "known", "held"]);
    const c = facts("applying", [st(1, "applying", ["network", "other"])]);
    expect(newEvents(new Set(), c).map((f) => f.text)).toEqual(["pull request #12 opened", "the plan creates 5", "pull request #12 merged", "wave 1 started"]);
  });

  it("keeps a fact that turns up late, behind the story already told, for the trail alone", () => {
    const b = facts("waiting", [st(1, "applied", ["network", "other"]), st(2, "waiting", ["app"])]);
    const after = Math.max(...b.map((f) => f.order)) - 10;
    expect(newEvents(new Set(), b, { after }).map((f) => f.kind)).toEqual(["applied-wave", "known", "held"]);
  });
});

describe("event-help: calm queues", () => {
  const ev = (id, critical = false, kind = "applied-wave") => ({ id, kind, critical });
  it("shows two tips at once, each its time, and the rest wait their turn", () => {
    let q = tipsQueue(null, { add: [ev("a"), ev("b"), ev("c")], now: 0 });
    expect(q.shown.map((s) => s.event.id)).toEqual(["a", "b"]);
    expect(q.waiting.map((e) => e.id)).toEqual(["c"]);
    q = tipsQueue(q, { now: 4_999 });
    expect(q.shown.map((s) => s.event.id)).toEqual(["a", "b"]);
    q = tipsQueue(q, { now: 5_000 });
    expect(q.shown.map((s) => s.event.id)).toEqual(["c"]);
    expect(tipsQueue(q, { add: [ev("c")], now: 5_001 }).waiting).toEqual([]);
  });

  it("opens one modal at a time, never while a viewer is at the page, newest of each kind", () => {
    const held = ev("held", true, "held");
    const held2 = ev("held2", true, "held");
    expect(modalQueue(null, { add: [ev("x"), held], now: 10_000, lastInput: 9_000 })).toEqual({ next: null, waiting: [held] });
    expect(modalQueue({ waiting: [held] }, { add: [held2], now: 30_000 }).next).toBe(held2);
    expect(modalQueue({ waiting: [held] }, { now: 30_000, open: true }).next).toBeNull();
  });
});
