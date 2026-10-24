import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ChantDemo } from "./chant-demo.ts";
import { chantPrRoute, prStageOfReport } from "./chant-pr.ts";
import { COVERED_WORDS, composedReportOf, composedView } from "./chant-compose.ts";
import type { TerragucciSource } from "./terragucci-source.ts";
// @ts-expect-error the kiosk's browser modules have no declaration files
import { badgeWords, cardLines, lineState, planOf, selectLight, stateMarks, stateWords } from "../web/kiosk-light.js";
// @ts-expect-error see above
import { sceneModel } from "../web/kiosk-estate-scene.js";
// @ts-expect-error see above
import { readEdges, rootStates } from "../web/terragucci-change.js";

// behold#969 (chant#4419): a composed chant run, stacks network, app and edge. There is no real run to copy yet
// (terragucci#1269), so the fixtures are pr-report/v1 documents built from the shapes chant documents: the schema
// (packages/core/src/workspace/pr-report.schema.json), pr-run.test.ts's covered round, and cfn-plan.test.ts's
// preview (a created resource's id and the properties an unknown input drives marked `unknown`). Replace them with
// the demo's own files when its first local run writes them.
const FIX = join(import.meta.dirname, "__fixtures__", "chant-compose");
const json = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8")) as Record<string, unknown>;
const plan = () => composedReportOf(json("pr-plan.json"))!;
const covered = () => composedReportOf(json("pr-apply-covered.json"))!;
const notCovered = () => composedReportOf(json("pr-apply-not-covered.json"))!;
const VPC_CARD = "chant/network/Vpc";
const SG_CARD = "chant/app/AppSecurityGroup";
const DNS_CARD = "chant/edge/DnsUpstream";

describe("reading chant's composed report", () => {
  it("keeps the unknown inputs, the entries marked unknown and the rounds", () => {
    const p = plan();
    expect(p.members.map((m) => [m.member, m.unknownInputs])).toEqual([["app", ["network.VpcId"]], ["edge", ["app.QueueArn"]], ["network", []]]);
    expect(p.entries.find((e) => e.address === "AppSecurityGroup")!.attributes).toEqual([{ path: "VpcId", unknown: true }]);
    expect(p.order).toEqual(["network", "app", "edge"]);
    expect(covered().rounds.map((r) => [r.round, r.components, r.covered?.filledInputs])).toEqual([[2, ["app"], ["network.VpcId"]], [3, ["edge"], ["app.QueueArn"]]]);
    expect(notCovered().rounds[0]).toMatchObject({ notCovered: "app now plans to create RouteTable, which the first plan did not" });
    expect(notCovered().rounds[0]!.covered).toBeUndefined();
  });
  it("is absent for a report of a plain fan-out", () => {
    const fan = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "chant-demo", "reports", "773", "6d4a48da36317886b549ca0d46c44646e697f561", "pr-plan.json"), "utf8"));
    expect(composedReportOf(fan)).toBeUndefined();
    expect(prStageOfReport(fan, "x")!.composed).toBeUndefined();
    expect(prStageOfReport(json("pr-plan.json"), "x")!.composed).toBeDefined();
  });
});

