import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { prStageOfReport } from "./chant-pr.ts";
import { chantComposedFeedRoutes } from "./chant-compose-feed.ts";
import { COVERED_WORDS, composedReportOf, composedView } from "./chant-compose.ts";
import type { TerragucciSource } from "./terragucci-source.ts";
// @ts-expect-error the kiosk's browser modules have no declaration files
import { badgeWords, cardLines, lineState, planOf, selectLight, stateMarks, stateWords } from "../web/kiosk-light.js";
// @ts-expect-error see above
import { sceneModel } from "../web/kiosk-estate-scene.js";
// @ts-expect-error see above
import { readEdges, rootStates } from "../web/terragucci-change.js";

// behold#969 (chant#4419): a composed chant run, stacks network, app and edge. The fixtures are the demo's own reports
// (terragucci's example-demo-chant-compose, chant 0.124.34), copied from the local bucket's
// demo/chant/terragucci-admin/demo-chant-compose/<pull request>/<commit>/ without a change:
//   edit-*    pull request 1: network's proxy port moves and an admin port is added; every value is known at plan.
//   create-*  pull request 2: network creates subnetB, app puts workerInterface in it, edge's allowlist takes its range.
//             The apply's one round (app and edge) is covered by the first approval.
const FIX = join(import.meta.dirname, "__fixtures__", "chant-compose");
const json = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8")) as Record<string, unknown>;
const stage = (f: string) => composedReportOf(json(f))!;
const SUBNET_CARD = "chant/network/subnetB";
const WORKER_CARD = "chant/app/workerInterface";
const ALLOW_CARD = "chant/edge/allowlist";
const SUBNET_ID = "subnet-0f3a91c2";
const OUTPUTS = { network: { SubnetBId: SUBNET_ID, VpcId: "vpc-103dd1ad" } };
const linesOf = (v: { answer: unknown }, card: string) => cardLines(planOf(v.answer)).filter((l: { cardId: string }) => l.cardId === card);
const shown = (v: { answer: unknown; progress: unknown }, card: string) => linesOf(v, card).map((l: { path: string }) => [l.path, lineState(l, v.answer, v.progress).text]);

describe("reading chant's composed report", () => {
  it("keeps the unknown inputs, the planned upstreams and the round", () => {
    const p = stage("create-plan.json");
    expect(p.members.map((m) => [m.member, m.unknownInputs])).toEqual([["app", ["network.SubnetBId"]], ["edge", []], ["network", []]]);
    expect(p.entries.find((e) => e.address === "workerInterface")!.attributes).toEqual([{ path: "SubnetId", unknown: true }]);
    expect(p.order).toEqual(["network", "app", "edge"]);
    expect(p.planned).toEqual(["app", "network"]);
    expect([p.pr, p.head]).toEqual([2, "a71e1d3229de3b69009d2730ab47794ef2907b88"]);
    expect(stage("create-apply.json").rounds.map((r) => [r.round, r.components, r.covered?.filledInputs])).toEqual([[2, ["app", "edge"], ["network.SubnetBId"]]]);
  });
  it("reads an edit that moves only known values as a composed run too", () => {
    const e = stage("edit-plan.json");
    expect(e.members.every((m) => m.unknownInputs.length === 0)).toBe(true);
    expect(e.rounds).toEqual([]);
    expect(e.entries.map((x) => x.address)).toEqual(["adminListenerPort", "listenerPort", "adminUpstream", "upstream", "adminPort", "httpProxyPort"]);
  });
  it("is absent for a report of a plain fan-out", () => {
    const fan = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "chant-demo", "reports", "773", "6d4a48da36317886b549ca0d46c44646e697f561", "pr-plan.json"), "utf8"));
    expect(composedReportOf(fan)).toBeUndefined();
    expect(prStageOfReport(fan, "x")!.composed).toBeUndefined();
    expect(prStageOfReport(json("create-plan.json"), "x")!.composed).toBeDefined();
  });
});

