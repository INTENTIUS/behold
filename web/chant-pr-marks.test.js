import { describe, expect, it } from "vitest";
import { CHANT_PANEL_STEPS, chantApprovalModel, chantComponentMarks, chantLiveWaves, chantResultModel, countWords, graphWaves, shortReason } from "./chant-pr-marks.js";

// behold#631: the marks on a chant repo's components view, from /api/chant/pr's
// answer, shaped as it answered for cycle 767 of terragucci's demo (scenario
// chant-pr-loop: network, app and edge, one wave each, pull request 13).
const DIGEST = "jcs1-sha256:909bbc5e4f02021bdff9d852c8253f215383a2489eee464ace2adb0fda138553";
const facets = { forge: "forgejo", workflow: ".forgejo/workflows/chant-pr.yml", env: "demo", gate: "pr-apply", tools: ["chant", "opentofu"], waves: { network: 1, app: 2, edge: 3, cache: 3 }, members: { network: "network", app: "app", edge: "edge", cache: "cache" } };
const member = (name, status) => ({ member: name, status, counts: { create: 1, update: 0, replace: 0, delete: 0 } });
const plan = { stage: "plan", from: "log", source: "run #3843", run: 3843, pr: 13, status: "planned", digest: DIGEST, op: "pr-13", gate: "pr-apply", members: ["app", "edge", "network"].map((m) => member(m, "planned")) };
const loop = { forge: "forgejo", workflow: facets.workflow, env: "demo", gate: "pr-apply", output: ".chant/pr", stages: ["plan", "apply"] };
const waiting = { op: "pr-13", gate: "pr-apply", digest: DIGEST, state: "waiting", from: "log", approveCommand: `chant approve pr-13 pr-apply --plan ${DIGEST} --approver <you> --sign` };
const approved = { op: "pr-13", gate: "pr-apply", digest: DIGEST, state: "approved", by: "forgejo@forgejo:3000:demo-reviewer", at: "2026-10-16T08:15:25.591Z", seal: "sealed", ledgerCommit: "10a36285", from: "ledger" };
const answer = (over) => ({ schema: "behold.chant-pr/v1", loop, pull: 13, plan: null, apply: null, running: null, gate: null, reads: [], gaps: [], ...over });

