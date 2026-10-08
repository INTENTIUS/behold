import { describe, expect, it } from "vitest";
import { approveArgs, gateKey, isEnvName, localApprover, parseWorkspaceStatus, STATUS_SCHEMA_ID } from "./workspace-gates.ts";

// The shape `chant workspace status local --json` wrote (chant 0.87.0) for a
// workspace whose delivery member has one gate waiting and one approved; the
// same document arugula's block tests against (fixtures/reference-raw.json).
const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    $schema: STATUS_SCHEMA_ID,
    contract: 1,
    chant: "0.87.0",
    env: "local",
    members: [
      { name: "app", dir: "app", kind: "other", gates: [] },
      {
        name: "delivery",
        dir: "delivery",
        kind: "chant",
        gates: [
          { approvals: [], approve: "chant approve release approve-release", component: "release", env: null, expiresAt: "2026-10-03T21:09:51.548Z", name: "approve-release", needed: 1, planDigest: null, recordedAt: "2026-10-02T21:09:51.548Z", state: "pending" },
          { approvals: [{ at: "2026-10-02T21:07:29.897Z", channel: "cli", principal: "jake" }], approve: "chant approve ship approve-ship", component: "ship", env: null, name: "approve-ship", needed: 1, planDigest: null, state: "approved" },
          { approvals: [], component: "deploy", env: "prod", name: "go", needed: 2, planDigest: "sha256:abc", state: "pending", signed: { class: "release" } },
          { approvals: [], approve: "chant approve tag t --sign", component: "tag", env: null, name: "t", needed: 1, planDigest: null, state: "pending", signed: { class: "release" } },
        ],
      },
    ],
    ...over,
  });

describe("parseWorkspaceStatus (#477)", () => {
  it("keeps the waiting gates, keyed member/op/gate as arugula keys them", () => {
    const read = parseWorkspaceStatus(doc(), "/ws");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.env).toBe("local");
    expect(read.gates.map((g) => g.key)).toEqual(["delivery/release/approve-release", "delivery/deploy/go", "delivery/tag/t"]);
    const [release, deploy, tag] = read.gates;
    // status's own line is taken as given: --sign once.
    expect(tag.approve).toBe("chant approve tag t --sign");
    expect(release).toMatchObject({ member: "delivery", dir: "/ws/delivery", op: "release", gate: "approve-release", needed: 1, signed: false, approve: "chant approve release approve-release" });
    // No line from status: built from the gate, the way arugula builds it.
    expect(deploy).toMatchObject({ env: "prod", planDigest: "sha256:abc", needed: 2, signed: true, approve: "chant approve deploy go --env prod --plan sha256:abc --sign" });
  });
  it("refuses any other contract", () => {
    const read = parseWorkspaceStatus(doc({ contract: 2 }), "/ws");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("workspace-contract");
  });
  it("refuses a document chant wrote as an error", () => {
    const read = parseWorkspaceStatus(JSON.stringify({ contract: 1, error: { code: "declaration-missing", message: "no file" } }), "/ws");
    expect(read.ok).toBe(false);
  });
  it("refuses something that isn't JSON", () => {
    expect(parseWorkspaceStatus("nope", "/ws").ok).toBe(false);
  });
});

describe("isEnvName (#477)", () => {
  it("takes env names and refuses anything chant would read as a flag", () => {
    expect(["local", "prod", "eu-west.1"].every(isEnvName)).toBe(true);
    expect(["-x", "--help", "a b", ""].some(isEnvName)).toBe(false);
  });
});

describe("approve helpers (#477)", () => {
  it("builds chant approve with env and plan only when the gate has them", () => {
    expect(approveArgs({ op: "ship", gate: "g", env: null, planDigest: null })).toEqual(["approve", "ship", "g"]);
    expect(approveArgs({ op: "ship", gate: "g", env: "prod", planDigest: "p" })).toEqual(["approve", "ship", "g", "--env", "prod", "--plan", "p"]);
    expect(gateKey("m", "o", "g")).toBe("m/o/g");
  });
  it("names the approver the way chant falls back to one", () => {
    expect(localApprover({ USER: "alex" })).toBe("alex");
    expect(localApprover({ USER: "alex", GITHUB_ACTOR: "lex00" })).toBe("lex00");
    expect(localApprover({})).toBe("unknown");
  });
});
