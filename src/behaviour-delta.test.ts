import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import type { GraphOptions } from "./chant.ts";
import type { BehaviourMeta } from "./behaviour.ts";
import { resetMemberIrCache } from "./member-ir.ts";
import { invalidateOverlay, resetOverlayCache } from "./overlay-ir.ts";
import {
  attachBehaviourDelta,
  attachDeclaredBehaviour,
  DECLARED_ATTR,
  paintLive,
  predictMember,
  reportFromIr,
  trafficFor,
  type PredictedReport,
} from "./behaviour-delta.ts";

/**
 * Live versus declared (#402). The figures here are written, not predicted:
 * `engine: "behold-fixture"` says so on every block, as src/behaviour.test.ts's
 * do. What is under test is which read is asked for what, what is cached, and
 * one subtraction.
 */

const TRAFFIC = "100 rps, p50";

const block = (perHour: number, currency = "USD") => ({
  at: { traffic: TRAFFIC },
  cost: { rate: "per-hour", perHour, currency },
  headroom: { cpu: 0.5 },
  errorRate: 0,
  resilience: { failure: "one zone lost", verdict: "survives" },
  provenance: { engine: "behold-fixture", version: "0", tolerance: "fixture", basis: "modeled" },
});

const meta = (total?: number, currency = "USD") => ({
  engine: "behold-fixture",
  version: "0",
  at: { traffic: TRAFFIC },
  ...(total === undefined ? {} : { total: { rate: "per-hour", perHour: total, currency } }),
});

const report = (entities: Record<string, number>, total?: number): PredictedReport => ({
  meta: meta(total),
  entities: Object.fromEntries(Object.entries(entities).map(([address, perHour]) => [address, block(perHour)])),
});

const irOf = (...ids: string[]) => ({ nodes: ids.map((id) => ({ id, attrs: {} as Record<string, unknown> })) });

describe("trafficFor", () => {
  const query = (s: string) => new URLSearchParams(s);

  it("is the request's level over the config's, and the config's over nothing", () => {
    expect(trafficFor(query("traffic=500%20rps"), { behaviour: { traffic: TRAFFIC } })).toBe("500 rps");
    expect(trafficFor(query(""), { behaviour: { traffic: TRAFFIC } })).toBe(TRAFFIC);
  });

  it("is nothing when neither names one, and a blank one names nothing", () => {
    expect(trafficFor(query(""), {})).toBeUndefined();
    expect(trafficFor(query("traffic=%20%20"), {})).toBeUndefined();
    expect(trafficFor(query("traffic="), { behaviour: { traffic: TRAFFIC } })).toBe(TRAFFIC);
  });
});

describe("reportFromIr", () => {
  it("lifts the meta and every block, with the reader project's root taken off the id", () => {
    const ir = {
      meta: { _behaviour: meta(0.01) },
      nodes: [
        { id: "monolith/aws_sns_topic.jobs", attrs: { _behaviour: block(0.01) } },
        { id: "monolith/aws_iam_role.team_a", attrs: {} },
      ],
    };
    expect(reportFromIr(ir, "monolith/")).toEqual({ meta: meta(0.01), entities: { "aws_sns_topic.jobs": block(0.01) } });
    expect(Object.keys(reportFromIr(ir)!.entities)).toEqual(["monolith/aws_sns_topic.jobs"]);
  });

  it("is undefined for a read that carries neither, which is chant not having looked", () => {
    expect(reportFromIr({ nodes: [{ id: "a", attrs: { _status: "good" } }] })).toBeUndefined();
  });

  it("keeps a refusal, which has a meta and no block", () => {
    const refusal = { behaviour: "v1", refusal: { cause: "no-engine", reason: "no engine", remedy: "set one" } };
    expect(reportFromIr({ meta: { _behaviour: refusal }, nodes: [] })).toEqual({ meta: refusal, entities: {} });
  });
});

