// A small stage in Watch (the cone scenario's three estates): one card says
// each thing, a root its wave never started says so, and a read between two
// choudoufu roots is of the estate's outputs, not a state file.
import { describe, expect, it } from "vitest";
import { modalShownElsewhere, tipsShown } from "./kiosk-event-help.js";
import { shotFor, stepLine, watchOverlays } from "./kiosk-watch.js";
import { settleMember } from "./terragucci-components-live.js";
import { pinWaits, pinnedAnswer, pinnedCaption, readEdges, readLabel, readLine, viewCaption } from "./terragucci-change.js";
import { wrapWords } from "./cone.js";
import { framePull } from "./kiosk.js";
import { settleView } from "./view-url.js";
import { viewFromMessage } from "./embed.js";

// Cycle 107: pull request #22 of 01:04, merged at 3333333; the reports a frame read a cycle ago hold #20 of 01:01.
const pr = (n, finished, cone = null) => ({ run: { pull_request: String(n), commit: n === 22 ? "2222222" : "1111111", finished }, roots: ["service-b"], waves: [], reads: [], ...(cone ? { cone } : {}) });
const cone = { roots: [{ root: "service-b", kind: "cone", blocks: 2, of: 8 }] };
const old = { roots: [], pull_request: pr(20, "2026-10-18T01:01:00Z", cone) };
const now = { roots: [], pull_request: pr(22, "2026-10-18T01:04:23Z", cone) };
const ran = { run: { present: true, commit: "3333333aaaa", updated: "2026-10-18T01:06:00Z" }, states: [{ number: 1, state: "applying", roots: ["network"] }], reads: [] };
const clock = new Date("2026-10-18T01:07:00Z");

describe("a frame pinned to this cycle", () => {
  it("at planned reads again while its plan isn't in the reports, and stops once it is", () => {
    expect(pinWaits(old, null, "pull-22-2222222", "22")).toEqual({ plan: true, run: false });
    expect(pinWaits(now, null, "pull-22-2222222", "22")).toEqual({ plan: false, run: false });
    expect(pinnedCaption(old, "pull-22-2222222", "22")).toBe("Pull request #22 is being planned; its plan shows here once the plan job writes it");
    expect(pinnedCaption(now, "pull-22-2222222", "22")).toBeNull();
  });

  it("at the merge never draws the last cycle's pull request, and reads again for this one's", () => {
    expect(pinnedAnswer(old, "3333333", "22").pull_request).toBeNull();
    expect(pinnedAnswer(now, "3333333", "22").pull_request.run.pull_request).toBe("22");
    expect(pinWaits(old, null, "3333333", "22")).toEqual({ plan: true, run: true });
    expect(pinnedCaption(old, "3333333", "22", null)).toBe("Pull request #22 is merged; the merge's run shows here once it starts");
    // Without the pull named (a page that isn't the kiosk's frame), as before.
    expect(pinnedAnswer(old, "3333333", null).pull_request.run.pull_request).toBe("20");
  });

  it("names what it shows: this pull request's plan until the merge's run starts, then the merge's run", () => {
    expect(viewCaption(now, null, clock, { merged: true })).toBe("the plan of pull request #22 at 01:04 UTC; the merge's run starts next");
    expect(viewCaption(now, null, clock)).toBe("the plan of pull request #22 at 01:04 UTC, before the merge");
    expect(viewCaption(now, ran, clock, { merged: true })).toBe("the merge's run (3333333a), planning each estate in full, as of 01:06 UTC");
    expect(pinWaits(now, ran, "3333333", "22")).toEqual({ plan: false, run: false });
    // A plan with no cone: the run's words as before.
    expect(viewCaption({ roots: [], pull_request: pr(22, "2026-10-18T01:04:23Z") }, ran, clock)).toBe("the run of merge 3333333a, as of 01:06 UTC");
  });

  it("tells the frame the cycle's pull request, through the view's own checks", () => {
    expect(framePull({ step: "applying", pull: 22 })).toBe("22");
    expect(framePull({ step: "reset", pull: 22 })).toBeNull();
    expect(framePull({ step: "pull-request", pull: null })).toBeNull();
    expect(settleView({ pull: "22" }, {}).apply).toEqual({ pull: "22" });
    expect(settleView({ pull: "x" }, {}).refused[0]).toMatchObject({ key: "pull" });
    expect(viewFromMessage({ origin: "https://k", data: { type: "behold:view", run: "3333333", pull: "22" } }, "https://k")).toEqual({ run: "3333333", pull: "22" });
  });
});

