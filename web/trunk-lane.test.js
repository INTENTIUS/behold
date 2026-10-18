import { describe, expect, it } from "vitest";
import { commitRow, laneGateCard, laneLegend, laneView, releaseColumnNote, releaseRow, renderTrunkLane, runsLines, signatureWords, supersededLine, UNDECIDED_NOTE, whereWords, workWords } from "./trunk-lane.js";

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

// #692: the release column of the same workspace (src/trunk-lane-fixture.ts):
// v1 from C1 running in prod, v2 from C2 with v1's image digest running in
// staging and waiting in prod, v3 from the revoked C3 with a new one.
const R1 = `jcs1-sha256:${"1".repeat(64)}`;
const R2 = `jcs1-sha256:${"2".repeat(64)}`;
const R3 = `jcs1-sha256:${"3".repeat(64)}`;
const revocation = { tag: `ci/revoked/${C3}`, tagged: "2026-10-05T00:00:00Z", phase: "test", run: run(113, "failure"), signer: null };
const ROLLBACK = "chant components rollback staging --release v2";
const unsigned = { status: "unsigned", reason: "the cut carries no signature" };
const releases = [
  { member: "web", releaseDigest: R3, label: "v3", commit: C3, listed: true, artifacts: 1, previous: { releaseDigest: R2, label: "v2" }, configOnly: false, cut: { by: "github:alice", at: "2026-10-04T09:00:00Z", signature: { status: "unverified", reason: "there is no signers file (.chant/allowed_signers) at base to check the cut's signature against" } }, revoked: { ...revocation, rollback: [ROLLBACK] }, runs: [{ env: "staging", components: ["api"] }], waits: [{ env: "prod", gate: "web/release/promote", state: "superseded" }], next: null },
  { member: "web", releaseDigest: R2, label: "v2", commit: C2, listed: true, artifacts: 1, previous: { releaseDigest: R1, label: "v1" }, configOnly: true, cut: { by: "github:alice", at: "2026-10-03T09:00:00Z", signature: unsigned }, revoked: null, runs: [{ env: "staging", components: ["web"] }], waits: [{ env: "prod", gate: "web/web/promote", state: "pending" }], next: "prod" },
  { member: "web", releaseDigest: R1, label: "v1", commit: C1, listed: true, artifacts: 1, previous: null, configOnly: null, cut: { by: "github:alice", at: "2026-10-02T09:00:00Z", signature: unsigned }, revoked: null, runs: [{ env: "prod", components: ["web"] }], waits: [], next: null },
];
const superseded = { key: "web/release/promote", member: "web", op: "release", gate: "promote", env: "prod", releaseDigest: R3, gitSha: C3, runId: "run-12", revoked: revocation };
const column = {
  ...answer,
  chant: "0.124.29",
  releases,
  releaseColumn: { full: true, floor: "0.124.29" },
  commits: answer.commits.map((c, i) => ({ ...c, cuts: [[], [{ member: "web", releaseDigest: R3, label: "v3" }], [{ member: "web", releaseDigest: R2, label: "v2" }], [{ member: "web", releaseDigest: R1, label: "v1" }]][i] })),
  environments: [
    { ...answer.environments[0], releases: [{ member: "web", label: "v3", releaseDigest: R3, commit: C3, listed: true, components: ["api"], cutBy: "github:alice", cutAt: "2026-10-04T09:00:00Z", approver: null, rollback: [ROLLBACK] }, { ...answer.environments[0].releases[0], rollback: [] }], superseded: [] },
    { ...answer.environments[1], superseded: [superseded] },
  ],
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
      facts: "for a14610e (green) · 0 of 1 approval · run run-9",
      changeSet: { text: "change set 4b5e57f6eb2f", title: expect.stringContaining("Draw this change set on the graph") },
      button: { label: "Approve as alex" },
    });
    expect(card.command).toContain("chant change-set show sha256:4b5e57f6");
    expect(card.changeSet.title).toContain("chant change-set show sha256:4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2 --member web");
    // #681: a release gate names the release its change set was planned for.
    expect(laneGateCard({ ...gate, op: "release", releaseDigest: "jcs1-sha256:1a23268fa8b1fc419cffde4c1780f4387ff0346495f97bd9e22b0508bef99f9d" }, answer).facts).toBe("for a14610e (green) · 0 of 1 approval · run run-9 · release 1a23268fa8b1");
    expect(laneGateCard({ ...gate, gitSha: undefined, commitState: null, changeSet: undefined }, answer)).toMatchObject({ facts: "commit unknown · 0 of 1 approval · run run-9" });
    expect(laneGateCard({ ...gate, changeSet: undefined }, answer).changeSet).toBeUndefined();
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

