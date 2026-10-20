import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURE_LINES, fitFeatures, FOLLOW_LINES, followsLog, logKey, nearEnd, mergeRun, newerOf, agoWords, defaultJob, defaultStep, durationWords, indexWords, jobOrder, originLink, liveRun, codeish, logLineWords, logRows, placeWords, scenarioTitles, setupLine, sidebarRuns, splitSkipped, STATUS_TONE, toneOf, triggerWords } from "./kiosk-runs.js";

const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "terragucci-demo", "runs");
const run = (id) => JSON.parse(readFileSync(join(FIX, `${id}.json`), "utf8"));
const index = () => JSON.parse(readFileSync(join(FIX, "index.json"), "utf8"));

describe("the runs, as a CI page lists them (#569)", () => {
  it("names what started each run", () => {
    expect(triggerWords({ trigger: "plan", pull: 278 })).toBe("Plan of pull request #278");
    expect(triggerWords({ trigger: "merge", pull: 278, ref: "main" })).toBe("Merge of #278 to main");
    expect(triggerWords({ trigger: "resume", pull: 278, ref: "main" })).toBe("/terragucci apply on #278");
    expect(triggerWords({ trigger: "reset", pull: null, ref: "main" })).toBe("Reset main to the base");
    expect(triggerWords({ trigger: "base", pull: null, ref: "main" })).toBe("The base, pushed to main");
    expect(triggerWords({ trigger: "push", pull: null, ref: "main" })).toBe("Push to main");
    expect(triggerWords({ trigger: "push", pull: null, ref: "demo-a-known" })).toBe("Push to branch demo-a-known");
  });
  it("never draws a wave held at the gate as a failure", () => {
    expect(STATUS_TONE.waiting).toBe("wait");
    expect(STATUS_TONE.waiting).not.toBe(STATUS_TONE.failure);
  });
  it("shows the runner's exit 3 under a job held at the gate as the hold, not a failure", () => {
    const line = "⚙️ [runner]: exitcode '3': failure";
    expect(logLineWords("waiting", line)).toEqual({ text: "[runner]: exit code 3: held at the gate, waiting for an approval", held: true });
    // The fixture's held job ends its log with that line.
    const held = run(444).jobs.find((j) => j.status === "waiting");
    const last = held.steps.find((s) => s.status === "waiting").log.at(-1);
    expect(logLineWords(held.status, last).held).toBe(true);
    // A real failure keeps its line, whatever the code.
    expect(logLineWords("failure", line)).toEqual({ text: line, held: false });
    expect(logLineWords("failure", "⚙️ [runner]: exitcode '1': failure")).toEqual({ text: "⚙️ [runner]: exitcode '1': failure", held: false });
    // A held job's other lines, and another code, are kept as they came.
    expect(logLineWords("waiting", "⚙️ [runner]: exitcode '1': failure").held).toBe(false);
    expect(logLineWords("waiting", "wave 2 of 3: approval ledger (the default)").held).toBe(false);
  });
  it("follows the newest run still going, pinned first", () => {
    const runs = index().runs;
    expect(liveRun(runs).id).toBe(448);
    expect(liveRun(runs.filter((r) => r.id !== 448)).id).toBe(447); // nothing going: the newest
    // Held at a gate: followed while it is the newest, a recent run once another came after it.
    expect(liveRun([{ id: 8, status: "waiting" }, { id: 7, status: "success" }]).id).toBe(8);
    expect(liveRun([{ id: 9, status: "success" }, { id: 8, status: "waiting" }]).id).toBe(9);
    expect(sidebarRuns([{ id: 9, status: "success" }, { id: 8, status: "running" }]).map((r) => r.id)).toEqual([8, 9]);
    expect(liveRun([])).toBe(null);
  });
  it("orders jobs by their needs and folds the skipped ones", () => {
    const jobs = jobOrder(run(444).jobs);
    const { shown, skipped } = splitSkipped(jobs);
    expect(shown.map((j) => `${j.name}@${j.depth}`)).toEqual(["check@0", "apply-wave-1@1", "apply-wave-2@2"]);
    expect(skipped.map((j) => j.name)).toContain("apply-wave-3");
    expect(jobOrder([{ name: "b", needs: ["a"] }, { name: "a", needs: ["b"] }]).map((j) => j.name).sort()).toEqual(["a", "b"]); // a cycle still lists every job
  });
  it("shows the job that runs, waits or failed, else the one with the most to say", () => {
    expect(defaultJob(run(448).jobs).name).toBe("apply-wave-2");
    expect(defaultJob(run(444).jobs).name).toBe("apply-wave-2");
    expect(defaultJob(run(447).jobs).status).toBe("failure");
    expect(defaultJob(run(443).jobs).name).toBe("plan");
  });
  it("opens the step with the job's own output, not the first one", () => {
    const step = (id, job) => {
      const steps = run(id).jobs.find((j) => j.name === job).steps;
      return steps[defaultStep(steps)];
    };
    expect(step(444, "apply-wave-2")).toMatchObject({ name: "Apply wave 2 of 3", status: "waiting" });
    expect(step(448, "apply-wave-2")).toMatchObject({ name: "Apply wave 2 of 3", status: "running" });
    expect(step(447, "apply-wave-2").status).toBe("failure");
    expect(step(443, "plan").name).toBe("Plan the roots the change reaches and write the plan report");
    expect(step(444, "apply-wave-1").name).toBe("Apply wave 1 of 3");
    expect(defaultStep([])).toBe(-1);
  });
  it("says durations and ages", () => {
    const now = new Date("2026-10-15T04:10:00Z");
    expect(durationWords("2026-10-15T04:09:28Z", "2026-10-15T04:09:45Z", now)).toBe("17 s");
    expect(durationWords("2026-10-15T04:07:55Z", null, now)).toBe("2 m 05 s");
    expect(durationWords(null, null, now)).toBe(null);
    expect(agoWords("2026-10-15T04:09:58Z", now)).toBe("just now");
    expect(agoWords("2026-10-15T04:07:00Z", now)).toBe("3 m ago");
    expect(placeWords({ scenario: "a-output", cycle: 90 }, { "a-output": { name: "A, read through .output" } })).toBe("A, read through .output · cycle 90");
    expect(placeWords({ scenario: null, cycle: null }, {})).toBe("");
  });
});

