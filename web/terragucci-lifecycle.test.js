import { describe, it, expect } from "vitest";
import { holderWords, laneActionCards, laneGateCards, laneLegend, laneLockRows, sourceWords } from "./terragucci-lifecycle.js";

const NOW = new Date("2026-10-09T12:00:00Z");
const source = { branch: "chant/lifecycle", commit: "1a2b3c4d5e6f7a8b", committed: "2026-10-09T10:00:00Z", path: "_gates/tf-apply.jsonl" };
const D = `jcs1-sha256:${"2".repeat(64)}`;
const lane = (over = {}) => ({
  branch: "chant/lifecycle",
  found: true,
  via: "fetch",
  fetch: { ok: true },
  commit: { sha: "1a2b3c4d5e6f7a8b", committed: "2026-10-09T10:00:00Z" },
  read: { at: "2026-10-09T11:59:00Z" },
  gates: [
    { gate: "wave-1", wave: 1, state: "approved", digest: D, approval: { by: "alice", at: "2026-10-09T09:00:00Z", signed: true }, records: [], source },
    { gate: "wave-2", wave: 2, state: "waiting", digest: D, pending: { timestamp: "2026-10-09T10:00:00Z", expiresAt: "2099-01-01T00:00:00Z" }, records: [], command: `npx terragucci approve wave-2 --plan ${D}`, source },
  ],
  locks: [{ root: "envs/prod/orders", pr: 12, by: "carol", at: "2026-10-09T07:00:00Z", head: "abc123", source: { ...source, path: "_locks/tf-apply.json" } }],
  note: "chant/lifecycle as fetched",
  ...over,
});

describe("the chant/lifecycle lane, dated (#505)", () => {
  it("names the commit an entry came from and its age", () => {
    expect(sourceWords(source, NOW)).toBe("chant/lifecycle 1a2b3c4d5e6f, committed 10:00 UTC, 2h ago");
  });

  it("says when behold last read the branch, and how", () => {
    expect(laneLegend(lane(), NOW).text).toBe("chant/lifecycle at 1a2b3c4d5e6f, committed 2h ago · read 1m ago, fetched from origin");
    const stale = laneLegend(lane({ via: "checkout-ref", fetch: { ok: false, error: "Could not resolve host" } }), NOW);
    expect(stale.text).toContain("the checkout's origin/chant/lifecycle");
    expect(stale.title).toContain("Could not resolve host");
    expect(stale.tone).toBe("stale");
    // A later poll moves "read" forward without a new lane read.
    expect(laneLegend(lane({ read: { at: "2026-10-09T10:00:00Z" } }), NOW, { at: "2026-10-09T11:59:30Z" }).text).toContain("read just now");
  });

  it("says no branch is no branch, and an unreadable one is unknown", () => {
    expect(laneLegend(lane({ found: false, gates: [], locks: [] }), NOW).text).toMatch(/^no chant\/lifecycle branch yet/);
    expect(laneLegend(lane({ found: false, via: "none" }), NOW).text).toMatch(/^chant\/lifecycle unknown/);
    expect(laneGateCards(lane({ found: false }), NOW)).toEqual([]);
  });

  it("words each gate with its state, its source and, when it waits, the line to run", () => {
    const [one, two] = laneGateCards(lane(), NOW);
    expect(one.title).toBe("wave 1 approved by alice, not applied yet");
    expect(one.facts).toContain("approved by alice (signed) 09:00 UTC, 3h ago");
    expect(one.command).toBeUndefined();
    expect(two.title).toBe("wave 2 waits for an approval");
    expect(two.command).toBe(`npx terragucci approve wave-2 --plan ${D}`);
    expect(two.source).toBe("chant/lifecycle 1a2b3c4d5e6f, committed 10:00 UTC, 2h ago");
    expect(two.tone).toBe("wave");
  });

  it("shows the mode a wave asked under, and says when it was read at base instead (chant#3861)", () => {
    const [one, two] = lane().gates;
    const g = lane({
      approval: { mode: "ledger", source: "the default", inferred: "a wave whose pending fact records no approval mode ..." },
      gates: [{ ...one, approvalMode: { mode: "sealed", from: "pending" } }, { ...two, approvalMode: { mode: "ledger", from: "base" } }],
    });
    const [a, b] = laneGateCards(g, NOW);
    expect(a.facts).toContain("asked under sealed");
    expect(b.facts).toContain("approval mode ledger, read at base: its request records none");
    expect(laneLegend(g, NOW).text).toContain("approval mode ledger at base, for the waves whose requests record none");
    expect(laneLegend(lane({ approval: { mode: "ledger", source: "the default" } }), NOW).text).not.toContain("approval mode");
  });

  it("names an identity.gates gate's class without a caveat, and a hold by its fact (chant#3862, chant#3839)", () => {
    const [one] = lane().gates;
    const held = { ...one, state: "held", approval: undefined, heldOn: { op: "tf-migrate", gate: "move-db", since: "2026-10-09T10:00:00Z", description: "migrate the orders table first" }, identity: { class: "human" } };
    const [c] = laneGateCards(lane({ gates: [held] }), NOW);
    expect(c.facts).toContain("only a signed approval counts, from class human");
    expect(c.facts).not.toContain("chant#3862");
    expect(c.facts).toContain("held 10:00 UTC, 2h ago; tf-migrate/move-db waits");
    expect(c.facts).toContain("migrate the orders table first");
    expect(c.title).toBe("wave 1 held on tf-migrate/move-db");
  });

  it("names the hook that holds a wave from the fact's heldBy, before its description (chant#3886)", () => {
    const [one] = lane().gates;
    const heldOn = { op: "tf-migrate", gate: "move-db", since: "2026-10-09T10:00:00Z", heldBy: { hook: "migrate", moment: "after-plan", target: "vpc" }, description: "migrate the orders table first" };
    const [c] = laneGateCards(lane({ gates: [{ ...one, state: "held", approval: undefined, heldOn }] }), NOW);
    expect(c.title).toBe("wave 1 held on tf-migrate/move-db by hook migrate");
    expect(c.facts).toContain("held by hook migrate at after-plan for vpc");
    expect(c.facts).not.toContain("migrate the orders table first");
    expect(holderWords({ ...heldOn, heldBy: { hook: "migrate", moment: "after-plan" } })).toBe("held by hook migrate at after-plan");
    expect(holderWords({ ...heldOn, heldBy: undefined })).toBe("migrate the orders table first");
  });

  it("words a lock with its holder, its age and its source", () => {
    const [l] = laneLockRows(lane(), NOW);
    expect(l.text).toBe("locked by PR #12 (carol, by an apply) 07:00 UTC, 5h ago");
    expect(l.title).toContain("chant/lifecycle 1a2b3c4d5e6f");
  });
});