describe("attachBehaviourDelta", () => {
  /** An overlay the live pass has already been over: a block on what the
   * account holds, none on the topic somebody deleted. */
  function drifted() {
    const ir = irOf("monolith/aws_sns_topic.jobs", "monolith/aws_sns_topic.events", "monolith/aws_iam_role.team_a");
    ir.nodes[0].attrs._behaviour = block(0.005);
    return ir;
  }

  it("carries both figures and live minus declared, per member and for the estate", () => {
    const ir = drifted();
    const out = attachBehaviourDelta(
      ir,
      [{ name: "monolith", liveMeta: meta(0.005), prediction: { declared: report({ "aws_sns_topic.jobs": 0.005, "aws_sns_topic.events": 0.005 }, 0.01) } }],
      { engine: "behold-fixture", version: "0", at: { traffic: TRAFFIC } },
    );
    expect(out.live).toEqual({ perHour: 0.005, currency: "USD", basis: "total" });
    expect(out.declared).toEqual({ perHour: 0.01, currency: "USD", basis: "total" });
    expect(out.delta).toEqual({ perHour: -0.005, currency: "USD" });
    expect(out.members).toEqual({ monolith: { live: out.live, declared: out.declared, delta: out.delta } });
  });

  it("puts the declared block on the node the account no longer holds", () => {
    const ir = drifted();
    attachBehaviourDelta(ir, [{ name: "monolith", liveMeta: meta(0.005), prediction: { declared: report({ "aws_sns_topic.jobs": 0.005, "aws_sns_topic.events": 0.005 }, 0.01) } }], {});
    const events = ir.nodes[1].attrs;
    expect(events._behaviour).toBeUndefined();
    expect((events[DECLARED_ATTR] as { cost: { perHour: number } }).cost.perHour).toBe(0.005);
  });

  it("adds the members for the estate, and says the result is a sum", () => {
    const ir = irOf("a/x", "b/y");
    ir.nodes[0].attrs._behaviour = block(0.02);
    ir.nodes[1].attrs._behaviour = block(0.03);
    const out = attachBehaviourDelta(
      ir,
      [
        { name: "a", liveMeta: meta(0.02), prediction: { declared: report({ x: 0.02 }, 0.02) } },
        { name: "b", liveMeta: meta(0.03), prediction: { declared: report({ y: 0.04 }, 0.04) } },
      ],
      { total: { perHour: 0.02, currency: "USD" }, diagnostics: ["two members stated an estate total; the first is shown"] },
    );
    expect(out.live).toEqual({ perHour: 0.05, currency: "USD", basis: "sum" });
    expect(out.declared).toEqual({ perHour: 0.06, currency: "USD", basis: "sum" });
    expect(out.delta).toEqual({ perHour: -0.01, currency: "USD" });
    // One member's total labelled as the estate's goes, with the line about it.
    expect(out.total).toBeUndefined();
    expect(out.diagnostics).toBeUndefined();
  });

  it("gives no delta across currencies, or between an engine's total and behold's sum, and says which", () => {
    const ir = irOf("a/x");
    ir.nodes[0].attrs._behaviour = block(0.02);
    const mixed = attachBehaviourDelta(ir, [{ name: "a", liveMeta: meta(0.02), prediction: { declared: { meta: meta(0.02, "EUR"), entities: {} } } }], {});
    expect(mixed.delta).toBeUndefined();
    expect(mixed.diagnostics?.join()).toContain("USD and the declared one in EUR");

    const kinds = attachBehaviourDelta(ir, [{ name: "a", liveMeta: meta(), prediction: { declared: report({ x: 0.02 }, 0.02) } }], {});
    expect(kinds.members?.a.live?.basis).toBe("sum");
    expect(kinds.members?.a.declared?.basis).toBe("total");
    expect(kinds.delta).toBeUndefined();
    expect(kinds.diagnostics?.join()).toContain("not the same kind of figure");
  });

  it("has no live figure under a refusal, and still carries the declared one", () => {
    // The member's own read stated a total; the estate refused all the same,
    // and a refusal leaves no live figure standing.
    const out = attachBehaviourDelta(irOf("a/x"), [{ name: "a", liveMeta: meta(0.02), prediction: { declared: report({ x: 0.02 }, 0.02) } }], {
      refusal: { reason: "no engine", remedy: "set one" },
    });
    expect(out.live).toBeUndefined();
    expect(out.declared?.perHour).toBe(0.02);
    expect(out.delta).toBeUndefined();
  });

  it("drops a malformed declared block with its reason, and a refused declared side with the engine's words", () => {
    const bad = attachBehaviourDelta(irOf("a/x"), [{ name: "a", prediction: { declared: { meta: meta(), entities: { x: { cost: {} } } } } }], {});
    expect(bad.diagnostics?.join()).toContain("dropped the declared behaviour block on a/x");
    const refused = attachBehaviourDelta(irOf("a/x"), [{ name: "a", prediction: { declared: { meta: { refusal: { reason: "engine is down", remedy: "start it" } }, entities: {} } } }], {});
    expect(refused.declared).toBeUndefined();
    expect(refused.diagnostics?.join()).toContain("engine is down");
  });

  it("names a member's missing side", () => {
    const out = attachBehaviourDelta(irOf("a/x"), [{ name: "a", prediction: { note: "live prediction unavailable: timed out" } }], {});
    expect(out.diagnostics).toEqual(["a: live prediction unavailable: timed out"]);
  });
});