describe("the create plan: three stacks planned together", () => {
  const v = composedView(stage("create-plan.json"), undefined)!;
  it("draws the three stacks as boxes, upstream first, with a line from each stack to the next", () => {
    expect(v.progress).toBeNull();
    const a = v.answer as never;
    expect(planOf(a).roots.map((r: { path: string }) => r.path)).toEqual(["network", "app", "edge"]);
    expect(planOf(a).edges).toEqual([{ from: "network", to: "app" }, { from: "app", to: "edge" }]);
    const edges = readEdges(a, null);
    // Every read between stacks, from the plan on: app's of network known after apply, edge's of app known at plan
    // (this report predates `reads`, so the waves after network and app, whose outputs the plan states, stand in).
    expect(edges.map((e: { from: string; to: string; unknown: string[] }) => [e.from, e.to, e.unknown])).toEqual([
      ["app", "network", ["SubnetBId", "SubnetId"]],
      ["edge", "app", []],
    ]);
    const m = sceneModel(a, planOf(a), null, { width: 1900, height: 740 });
    expect(m.roots.map((r: { path: string }) => r.path)).toEqual(["network", "app", "edge"]);
  });
  it("takes the stacks' edges from the components graph when it is given", () => {
    const g = composedView(stage("create-plan.json"), undefined, { dependsOn: { app: ["network"], edge: ["network", "app"] } })!;
    expect(planOf(g.answer as never).edges).toEqual([{ from: "network", to: "app" }, { from: "network", to: "edge" }, { from: "app", to: "edge" }]);
  });
  it("says planned together on each box", () => {
    const states = rootStates(v.answer, null).roots;
    expect(Object.keys(states).sort()).toEqual(["app", "edge", "network"]);
    for (const r of ["network", "app", "edge"]) expect(badgeWords(states[r], r, null)).toBe("planned together");
  });
  it("gives a changed resource at most two lines: the id and the read are known after apply, the update says updated", () => {
    expect(shown(v, SUBNET_CARD)).toEqual([["id", "id: known after apply"]]);
    expect(shown(v, WORKER_CARD)).toEqual([["id", "id: known after apply"], ["SubnetId", "SubnetId: known after apply"]]);
    expect(shown(v, ALLOW_CARD)).toEqual([["Value", "Value: updated"]]);
    for (const l of linesOf(v, WORKER_CARD)) expect(lineState(l, v.answer, null).state).toBe("unknown");
    // The read's producer is the resource the upstream stack creates.
    expect(linesOf(v, WORKER_CARD).find((l: { path: string }) => l.path === "SubnetId")).toMatchObject({ producerRoot: "network", producerName: "subnetB" });
  });
  it("lights a resource and what reads it", () => {
    const sel = selectLight(planOf(v.answer), { light: ["network/subnetB"], paths: true });
    expect(sel.roots).toEqual(["network", "app", "edge"]);
  });
  it("tells previewed members from plain ones", () => {
    expect(v.members.map((m) => [m.member, m.kind])).toEqual([["app", "previewed"], ["edge", "plain"], ["network", "plain"]]);
  });
  it("tells a hole, a member nothing could be previewed for, from a previewed one", () => {
    const doc = json("create-plan.json") as { changeSet: { members: { member: string; holes: unknown[] }[] } };
    doc.changeSet.members.find((m) => m.member === "edge")!.holes = [{ address: "allowlist", reason: "no preview: CloudFormation refused the stand-in" }];
    const h = composedView(composedReportOf(doc)!, undefined)!;
    expect(h.members.map((m) => [m.member, m.kind])).toEqual([["app", "previewed"], ["edge", "hole"], ["network", "plain"]]);
    expect((h.answer as { pull_request: { waves: { composed: { held_by_unknown: string[] } }[] } }).pull_request.waves[0]!.composed.held_by_unknown).toContain("edge");
  });
  it("pins the plan to its pull request and head, so another cycle's plan is never drawn as this one's", () => {
    expect((v.answer as { pull_request: { run: { pull_request: string; commit: string } } }).pull_request.run).toMatchObject({ pull_request: "2", commit: "a71e1d3229de3b69009d2730ab47794ef2907b88" });
  });
});