describe("a chant repo's components, marked from its pull-request loop (behold#631)", () => {
  it("before the first plan: no card and no wave has a state", () => {
    const m = chantComponentMarks(answer({}), facets);
    expect(m.cards).toEqual({});
    expect(m.waves).toEqual({});
  });

  it("planned: each component planned with its changes, a component the change missed unchanged, each wave waiting on the digest", () => {
    const m = chantComponentMarks(answer({ plan, gate: waiting }), facets);
    expect(m.cards.app).toMatchObject({ wave: 2, state: "planned", tone: "plan", words: "planned +1" });
    expect(m.cards.app.facts).toEqual(["1 to create", "plan 909bbc5e"]);
    expect(m.cards.cache).toMatchObject({ state: "unchanged", tone: "idle" });
    expect(m.waves[1]).toMatchObject({ state: "waiting", tone: "wait", status: null, facts: [`approve plan ${DIGEST.slice(12)}`] });
    expect(m.waves[3].state).toBe("waiting");
    expect(m.source).toBe("(from chant pr-plan's summary in run #3843)");
  });

  it("on a kiosk: the plan by its short id, the box's words at the right of its title line, and no approve command on the card", () => {
    const m = chantComponentMarks(answer({ plan, gate: waiting }), facets, { kiosk: true });
    // The approval card names the plan; the boxes don't repeat it on a kiosk.
    expect(m.waves[1].facts).toEqual([]);
    expect(m).toMatchObject({ statusRight: true, cardFont: 15, waveFont: 18 });
    const panel = chantApprovalModel({ demo: { step: "waiting", pull: 13 }, answer: answer({ plan, gate: waiting }), kiosk: true });
    expect(panel.rows[0].command).toBeUndefined();
    // No run numbers and plain words for what comes next.
    expect(panel.run).toBeNull();
    expect(panel.rows.every((r) => !r.runId)).toBe(true);
    expect(panel.rows.map((r) => r.text).slice(1)).toEqual(["A reviewer approves this exact plan.", "The merge applies it only if it still matches."]);
    // An answer read for the cycle's first pull request is not the fix's.
    expect(chantApprovalModel({ demo: { step: "waiting", pull: 14 }, answer: answer({ plan, gate: waiting }), kiosk: true })).toBeNull();
    // Inspect keeps both.
    expect(chantComponentMarks(answer({ plan, gate: waiting }), facets).statusRight).toBeUndefined();
    expect(chantApprovalModel({ demo: { step: "waiting", pull: 13 }, answer: answer({ plan, gate: waiting }) }).rows[0].command).toBe(waiting.approveCommand);
  });

  it("approved: the waves planned, and who approved", () => {
    const m = chantComponentMarks(answer({ plan, gate: approved }), facets);
    expect(m.waves[2]).toMatchObject({ state: "planned", facts: ["approved by demo-reviewer"] });
    expect(m.source).toMatch(/the gate's ledger/);
  });

  it("while the merge's apply runs: the job on each box and the plan on each card, with the issue that asks for progress", () => {
    const m = chantComponentMarks(answer({ plan, gate: approved, running: { stage: "apply", run: 3844, job: "apply", status: "running", started_at: null } }), facets);
    expect(m.cards.network.state).toBe("planned");
    expect(m.cards.network.facts).toContain("per-component progress: chant#4007");
    expect(m.waves[1]).toMatchObject({ state: "planned", status: { status: "running", words: "apply running", tone: "busy", run: 3844 }, title: "wave-1 · apply running" });
    expect(m.waves[1].facts[0]).toBe("per-wave progress: chant#4007");
  });

  it("applied: each component and wave applied", () => {
    const apply = { ...plan, stage: "apply", source: "run #3844", run: 3844, status: "applied", members: plan.members.map((x) => ({ ...x, status: "applied" })) };
    const m = chantComponentMarks(answer({ plan, apply, gate: approved }), facets);
    expect(m.cards.edge).toMatchObject({ state: "applied", tone: "ok", words: "applied +1" });
    expect(m.waves[3]).toMatchObject({ state: "applied", tone: "ok", facts: ["applied plan 909bbc5e"] });
    expect(m.cards.cache.state).toBe("unchanged");
  });

  it("a failed wave fails, and what depends on it is blocked by it", () => {
    const apply = { ...plan, stage: "apply", run: 3844, status: "failed", members: [member("network", "applied"), { ...member("app", "failed"), error: "exit 1" }, member("edge", "blocked")] };
    const m = chantComponentMarks(answer({ plan, apply, gate: approved }), facets);
    expect(m.waves[1].state).toBe("applied");
    expect(m.cards.app).toMatchObject({ state: "failed", tone: "bad", words: "failed: exit 1", short: "failed" });
    expect(m.cards.app.facts).toContain("exit 1");
    // No edges in the facets: blocked, the blocker unnamed.
    expect(m.cards.edge).toMatchObject({ state: "blocked", short: "blocked", words: "blocked by an earlier failure" });
    // With the graph's edges, the blocker by name.
    const named = chantComponentMarks(answer({ plan, apply, gate: approved }), { ...facets, needs: { edge: ["app"], app: ["network"] } });
    expect(named.cards.edge).toMatchObject({ state: "blocked", words: "blocked by app", blockedBy: "app" });
  });

  it("sums a plan's changes as Terraform does", () => {
    expect(countWords({ create: 2, update: 1, replace: 1, delete: 0 })).toBe("+3 ~1 -1");
    expect(countWords({ create: 0, update: 0, replace: 0, delete: 0 })).toBeNull();
  });
});

describe("how chant's gate ends, the hold panel (behold#631)", () => {
  const demo = (step) => ({ step, pull: 13 });
  it("waiting: requested with the approve line, then the approval and the apply to come", () => {
    const m = chantApprovalModel({ demo: demo("waiting"), answer: answer({ plan, gate: waiting }) });
    expect(m).toMatchObject({ wave: null, digest: DIGEST, run: 3843 });
    expect(m.rows.map((r) => [r.id, r.state])).toEqual([["requested", "lit"], ["approved", "dim"], ["spent", "dim"]]);
    expect(m.rows[0].command).toBe(waiting.approveCommand);
  });
  it("applied: each row lit from its record, the ledger's approval with its seal and commit", () => {
    const apply = { ...plan, stage: "apply", run: 3844, status: "applied" };
    const m = chantApprovalModel({ demo: demo("applied"), answer: answer({ plan, apply, gate: approved }) });
    expect(m.rows.map((r) => r.state)).toEqual(["lit", "lit", "lit"]);
    expect(m.rows[1]).toMatchObject({ text: "forgejo@forgejo:3000:demo-reviewer approved this exact digest.", at: approved.at, commit: "10a36285", seal: { text: "signed" } });
    expect(m.rows[0].command).toBeUndefined();
    expect(m.run).toBe(3844);
  });
  it("shows on no step before the plan waits, and for no answer", () => {
    expect(chantApprovalModel({ demo: demo("planned"), answer: answer({ plan, gate: waiting }) })).toBeNull();
    expect(chantApprovalModel({ demo: demo("waiting"), answer: null })).toBeNull();
  });
});

// behold#631, chant#4007: terragucci's fan-out scenario on demo-chant-fanout, chant's examples/fan-out-estate.
describe("a chant repo's apply, live from its run events", () => {
  const appsA = ["app-01", "app-02", "app-03", "app-04", "app-05", "app-06"];
  const appsB = ["app-07", "app-08", "app-09", "app-10", "app-11", "app-12"];
  const all = ["network", "cluster-a", "cluster-b", ...appsA, ...appsB];
  const fan = {
    ...facets,
    waves: Object.fromEntries(all.map((c) => [c, c === "network" ? 1 : c.startsWith("cluster") ? 2 : 3])),
    members: Object.fromEntries(all.map((c) => [c, c])),
    needs: { "cluster-a": ["network"], "cluster-b": ["network"], ...Object.fromEntries(appsA.map((a) => [a, ["cluster-a"]])), ...Object.fromEntries(appsB.map((a) => [a, ["cluster-b"]])) },
  };
  const fanPlan = { ...plan, pr: 14, op: "pr-14", members: all.map((c) => member(c, "planned")) };
  const FIFO = "Resource handler returned message: The name of a FIFO queue can only end with '.fifo'.";
  const comps = (states) => Object.fromEntries(Object.entries(states).map(([c, s]) => [c, { component: c, wave: fan.waves[c], ...(typeof s === "string" ? { state: s } : s) }]));
  const wave = (n, state, counts = {}) => ({ wave: n, state, components: all.filter((c) => fan.waves[c] === n), counts: { applied: 0, failed: 0, blocked: 0, alreadyApplied: 0, running: 0, waiting: 0, ...counts } });
  const running = { stage: "apply", run: 3901, job: "apply", status: "running", started_at: null };

  it("while wave 2 applies: wave 1 done, wave 2 applying, the apps waiting for wave 3, and no progress issue", () => {
    const live = { stage: "apply", settled: false, status: null, waves: [wave(1, "applied", { applied: 1 }), wave(2, "running", { running: 2 }), wave(3, "waiting", { waiting: 12 })], components: comps({ network: "applied", "cluster-a": "running", "cluster-b": "running", ...Object.fromEntries([...appsA, ...appsB].map((a) => [a, "planned"])) }) };
    const m = chantComponentMarks(answer({ pull: 14, plan: fanPlan, gate: approved, running, live: { reportUrl: "s3://r", via: "pipeline", plan: null, apply: live } }), fan);
    expect(m.waves[1]).toMatchObject({ state: "applied", status: { words: "done" } });
    expect(m.waves[2]).toMatchObject({ state: "applying", tone: "busy", status: { status: "running", words: "applying" } });
    // A wave the run has not reached is waiting, never "held".
    expect(m.waves[3].status).toMatchObject({ status: "queued", words: "waiting" });
    expect(m.cards["cluster-a"]).toMatchObject({ state: "applying", words: "applying", tone: "busy" });
    expect(m.cards["app-01"]).toMatchObject({ state: "queued", words: "waiting for wave 3" });
    expect(JSON.stringify(m)).not.toContain("chant#4007");
  });

  it("after the merge: cluster-a failed with its reason, cluster-b's apps applied, cluster-a's blocked by it", () => {
    const live = {
      stage: "apply",
      settled: true,
      status: "failed",
      waves: [wave(1, "applied", { applied: 1 }), wave(2, "failed", { applied: 1, failed: 1 }), wave(3, "applied", { applied: 6, blocked: 6 })],
      components: comps({ network: "applied", "cluster-a": { state: "failed", error: FIFO, failedIn: "apply" }, "cluster-b": "applied", ...Object.fromEntries(appsA.map((a) => [a, { state: "blocked", blockedBy: "cluster-a" }])), ...Object.fromEntries(appsB.map((a) => [a, "applied"])) }),
    };
    const a = answer({ pull: 14, plan: fanPlan, gate: approved, running, live: { reportUrl: "s3://r", via: "pipeline", plan: null, apply: live } });
    const m = chantComponentMarks(a, fan);
    expect(m.cards["cluster-a"]).toMatchObject({ state: "failed", tone: "bad", short: "failed", reason: "The name of a FIFO queue can only end with '.fifo'" });
    expect(m.cards["cluster-a"].words).toBe("failed: The name of a FIFO queue can only end with '.fifo'");
    expect(m.cards["cluster-a"].mid).toMatch(/^failed: The name of a…$/);
    expect(m.cards["app-03"]).toMatchObject({ state: "blocked", words: "blocked by cluster-a", tone: "wait" });
    expect(m.cards["app-03"].facts).toContain("did not run: cluster-a failed, and this depends on it");
    expect(m.cards["app-09"].state).toBe("applied");
    expect(m.waves[2]).toMatchObject({ state: "failed", status: { words: "1 failed, 1 applied" } });
    expect(m.waves[2].facts[0]).toBe("cluster-a failed: The name of a FIFO queue can only end with '.fifo'");
    expect(m.waves[3]).toMatchObject({ state: "blocked", status: { words: "6 applied, 6 blocked by cluster-a" } });
    expect(m.source).toMatch(/run events/);
    // The gate's panel stays up on the failed step, and says how far the apply got.
    expect(CHANT_PANEL_STEPS).toContain("failed");
    const panel = chantApprovalModel({ demo: { step: "failed", pull: 14 }, answer: a });
    expect(panel.rows[2]).toMatchObject({ id: "spent", state: "dim", text: "The merge applied part of this digest: 8 applied, 1 failed, 6 blocked. The rest waits for a fix." });
    expect(panel.chantWaves[1]).toMatchObject({ wave: 2, state: "failed", failed: [{ component: "cluster-a", reason: "The name of a FIFO queue can only end with '.fifo'" }] });
    expect(chantLiveWaves(a)[2]).toMatchObject({ applied: 6, blocked: 6, blockedBy: ["cluster-a"] });
  });

  it("a blocked card names its blocker from the graph when chant's events don't", () => {
    const live = { stage: "apply", settled: true, status: "failed", waves: [wave(1, "applied"), wave(2, "failed"), wave(3, "applied")], components: comps({ network: "applied", "cluster-a": "failed", "cluster-b": "applied", ...Object.fromEntries(appsA.map((a) => [a, "blocked"])), ...Object.fromEntries(appsB.map((a) => [a, "applied"])) }) };
    const m = chantComponentMarks(answer({ pull: 14, plan: fanPlan, gate: approved, live: { reportUrl: "s3://r", via: "pipeline", plan: null, apply: live } }), fan);
    expect(m.cards["app-01"]).toMatchObject({ state: "blocked", blockedBy: "cluster-a", words: "blocked by cluster-a" });
  });

  it("a resume's boxes follow the graph's waves by name, not run-start's re-layered numbers", () => {
    // run-start re-layered what was left: cluster-a is its wave 1, cluster-a's apps its wave 2.
    const live = {
      stage: "apply",
      settled: false,
      status: null,
      waves: [{ ...wave(1, "running", { running: 1 }), components: ["cluster-a"] }, { ...wave(2, "waiting", { waiting: 6 }), components: appsA }],
      components: comps({
        network: { state: "already-applied", wave: 1, waveFrom: "graph" },
        "cluster-b": { state: "already-applied", wave: 2, waveFrom: "graph" },
        ...Object.fromEntries(appsB.map((a) => [a, { state: "already-applied", wave: 3, waveFrom: "graph" }])),
        "cluster-a": { state: "running", wave: 1 },
        ...Object.fromEntries(appsA.map((a) => [a, { state: "planned", wave: 2 }])),
      }),
    };
    const m = chantComponentMarks(answer({ pull: 15, plan: fanPlan, gate: approved, running, live: { reportUrl: "s3://r", via: "pipeline", plan: null, apply: live } }), fan);
    expect(m.cards.network).toMatchObject({ state: "already-applied", words: "applied before", tone: "ok" });
    // The graph's wave 1 (network) is done though run-start's wave 1 (cluster-a) runs.
    expect(m.waves[1]).toMatchObject({ state: "applied", status: { words: "done" } });
    expect(m.waves[2]).toMatchObject({ state: "applying", status: { words: "applying" } });
    // Wave 3: cluster-b's apps applied before, cluster-a's wait their turn.
    expect(m.waves[3]).toMatchObject({ state: "planned", status: { words: "waiting" } });
    expect(m.cards["app-01"]).toMatchObject({ state: "queued", words: "waiting for wave 3" });
  });

  it("the fix's apply: what the cycle's first apply landed reads applied earlier, and every card has landed at the end", () => {
    const live = {
      stage: "apply",
      settled: true,
      status: "ok",
      waves: [{ ...wave(1, "applied", { applied: 1 }), components: ["cluster-a"] }, { ...wave(2, "applied", { applied: 6 }), components: appsA }],
      components: comps({ "cluster-a": { state: "applied", wave: 1, graphWave: 2 }, ...Object.fromEntries(appsA.map((a) => [a, { state: "applied", wave: 2, graphWave: 3 }])) }),
    };
    const fixPlan = { ...plan, pr: 15, op: "pr-15", members: ["cluster-a", ...appsA].map((c) => member(c, "planned")) };
    const earlier = { runs: [3901], applied: ["app-07", "app-08", "app-09", "app-10", "app-11", "app-12", "cluster-b", "network"] };
    const a = answer({ pull: 15, plan: fixPlan, gate: approved, live: { reportUrl: "s3://r", via: "pipeline", plan: null, apply: live, earlier } });
    const m = chantComponentMarks(a, fan);
    expect(m.cards.network).toMatchObject({ state: "applied-earlier", words: "applied earlier", tone: "ok" });
    expect(m.cards["app-09"].state).toBe("applied-earlier");
    expect(m.cards["cluster-a"].state).toBe("applied");
    expect(Object.values(m.cards).every((c) => c.state === "applied" || c.state === "applied-earlier")).toBe(true);
    expect(m.waves[1]).toMatchObject({ state: "applied", status: { words: "applied earlier" } });
    // Network landed in the first apply: its box claims none of this run's plan.
    expect(m.waves[1].facts.some((f) => /^applied plan/.test(f))).toBe(false);
    // The run's waves numbered as the graph's boxes are.
    expect(graphWaves(live).map((w) => w.wave)).toEqual([2, 3]);
    // The result card, the one terragucci's scenarios get.
    const r = chantResultModel({ step: "applied", label: "Done." }, a);
    expect(r).toMatchObject({ head: "Applied", line: "Done.", counts: ["7 applied this run", "8 applied earlier", "the fix ran 2 waves"] });
    expect(r.waves).toEqual([{ wave: 2, words: "1 applied" }, { wave: 3, words: "6 applied" }]);
    expect(chantResultModel({ step: "applying" }, a)).toBeNull();
    // The plan of the same fix, before it applies: the eight read as landed there too.
    const planned = chantComponentMarks(answer({ pull: 15, plan: fixPlan, gate: waiting, live: { reportUrl: "s3://r", via: "pipeline", plan: null, apply: null, earlier } }), fan);
    expect(planned.cards.network.state).toBe("applied-earlier");
    expect(planned.cards["cluster-a"].state).toBe("planned");
  });

  it("says starting… while the apply runs and its events have not landed, and never an issue number on a kiosk", () => {
    const run = { stage: "apply", run: 3901, job: "apply", status: "running", started_at: null };
    const m = chantComponentMarks(answer({ pull: 14, plan: fanPlan, gate: approved, running: run, eventsExpected: true }), fan);
    // Only the wave the apply starts with says so; the ones after it wait.
    expect(m.waves[1].status).toMatchObject({ words: "starting…", tone: "busy" });
    expect(m.waves[2].status).toMatchObject({ status: "queued", words: "waiting" });
    expect(m.waves[3].status).toMatchObject({ status: "queued", words: "waiting" });
    expect(JSON.stringify(m)).not.toContain("chant#4007");
    const kiosk = chantComponentMarks(answer({ pull: 14, plan: fanPlan, gate: approved, running: run }), fan, { kiosk: true });
    expect(JSON.stringify(kiosk)).not.toContain("chant#4007");
    // Inspect, with no events at all, still says which issue asks for them.
    const inspect = chantComponentMarks(answer({ pull: 14, plan: fanPlan, gate: approved, running: run }), fan);
    expect(inspect.waves[2].facts[0]).toBe("per-wave progress: chant#4007");
  });

  it("names the specific part of a tool's error, not its prefix or its advice", () => {
    expect(shortReason('cfn-deploy "cluster-a": stack reached ROLLBACK_COMPLETE — the deploy failed and was rolled back. Inspect the stack events for the resource that failed to create/update.')).toBe("stack reached ROLLBACK_COMPLETE");
  });

  it("a fix just opened, with no plan yet: what landed reads applied earlier, a failed or blocked card keeps its state, nothing blank", () => {
    const run = { stage: "plan", run: 3950, job: "plan", status: "queued", started_at: null };
    const lastStates = { "cluster-a": "failed", ...Object.fromEntries(appsA.map((a) => [a, "blocked"])) };
    const earlier = { runs: [], applied: ["network", "cluster-b", ...appsB] };
    const m = chantComponentMarks(answer({ pull: 15, plan: null, gate: null, running: run, lastStates, live: { reportUrl: null, via: "pipeline", plan: null, apply: null, earlier } }), fan, { kiosk: true });
    expect(m.cards.network.state).toBe("applied-earlier");
    expect(m.cards["cluster-a"].state).toBe("failed");
    expect(m.cards["app-02"]).toMatchObject({ state: "blocked", blockedBy: "cluster-a" });
    expect(Object.values(m.cards).every((c) => c.state !== "unchanged")).toBe(true);
    // Network's box is not part of the fix: it says applied earlier, never the plan job.
    expect(m.waves[1].status.words).toBe("applied earlier");
    expect(JSON.stringify(m)).not.toContain("plan queued");
  });

  it("cuts a long reason at a word", () => {
    expect(shortReason("error: one two three four five six seven", 20)).toBe("one two three four…");
    expect(shortReason("")).toBeNull();
  });
});