describe("a cone's lines on a card", () => {
  // About 6.3 px a character at 11.5 px, on a card with 160 px for words.
  const measure = (t) => t.length * 6.3;
  it("wrap to the card's width, never cut", () => {
    expect(wrapWords("2 of 8 blocks, as a cone", 160, measure)).toEqual(["2 of 8 blocks, as a cone"]);
    expect(wrapWords("iam_role_policy.service · changed", 160, measure)).toEqual(["iam_role_policy.service", "· changed"]);
    expect(wrapWords("iam_role_policy.service_with_a_long_name · read", 160, measure)).toEqual(["iam_role_policy.service_", "with_a_long_name · read"]);
    for (const line of wrapWords("planned in full: a provider block changed and the lock file too", 160, measure)) expect(measure(line)).toBeLessThanOrEqual(160);
  });
});

describe("nothing overlays the graph in Watch, on a held small stage only", () => {
  const STEPS = ["pull-request", "planned", "merged", "applying", "waiting", "approved", "failed", "resumed", "applied", "reset"];
  const demo = (step, scenario = "cone") => ({ cycle: 112, scenario, step, label: "", started_at: "2026-10-18T01:10:00Z", pull: 24, commit: "3333333", next: null });
  const shotOf = (step, scenario) => shotFor(demo(step, scenario), { held: step === "waiting" ? 2 : null, gate: step === "waiting", progress: step === "applying" || step === "failed" || step === "resumed" ? { run: { present: true, commit: "3333333", updated: "2026-10-18T01:12:00Z" }, states: [{ number: 1, state: step === "failed" ? "failed" : "applying", roots: ["network"] }], reads: [] } : null });

  it("held: at every step, applied included, no result card, no callout, no badges, no drawer the step opens", () => {
    for (const step of STEPS) {
      const shot = shotOf(step);
      expect(watchOverlays({ kind: shot.kind, opened: false, held: true })).toEqual({ result: false, callout: false, badges: false, drawer: false });
    }
    // A drawer the viewer opened on a wave shows until they fold it.
    expect(watchOverlays({ kind: "result", opened: true, held: true }).drawer).toBe(true);
  });

  it("not held (b-waves, failure, tg-planned-outputs): the callout, the badges, the result card and the step's drawer, as on main", () => {
    for (const scenario of ["b-waves", "failure", "tg-planned-outputs"]) {
      for (const step of STEPS) {
        const shot = shotOf(step, scenario);
        const shows = watchOverlays({ kind: shot.kind, opened: false, held: false });
        expect(shows).toMatchObject({ result: true, callout: true, badges: true });
        // main: `const drawer = shot.kind === "active" || opened`.
        expect(shows.drawer).toBe(shot.kind === "active");
      }
      expect(shotOf("applied", scenario).kind).toBe("result");
      expect(shotOf("waiting", scenario).kind).toBe("held");
      expect(watchOverlays({ kind: "result", opened: true }).drawer).toBe(true);
    }
  });

  it("held: opens no event-help modal and no Tips bubble in Watch; a stage that isn't held, and Inspect, as before", () => {
    for (const kind of ["applied", "held", "failed", "refused"]) {
      expect(modalShownElsewhere({ kind }, { watch: true, held: true })).toBe(true);
      expect(modalShownElsewhere({ kind }, { watch: true, held: false })).toBe(false);
      expect(modalShownElsewhere({ kind }, { watch: false, held: true })).toBe(false);
    }
    expect(tipsShown({ watch: true, held: true })).toBe(false);
    expect(tipsShown({ watch: true, held: false })).toBe(true);
    expect(tipsShown({ watch: false, held: true })).toBe(true);
  });

  it("applied: Watch's result card says it, so no modal says it again; Inspect, with no card, opens it (behold#782)", () => {
    expect(modalShownElsewhere({ kind: "applied" }, { watch: true, result: true })).toBe(true);
    // Before the card has the run to draw, the modal opens as before.
    expect(modalShownElsewhere({ kind: "applied" }, { watch: true, result: false })).toBe(false);
    expect(modalShownElsewhere({ kind: "applied" }, { watch: false, result: true })).toBe(false);
    for (const kind of ["held", "failed", "refused"]) expect(modalShownElsewhere({ kind }, { watch: true, result: true })).toBe(false);
  });

  it("held: says what the cards said in one quiet line of the caption; not held, no such line", () => {
    const result = { head: "Applied", line: "Done in 2 waves.", counts: ["2 waves applied", "1 updated", "3.2 s of job time"], waves: [] };
    expect(stepLine(demo("applied"), { result, held: true })).toBe("2 waves applied · 1 updated · 3.2 s of job time");
    const hold = { kind: "driver", head: "Wave 2 · plan 1a2b3c4d", appr: { approve: "chant approve tf-apply wave-2 --actor <reviewer> --sign <reviewer key>" } };
    expect(stepLine(demo("waiting"), { hold, held: true })).toBe("Wave 2 · plan 1a2b3c4d: chant approve tf-apply wave-2 --actor <reviewer> --sign <reviewer key>");
    expect(stepLine(demo("waiting"), { hold: { kind: "approval", head: "Wave 2 · run #41" }, held: true })).toBe("Wave 2 · run #41 waits for an approval");
    expect(stepLine(demo("planned"), { result, hold, held: true })).toBeNull();
    expect(stepLine(demo("applied", "b-waves"), { result })).toBeNull();
    expect(stepLine(demo("waiting", "b-waves"), { hold, held: false })).toBeNull();
  });
});

