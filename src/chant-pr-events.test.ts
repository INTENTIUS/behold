import { describe, expect, it } from "vitest";
import { blockerOf, chantReportKey, eventsFileOf, foldPrEvents, parseRunEvents, readPrLive } from "./chant-pr-events.ts";
import { prLoopIn, resolveVars } from "./chant-pr.ts";

// chant's examples/fan-out-estate, as terragucci's fan-out scenario runs it
// (behold#631, chant#4007): network in wave 1, cluster-a and cluster-b in
// wave 2, app-01..06 on cluster-a and app-07..12 on cluster-b in wave 3. On
// the merge, cluster-a fails, cluster-b applies, cluster-b's apps apply and
// cluster-a's are blocked.
const SCHEMA = "https://intentius.io/chant/schemas/workspace/run-event/v1/run-event.schema.json";
const SHA = "0c45b81ff5c050d1f9dfbdb1fe1638e24dee67ed";
const FIFO = "Resource handler returned message: \"The name of a FIFO queue can only end with '.fifo'.\"";
const appsA = ["app-01", "app-02", "app-03", "app-04", "app-05", "app-06"];
const appsB = ["app-07", "app-08", "app-09", "app-10", "app-11", "app-12"];
const WAVES = [["network"], ["cluster-a", "cluster-b"], [...appsA, ...appsB]];
const dependsOn: Record<string, string[]> = {
  "cluster-a": ["network"],
  "cluster-b": ["network"],
  ...Object.fromEntries(appsA.map((a) => [a, ["cluster-a"]])),
  ...Object.fromEntries(appsB.map((a) => [a, ["cluster-b"]])),
};

/** A stream of event bodies, each in chant's envelope, seq from 0. */
function stream(bodies: Record<string, unknown>[]): string {
  return bodies
    .map((b, seq) =>
      JSON.stringify({
        $schema: SCHEMA,
        contract: 1,
        chant: "0.124.29",
        seq,
        at: new Date(Date.UTC(2026, 9, 17, 9, 0, seq)).toISOString(),
        runId: "pr-14-1760691600000",
        kind: "component",
        name: "pr-apply pr-14",
        gitSha: SHA,
        runtime: "ci",
        runOrigin: { forge: "github", repo: "terragucci-admin/demo-chant-fanout" },
        ...b,
      }),
    )
    .join("\n");
}

const comp = (wave: number, component: string, status: string, extra: Record<string, unknown> = {}) => [
  { type: "component-start", wave, component },
  { type: "phase-start", component, phase: "deploy" },
  { type: "step-start", component, phase: "deploy", step: "apply" },
  { type: "step-settle", component, phase: "deploy", step: "apply", status: status === "ok" ? "ok" : "failed", durationMs: 1000, ...(status === "failed" ? { error: FIFO } : {}) },
  { type: "phase-settle", component, phase: "deploy", status },
  { type: "component-settle", wave, component, status, ...extra },
];
const planPhase = (names: string[]) => [
  { type: "phase-start", component: null, phase: "plan" },
  ...names.flatMap((n) => [
    { type: "step-start", component: n, phase: "plan", step: "plan" },
    { type: "step-settle", component: n, phase: "plan", step: "plan", status: "ok", durationMs: 500 },
  ]),
  { type: "phase-settle", component: null, phase: "plan", status: "ok" },
];
const gate = [
  { type: "phase-start", component: null, phase: "gate" },
  { type: "step-start", component: null, phase: "gate", step: "gate:pr-apply" },
  { type: "gate-resolved", component: null, phase: "gate", step: "gate:pr-apply", op: "pr-14", gate: "pr-apply", resolvedBy: "forgejo@forgejo:3000:demo-reviewer", resolvedAt: "2026-10-17T08:59:00.000Z", via: null },
  { type: "step-settle", component: null, phase: "gate", step: "gate:pr-apply", status: "ok", durationMs: 20 },
  { type: "phase-settle", component: null, phase: "gate", status: "ok" },
];

