import { describe, it, expect } from "vitest";
import { laneGateCards, laneLegend, laneLockRows, sourceWords } from "./terragucci-lifecycle.js";

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

  it("words a lock with its holder, its age and its source", () => {
    const [l] = laneLockRows(lane(), NOW);
    expect(l.text).toBe("locked by PR #12 (carol, by an apply) 07:00 UTC, 5h ago");
    expect(l.title).toContain("chant/lifecycle 1a2b3c4d5e6f");
  });
});