describe("a root its wave never started, under a job that succeeded", () => {
  const card = (root) => ({ root, wave: 2, state: "not-started", tone: "idle", words: "queued", short: "queued", facts: [] });
  it("says unchanged when the run view's wave changed nothing in it", () => {
    const progress = { states: [{ number: 2, state: "not-started", roots: ["service-a", "service-b"], changed: ["service-b"] }] };
    expect(settleMember(card("service-a"), progress, 2)).toMatchObject({ state: "unchanged", words: "unchanged", short: "unchanged" });
    expect(settleMember(card("x"), { states: [{ number: 2, totals: { "no-op": 3 } }] }, 2).words).toBe("unchanged");
  });
  it("while the wave's report is not read yet, says so, never skipped", () => {
    expect(settleMember(card("service-b"), { states: [{ number: 2, state: "not-started" }] }, 2)).toMatchObject({ state: "reading", words: "wave done, reading its report", short: "reading its report" });
  });
  it("leaves every other card as it is", () => {
    const c = { root: "a", state: "applied", words: "applied", facts: [] };
    expect(settleMember({ ...c }, { states: [] }, 1)).toEqual(c);
  });
});

describe("a read between two choudoufu roots", () => {
  const answer = (binaries) => ({ roots: [], ...(binaries ? { binaries } : {}), pull_request: { run: { finished: "2026-10-17T10:05:00Z" }, roots: ["service-a"], waves: [], reads: [{ root: "service-a", upstream: "network", data: "network", outputs: "applied" }] } });
  it("is of the estate's outputs", () => {
    const [e] = readEdges(answer({ "service-a": "choudoufu", network: "choudoufu" }), null);
    expect(readLabel(e)).toBe("reads network's outputs");
    expect(readLine(e)).toBe("service-a reads network's outputs as they stand (data network)");
    const progress = { run: { present: true, updated: "2026-10-17T11:00:00Z" }, states: [{ number: 1 }], reads: [{ root: "service-a", reads: ["network"], wave: 2 }] };
    expect(readLabel(readEdges(answer({ "service-a": "choudoufu", network: "choudoufu" }), progress)[0])).toBe("reads network's outputs");
  });
  it("of any other binary, or with no binaries named, reads the state as before", () => {
    expect(readLabel(readEdges(answer({ "service-a": "tofu", network: "choudoufu" }), null)[0])).toBe("reads network's applied state");
    expect(readLabel(readEdges(answer(null), null)[0])).toBe("reads network's applied state");
  });
});
