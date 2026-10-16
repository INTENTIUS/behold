import { describe, expect, it } from "vitest";
import { OPEN_DEPTH, TRACE_POLL_MS, criticalPath, foldState, msWords, runStrip, spanWords, stripTone, traceSource, traceUrl, waterfallRows } from "./kiosk-trace.js";

const T = 1_792_166_000_000;
const sp = (id, parent, name, from, to, attrs = {}, service = "terragucci") => ({ id, parent, name, service, start: T + from, ms: to - from, attrs });

/** A wave's job: two roots planning at once (b ends last), a gate held, then the applies one after the other. */
const SPANS = [
  sp("s", null, "terragucci tf-apply", 0, 1000, { "terragucci.stage": "tf-apply", "terragucci.wave": 1, "terragucci.result": "applied" }),
  sp("p", "s", "plan", 100, 400, { "terragucci.phase": "plan" }),
  sp("ra", "p", "root a", 110, 300, { "terragucci.root": "a" }),
  sp("rb", "p", "root b", 110, 390, { "terragucci.root": "b" }),
  sp("pb", "rb", "tofu plan", 120, 380),
  sp("ob", "pb", "tofu", 130, 370, {}, "OpenTofu CLI"),
  sp("rib", "ob", "Plan resource instance changes", 200, 300, { "opentofu.resource_instance.address": "terraform_data.release" }, "OpenTofu CLI"),
  sp("g", "s", "gate", 400, 800, { "terragucci.phase": "gate", "terragucci.gate.status": "approved", "terragucci.gate.held_seconds": 40 }),
  sp("a", "s", "apply", 800, 950, { "terragucci.phase": "apply" }),
  sp("aa", "a", "root a", 800, 860, { "terragucci.root": "a" }),
  sp("ab", "a", "root b", 860, 950, { "terragucci.root": "b" }),
];

describe("the trace view's reads", () => {
  it("names a run by its repo and id, or by a commit, and nothing else", () => {
    expect(traceUrl({ repo: "terragucci-admin/demo", run: 4184 })).toBe("/api/traces?project=terragucci-admin%2Fdemo&run=4184");
    expect(traceUrl({ repo: "terragucci-admin/demo", run: null, commit: "abc1234" })).toBe("/api/traces?project=terragucci-admin%2Fdemo&commit=abc1234");
    expect(traceUrl({ repo: null, run: 4184 })).toBeNull();
    expect(traceUrl({ repo: "terragucci-admin/demo", run: "1 or 2" })).toBeNull();
  });

  it("reads a run once per poll, shared by its jobs, and says when it lands", async () => {
    let t = 0;
    const asked = [];
    let changed = 0;
    const answer = { traces: [{ job: "apply-wave-1", start: T, ms: 1000, spans: SPANS }], jobs: ["apply-wave-1"] };
    const src = traceSource({ fetchJson: async (u) => (asked.push(u), answer), onChange: () => changed++, now: () => t });
    expect(src.has("terragucci-admin/demo", 4184, "apply-wave-1")).toBe(false);
    expect(src.has("terragucci-admin/demo", 4184, "apply-wave-2")).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toHaveLength(1);
    expect(changed).toBe(1);
    expect(src.has("terragucci-admin/demo", 4184, "apply-wave-1")).toBe(true);
    expect(src.has("terragucci-admin/demo", 4184, "check")).toBe(false);
    t += TRACE_POLL_MS;
    src.has("terragucci-admin/demo", 4184, "apply-wave-1");
    expect(asked).toHaveLength(2);
  });

  it("keeps the last answer when a read fails", async () => {
    let t = 0;
    let fail = false;
    const src = traceSource({ fetchJson: async () => (fail ? { error: "Tempo is down" } : { traces: [{ job: "plan", start: T, ms: 1, spans: [] }], jobs: ["plan"] }), now: () => t });
    src.has("o/r", 1, "plan");
    await new Promise((r) => setTimeout(r, 0));
    fail = true;
    t += TRACE_POLL_MS;
    src.has("o/r", 1, "plan");
    await new Promise((r) => setTimeout(r, 0));
    expect(src.has("o/r", 1, "plan")).toBe(true);
  });
});