describe("the plan: three stacks planned together", () => {
  const v = composedView(plan(), undefined)!;
  it("draws the three stacks as boxes, upstream first, and a line for each cross-stack read", () => {
    expect(v.progress).toBeNull();
    const a = v.answer as never;
    expect(planOf(a).roots.map((r: { path: string }) => r.path)).toEqual(["network", "app", "edge"]);
    expect(planOf(a).edges).toEqual([{ from: "network", to: "app" }, { from: "app", to: "edge" }]);
    const edges = readEdges(a, null);
    expect(edges.map((e: { from: string; to: string; unknown: string[] }) => [e.from, e.to, e.unknown])).toEqual([["app", "network", ["VpcId"]], ["edge", "app", ["QueueArn", "ResourceRecords"]]]);
    const m = sceneModel(a, planOf(a), null, { width: 1900, height: 740 });
    expect(m.roots.map((r: { path: string }) => r.path)).toEqual(["network", "app", "edge"]);
  });
  it("says planned together on each box", () => {
    const states = rootStates(v.answer, null).roots;
    expect(Object.keys(states).sort()).toEqual(["app", "edge", "network"]);
    for (const r of ["network", "app", "edge"]) expect(badgeWords(states[r], r, null)).toBe("planned together");
  });
  it("gives a changed resource at most two lines: its id known after apply, then the read, known after apply", () => {
    const p = planOf(v.answer);
    const lines = cardLines(p);
    const of = (id: string) => lines.filter((l: { cardId: string }) => l.cardId === id).map((l: { path: string; kind: string }) => `${l.path}:${l.kind}`);
    expect(of(VPC_CARD)).toEqual(["id:unknown"]);
    expect(of(SG_CARD)).toEqual(["id:unknown", "VpcId:unknown"]);
    expect(of(DNS_CARD)).toEqual(["id:unknown", "ResourceRecords:unknown"]);
    expect(of("chant/app/Queue")).toEqual(["id:unknown"]);
    for (const l of lines.filter((x: { cardId: string }) => x.cardId === SG_CARD)) expect(lineState(l, v.answer, null)).toMatchObject({ state: "unknown", text: expect.stringContaining("known after apply") });
    // The read's producer is a resource the upstream stack creates.
    expect(lines.find((l: { cardId: string; path: string }) => l.cardId === SG_CARD && l.path === "VpcId")).toMatchObject({ producerRoot: "network" });
  });
  it("lights a resource and what reads it", () => {
    const sel = selectLight(planOf(v.answer), { light: ["network/Vpc"], paths: true });
    expect(sel.roots).toEqual(["network", "app", "edge"]);
  });
  it("tells previewed members from plain ones", () => {
    expect(v.members.map((m) => [m.member, m.kind])).toEqual([["app", "previewed"], ["edge", "previewed"], ["network", "plain"]]);
  });
  it("tells a hole, a member nothing could be previewed for, from a previewed one", () => {
    const doc = json("pr-plan.json") as { changeSet: { members: { member: string; holes: unknown[] }[] } };
    doc.changeSet.members.find((m) => m.member === "edge")!.holes = [{ address: "DnsUpstream", reason: "no preview: CloudFormation refused the stand-in" }];
    const h = composedView(composedReportOf(doc)!, undefined)!;
    expect(h.members.map((m) => [m.member, m.kind])).toEqual([["app", "previewed"], ["edge", "hole"], ["network", "plain"]]);
    expect((h.answer as { pull_request: { waves: { composed: { held_by_unknown: string[] } }[] } }).pull_request.waves[0]!.composed.held_by_unknown).toContain("edge");
  });
});

describe("the apply the first approval covered", () => {
  const v = composedView(plan(), covered())!;
  it("says applied together on each box, and the covered round once", () => {
    const states = rootStates(v.answer, v.progress).roots;
    for (const r of ["network", "app", "edge"]) expect(badgeWords(states[r], r, v.progress)).toBe("applied together");
    expect(states.app.facts).toContain(COVERED_WORDS);
    expect(states.edge.facts).toContain(COVERED_WORDS);
    expect(states.network.facts).not.toContain(COVERED_WORDS);
    expect(v.rounds).toEqual([
      { round: 2, members: ["app"], covered: true, words: COVERED_WORDS, digest: expect.any(String), filledInputs: ["network.VpcId"] },
      { round: 3, members: ["edge"], covered: true, words: COVERED_WORDS, digest: expect.any(String), filledInputs: ["app.QueueArn"] },
    ]);
    const marks = stateMarks(v.answer, v.progress);
    expect(stateWords(marks.app)).toBe(`app · applied · ${COVERED_WORDS}`);
    expect(stateWords(marks.network)).toBe("network · applied");
  });
  it("shows the real value where the plan said known after apply", () => {
    const lines = cardLines(planOf(v.answer));
    const read = lines.find((l: { cardId: string; path: string }) => l.cardId === SG_CARD && l.path === "VpcId");
    expect(lineState(read, v.answer, v.progress)).toEqual({ state: "applied", text: "VpcId: vpc-0a1b2c" });
    const dns = lines.find((l: { cardId: string; path: string }) => l.cardId === DNS_CARD && l.path === "ResourceRecords");
    expect(lineState(dns, v.answer, v.progress).text).toBe("ResourceRecords: arn:aws:sqs:us-east-1:000000000000:app-queue");
    // The id is not stated by the report: the line says the resource was created.
    const id = lines.find((l: { cardId: string; path: string }) => l.cardId === VPC_CARD);
    expect(lineState(id, v.answer, v.progress)).toEqual({ state: "applied", text: "id: created" });
  });
  it("keeps the lines at two per card after the apply", () => {
    const per: Record<string, number> = {};
    for (const l of cardLines(planOf(v.answer))) per[l.cardId] = (per[l.cardId] || 0) + 1;
    expect(Math.max(...Object.values(per))).toBeLessThanOrEqual(2);
  });
});