describe("the release column (#692)", () => {
  it("names each release with its commit, its cut and its signature check", () => {
    const v2 = releaseRow(releases[1], NOW);
    expect(v2).toMatchObject({ head: "v2 · web", cutFrom: "cut from a14610e" });
    expect(v2.facts.map((f) => f.text)).toEqual(["cut by github:alice 2d ago", "unsigned"]);
    expect(releaseRow(releases[0], NOW).facts.map((f) => f.text)).toEqual(["cut by github:alice 25h ago", "signature does not count"]);
    expect(signatureWords({ status: "verified", reason: "" }).text).toBe("signed");
    expect(signatureWords(null)).toBeNull();
    expect(releaseRow({ ...releases[2], cut: null, artifacts: 0, listed: false }, NOW)).toMatchObject({ cutFrom: "cut from 6828a7f (older than the trunk list)", facts: [{ text: "no cut recorded" }, { text: "no artifact digests" }] });
  });

  it("marks a config-only release, and not one whose artifacts changed", () => {
    expect(releaseRow(releases[1], NOW).marks).toEqual([{ text: "config-only", cls: "lane-config-only", title: "The same artifact digests as v1: only configuration changed." }]);
    expect(releaseRow(releases[0], NOW).marks.map((m) => m.text)).toEqual(["revoked"]);
    expect(releaseRow(releases[2], NOW).marks).toEqual([]);
  });

  it("says where a release runs and waits, and where promotion takes it next", () => {
    expect(releaseRow(releases[1], NOW).where.map((w) => w.text)).toEqual(["runs in staging", "waits in prod"]);
    expect(releaseRow({ ...releases[1], waits: [] }, NOW).where.map((w) => w.text)).toEqual(["runs in staging", "next: prod"]);
    expect(releaseRow({ ...releases[1], runs: [], waits: [], next: "staging" }, NOW).where.map((w) => w.text)).toEqual(["next: staging"]);
    expect(releaseRow(releases[2], NOW).where.map((w) => w.text)).toEqual(["runs in prod"]);
    expect(releaseRow({ ...releases[2], runs: [] }, NOW).where.map((w) => w.text)).toEqual(["runs nowhere"]);
  });

  it("marks a revoked release with what failed and the line that rolls it back, and its gate as superseded", () => {
    const v3 = releaseRow(releases[0], NOW);
    expect(v3.revoked).toEqual({ text: "revoked: test failed", run: { text: "test", href: "https://github.com/acme/app/actions/runs/113", title: "test: failure" }, rollback: [`roll back: ${ROLLBACK}`] });
    expect(v3.where.map((w) => w.text)).toEqual(["runs in staging", "gate in prod superseded"]);
    expect(supersededLine(superseded, column).text).toBe("web/release/promote superseded: release v3 is revoked (test failed)");
    expect(runsLines(column.environments[0], NOW)[0]).toMatchObject({ text: "runs v3, cut from 9c4250f · api · revoked", revoked: true, title: expect.stringContaining(`roll back: ${ROLLBACK}`) });
    const d = { member: "web", component: "api", digest: "sha256:0123456789abcdef", gitSha: C3, listed: true, timestamp: "2026-10-04T10:00:00Z", actor: "ci", approver: null, runId: "r", release: { releaseDigest: R3, label: "v3" }, rollback: ROLLBACK };
    expect(runsLines({ env: "staging", releases: [], deploys: [d] }, NOW)[0]).toMatchObject({ text: "runs api 0123456789ab from release v3, 9c4250f · revoked", revoked: true });
  });

  it("names the releases cut from each commit", () => {
    expect(commitRow(column.commits[2], NOW).facts.map((f) => f.text)).toEqual(["cut as v2"]);
    expect(commitRow(column.commits[0], NOW).facts.map((f) => f.text)).toEqual(["work task:12"]);
  });

  it("says when the project's chant is below the column's floor, and nothing at or above it", () => {
    expect(releaseColumnNote(column)).toBeNull();
    const old = { ...column, chant: "0.124.28", releaseColumn: { full: false, floor: "0.124.29" }, releases: releases.map((r) => ({ ...r, revoked: null })) };
    expect(releaseColumnNote(old)).toBe("chant 0.124.28 does not say which releases are revoked; chant 0.124.29 and newer does.");
    expect(laneView(old, NOW).releases.note).toBe(releaseColumnNote(old));
    // An answer from before #692 has no column at all.
    expect(laneView(answer, NOW).releases).toBeNull();
    expect(laneView({ ...column, releases: [] }, NOW).releases.empty).toBe("no release cut yet");
  });

  it("draws the column between the trunk's commits and the environments' gates", () => {
    const make = (tag) => {
      const el = { tag, children: [], dataset: {}, className: "", textContent: "", title: "", listeners: {} };
      Object.defineProperty(el, "childNodes", { get: () => el.children });
      el.appendChild = (c) => (el.children.push(c), c);
      el.append = (...cs) => cs.forEach((c) => el.children.push(c));
      el.replaceChildren = () => (el.children = []);
      el.addEventListener = (k, f) => (el.listeners[k] = f);
      return el;
    };
    const saved = globalThis.document;
    globalThis.document = { createElement: make, createTextNode: (t) => ({ tag: "#text", textContent: t, children: [] }) };
    try {
      const host = make("div");
      renderTrunkLane(host, column, NOW, {});
      const heads = host.children.filter((c) => c.tag === "h3").map((c) => c.textContent);
      expect(heads).toEqual(["trunk", "releases", "staging", "prod"]);
      const rows = host.children.filter((c) => c.className === "lane-release");
      expect(rows.map((r) => r.dataset.release)).toEqual([R3, R2, R1]);
      const text = (el) => (el.textContent || "") + el.children.map(text).join("");
      expect(text(rows[1])).toBe("v2 · web · cut from a14610e · config-onlycut by github:alice 2d ago · unsignedruns in staging · waits in prod");
      expect(text(rows[0])).toContain(`roll back: ${ROLLBACK}`);
      expect(host.children.findIndex((c) => c.className === "lane-release")).toBeGreaterThan(host.children.findIndex((c) => c.className === "lane-commit"));
      expect(host.children.find((c) => c.className === "lane-superseded").textContent).toBe("web/release/promote superseded: release v3 is revoked (test failed)");
    } finally {
      globalThis.document = saved;
    }
  });
});