describe("paintLive", () => {
  it("paints a member's live report onto its own nodes and hands back the meta", () => {
    const ir = irOf("monolith/aws_sns_topic.jobs", "team-a/aws_sns_topic.jobs");
    const notes: string[] = [];
    const got = paintLive(ir, "monolith", report({ "aws_sns_topic.jobs": 0.005, "aws_sns_topic.gone": 0.005 }, 0.01), notes);
    expect(got).toEqual(meta(0.01));
    expect(ir.nodes[0].attrs._behaviour).toEqual(block(0.005));
    expect(ir.nodes[1].attrs._behaviour).toBeUndefined();
    expect(notes).toEqual(["monolith: the live prediction prices aws_sns_topic.gone, which this overlay has no entity for"]);
  });
});

describe("attachDeclaredBehaviour", () => {
  it("paints the declared blocks as the source graph's own, with the figure", () => {
    const ir = irOf("aws_sns_topic.jobs", "aws_iam_role.team_a");
    const out = attachDeclaredBehaviour(ir, [{ prediction: { declared: report({ "aws_sns_topic.jobs": 0.005 }, 0.005) } }]);
    expect((ir.nodes[0].attrs._behaviour as { cost: { perHour: number } }).cost.perHour).toBe(0.005);
    expect(ir.nodes[1].attrs._behaviour).toBeUndefined();
    expect(out).toEqual({ engine: "behold-fixture", version: "0", at: { traffic: TRAFFIC }, declared: { perHour: 0.005, currency: "USD", basis: "total" } });
  });

  it("answers a refusal with the refusal and no block", () => {
    const ir = irOf("x");
    ir.nodes[0].attrs._behaviour = block(1);
    const out = attachDeclaredBehaviour(ir, [{ prediction: { declared: { meta: { refusal: { reason: "no engine", remedy: "set one" } }, entities: {} } } }]);
    expect(out).toEqual({ refusal: { reason: "no engine", remedy: "set one" } });
    expect(ir.nodes[0].attrs._behaviour).toBeUndefined();
  });

  it("says nothing came back when nothing did", () => {
    const out = attachDeclaredBehaviour(irOf("x"), [{ name: "a", prediction: { note: "this member's chant predates it" } }]);
    expect((out as BehaviourMeta).absent).toContain("no member's declared prediction came back");
    expect(out.diagnostics).toEqual(["a: this member's chant predates it"]);
  });
});