describe("the create apply the first approval covered", () => {
  const v = composedView(stage("create-plan.json"), stage("create-apply.json"), { outputs: OUTPUTS })!;
  it("says applied together on each box, and the covered round on the two stacks it re-planned", () => {
    const states = rootStates(v.answer, v.progress).roots;
    for (const r of ["network", "app", "edge"]) expect(badgeWords(states[r], r, v.progress)).toBe("applied together");
    expect(states.app.facts).toContain(COVERED_WORDS);
    expect(states.edge.facts).toContain(COVERED_WORDS);
    expect(states.network.facts).not.toContain(COVERED_WORDS);
    expect(v.rounds).toEqual([{ round: 2, members: ["app", "edge"], covered: true, words: COVERED_WORDS, digest: expect.any(String), filledInputs: ["network.SubnetBId"] }]);
    const marks = stateMarks(v.answer, v.progress);
    expect(stateWords(marks.app)).toBe(`applied · ${COVERED_WORDS}`);
    expect(stateWords(marks.network)).toBe("applied");
  });
  it("shows the real subnet id where the plan said known after apply", () => {
    expect(shown(v, SUBNET_CARD)).toEqual([["id", `id: ${SUBNET_ID}`]]);
    expect(shown(v, WORKER_CARD)).toEqual([["id", "id: created"], ["SubnetId", `SubnetId: ${SUBNET_ID}`]]);
    for (const l of linesOf(v, WORKER_CARD).filter((x: { path: string }) => x.path === "SubnetId")) expect(lineState(l, v.answer, v.progress).state).toBe("applied");
  });
  it("without the stack's outputs the report states no value, and the line says where it was filled from", () => {
    const bare = composedView(stage("create-plan.json"), stage("create-apply.json"))!;
    expect(shown(bare, SUBNET_CARD)).toEqual([["id", "id: created"]]);
    expect(shown(bare, WORKER_CARD)[1]).toEqual(["SubnetId", "SubnetId: filled from subnetB"]);
  });
  it("keeps the lines at two per card after the apply", () => {
    const per: Record<string, number> = {};
    for (const l of cardLines(planOf(v.answer))) per[l.cardId] = (per[l.cardId] || 0) + 1;
    expect(Math.max(...Object.values(per))).toBeLessThanOrEqual(2);
  });
  it("pins the run view to the merge commit", () => {
    expect((v.progress as { run: { commit: string } }).run.commit).toBe("9d5964cbb98e5830cbdba91987eea41a6d1d19d1");
  });
});

describe("the edit: every value known at plan, three stacks, no round", () => {
  const plan = composedView(stage("edit-plan.json"), undefined)!;
  const done = composedView(stage("edit-plan.json"), stage("edit-apply.json"))!;
  it("draws no unknown line and no covered round", () => {
    expect(plan.rounds).toEqual([]);
    expect(done.rounds).toEqual([]);
    // The only unknown a card shows is a created resource's own id; no read between stacks is unknown.
    for (const l of cardLines(planOf(plan.answer))) if (l.kind === "unknown") expect(l.path).toBe("id");
    expect(shown(plan, "chant/network/httpProxyPort")).toEqual([["Value", "Value: updated"]]);
    const states = rootStates(done.answer, done.progress).roots;
    for (const r of ["network", "app", "edge"]) expect(badgeWords(states[r], r, done.progress)).toBe("applied together");
    expect(JSON.stringify(states)).not.toContain(COVERED_WORDS);
  });
  it("draws the three stacks in a chain", () => {
    expect(planOf(plan.answer as never).edges).toEqual([{ from: "network", to: "app" }, { from: "app", to: "edge" }]);
  });
  it("draws a line for each read between stacks at the plan, the same ones as after the apply, though every value was known", () => {
    const pair = (e: { from: string; to: string }) => `${e.from}>${e.to}`;
    const atPlan = readEdges(plan.answer, null);
    expect(atPlan.map(pair)).toEqual(["app>network", "edge>app"]);
    for (const e of atPlan) expect(e.unknown).toEqual([]);
    expect(readEdges(done.answer, done.progress).map(pair).sort()).toEqual(atPlan.map(pair).sort());
    // With the components graph the same pairs, from its dependsOn.
    const g = composedView(stage("edit-plan.json"), undefined, { dependsOn: { app: ["network"], edge: ["app"] } })!;
    expect(readEdges(g.answer, null).map(pair)).toEqual(["app>network", "edge>app"]);
  });
});

