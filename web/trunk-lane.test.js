import { describe, expect, it } from "vitest";
import { commitRow, laneGateCard, laneLegend, laneView, runsLines, UNDECIDED_NOTE, whereWords, workWords } from "./trunk-lane.js";

const NOW = new Date("2026-10-05T10:00:00Z");
const C1 = "6828a7f5b398ea48543fe27c018ba302ce2aba14";
const C2 = "a14610e4f51778c969efcc77694a360412c34d88";
const C3 = "9c4250fa1ed203aa9c61eca708c8f0bbf4a06ddd";
const C4 = "0c7c85ae8cca01463f304a3bd69bc3e977899d5f";
const run = (id, conclusion) => ({ name: "test", url: `https://github.com/acme/app/actions/runs/${id}`, conclusion });

// The shape /api/workspace/lane answers for the #680 fixture workspace.
const gate = {
  key: "web/web/promote",
  member: "web",
  op: "web",
  gate: "promote",
  env: "prod",
  planDigest: "sha256:4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2",
  approvals: [],
  needed: 1,
  signed: false,
  state: "pending",
  approve: "chant approve web promote --env prod --plan sha256:4b5e57f6eb2f",
  gitSha: C2,
  runId: "run-9",
  changeSet: "sha256:4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2",
  commitState: "green",
};
const answer = {
  workspace: true,
  chant: "0.124.28",
  approver: "alex",
  approverIdentity: { principal: "alex", source: "process", forge: false, signs: false },
  read: { at: "2026-10-05T09:59:58Z" },
  order: "promotion",
  trunk: { branch: "main", ref: "refs/heads/main", window: "3650d", since: null, require: ["test"] },
  commits: [
    { sha: C4, committed: "2026-10-04T10:00:00Z", state: "undecided", phases: [{ phase: "test", result: "unrecorded", runs: [] }], revoked: null, work: { state: "linked", ids: ["task:12"], problems: [] }, ignored: [], where: [] },
    { sha: C3, committed: "2026-10-03T10:00:00Z", state: "revoked", phases: [{ phase: "test", result: "fail", runs: [run(113, "failure")] }], revoked: { phase: "test", run: run(113, "failure") }, work: { state: "unlinked", ids: [], problems: [] }, ignored: [], where: [] },
    { sha: C2, committed: "2026-10-02T10:00:00Z", state: "green", phases: [{ phase: "test", result: "pass", runs: [run(102, "success")] }], revoked: null, work: null, ignored: [], where: [{ env: "staging", what: "runs" }, { env: "prod", what: "waits", gate: "web/web/promote" }] },
    { sha: C1, committed: "2026-10-01T10:00:00Z", state: "green", phases: [{ phase: "test", result: "pass", runs: [run(101, "success")] }], revoked: null, work: null, ignored: [], where: [{ env: "prod", what: "runs" }] },
  ],
  environments: [
    { env: "staging", canary: false, members: ["web"], releases: [{ member: "web", label: "v2", releaseDigest: "jcs1-sha256:1a23268fa8b1fc419cffde4c1780f4387ff0346495f97bd9e22b0508bef99f9d", commit: C2, listed: true, components: ["web"], cutBy: "github:alice", cutAt: "2026-10-03T09:00:00Z", approver: null }], deploys: [], waiting: [] },
    { env: "prod", canary: false, members: ["web"], releases: [{ member: "web", label: "v1", releaseDigest: "jcs1-sha256:e3956171ab72fcab2d812cbd3621ef18c04a46c96a9f1e1a8590dae0d9279185", commit: C1, listed: true, components: ["web"], cutBy: "github:alice", cutAt: "2026-10-02T09:00:00Z", approver: "github:alice" }], deploys: [], waiting: [gate] },
  ],
  releaseRefusals: [],
};