describe("predictMember on a choudoufu member", () => {
  let dir: string;
  let reads: GraphOptions[];
  const answer = (opts: GraphOptions): GraphIR =>
    ({
      meta: { _behaviour: meta(opts.live ? 0.005 : 0.01) },
      nodes: [{ id: `${"m"}/aws_sns_topic.jobs`, kind: "Terraform::Resource", lexicon: "terraform", attrs: { _behaviour: block(0.005) } }],
      edges: [],
      groups: {},
    }) as unknown as GraphIR;

  beforeEach(() => {
    resetMemberIrCache();
    resetOverlayCache();
    reads = [];
    dir = join(mkdtempSync(join(tmpdir(), "behold-delta-")), "m");
    mkdirSync(dir);
    writeFileSync(join(dir, "main.tf"), 'terraform {\n  live {\n    estate = "e"\n  }\n}\n\nresource "aws_sns_topic" "jobs" {\n  name = "jobs"\n}\n');
  });

  /** The optional lexicon, present: CI installs none, and these tests are
   * about the reads, not about the probe (src/terraform-member.test.ts). */
  const readerState = () => ({ lexicon: { pkg: "l", version: "0.76.0" }, parser: { pkg: "p", version: "0.21.0" }, from: "test" }) as never;
  const deps = { readerState, read: async (_project: string, opts: GraphOptions) => (reads.push(opts), answer(opts)) };
  const member = () => ({ dir, kind: "choudoufu" as const });

  it("asks chant twice, once about the account and once about the file", async () => {
    const got = await predictMember(member(), "live", TRAFFIC, deps);
    expect(reads.map((o) => [o.traffic, o.live === true, o.env]).sort()).toEqual([
      [TRAFFIC, false, undefined],
      [TRAFFIC, true, "live"],
    ]);
    // The reader project keys a block `<root>/<address>`; the member's own
    // nodes are keyed by address.
    expect(Object.keys(got.live!.entities)).toEqual(["aws_sns_topic.jobs"]);
    expect((got.live!.meta as { total: { perHour: number } }).total.perHour).toBe(0.005);
    expect((got.declared!.meta as { total: { perHour: number } }).total.perHour).toBe(0.01);
  });

  it("reads the file once while it has not moved, and again when it has", async () => {
    await predictMember(member(), "live", TRAFFIC, deps);
    invalidateOverlay(); // a re-check of the account, which is not a reason to read the file
    await predictMember(member(), "live", TRAFFIC, deps, true);
    expect(reads.filter((o) => !o.live)).toHaveLength(1);
    expect(reads.filter((o) => o.live)).toHaveLength(2);

    writeFileSync(join(dir, "more.tf"), 'resource "aws_sns_topic" "events" {\n  name = "events"\n}\n');
    await predictMember(member(), "live", TRAFFIC, deps);
    expect(reads.filter((o) => !o.live)).toHaveLength(2);
  });

  it("keys the declared read on the traffic level", async () => {
    await predictMember(member(), undefined, TRAFFIC, deps);
    await predictMember(member(), undefined, "500 rps, p99", deps);
    expect(reads.map((o) => o.traffic)).toEqual([TRAFFIC, "500 rps, p99"]);
  });

  it("has no live half with no env, which is the source graph", async () => {
    const got = await predictMember(member(), undefined, TRAFFIC, deps);
    expect(got.live).toBeUndefined();
    expect(got.declared).toBeDefined();
    expect(reads.every((o) => !o.live)).toBe(true);
  });

  it("says which side failed, and keeps the other", async () => {
    const got = await predictMember(member(), "live", TRAFFIC, {
      readerState,
      read: async (_p, opts) => {
        if (opts.live) throw new Error("Chant read exceeded 180000ms\nstack");
        return answer(opts);
      },
    });
    expect(got.live).toBeUndefined();
    expect(got.declared).toBeDefined();
    expect(got.note).toBe("live prediction unavailable: Chant read exceeded 180000ms");
  });
});

describe("predictMember without the optional lexicon", () => {
  it("predicts nothing for a choudoufu member and says what to install", async () => {
    resetMemberIrCache();
    resetOverlayCache();
    const dir = join(mkdtempSync(join(tmpdir(), "behold-delta-")), "m");
    mkdirSync(dir);
    writeFileSync(join(dir, "main.tf"), 'terraform {\n  live {\n    estate = "e"\n  }\n}\n\nresource "aws_sns_topic" "jobs" {\n  name = "jobs"\n}\n');
    const refusal = { error: "the terraform lexicon is not installed", code: "terraform-lexicon", remedy: "npm install it" };
    const got = await predictMember({ dir, kind: "choudoufu" }, "live", TRAFFIC, {
      readerState: () => ({ lexicon: { pkg: "l" }, parser: { pkg: "p" }, from: "test", refusal }) as never,
      read: async () => {
        throw new Error("chant was run with no lexicon to load");
      },
    });
    expect(got.live).toBeUndefined();
    expect(got.declared).toBeUndefined();
    expect(got.note).toContain("the terraform lexicon is not installed");
  });
});