describe("a report that names every read (`members[].reads`, chant 0.124.52)", () => {
  // The create plan with the reads chant now writes: app reads network (SubnetBId unknown), edge reads app and network.
  const withReads = () => {
    const doc = json("create-plan.json") as { members: { member: string; reads?: unknown }[] };
    const reads: Record<string, unknown> = {
      app: [{ upstream: "network", outputs: ["HttpProxyPort", "SubnetAId", "SubnetBId", "VpcId"], unknown: ["SubnetBId"] }],
      edge: [{ upstream: "app", outputs: ["ListenerPort"] }, { upstream: "network", outputs: ["SubnetBCidr"] }],
    };
    for (const m of doc.members) if (reads[m.member]) m.reads = reads[m.member];
    return doc;
  };
  it("draws each read the report names from the plan on, the unknown ones as known after apply", () => {
    const v = composedView(composedReportOf(withReads())!, undefined)!;
    expect(readEdges(v.answer, null).map((e: { from: string; to: string; unknown: string[] }) => [e.from, e.to, e.unknown])).toEqual([
      ["app", "network", ["SubnetBId", "SubnetId"]],
      ["edge", "app", []],
      ["edge", "network", []],
    ]);
  });
  it("draws no line for a dependency the report says nothing is read through", () => {
    const doc = withReads() as { members: { member: string; reads?: unknown }[] };
    doc.members.find((m) => m.member === "edge")!.reads = [{ upstream: "app", outputs: ["ListenerPort"] }];
    const v = composedView(composedReportOf(doc)!, undefined, { dependsOn: { app: ["network"], edge: ["network", "app"] } })!;
    expect(readEdges(v.answer, null).map((e: { from: string; to: string }) => `${e.from}>${e.to}`)).toEqual(["app>network", "edge>app"]);
    // The dependency still orders the run.
    expect((v.answer as { pull_request: { upstreams: Record<string, string[]> } }).pull_request.upstreams.edge).toEqual(["app", "network"]);
  });
  it("reads an edit whose every read is known as a composed run", () => {
    const doc = json("edit-plan.json") as { plannedOutputs?: unknown; members: { member: string; reads?: unknown }[] };
    delete doc.plannedOutputs;
    doc.members.find((m) => m.member === "app")!.reads = [{ upstream: "network", outputs: ["HttpProxyPort"] }];
    expect(composedReportOf(doc)).toBeDefined();
  });
});

describe("a re-plan the first approval did not cover", () => {
  // Derived from the real create apply: its round carries a reason instead of `covered`, and app and edge wait.
  const doc = json("create-apply.json") as { status: string; members: { member: string; status: string }[]; rounds: Record<string, unknown>[] };
  doc.status = "waiting";
  for (const m of doc.members) if (m.member !== "network") m.status = "waiting";
  delete doc.rounds[0]!.covered;
  doc.rounds[0]!.status = "waiting";
  doc.rounds[0]!.notCovered = "app now plans to create RouteTable, which the first plan did not";
  const v = composedView(stage("create-plan.json"), composedReportOf(doc)!, { outputs: OUTPUTS })!;
  it("says why, marks no stack covered, and leaves the held stacks unapplied", () => {
    expect(v.rounds).toEqual([{ round: 2, members: ["app", "edge"], covered: false, words: "the re-plan needed an approval of its own", reason: "app now plans to create RouteTable, which the first plan did not" }]);
    const states = rootStates(v.answer, v.progress).roots;
    expect(JSON.stringify(states)).not.toContain(COVERED_WORDS);
    expect(badgeWords(states.network, "network", v.progress)).toBe("applied together");
    expect(badgeWords(states.app, "app", v.progress)).toBe("not applied");
    // network applied, so its subnet has an id; app has not, so its worker's line stays unknown.
    expect(shown(v, SUBNET_CARD)).toEqual([["id", `id: ${SUBNET_ID}`]]);
    expect(shown(v, WORKER_CARD)[1]).toEqual(["SubnetId", "SubnetId: filled from subnetB"]);
  });
});