/** The merge's apply up to wave 3's settle; `blocked` says whether chant names the blocked (0.124.29) or leaves them out (0.124.28). */
function failedApply(blocked: boolean): Record<string, unknown>[] {
  return [
    { type: "run-start", waves: WAVES },
    ...planPhase(WAVES.flat()),
    ...gate,
    { type: "wave-start", wave: 1, components: ["network"] },
    ...comp(1, "network", "ok"),
    { type: "wave-settle", wave: 1, status: "ok" },
    { type: "wave-start", wave: 2, components: ["cluster-a", "cluster-b"] },
    ...comp(2, "cluster-a", "failed"),
    ...comp(2, "cluster-b", "ok"),
    { type: "wave-settle", wave: 2, status: "failed" },
    ...(blocked ? appsA.map((a) => ({ type: "component-settle", wave: 3, component: a, status: "blocked", blockedBy: "cluster-a" })) : []),
    { type: "wave-start", wave: 3, components: appsB },
    ...appsB.flatMap((a) => comp(3, a, "ok")),
    { type: "wave-settle", wave: 3, status: "ok" },
    { type: "run-settle", status: "failed", durationMs: 90_000, error: "a component failed" },
  ];
}

describe("the merge's apply, folded from chant's run events (behold#631, chant#4007)", () => {
  for (const blocked of [true, false]) {
    it(`three waves, cluster-a failing and its six apps blocked, ${blocked ? "with chant's blocked status" : "without it (worked out from the graph)"}`, () => {
      const live = readPrLive(stream(failedApply(blocked)), { stage: "apply", source: "s3://reports/chant/14/x/pr-apply.events.jsonl", dependsOn })!;
      expect(live).toMatchObject({ stage: "apply", contract: "run-event/v1", settled: true, status: "failed", runId: "pr-14-1760691600000", gitSha: SHA });
      expect(live.refused).toBeUndefined();
      expect(live.gate).toEqual({ state: "resolved", by: "forgejo@forgejo:3000:demo-reviewer" });
      expect(live.waves.map((w) => [w.wave, w.state])).toEqual([[1, "applied"], [2, "failed"], [3, "applied"]]);
      expect(live.waves[1]!.counts).toMatchObject({ applied: 1, failed: 1 });
      expect(live.waves[2]!.counts).toMatchObject({ applied: 6, blocked: 6, waiting: 0 });
      expect(live.components.network!.state).toBe("applied");
      expect(live.components["cluster-a"]).toMatchObject({ state: "failed", failedIn: "apply", error: FIFO, wave: 2 });
      expect(live.components["cluster-b"]!.state).toBe("applied");
      for (const a of appsB) expect(live.components[a]!.state).toBe("applied");
      for (const a of appsA) expect(live.components[a]).toMatchObject({ state: "blocked", blockedBy: "cluster-a", blockedFrom: blocked ? "event" : "graph", wave: 3 });
    });
  }

  it("without the status or the graph's edges, the skipped apps are still blocked, with no blocker named", () => {
    const live = readPrLive(stream(failedApply(false)), { stage: "apply", source: "x" })!;
    for (const a of appsA) {
      expect(live.components[a]!.state).toBe("blocked");
      expect(live.components[a]!.blockedBy).toBeUndefined();
    }
  });

  it("a resume after the fix: what applied before is already-applied, the rest applies", () => {
    const text = stream([
      { type: "run-start", waves: WAVES },
      { type: "component-settle", wave: 1, component: "network", status: "already-applied" },
      { type: "wave-start", wave: 2, components: ["cluster-a"] },
      { type: "component-settle", wave: 2, component: "cluster-b", status: "already-applied" },
      ...comp(2, "cluster-a", "ok"),
      { type: "wave-settle", wave: 2, status: "ok" },
      ...appsB.map((a) => ({ type: "component-settle", wave: 3, component: a, status: "already-applied" })),
      { type: "wave-start", wave: 3, components: appsA },
      ...appsA.flatMap((a) => comp(3, a, "ok")),
      { type: "wave-settle", wave: 3, status: "ok" },
      { type: "run-settle", status: "ok", durationMs: 60_000 },
    ]);
    const live = readPrLive(text, { stage: "apply", source: "x", dependsOn })!;
    expect(live.status).toBe("ok");
    expect(live.components.network!.state).toBe("already-applied");
    expect(live.components["cluster-b"]!.state).toBe("already-applied");
    expect(live.components["cluster-a"]!.state).toBe("applied");
    for (const a of appsA) expect(live.components[a]!.state).toBe("applied");
    for (const a of appsB) expect(live.components[a]!.state).toBe("already-applied");
    // Wave 1 never started: its one component applied before, so it is done.
    expect(live.waves.map((w) => [w.wave, w.state])).toEqual([[1, "applied"], [2, "applied"], [3, "applied"]]);
    expect(live.waves[2]!.counts).toMatchObject({ applied: 6, alreadyApplied: 6 });
  });

  it("a run still going: the first wave done, the second applying, the third waiting, nothing blocked yet", () => {
    const bodies = failedApply(true);
    // Up to cluster-b's deploy starting: cluster-a has failed, cluster-b still runs.
    const cut = bodies.findIndex((b) => b.type === "component-start" && b.component === "cluster-b");
    const live = readPrLive(stream(bodies.slice(0, cut + 3)), { stage: "apply", source: "x", dependsOn })!;
    expect(live.settled).toBe(false);
    expect(live.status).toBeNull();
    expect(live.waves.map((w) => [w.wave, w.state])).toEqual([[1, "applied"], [2, "running"], [3, "waiting"]]);
    expect(live.components["cluster-a"]!.state).toBe("failed");
    expect(live.components["cluster-b"]!.state).toBe("running");
    // Not blocked until chant says so, or wave 3 starts without them, or the run settles.
    for (const a of [...appsA, ...appsB]) expect(live.components[a]!.state).toBe("planned");
    expect(live.waves[2]!.counts.waiting).toBe(12);
  });

  it("wave 3 starting without cluster-a's apps blocks them before the run settles (0.124.28)", () => {
    const bodies = failedApply(false);
    const cut = bodies.findIndex((b) => b.type === "wave-start" && b.wave === 3);
    const live = readPrLive(stream(bodies.slice(0, cut + 1)), { stage: "apply", source: "x", dependsOn })!;
    expect(live.settled).toBe(false);
    expect(live.waves[2]!.state).toBe("running");
    for (const a of appsA) expect(live.components[a]).toMatchObject({ state: "blocked", blockedBy: "cluster-a" });
    for (const a of appsB) expect(live.components[a]!.state).toBe("planned");
  });

  it("reads a torn last line as not yet written, and counts a line that fails chant's schema", () => {
    const text = stream(failedApply(true).slice(0, 5)) + "\n" + JSON.stringify({ $schema: SCHEMA, contract: 1, type: "wave-start" }) + '\n{"$schema":"' + SCHEMA + '","seq":9,"ty';
    const p = parseRunEvents(text);
    expect(p.events).toHaveLength(5);
    expect(p.refused).toBe(1);
    const live = readPrLive(text, { stage: "apply", source: "x" })!;
    expect(live.refused?.lines).toBe(1);
  });

  it("the plan stage: each component planning, then planned, or failed to plan with the error", () => {
    const text = stream([
      { type: "run-start", waves: WAVES },
      { type: "phase-start", component: null, phase: "plan" },
      { type: "step-start", component: "network", phase: "plan", step: "plan" },
      { type: "step-settle", component: "network", phase: "plan", step: "plan", status: "ok", durationMs: 1 },
      { type: "step-start", component: "cluster-a", phase: "plan", step: "plan" },
      { type: "step-settle", component: "cluster-a", phase: "plan", step: "plan", status: "failed", durationMs: 1, error: "template invalid" },
      { type: "step-start", component: "cluster-b", phase: "plan", step: "plan" },
    ]);
    const live = readPrLive(text, { stage: "plan", source: "x" })!;
    expect(live.components.network!.state).toBe("planned");
    expect(live.components["cluster-a"]).toMatchObject({ state: "failed", failedIn: "plan", error: "template invalid" });
    expect(live.components["cluster-b"]!.state).toBe("planning");
    expect(live.components["app-01"]!.state).toBe("waiting");
  });

  it("names the blocker its dependencies lead back to, through a blocked one", () => {
    const comps = { a: { component: "a", wave: 1, state: "failed" as const }, b: { component: "b", wave: 2, state: "blocked" as const, blockedBy: "a" } };
    expect(blockerOf("c", { c: ["b"], b: ["a"] }, comps)).toBe("a");
    expect(blockerOf("c", undefined, comps)).toBeUndefined();
  });

  // The two settles exactly as chant#4083 writes them (envelope added by `stream`).
  it("reads chant's blocked settle as written: right after the failed wave, no component-start, valid against the schema", () => {
    const text = stream([
      { type: "run-start", waves: [["net"], ["app"]] },
      { type: "wave-start", wave: 1, components: ["net"] },
      ...comp(1, "net", "failed"),
      { type: "wave-settle", wave: 1, status: "failed" },
      { type: "component-settle", wave: 2, component: "app", status: "blocked", blockedBy: "net" },
      { type: "run-settle", status: "failed", durationMs: 10 },
    ]);
    expect(parseRunEvents(text).refused).toBe(0);
    const live = readPrLive(text, { stage: "apply", source: "x" })!;
    expect(live.refused).toBeUndefined();
    expect(live.components.app).toMatchObject({ state: "blocked", blockedBy: "net", blockedFrom: "event", wave: 2 });
    expect(live.components.app!.startedAt).toBeUndefined();
    expect(live.waves.map((w) => [w.wave, w.state])).toEqual([[1, "failed"], [2, "blocked"]]);
  });

  it("reads chant's already-applied settle as written: after run-start, before the first wave, placed by name and not by its wave", () => {
    // A resumed fan-out: run-start re-layers what is left, so app is its wave 1; net applied in the earlier attempt, where it was wave 1.
    const text = stream([
      { type: "run-start", waves: [["app"]] },
      { type: "component-settle", wave: 1, component: "net", status: "already-applied" },
      { type: "wave-start", wave: 1, components: ["app"] },
      ...comp(1, "app", "ok"),
      { type: "wave-settle", wave: 1, status: "ok" },
      { type: "run-settle", status: "ok", durationMs: 10 },
    ]);
    expect(parseRunEvents(text).refused).toBe(0);
    const live = readPrLive(text, { stage: "apply", source: "x", componentWaves: { net: 1, app: 2 } })!;
    expect(live.components.net).toMatchObject({ state: "already-applied", wave: 1, waveFrom: "graph" });
    expect(live.components.app).toMatchObject({ state: "applied", wave: 1 });
    // run-start's wave 1 is app's alone: net, whose event says wave 1, did not join it.
    expect(live.waves).toHaveLength(1);
    expect(live.waves[0]).toMatchObject({ wave: 1, state: "applied", components: ["app"], counts: { applied: 1, alreadyApplied: 0 } });
    // Without the graph it has no wave: the event's number is never used.
    expect(readPrLive(text, { stage: "apply", source: "x" })!.components.net!.wave).toBeNull();
  });

  it("places an already-applied component by run-start's waves when its event's wave disagrees", () => {
    const text = stream([
      { type: "run-start", waves: [["app"], ["net"]] },
      { type: "component-settle", wave: 1, component: "net", status: "already-applied" },
    ]);
    const live = readPrLive(text, { stage: "apply", source: "x", componentWaves: { net: 3 } })!;
    expect(live.components.net).toMatchObject({ state: "already-applied", wave: 2 });
    expect(live.components.net!.waveFrom).toBeUndefined();
    expect(live.waves[1]).toMatchObject({ wave: 2, components: ["net"], counts: { alreadyApplied: 1 } });
    expect(live.waves[0]!.components).toEqual(["app"]);
  });

  it("is nothing without events", () => {
    expect(foldPrEvents([], { stage: "apply", source: "x" })).toBeNull();
    expect(readPrLive(undefined, { stage: "apply", source: "x" })).toBeNull();
    expect(readPrLive("not json\n", { stage: "apply", source: "x" })).toBeNull();
  });
});