describe("the waterfall", () => {
  it("lights the critical path: the root that planned last, the gate, the applies in turn", () => {
    const on = criticalPath(SPANS);
    expect([...on].sort()).toEqual(["a", "aa", "ab", "g", "ob", "p", "pb", "rb", "rib", "s"].sort());
    expect(on.has("ra")).toBe(false);
    // A root that started first and finished first, while the other still planned, is off it too.
    const early = criticalPath([sp("p", null, "plan", 0, 100), sp("x", "p", "root x", 0, 60), sp("y", "p", "root y", 10, 100)]);
    expect([...early].sort()).toEqual(["p", "y"]);
  });

  it("shows the stage, its phases, the roots and their commands, and folds the binary's spans", () => {
    const rows = waterfallRows({ spans: SPANS });
    expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.label}`)).toEqual([
      "tf-apply, wave 1",
      "  plan",
      "    root a",
      "    root b",
      "      tofu plan",
      "  gate",
      "  apply",
      "    root a",
      "    root b",
    ]);
    const cmd = rows.find((r) => r.label === "tofu plan");
    expect(cmd).toMatchObject({ depth: OPEN_DEPTH, kids: 1, open: false, critical: true });
    const gate = rows.find((r) => r.label === "gate");
    expect(gate).toMatchObject({ wait: true, critical: true, sub: "approved after 40 s held", at: 0.4, width: 0.4 });
    expect(rows[0]).toMatchObject({ at: 0, width: 1, sub: "applied" });
  });

  it("opens a folded row on a click and folds an open one", () => {
    const folds = foldState();
    folds.toggle("pb", OPEN_DEPTH);
    folds.toggle("ob", OPEN_DEPTH + 1);
    let rows = waterfallRows({ spans: SPANS }, folds);
    expect(rows.find((r) => r.label === "OpenTofu")).toMatchObject({ depth: 4, service: "OpenTofu CLI", open: true });
    expect(rows.find((r) => r.label === "terraform_data.release")).toMatchObject({ sub: "plan", depth: 5 });
    folds.toggle("p", 1);
    rows = waterfallRows({ spans: SPANS }, folds);
    expect(rows.some((r) => r.label === "root a" && r.depth === 2 && r.at < 0.5)).toBe(false);
  });

  it("names OpenTofu's spans by what they act on", () => {
    expect(spanWords(sp("x", null, "Apply resource instance changes", 0, 1, { "opentofu.resource_instance.address": "terraform_data.x" }, "OpenTofu CLI"))).toEqual({ label: "terraform_data.x", sub: "apply" });
    expect(spanWords(sp("x", null, "Configure provider", 0, 1, { "opentofu.provider.source": "registry.opentofu.org/hashicorp/aws" }, "OpenTofu CLI"))).toEqual({ label: "Configure provider", sub: "hashicorp/aws" });
    expect(spanWords(sp("x", null, "gate", 0, 1, { "terragucci.phase": "gate", "terragucci.gate.status": "not-required" })).sub).toBe("no approval needed");
    expect(spanWords(sp("x", null, "State lock wait", 0, 1, {}, "choudoufu")).label).toBe("State lock wait");
  });

  it("lays the run's jobs on one time line, each job's newest attempt", () => {
    const strip = runStrip([
      { job: "apply-wave-1", start: T, ms: 1000, result: "waiting" },
      { job: "apply-wave-1", start: T + 2000, ms: 1000, result: "applied" },
      { job: "apply-wave-2", start: T + 3000, ms: 1000, result: "applied" },
    ]);
    expect(strip).toEqual([
      { job: "apply-wave-1", wave: undefined, result: "applied", ms: 1000, at: 0, width: 0.5 },
      { job: "apply-wave-2", wave: undefined, result: "applied", ms: 1000, at: 0.5, width: 0.5 },
    ]);
  });

  it("says a span's time in ms below a second", () => {
    expect(msWords(0.4)).toBe("<1 ms");
    expect(msWords(70)).toBe("70 ms");
    expect(msWords(6400)).toBe("6.4 s");
    expect(msWords(125_000)).toBe("2 min 5 s");
  });

  it("a gate that spans its hold shows held and check under it, and keeps the plan before the check on the path", () => {
    // The wave began waiting 40 s before this job; the job planned, checked the approval, then applied.
    const spans = [
      sp("s", null, "terragucci tf-apply", 0, 1000, { "terragucci.stage": "tf-apply", "terragucci.wave": 1 }),
      sp("p", "s", "plan", 100, 400, { "terragucci.phase": "plan" }),
      sp("r", "p", "root a", 110, 390, { "terragucci.root": "a" }),
      sp("g", "s", "gate", -40_000, 800, { "terragucci.phase": "gate", "terragucci.gate.status": "approved", "terragucci.gate.held_seconds": 40 }),
      sp("h", "g", "held", -40_000, 0, { "terragucci.wait": "approval", "terragucci.gate.held_seconds": 40 }),
      sp("c", "g", "check", 400, 800),
      sp("a", "s", "apply", 800, 950, { "terragucci.phase": "apply" }),
    ];
    const rows = waterfallRows({ spans });
    const gate = rows.find((r) => r.label === "gate");
    const held = rows.find((r) => r.label === "held");
    expect(gate.width).toBeGreaterThan(0.95);
    expect(held).toMatchObject({ sub: "for an approval", wait: true, critical: true, depth: 2 });
    expect(rows.find((r) => r.label === "check")).toMatchObject({ sub: "this job's decision", wait: false, critical: true });
    expect(rows.find((r) => r.label === "plan").critical).toBe(true);
    expect(rows.find((r) => r.label === "root a").critical).toBe(true);
  });
});


describe("the strip's left bars (behold#571)", () => {
  it("take the job's result: failed, waiting, applied, and neutral for none", () => {
    expect(["failed", "changed-after-approval", "waiting", "applied", "planned", undefined, "other"].map(stripTone)).toEqual(["bad", "bad", "wait", "ok", "ok", "idle", "idle"]);
  });
});

describe("kiosk trace: one attempt of several (behold#571)", () => {
  const t = (wave, start) => ({ wave, start, ms: 10, spans: [] });
  it("picks the attempt that is the asked-about wave's: its own start, else that wave's newest, else the newest", async () => {
    const { attemptFor, attemptWords } = await import("./kiosk-trace.js");
    const traces = [t(1, 100), t(2, 200), t(2, 300)];
    expect(attemptFor(traces, { wave: 2, start: 200 })).toBe(1);
    expect(attemptFor(traces, { wave: 2 })).toBe(2);
    expect(attemptFor(traces, { wave: 1 })).toBe(0);
    expect(attemptFor(traces, { wave: 9 })).toBe(2);
    expect(attemptFor([], { wave: 1 })).toBe(-1);
    expect(attemptWords(0, 2, Date.parse("2026-10-16T19:25:38Z"))).toBe("Attempt 1 of 2, started at 19:25 UTC");
  });
});