describe("the feed: /api/terragucci from the bucket the pipeline writes", () => {
  const DIR = "pr";
  const files: Record<string, string> = {
    "1/a6543aacfbb4ca2afdb6b4c26fc1908683d77195/pr-plan.json": "edit-plan.json",
    "1/f97fa21effb924712aa6cda6de86cf705ab649e5/pr-apply.json": "edit-apply.json",
    "2/a71e1d3229de3b69009d2730ab47794ef2907b88/pr-plan.json": "create-plan.json",
    "2/9d5964cbb98e5830cbdba91987eea41a6d1d19d1/pr-apply.json": "create-apply.json",
  };
  const memory = (held: string[]): TerragucciSource => ({
    kind: "dir",
    location: "mem",
    async read(key: string) {
      return held.includes(key) ? readFileSync(join(FIX, files[key]!), "utf8") : undefined;
    },
    async list(under: string) {
      const base = under === "" ? "" : `${under.replace(/\/+$/, "")}/`;
      const keys = held.filter((k) => k.startsWith(base)).map((k) => k.slice(base.length));
      return {
        prefixes: [...new Set(keys.filter((k) => k.includes("/")).map((k) => `${base}${k.split("/")[0]}/`))],
        objects: keys.filter((k) => !k.includes("/")).map((k) => ({ key: `${base}${k}`, modified: "2026-10-24T22:14:00.000Z" })),
        truncated: false,
      };
    },
  });
  const WORKFLOW = `jobs:\n  plan:\n    steps:\n      - run: chant components pr-plan --base "$BASE_SHA" --pr "$PR_NUMBER" --env demo --gate pr-apply --output .chant/pr --forge forgejo --report-url s3://demo-reports/demo/chant/o/r\n`;
  function app(held: string[], withLoop = true, stacks: string[] = ["network"]) {
    const dir = join(mkdtempSync(join(tmpdir(), "behold-chant-feed-")), "demo-chant-compose");
    mkdirSync(join(dir, ".forgejo", "workflows"), { recursive: true });
    if (withLoop) writeFileSync(join(dir, ".forgejo", "workflows", "chant-pr.yml"), WORKFLOW);
    const a = new Hono();
    const asked: string[][] = [];
    chantComposedFeedRoutes(a, () => dir, {
      reportSource: () => memory(held),
      aws: async (args) => {
        asked.push(args);
        const stack = args[args.indexOf("--stack-name") + 1]!;
        return { code: 0, stdout: JSON.stringify({ Stacks: [{ Outputs: stacks.includes(stack) ? Object.entries(OUTPUTS.network).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) : [] }] }), stderr: "" };
      },
    });
    a.get("/api/terragucci", (c) => c.json({ fell: "through" }));
    a.get("/api/terragucci/progress", (c) => c.json({ fell: "through" }));
    return { a, asked };
  }
  const all = Object.keys(files);
  it("serves the newest pull request's plan and apply, and the real subnet id from the network stack", async () => {
    const { a, asked } = app(all);
    const answer = (await (await a.request("/api/terragucci")).json()) as any;
    expect(answer.estateScene.roots.map((r: { path: string }) => r.path)).toEqual(["network", "app", "edge"]);
    expect(answer.pull_request.run.pull_request).toBe("2");
    expect(answer.applied["chant/network/subnetB"].values[0]).toMatchObject({ path: "id", after: SUBNET_ID });
    expect(asked.every((x) => x[0] === "cloudformation")).toBe(true);
    const progress = (await (await a.request("/api/terragucci/progress")).json()) as any;
    expect(progress.states[0].composed.members.find((m: { root: string }) => m.root === "app").covered.filledInputs).toEqual(["network.SubnetBId"]);
    expect(progress.run.commit).toBe("9d5964cbb98e5830cbdba91987eea41a6d1d19d1");
  });
  it("a commit picks the pull request that has a stage on it", async () => {
    const { a } = app(all);
    const answer = (await (await a.request("/api/terragucci?commit=f97fa21e")).json()) as any;
    expect(answer.pull_request.run.pull_request).toBe("1");
    expect(answer.chant.rounds).toEqual([]);
  });
  it("at the plan alone there is no run view", async () => {
    const { a } = app(["2/a71e1d3229de3b69009d2730ab47794ef2907b88/pr-plan.json"]);
    expect(((await (await a.request("/api/terragucci")).json()) as any).pull_request.waves[0].composed.members).toHaveLength(3);
    expect(((await (await a.request("/api/terragucci/progress")).json()) as any).run).toBeNull();
  });
  it("a checkout with no pull-request loop, or no composed report, goes on to the terragucci read", async () => {
    expect(await (await app(all, false).a.request("/api/terragucci")).json()).toEqual({ fell: "through" });
    expect(await (await app([]).a.request("/api/terragucci/progress")).json()).toEqual({ fell: "through" });
  });
});