describe("one run, from the index and its own document (#569)", () => {
  // The host's #528: index.json says running on demo-a-known; the run's own
  // document, written later, says success and carries no ref.
  const entry = { id: 528, trigger: "push", ref: "demo-a-known", status: "running", started_at: "2026-10-15T04:49:19Z", ended_at: null, jobs: [{ id: 1, name: "check", needs: [], status: "running", started_at: "2026-10-15T04:49:19Z", ended_at: null }] };
  const doc = { id: 528, trigger: "push", status: "success", started_at: "2026-10-15T04:49:19Z", ended_at: "2026-10-15T04:49:25Z", jobs: [{ id: 1, name: "check", needs: [], status: "success", started_at: "2026-10-15T04:49:19Z", ended_at: "2026-10-15T04:49:25Z", steps: [{ name: "Set up job", status: "success", log: [] }] }] };
  it("names the run's real ref and takes the newer status", () => {
    const m = mergeRun(entry, doc);
    expect(m.ref).toBe("demo-a-known");
    expect(triggerWords(m)).toBe("Push to branch demo-a-known");
    expect(m.status).toBe("success");
    expect(m.ended_at).toBe("2026-10-15T04:49:25Z");
    expect(m.jobs[0].steps.length).toBe(1);
  });
  it("takes the index's status when the document lags it, keeping the document's steps", () => {
    const lagging = { ...doc, status: "running", ended_at: null, jobs: [{ ...doc.jobs[0], status: "running", ended_at: null }] };
    const ahead = { ...entry, status: "failure", ended_at: "2026-10-15T04:49:30Z", jobs: [{ ...entry.jobs[0], status: "failure", ended_at: "2026-10-15T04:49:30Z" }] };
    const m = mergeRun(ahead, lagging);
    expect(m.status).toBe("failure");
    expect(m.jobs[0]).toMatchObject({ status: "failure", ended_at: "2026-10-15T04:49:30Z" });
    expect(m.jobs[0].steps.length).toBe(1);
  });
  it("never moves a status back, and a held run is ahead of a running one", () => {
    expect(newerOf({ status: "success" }, { status: "running" }).status).toBe("success");
    expect(newerOf({ status: "running" }, { status: "waiting" }).status).toBe("waiting");
    expect(mergeRun(null, doc)).toBe(doc);
    expect(mergeRun(entry, null)).toBe(entry);
  });
});

