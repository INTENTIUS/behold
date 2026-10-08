import { describe, expect, it } from "vitest";
import { gateCards, HOST_APPROVES } from "./workspace-gates.js";

const answer = {
  workspace: true,
  env: "local",
  approver: "alex",
  gates: [
    { key: "delivery/ship/approve-ship", member: "delivery", op: "ship", gate: "approve-ship", env: null, planDigest: null, approvals: [], needed: 1, signed: false, approve: "chant approve ship approve-ship" },
    { key: "infra/deploy/go", member: "infra", op: "deploy", gate: "go", env: "prod", planDigest: "sha256:0123456789abcdef", approvals: [{ principal: "jake" }], needed: 2, signed: false, approve: "chant approve deploy go --env prod" },
  ],
};

describe("gateCards (#477)", () => {
  it("offers approve standalone, and says who chant records", () => {
    const { cards } = gateCards(answer);
    expect(cards[0]).toMatchObject({ title: "delivery: ship waits at gate approve-ship", facts: "0 of 1 approval", button: { label: "Approve as alex" } });
    expect(cards[1].facts).toBe("1 of 2 approvals · env prod · plan 0123456789ab · approved by jake");
  });
  it("draws the gate and no button when framed", () => {
    const { cards } = gateCards(answer, { embed: true });
    expect(cards.every((c) => !c.button && c.note === HOST_APPROVES)).toBe(true);
  });
  it("narrows to one member and counts the rest", () => {
    const { cards, elsewhere } = gateCards(answer, { embed: true, member: "delivery" });
    expect(cards.map((c) => c.key)).toEqual(["delivery/ship/approve-ship"]);
    expect(elsewhere).toBe(1);
  });
  it("sends a signed gate to the command line", () => {
    const { cards } = gateCards({ ...answer, gates: [{ ...answer.gates[0], signed: true, approve: "chant approve ship approve-ship --sign" }] });
    expect(cards[0].button).toBeUndefined();
    expect(cards[0].note).toBe("wants a signed approval; run chant approve ship approve-ship --sign");
  });
});
