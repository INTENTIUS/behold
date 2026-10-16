import { describe, expect, it } from "vitest";
import { chantApprovalModel, chantComponentMarks, countWords } from "./chant-pr-marks.js";

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

  it("a failed wave fails, and the waves after it are held back", () => {
    const apply = { ...plan, stage: "apply", run: 3844, status: "failed", members: [member("network", "applied"), { ...member("app", "failed"), error: "exit 1" }, member("edge", "blocked")] };
    const m = chantComponentMarks(answer({ plan, apply, gate: approved }), facets);
    expect(m.waves[1].state).toBe("applied");
    expect(m.cards.app).toMatchObject({ state: "failed", tone: "bad", words: "apply failed" });
    expect(m.cards.app.facts).toContain("exit 1");
    expect(m.cards.edge).toMatchObject({ state: "not-started", short: "held back" });
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