describe("the log pane follows its end, like a CI page's log", () => {
  const key = logKey(448, "apply-wave-2", 2);
  it("follows a log that just opened: another run, job or step", () => {
    expect(followsLog(null, key, false)).toBe(true);
    expect(followsLog(logKey(447, "apply-wave-2", 2), key, false)).toBe(true);
    expect(followsLog(logKey(448, "apply-wave-1", 2), key, false)).toBe(true);
    expect(followsLog(logKey(448, "apply-wave-2", 1), key, false)).toBe(true);
  });
  it("on the same log, keeps what the viewer chose", () => {
    expect(followsLog(key, key, true)).toBe(true);
    expect(followsLog(key, key, false)).toBe(false);
  });
  it("counts a view within a few lines of the end as at the end", () => {
    const slack = 18 * FOLLOW_LINES;
    expect(nearEnd({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 }, slack)).toBe(true);
    expect(nearEnd({ scrollTop: 600 - slack, clientHeight: 400, scrollHeight: 1000 }, slack)).toBe(true);
    expect(nearEnd({ scrollTop: 600 - slack - 1, clientHeight: 400, scrollHeight: 1000 }, slack)).toBe(false);
    expect(nearEnd({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 }, slack)).toBe(false);
  });
});

describe("the runs for a viewer new to the demo (behold#571)", () => {
  const SC = { "a-output": { name: "A, read through .output" }, "b-waves": { name: "B on waves" }, failure: { name: "a failure mid-apply" } };
  it("prefers the scenario's title when its short label reads as code", () => {
    expect(codeish("A, read through .output")).toBe(true);
    expect(codeish("B on waves")).toBe(true);
    expect(codeish("a-output")).toBe(true);
    expect(codeish("a failure mid-apply")).toBe(false);
    expect(codeish("the base")).toBe(false);
    const titles = { "a-output": "The same change, read once it is built", failure: "One root fails partway" };
    expect(placeWords({ scenario: "a-output", cycle: 90 }, SC, titles)).toBe("The same change, read once it is built · cycle 90");
    expect(placeWords({ scenario: "failure", cycle: 92 }, SC, titles)).toBe("a failure mid-apply · cycle 92");
    expect(placeWords({ scenario: "b-waves", cycle: 91 }, SC, titles)).toBe("B on waves · cycle 91");
    expect(placeWords({ scenario: "c-new", cycle: 93 }, SC, { "c-new": "A new one" })).toBe("A new one · cycle 93");
    expect(placeWords({ scenario: "a-output", cycle: 90 }, SC)).toBe("A, read through .output · cycle 90");
  });
  it("takes demo.json's name for a scenario before the table's label (terragucci#1050)", () => {
    const names = { "b-waves": "a new subnet", failure: "a failure halfway" };
    expect(placeWords({ scenario: "b-waves", cycle: 12 }, SC, {}, names)).toBe("a new subnet · cycle 12");
    expect(placeWords({ scenario: "failure", cycle: 12 }, SC, { failure: "One root fails" }, names)).toBe("a failure halfway · cycle 12");
    expect(placeWords({ scenario: "a-output", cycle: 12 }, SC, {}, names)).toBe("A, read through .output · cycle 12");
  });
  it("learns titles from the merge runs, and demo.json's win", () => {
    const runs = index().runs;
    const t = scenarioTitles(runs);
    expect(t["a-known"]).toBe("A port change, known when it plans");
    expect(scenarioTitles(runs, { "a-known": "A plain title" })["a-known"]).toBe("A plain title");
    expect(scenarioTitles([], {})).toEqual({});
  });
  it("knows the runner's set-up lines from terragucci's own", () => {
    for (const l of ["hint: Using 'master' as the name", "[command]/usr/bin/git init /workspace/demo", "##[group]Initializing the repository", "##[endgroup]", "Initialized empty Git repository in /workspace/demo/.git/"]) expect(setupLine(l)).toBe(true);
    for (const l of ["wave 2 of 3: planning app", "app: Plan: 0 to add, 1 to change, 0 to destroy.", "  terragucci approve wave-2 --plan jcs1-sha256:0a", "⚙️ [runner]: exitcode '3': failure"]) expect(setupLine(l)).toBe(false);
  });
  it("folds the set-up lines into one row at the top, and opens it in order", () => {
    const log = ["##[group]Init", "[command]/usr/bin/git init", "wave 1 of 3: planning network", "hint: x", "##[endgroup]", "wave 1 of 3: applied"];
    expect(logRows(log)).toEqual([{ setup: 4, open: false }, { n: 3, text: "wave 1 of 3: planning network" }, { n: 6, text: "wave 1 of 3: applied" }]);
    const open = logRows(log, { open: true });
    expect(open[0]).toEqual({ setup: 4, open: true });
    expect(open.slice(1).map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(open.filter((r) => r.quiet).map((r) => r.n)).toEqual([1, 2, 4, 5]);
    expect(logRows(["a", "b"], { from: 10 })).toEqual([{ n: 11, text: "a" }, { n: 12, text: "b" }]);
  });
  it("folds the checkout's set-up in a real held job's log, and leaves terragucci's step as it came", () => {
    const job = run(444).jobs.find((j) => j.status === "waiting");
    const checkout = job.steps.find((s) => s.name.includes("checkout") && !s.name.startsWith("Post"));
    const rows = logRows(checkout.log);
    expect(rows[0].setup).toBeGreaterThan(40);
    expect(rows.slice(1).some((r) => /^hint:|^\[command\]|^##\[/.test(r.text))).toBe(false);
    const own = job.steps.find((s) => /^Apply wave/.test(s.name));
    expect(logRows(own.log)).toEqual(own.log.map((text, i) => ({ n: i + 1, text })));
  });
});

describe("an artifact's upload and download fold with the set-up (behold#571)", () => {
  it("knows upload-artifact's and download-artifact's lines", () => {
    for (const l of [
      "With the provided path, there will be 9 files uploaded",
      "Starting artifact upload",
      "For more detailed logs during the artifact upload process, enable step-debugging: https://docs.github.com/actions/monitoring-and-troubleshooting-workflows/enabling-debug-logging#enabling-step-debug-logging",
      "Artifact name is valid!",
      'Container for artifact "terragucci-report-apply-wave-1" successfully created. Starting upload of file(s)',
      "Total size of all the files uploaded is 10011 bytes",
      "File upload process has finished. Finalizing the artifact upload",
      "Artifact has been finalized. All files have been successfully uploaded!",
      "The raw size of all the files that were specified for upload is 38546 bytes",
      "The size of all the files that were uploaded is 10011 bytes. This takes into account any gzip compression used to reduce the upload size, time and storage",
      "Note: The size of downloaded zips can differ significantly from the reported size. For more information see: https://github.com/actions/upload-artifact#zipped-artifact-downloads ",
      "Artifact terragucci-report-apply-wave-1 has been successfully uploaded!",
      "Starting download for terragucci-report",
      "Directory structure has been setup for the artifact",
      "Total number of files that will be downloaded: 16",
      "Artifact terragucci-report was downloaded to /workspace/terragucci-admin/demo/terragucci-report",
      "Artifact download has finished successfully",
    ]) expect(setupLine(l), l).toBe(true);
    expect(setupLine("wave 2: report copied to demo/forgejo:3000/x/tf-apply-wave-2")).toBe(false);
  });

  it("folds a whole upload step, its blank lines with it, into the one row", () => {
    const keep = run(444).jobs.find((j) => j.name === "apply-wave-1").steps.find((s) => s.name === "Keep the apply report");
    const rows = logRows(keep.log);
    expect(rows).toEqual([{ setup: keep.log.length, open: false }]);
  });

  it("keeps a blank line that follows terragucci's own lines", () => {
    expect(logRows(["3 members: 3 groups, 0 destroys or replacements.", "", "Group b6b888372b35: 1 member (outlier), change:"]).map((r) => r.n)).toEqual([1, 2, 3]);
  });

  it("never opens an upload step by default, even when it has the most lines", () => {
    const check = run(444).jobs.find((j) => j.name === "check").steps;
    expect(check[defaultStep(check)].name).toBe("Format check and validate, every root");
  });
});

describe("the features strip, folded to whole lines (behold#571)", () => {
  // A drawn list just big enough: each item where it wrapped to, and the "+N more" button.
  const item = (cls, top) => ({ hidden: false, offsetTop: top, classList: { contains: (c) => c === cls } });
  const list = (items, moreTop) => {
    const more = { hidden: false, offsetTop: moreTop, textContent: "", classList: { contains: () => false } };
    return { more, items, el: { children: [...items, more], querySelector: () => more } };
  };

  it("hides what wraps past the last line it shows, never part of a line, and counts the features hidden", () => {
    expect(FEATURE_LINES).toBe(3);
    const items = [item("r-feats-product", 0), item("r-feat", 0), item("r-feat", 20), item("r-feat", 40), item("r-feats-product", 60), item("r-feat", 60), item("r-feat", 80)];
    const l = list(items, 40);
    fitFeatures(l.el, false);
    expect(items.map((i) => i.hidden)).toEqual([false, false, false, false, true, true, true]);
    expect(l.more).toMatchObject({ hidden: false, textContent: "+2 more" });
  });

  it("shows everything, and no button, when it fits; everything with the button when opened", () => {
    const fits = list([item("r-feat", 0), item("r-feat", 20)], 20);
    fitFeatures(fits.el, false);
    expect(fits.items.every((i) => !i.hidden)).toBe(true);
    expect(fits.more.hidden).toBe(true);
    const open = list([item("r-feat", 0), item("r-feat", 20), item("r-feat", 40), item("r-feat", 60)], 60);
    fitFeatures(open.el, true);
    expect(open.items.every((i) => !i.hidden)).toBe(true);
    expect(open.more.hidden).toBe(false);
  });

  it("never shows \"+0 more\": past the last line only a tool's name, so no button", () => {
    const items = [item("r-feats-product", 0), item("r-feat", 0), item("r-feat", 20), item("r-feat", 40), item("r-feats-product", 60)];
    const l = list(items, 40);
    fitFeatures(l.el, false);
    expect(items.map((i) => i.hidden)).toEqual([false, false, false, false, true]);
    expect(l.more.hidden).toBe(true);
    expect(l.more.textContent).not.toBe("+0 more");
  });

  it("shows \"+N more\" with N the features hidden, and no button once a wider list fits them all", () => {
    const items = [item("r-feat", 0), item("r-feat", 20), item("r-feat", 40), item("r-feat", 60), item("r-feat", 60), item("r-feat", 80)];
    const l = list(items, 40);
    fitFeatures(l.el, false);
    expect(l.more).toMatchObject({ hidden: false, textContent: "+3 more" });
    // Measured again after the list widened: everything on three lines.
    for (const [i, top] of [0, 0, 20, 20, 40, 40].entries()) items[i].offsetTop = top;
    fitFeatures(l.el, false);
    expect(items.every((i) => !i.hidden)).toBe(true);
    expect(l.more.hidden).toBe(true);
  });

  it("opened, offers to fold back only when folding would hide a feature", () => {
    const open = list([item("r-feat", 0), item("r-feat", 20), item("r-feat", 40), item("r-feats-product", 60)], 60);
    fitFeatures(open.el, true);
    expect(open.more.hidden).toBe(true);
  });

  it("drops a tool's name left last on a line with none of its features after it", () => {
    const items = [item("r-feat", 0), item("r-feat", 20), item("r-feats-product", 40), item("r-feat", 60)];
    const l = list(items, 40);
    fitFeatures(l.el, false);
    expect(items.map((i) => i.hidden)).toEqual([false, false, true, true]);
  });
});

describe("the left bar's tone (behold#571)", () => {
  it("takes a run's, job's or step's status: running in the accent, held amber, failed, succeeded, and neutral for the rest", () => {
    expect(["running", "waiting", "failure", "success", "queued", "skipped", "cancelled", "mystery"].map(toneOf)).toEqual(["busy", "wait", "bad", "ok", "idle", "idle", "idle", "idle"]);
  });
  it("has a bar rule in kiosk.html for every tone a status can take", () => {
    const html = readFileSync(join(import.meta.dirname, "kiosk.html"), "utf8");
    for (const tone of new Set(Object.values(STATUS_TONE))) expect(html).toContain(`[data-k-tone="${tone}"]`);
  });
});

// behold#815: chant's run index, as src/ci-run-index.ts hands it to the pane.
describe("runs from chant's run index (behold#815)", () => {
  const ci = (over = {}) => ({ schema: "demo.run/v1", from: "ci-run-index", id: "6782", status: "failure", trigger: "merge", pull: 773, ref: null, member: null, failure: "failed", signer: null, started_at: "2026-10-19T02:26:01.917Z", ended_at: "2026-10-19T02:26:10.991Z", jobs: [{ id: "6782", name: "pr-apply", needs: [], status: "failure" }], ...over });
  it("names the member, why it failed, and who signed it, beside the trigger", () => {
    expect(triggerWords(ci())).toBe("Merge of #773 to main");
    // "failed" beside a failed status says nothing more; a reason that does is kept.
    expect(indexWords(ci())).toEqual([]);
    expect(indexWords(ci({ failure: "command-failed" }))).toEqual(["failed: command-failed"]);
    expect(indexWords(ci({ member: "web", failure: null, signer: "ci-runner@chant-demo", status: "success" }))).toEqual(["web", "signed by ci-runner@chant-demo"]);
  });
  it("says nothing of a signer a run doesn't have: signing is opt-in (chant#4156)", () => {
    for (const signer of [null, undefined, ""]) expect(indexWords(ci({ signer, failure: null })).join(" ")).not.toMatch(/sign/);
  });
  it("words an apply that exited 3 as a plan that moved or waits, not a failure (chant#4156)", () => {
    expect(indexWords(ci({ status: "waiting", failure: "plan-changed", moved: "the plan moved or waits: re-plan and re-approve" }))).toEqual(["the plan moved or waits: re-plan and re-approve (plan-changed)"]);
    expect(toneOf("waiting")).not.toBe(toneOf("failure"));
  });
  it("links the forge's run by its URL's host, never by runOrigin's forge name", () => {
    expect(originLink(ci({ origin: "http://forgejo:3000/chant-demo/fan-out-estate/actions/runs/6782" }))).toEqual({ href: "http://forgejo:3000/chant-demo/fan-out-estate/actions/runs/6782", text: "the run on forgejo:3000" });
    expect(originLink(ci({ origin: "javascript:alert(1)" }))).toBeNull();
    expect(originLink(ci())).toBeNull();
    expect(originLink({ origin: "https://x.example/r/1" })).toBeNull();
  });
  it("adds nothing to a run from anywhere else", () => {
    expect(indexWords({ ...ci(), from: undefined, member: "web" })).toEqual([]);
    expect(indexWords(null)).toEqual([]);
  });
  it("calls a job chant adds later a run, and draws a status it adds by its own word", () => {
    expect(triggerWords(ci({ trigger: null, event: null }))).toBe("a run");
    expect(toneOf("cancelled-by-host")).toBe("idle");
  });
  it("keys runs by chant's run id, a string, through the merge and the live pick", () => {
    const entry = ci({ status: "waiting", ended_at: null });
    expect(mergeRun(entry, ci({ status: "waiting", ended_at: null, jobs: [{ id: "6782", name: "pr-apply", needs: [], status: "waiting", steps: [] }] })).id).toBe("6782");
    expect(liveRun([ci({ id: "b" }), ci({ id: "a" })]).id).toBe("b");
  });
});