describe("laneLegend (#680)", () => {
  it("names the branch, the count and the window, and carries the undecided caveat", () => {
    expect(laneLegend(answer, NOW)).toEqual({ text: "trunk main · 4 commits within 3650d · read just now", title: UNDECIDED_NOTE, tone: "quiet" });
  });
  it("says why when the lane or the trunk wasn't read", () => {
    const refusal = { error: "Trunk commits needs chant 0.124.28 or newer. This project has chant 0.124.24.", code: "chant-too-old", remedy: "Upgrade @intentius/chant to 0.124.28 or newer in the project." };
    expect(laneLegend({ workspace: true, refusal }, NOW)).toEqual({ text: `lane not read: ${refusal.error}`, title: refusal.remedy, tone: "refusal" });
    const noGreen = { ...answer, trunk: null, commits: [], trunkRefusal: { error: "chant ci list: the workspace declares no ci.green", code: "ci-green-undeclared", remedy: "Declare ci.green" } };
    expect(laneLegend(noGreen, NOW)).toMatchObject({ text: "trunk not read: chant ci list: the workspace declares no ci.green · read just now", tone: "refusal" });
  });
});

describe("a trunk commit (#680)", () => {
  it("says its state, where it is, its work and its runs", () => {
    const green = commitRow(answer.commits[2], NOW);
    expect(green).toMatchObject({ head: "a14610e green", when: "3d ago", where: "runs in staging, waits in prod", facts: [] });
    expect(green.runs).toEqual([{ text: "test", href: "https://github.com/acme/app/actions/runs/102", title: "test: success" }]);
    const revoked = commitRow(answer.commits[1], NOW);
    expect(revoked.facts.map((f) => f.text)).toEqual(["revoked: test failed", "no work item"]);
    expect(revoked.runs).toHaveLength(1);
    const undecided = commitRow(answer.commits[0], NOW);
    expect(undecided.facts.map((f) => f.text)).toEqual(["work task:12"]);
    expect(undecided.title).toContain(UNDECIDED_NOTE);
  });
  it("words each work state chant#4029 defines, and nothing when chant said nothing", () => {
    expect(workWords(null)).toBeNull();
    expect(workWords({ state: "merge", ids: [], problems: [] }).text).toBe("merge commit");
    expect(workWords({ state: "wrong", ids: [], problems: [{ trailer: "Chant-Record: task:99", message: "no task record 99 exists" }] })).toEqual({ text: "names a work item that does not exist", title: "Chant-Record: task:99: no task record 99 exists" });
    expect(whereWords([])).toBe("");
  });
});

describe("an environment's lane (#680)", () => {
  it("says what it runs and the commit it was cut from", () => {
    expect(runsLines(answer.environments[0], NOW)).toEqual([{ text: "runs v2, cut from a14610e · web", title: expect.stringContaining("cut by github:alice") }]);
    expect(runsLines(answer.environments[1], NOW)[0].title).toContain("deploy approved by github:alice");
  });
  it("says plainly when there is no deploy record, and names a deploy no release covers", () => {
    expect(runsLines({ env: "dev", releases: [], deploys: [] }, NOW)).toEqual([{ text: "no deploy record", title: expect.any(String) }]);
    const d = { member: "web", component: "api", digest: "sha256:0123456789abcdef", gitSha: C1, listed: false, timestamp: "2026-10-04T10:00:00Z", actor: "ci", approver: null, runId: "r" };
    expect(runsLines({ env: "dev", releases: [], deploys: [d] }, NOW)[0].text).toBe("runs api 0123456789ab from 6828a7f (older than the trunk list)");
  });
  it("draws a waiting gate with its commit, run and change set, and the approve button that names the approver", () => {
    const card = laneGateCard(gate, answer);
    expect(card).toMatchObject({
      title: "web: web waits at gate promote",
      facts: "for a14610e (green) · 0 of 1 approval · run run-9 · change set 4b5e57f6eb2f",
      button: { label: "Approve as alex" },
    });
    expect(card.command).toContain("chant change-set show sha256:4b5e57f6");
    expect(laneGateCard({ ...gate, gitSha: undefined, commitState: null, changeSet: undefined }, answer).facts).toBe("commit unknown · 0 of 1 approval · run run-9");
    expect(laneGateCard(gate, answer, { embed: true }).button).toBeUndefined();
  });
  it("lays the environments out in the order the answer gives", () => {
    const v = laneView(answer, NOW);
    expect(v.environments.map((e) => [e.heading, e.gates.length])).toEqual([
      ["staging", 0],
      ["prod", 1],
    ]);
    expect(v.notes).toEqual([]);
    expect(laneView({ ...answer, order: "env", environments: [answer.environments[1]] }, NOW).notes).toEqual(["no member declares a promotion order, so this is prod alone"]);
  });
});
