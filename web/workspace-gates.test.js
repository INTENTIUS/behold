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
  it("sends a signed gate to the command line when behold holds no key", () => {
    const { cards } = gateCards({ ...answer, gates: [{ ...answer.gates[0], signed: true, approve: "chant approve ship approve-ship --sign" }] });
    expect(cards[0].button).toBeUndefined();
    expect(cards[0].note).toBe("needs a signed approval, and behold has no key for alex. Run chant approve ship approve-ship --sign");
  });
});

describe("who the approval is recorded as (#690)", () => {
  const as = (identity) => ({ ...answer, approver: identity.principal, approverIdentity: identity });
  const alice = { principal: "github:alice", source: "configured", forge: true, signs: false };
  it("names the person on the button, and where the name came from in its title", () => {
    const { cards } = gateCards(as(alice));
    expect(cards[0].button).toEqual({ label: "Approve as github:alice", title: "behold runs chant approve ship approve-ship. chant records github:alice, set when behold started." });
    const signedIn = gateCards(as({ ...alice, source: "header" })).cards[0];
    expect(signedIn.button.title).toMatch(/github:alice, from your sign-in\.$/);
  });
  it("offers a signed gate when behold holds the person's key", () => {
    const { cards } = gateCards({ ...as({ ...alice, signs: true }), gates: [{ ...answer.gates[0], signed: true, approve: "chant approve ship approve-ship --sign" }] });
    expect(cards[0].button.label).toBe("Approve as github:alice, signed");
    expect(cards[0].button.title).toBe("behold runs chant approve ship approve-ship --sign with github:alice's key. chant records github:alice, set when behold started.");
  });
  it("draws no button when behold can't tell who is asking", () => {
    const { cards } = gateCards({ ...answer, approver: null, approverRefusal: { error: "behold reads who you are from the x-forwarded-user header, and this request has none", code: "no-identity" } });
    expect(cards[0].button).toBeUndefined();
    expect(cards[0].note).toBe("can't approve here: behold reads who you are from the x-forwarded-user header, and this request has none. Run chant approve ship approve-ship");
  });
});