describe("where the stages upload their events (chant#4083)", () => {
  it("is <pr>/<commit>[/<member>]/pr-<stage>.events.jsonl under the report URL, <pr> unknown without one", () => {
    expect(eventsFileOf("apply")).toBe("pr-apply.events.jsonl");
    expect(eventsFileOf("plan")).toBe("pr-plan.events.jsonl");
    expect(chantReportKey(14, SHA, eventsFileOf("apply"))).toBe(`14/${SHA}/pr-apply.events.jsonl`);
    expect(chantReportKey(null, SHA, eventsFileOf("apply"))).toBe(`unknown/${SHA}/pr-apply.events.jsonl`);
    expect(chantReportKey(14, SHA, "pr-plan.json", "infra")).toBe(`14/${SHA}/infra/pr-plan.json`);
  });
  it("is read off the pipeline's --report-url, a literal or a variable its env sets", () => {
    const wf = (url: string, env = "") => `${env}jobs:
  apply:
    steps:
      - run: chant components pr-apply --base "$BASE_SHA" --env demo --forge forgejo --require-review --events-json --report-url ${url}
`;
    expect(prLoopIn(wf("s3://reports/chant"), "forgejo", "w.yml")).toMatchObject({ reportUrl: "s3://reports/chant", events: true });
    expect(prLoopIn(wf('"${CHANT_REPORTS}/fanout"', "env:\n  CHANT_REPORTS: s3://reports/chant\n"), "forgejo", "w.yml")).toMatchObject({ reportUrl: "s3://reports/chant/fanout" });
    const unset = prLoopIn(wf("$CHANT_REPORTS"), "forgejo", "w.yml")!;
    expect(unset.reportUrl).toBeUndefined();
    expect(unset.reportUrlAs).toBe("$CHANT_REPORTS");
    expect(resolveVars("$A/$B", "A: x\nB: ${{ secrets.B }}\n")).toBeNull();
  });
});
