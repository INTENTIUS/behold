import { describe, expect, it } from "vitest";
import { HOST_ANSWERS, placePoints, pointLines, STANDALONE_ANSWERS, whoAnswers } from "./decision-points.js";
import { gateCards, HOST_APPROVES } from "./workspace-gates.js";

const GATE_Q = "staging-apply-ec72c7930446";
const LOOSE_Q = "launch-tier-1f278d6a8207";
const command = (id) => `chant workspace points answer ${id} --answer <value> --by <name>`;

// What /api/workspace/points answers for src/__fixtures__/decision-points/.
const points = {
  workspace: true,
  points: [
    { id: LOOSE_Q, point: "launch-tier", title: "Which tier the launch goes out on", question: "Pick the tier the launch goes out on.", questionType: "choice", candidates: ["small", "large"], subject: "L-7", gate: null, state: "escalated", quorum: { count: 1, roles: [] }, model: null, askedOn: "2026-10-20", askedBy: null, stale: false, path: `answers/${LOOSE_Q}.md`, command: command(LOOSE_Q) },
    { id: GATE_Q, point: "staging-apply", title: "Apply this plan to staging", question: "Should this plan be applied to staging?", questionType: "noul", candidates: [true, false], subject: "gate:deploy/approve-apply@staging", gate: { op: "deploy", gate: "approve-apply", env: "staging" }, state: "escalated", quorum: { count: 2, roles: ["maintainer"] }, model: null, askedOn: "2026-10-20", askedBy: null, stale: false, path: `answers/${GATE_Q}.md`, command: command(GATE_Q) },
  ],
};

const gates = {
  workspace: true,
  env: "staging",
  approver: "alex",
  gates: [
    { key: "web/deploy/approve-apply", member: "web", op: "deploy", gate: "approve-apply", env: "staging", planDigest: null, approvals: [], needed: 1, signed: false, approve: command(GATE_Q), answer: { point: "staging-apply", id: GATE_Q, path: `answers/${GATE_Q}.md` } },
    { key: "api/ship/go", member: "api", op: "ship", gate: "go", env: "staging", planDigest: null, approvals: [], needed: 1, signed: false, approve: "chant approve ship go --env staging" },
  ],
};

describe("pointLines (#472)", () => {
  it("says the question, who may answer, and gives chant's line standalone", () => {
    const l = pointLines(points.points[1]);
    expect(l).toMatchObject({ title: "decision point staging-apply: Apply this plan to staging", question: "Should this plan be applied to staging?", note: STANDALONE_ANSWERS, command: command(GATE_Q), showCommand: true });
    expect(l.facts).toBe("answers: yes, no · 2 people holding maintainer may answer · asked 2026-10-20");
  });
  it("sends a framed reader to the host's rail", () => {
    expect(pointLines(points.points[1], { embed: true })).toMatchObject({ note: HOST_ANSWERS, showCommand: false });
  });
  it("names a model's proposal waiting for a person", () => {
    const l = pointLines({ ...points.points[0], state: "proposed", model: { answer: "large", confidence: 0.91, threshold: 0.8, model: "m" } });
    expect(l.facts).toContain("a model proposes large (91%), waiting for a person to confirm it");
  });
  it("counts who may answer", () => {
    expect(whoAnswers({ count: 1, roles: [] })).toBe("1 person");
    expect(whoAnswers({ count: 3, roles: ["sre", "owner"] })).toBe("3 people holding sre or owner");
  });
});

describe("placePoints (#472)", () => {
  it("puts a question on the gate whose answer names it, and the rest on their own", () => {
    const { byGate, loose } = placePoints(points.points, gates.gates);
    expect([...byGate.keys()]).toEqual(["web/deploy/approve-apply"]);
    expect(byGate.get("web/deploy/approve-apply").map((p) => p.id)).toEqual([GATE_Q]);
    expect(loose.map((p) => p.id)).toEqual([LOOSE_Q]);
  });
  it("puts every question on its own when no gate names one", () => {
    expect(placePoints(points.points, []).loose).toHaveLength(2);
  });
});

describe("gate cards with decision points (#472)", () => {
  it("draws the question on its gate, no approve button, and the loose question after the gates", () => {
    const { cards } = gateCards(gates, { points });
    const [asks, plain, loose] = cards;
    expect(asks).toMatchObject({ key: "web/deploy/approve-apply", title: "web: deploy waits at gate approve-apply on decision point staging-apply", facts: "env staging" });
    expect(asks.button).toBeUndefined();
    expect(asks.note).toContain("which behold doesn't answer");
    expect(asks.points.map((p) => p.id)).toEqual([GATE_Q]);
    expect(plain.button).toMatchObject({ label: "Approve as alex" });
    expect(plain.points).toBeUndefined();
    expect(loose).toMatchObject({ key: `point/${LOOSE_Q}`, point: true, title: "decision point launch-tier: Which tier the launch goes out on", command: command(LOOSE_Q) });
  });
  it("framed, sends the point's gate to the rail and keeps the plain gate's note", () => {
    const { cards } = gateCards(gates, { embed: true, points });
    expect(cards[0].note).toBe(HOST_ANSWERS);
    expect(cards[1].note).toBe(HOST_APPROVES);
    expect(cards.some((c) => c.button)).toBe(false);
    expect(cards[0].points[0].showCommand).toBe(false);
  });
  it("names the gate a loose question was asked by when that gate waits elsewhere", () => {
    const { cards } = gateCards({ ...gates, gates: [gates.gates[1]] }, { points });
    expect(cards.find((c) => c.key === `point/${GATE_Q}`).title).toBe("decision point staging-apply: Apply this plan to staging (asked by gate deploy/approve-apply in staging)");
  });
  it("passes the points refusal through, and draws the gates as before without a points answer", () => {
    const refusal = { error: "Decision points needs chant 0.107.0 or newer.", code: "chant-too-old" };
    expect(gateCards(gates, { points: { workspace: true, points: [], refusal } }).pointsRefusal).toEqual(refusal);
    expect(gateCards(gates).cards).toHaveLength(2);
  });
});