describe("a re-plan the first approval did not cover", () => {
  const v = composedView(plan(), notCovered())!;
  it("says why, marks no stack covered, and leaves the held stacks unapplied", () => {
    expect(v.rounds).toEqual([{ round: 2, members: ["app"], covered: false, words: "the re-plan needed an approval of its own", reason: "app now plans to create RouteTable, which the first plan did not" }]);
    const states = rootStates(v.answer, v.progress).roots;
    expect(JSON.stringify(states)).not.toContain(COVERED_WORDS);
    expect(badgeWords(states.network, "network", v.progress)).toBe("applied together");
    expect(badgeWords(states.app, "app", v.progress)).toBe("not applied");
    const lines = cardLines(planOf(v.answer));
    const read = lines.find((l: { cardId: string; path: string }) => l.cardId === SG_CARD && l.path === "VpcId");
    // network applied, so the value exists; app has not, so the report states none for it.
    expect(lineState(read, v.answer, v.progress)).toEqual({ state: "applied", text: "VpcId: filled from Vpc" });
  });
});

describe("/api/terragucci on a chant demo", () => {
  const HEAD = "b".repeat(40);
  const MERGE = "c".repeat(40);
  const noGit = async () => ({ code: 1, stdout: "", stderr: "" });
  const noLedger = { history: async () => ({ found: false, via: "none" as const, fetch: { ok: false }, read: { at: "" }, logs: [], note: "" }), git: noGit };
  const memory = (files: Record<string, unknown>): TerragucciSource => ({ kind: "dir", location: "mem", async read(key: string) { return key in files ? JSON.stringify(files[key]) : undefined; } }) as TerragucciSource;
  const WORKFLOW = `jobs:\n  plan:\n    steps:\n      - run: chant components pr-plan --base "$BASE_SHA" --pr "$PR_NUMBER" --env demo --gate pr-apply --output .chant/pr --forge forgejo\n`;
  async function app(reports: Record<string, unknown>, stepName: string) {
    const dir = join(mkdtempSync(join(tmpdir(), "behold-chant-compose-")), "compose-estate");
    mkdirSync(join(dir, ".forgejo", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".forgejo", "workflows", "chant-pr.yml"), WORKFLOW);
    const step = {
      $schema: "https://intentius.io/chant/schemas/demo/demo-step/v1/demo-step.schema.json",
      contract: 1,
      demo: "compose-estate",
      repo: "chant-demo/compose-estate",
      cycle: 1,
      step: stepName,
      pull: 41,
      commit: stepName === "applied" ? MERGE : HEAD,
      reports: { url: "s3://chant-demo/compose-estate/reports", plan: `41/${HEAD}`, ...(stepName === "applied" ? { apply: `41/${MERGE}` } : {}) },
    };
    const sources: Record<string, TerragucciSource> = { mem: memory({ "step.json": step }), "s3://chant-demo/compose-estate/reports": memory(reports) };
    const demo = new ChantDemo({ source: "mem", sourceOf: (u) => sources[u]! });
    const a = new Hono();
    chantPrRoute(a, () => dir, { ...noLedger, reportSource: (u) => sources[u]!, demoReports: (d) => demo.prReports(d, noGit) });
    return a;
  }
  it("serves the answer and the run view the ask mode reads, and keeps /api/chant/pr small", async () => {
    const a = await app({ [`41/${HEAD}/pr-plan.json`]: json("pr-plan.json"), [`41/${MERGE}/pr-apply.json`]: json("pr-apply-covered.json") }, "applied");
    const answer = (await (await a.request("/api/terragucci")).json()) as any;
    expect(answer.estateScene.roots.map((r: { path: string }) => r.path)).toEqual(["network", "app", "edge"]);
    const progress = (await (await a.request("/api/terragucci/progress")).json()) as any;
    expect(progress.states[0].composed.members.find((m: { root: string }) => m.root === "app").covered.filledInputs).toEqual(["network.VpcId"]);
    const pr = (await (await a.request("/api/chant/pr")).json()) as any;
    expect(pr.plan.status).toBe("planned");
    expect(pr.plan.composed).toBeUndefined();
    expect(pr.apply.composed).toBeUndefined();
  });
  it("at the plan alone there is no run view", async () => {
    const a = await app({ [`41/${HEAD}/pr-plan.json`]: json("pr-plan.json") }, "pull-request");
    expect(((await (await a.request("/api/terragucci")).json()) as any).pull_request.waves[0].composed.members).toHaveLength(3);
    expect(((await (await a.request("/api/terragucci/progress")).json()) as any).run).toBeNull();
  });
  it("a plain fan-out has neither read, as before", async () => {
    const fan = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "chant-demo", "reports", "773", "6d4a48da36317886b549ca0d46c44646e697f561", "pr-plan.json"), "utf8"));
    const a = await app({ [`41/${HEAD}/pr-plan.json`]: fan }, "pull-request");
    expect((await a.request("/api/terragucci")).status).toBe(404);
    expect((await a.request("/api/terragucci/progress")).status).toBe(404);
  });
});