describe("a day-2 action's gate card (behold#1037)", () => {
  const DA = `sha256:${"a".repeat(64)}`;
  const base = { op: "tf-action", gate: "apps/orders:module.app.action.aws_lambda_invoke.rotate", root: "apps/orders", address: "module.app.action.aws_lambda_invoke.rotate", name: "rotate", requester: "lee", digest: DA, approvalMode: { mode: "ledger", from: "base" }, source: { ...source, path: "_gates/tf-action.jsonl" } };
  const waiting = { ...base, state: "waiting", pending: { timestamp: "2026-10-09T10:00:00Z", expiresAt: "2099-01-01T00:00:00Z", url: "https://github.com/acme/shop/actions/runs/401" }, command: `npx terragucci approve action apps/orders --plan ${DA}`, uncounted: [{ approval: { by: "lee", at: "2026-10-09T10:30:00Z", signed: false }, reason: "the requester's own approval never counts" }] };
  const applied = { ...base, gate: "apps/search:module.app.action.aws_lambda_invoke.rotate", root: "apps/search", state: "applied", approval: { by: "dana", at: "2026-10-09T11:00:00Z", signed: false }, applied: { at: "2026-10-09T11:05:00Z", approvedAt: "2026-10-09T11:00:00Z", approvedBy: "dana", result: "ok", finished: "2026-10-09T11:06:00Z", exit: 0 } };

  it("shows the digest, the waiting state and the approve line for a second person, with no button but Copy", () => {
    const [c] = laneActionCards(lane({ actions: [waiting, applied] }), NOW, { root: "apps/orders" });
    expect(c.title).toBe("rotate on apps/orders waits for an approval by someone other than lee");
    expect(c.tone).toBe("wave");
    expect(c.command).toBe(`npx terragucci approve action apps/orders --plan ${DA}`);
    expect(c.note).toContain("a person other than the one who asked");
    expect(c.facts).toContain(`plan ${"a".repeat(12)}`);
    expect(c.uncounted).toEqual(["lee's approval of this plan does not count: the requester's own approval never counts"]);
    expect(c.job).toBe("https://github.com/acme/shop/actions/runs/401");
  });

  it("shows a finished run's ok, and nothing for a lane without actions", () => {
    const cards = laneActionCards(lane({ actions: [waiting, applied] }), NOW);
    expect(cards.map((c) => c.root)).toEqual(["apps/orders", "apps/search"]);
    expect(cards[1]).toMatchObject({ title: "rotate on apps/search ran: ok", tone: "ok" });
    expect(cards[1].command).toBeUndefined();
    expect(cards[1].facts).toContain("ran 11:06 UTC, 54m ago, exit 0");
    expect(laneActionCards(lane(), NOW)).toEqual([]);
    expect(laneActionCards(lane({ found: false, actions: [waiting] }), NOW)).toEqual([]);
  });
});
