import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { driftDigest, driftDigestsByLexicon, changedLexicons, startDriftPoll, UNKNOWN_LEXICON } from "./poll.ts";
import type { GraphIR } from "@intentius/chant";

const ir = (nodes: Array<{ id: string; status?: string; lexicon?: string }>): GraphIR =>
  ({
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: "K",
      lexicon: n.lexicon ?? "aws",
      attrs: n.status ? { _status: n.status } : {},
    })),
    edges: [],
    groups: {},
  }) as unknown as GraphIR;

describe("driftDigest", () => {
  it("is stable regardless of node order", () => {
    const a = driftDigest(ir([{ id: "vpc", status: "good" }, { id: "sg", status: "warn" }]));
    const b = driftDigest(ir([{ id: "sg", status: "warn" }, { id: "vpc", status: "good" }]));
    expect(a).toBe(b);
  });

  it("changes when a node's drift status changes", () => {
    const before = driftDigest(ir([{ id: "vpc", status: "accent" }]));
    const after = driftDigest(ir([{ id: "vpc", status: "good" }]));
    expect(after).not.toBe(before);
  });

  it("changes when a node appears or disappears", () => {
    const one = driftDigest(ir([{ id: "vpc", status: "good" }]));
    const two = driftDigest(ir([{ id: "vpc", status: "good" }, { id: "sg", status: "warn" }]));
    expect(two).not.toBe(one);
  });
});

describe("driftDigestsByLexicon", () => {
  const mixed = ir([
    { id: "vpc", status: "good", lexicon: "aws" },
    { id: "svc", status: "accent", lexicon: "k8s" },
  ]);

  it("keeps one digest per substrate", () => {
    expect(Object.keys(driftDigestsByLexicon(mixed)).sort()).toEqual(["aws", "k8s"]);
  });

  // The whole point of #117: the estate-wide digest could not tell these apart,
  // so a drifted Service and a drifted security group were the same event.
  it("moves only the substrate that actually moved", () => {
    const after = ir([
      { id: "vpc", status: "good", lexicon: "aws" },
      { id: "svc", status: "warn", lexicon: "k8s" },
    ]);
    expect(changedLexicons(driftDigestsByLexicon(mixed), driftDigestsByLexicon(after))).toEqual(["k8s"]);
  });

  it("is stable regardless of node order", () => {
    const flipped = ir([
      { id: "svc", status: "accent", lexicon: "k8s" },
      { id: "vpc", status: "good", lexicon: "aws" },
    ]);
    expect(driftDigestsByLexicon(flipped)).toEqual(driftDigestsByLexicon(mixed));
  });

  it("buckets a node with no lexicon on its own, never onto a real substrate", () => {
    // Built directly rather than through `ir` above, whose default would supply
    // the very lexicon this asserts is absent.
    const orphan = {
      nodes: [{ id: "mystery", kind: "K", attrs: { _status: "warn" } }],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    expect(Object.keys(driftDigestsByLexicon(orphan))).toEqual([UNKNOWN_LEXICON]);
  });
});

// #297: the poll used to query only the primary member — on an 11-member estate
// 10/11 of it never fired a changed event. These pin the estate-wide sweep.
describe("startDriftPoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A member whose query returns the queued IRs in order (the last repeats). */
  const member = (dir: string, irs: GraphIR[]) => {
    let i = 0;
    return { dir, query: vi.fn(async () => irs[Math.min(i++, irs.length - 1)]) };
  };

  it("polls every member and attributes drift to the member that moved", async () => {
    const steady = member("/estate/a", [ir([{ id: "vpc", status: "good" }])]);
    const mover = member("/estate/b", [
      ir([{ id: "svc", status: "good", lexicon: "k8s" }]),
      ir([{ id: "svc", status: "warn", lexicon: "k8s" }]),
    ]);
    const onChange = vi.fn();
    const stop = startDriftPoll({ intervalMs: 1000, members: [steady, mover], onChange });

    await vi.advanceTimersByTimeAsync(1000); // first sweep: baselines only
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000); // second sweep: b moved, a did not
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("/estate/b", ["k8s"]);
    expect(steady.query).toHaveBeenCalledTimes(2); // a WAS polled, it just didn't move
    stop();
  });

  it("sweeps members sequentially — a slow read never stampedes the next member", async () => {
    let release!: (ir: GraphIR) => void;
    const slow = { dir: "/estate/a", query: vi.fn(() => new Promise<GraphIR>((res) => (release = res))) };
    const next = member("/estate/b", [ir([{ id: "svc", status: "good" }])]);
    const stop = startDriftPoll({ intervalMs: 1000, members: [slow, next], onChange: vi.fn() });

    await vi.advanceTimersByTimeAsync(1000);
    expect(slow.query).toHaveBeenCalledTimes(1);
    expect(next.query).not.toHaveBeenCalled(); // waiting on a, not describing in parallel

    release(ir([{ id: "vpc", status: "good" }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(next.query).toHaveBeenCalledTimes(1);
    stop();
  });

  it("isolates one member's failure: onError carries its dir, the sweep goes on", async () => {
    const broken = { dir: "/estate/a", query: vi.fn(async () => Promise.reject(new Error("describe timed out"))) };
    const mover = member("/estate/b", [
      ir([{ id: "svc", status: "good", lexicon: "k8s" }]),
      ir([{ id: "svc", status: "warn", lexicon: "k8s" }]),
    ]);
    const onChange = vi.fn();
    const onError = vi.fn();
    const stop = startDriftPoll({ intervalMs: 1000, members: [broken, mover], onChange, onError });

    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledWith("/estate/a", expect.any(Error));
    expect(onChange).toHaveBeenCalledWith("/estate/b", ["k8s"]); // b still swept and fired
    stop();
  });

  it("a member that fails then recovers unchanged does not fake drift", async () => {
    const same = ir([{ id: "vpc", status: "good" }]);
    let calls = 0;
    const flaky = {
      dir: "/estate/a",
      query: vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error("blip");
        return same;
      }),
    };
    const onChange = vi.fn();
    const stop = startDriftPoll({ intervalMs: 1000, members: [flaky], onChange, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(3000); // baseline, blip, recovery
    expect(flaky.query).toHaveBeenCalledTimes(3);
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it("stop cancels future sweeps", async () => {
    const m = member("/estate/a", [ir([{ id: "vpc", status: "good" }])]);
    const stop = startDriftPoll({ intervalMs: 1000, members: [m], onChange: vi.fn() });
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.query).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(m.query).toHaveBeenCalledTimes(1);
  });
});

describe("changedLexicons", () => {
  it("reports nothing when the estate is unchanged", () => {
    expect(changedLexicons({ aws: "a", k8s: "b" }, { aws: "a", k8s: "b" })).toEqual([]);
  });

  it("reports a substrate whose first node appeared", () => {
    expect(changedLexicons({ aws: "a" }, { aws: "a", k8s: "b" })).toEqual(["k8s"]);
  });

  it("reports a substrate that vanished entirely", () => {
    expect(changedLexicons({ aws: "a", k8s: "b" }, { aws: "a" })).toEqual(["k8s"]);
  });

  it("is sorted, so routing and logs are deterministic", () => {
    expect(changedLexicons({}, { k8s: "b", azure: "c", aws: "a" })).toEqual(["aws", "azure", "k8s"]);
  });
});
