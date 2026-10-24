import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { besideFirst, CHANT_DEMO_TOOL, ChantDemo, chantDemoRoutes, contractRefusal, DEMO_CYCLE_SCHEMA, DEMO_STEP_SCHEMA, knownStep, readDemoCycle, readerSchema, readStep, runIdFor, schemaProblem, type DemoRun } from "./chant-demo.ts";
import { readChantPr, type RunDoc } from "./chant-pr.ts";
import { kioskRoute, vendorRoutes } from "./terragucci-demo.ts";
import { terragucciSource, type TerragucciSource } from "./terragucci-source.ts";

// behold#752: chant's fan-out demo, from its own records. The fixtures are
// cycle 610 of the fan-out scenario as terragucci's loop ran chant's
// pull-request pipeline on examples/fan-out-estate, mapped onto chant#4092's
// schemas (chant#4102): its fifteen steps as demo-step/v1 writes under
// chant's names (chant-demo/fan-out-estate), cycles/latest.json as
// demo-cycle/v1, and the four stages' real pr-report/v1 and run-event/v1
// files under reports/<pr>/<sha>/. step.json is the cycle's failed step:
// pull request 773's apply, cluster-a failed and its six apps blocked.
const FIX = join(import.meta.dirname, "__fixtures__", "chant-demo");
const REPORTS_URL = "s3://chant-demo/fan-out-estate/reports";
const HEAD_773 = "6d4a48da36317886b549ca0d46c44646e697f561";
const MERGE_773 = "a7cf3abc45abd6f77d8835939e0ceca3a6b88440";
const HEAD_774 = "47f4df6dc66e00aa3cff1d8a1512554ee3bb8404";
const MERGE_774 = "80eef4a5e0eb747fddb04a7067e91ea59dd8dade";
const json = (rel: string) => JSON.parse(readFileSync(join(FIX, rel), "utf8")) as Record<string, unknown>;

const records = terragucciSource(FIX);
const reportsDir = terragucciSource(join(FIX, "reports"));
const sourceOf = (url: string): TerragucciSource => (url === FIX ? records : url === REPORTS_URL ? reportsDir : (undefined as never));
/** A source holding `files` (key -> text) and nothing else. */
const memory = (files: Record<string, unknown>): TerragucciSource => ({ kind: "dir", location: "mem", async read(key: string) { return key in files ? JSON.stringify(files[key]) : undefined; } }) as TerragucciSource;
const step = (over: Record<string, unknown> = {}) => ({ ...json("step.json"), ...over });

describe("the fixtures are chant's records (chant#4102's schemas)", () => {
  it("step.json and every step of the cycle validate as demo-step/v1, the cycle as demo-cycle/v1", () => {
    expect(schemaProblem(json("step.json"), "demo-step")).toBeUndefined();
    const c = json("cycles/latest.json");
    expect(schemaProblem(c, "demo-cycle")).toBeUndefined();
    for (const s of c.steps as unknown[]) expect(schemaProblem(s, "demo-step")).toBeUndefined();
  });
  it("names nothing of terragucci", () => {
    for (const f of ["step.json", "cycles/latest.json", `reports/773/${MERGE_773}/pr-apply.events.jsonl`, `reports/773/${MERGE_773}/pr-apply.json`]) {
      expect(readFileSync(join(FIX, f), "utf8")).not.toMatch(/terragucci/i);
    }
  });
});

describe("step.json, demo-step/v1 (behold#752)", () => {
  it("reads as the kiosk reads demo.json, the chapter and the report keys included", async () => {
    const a = await readStep(records);
    expect(a.demo).toMatchObject({
      demo: "fan-out-estate",
      repo: "chant-demo/fan-out-estate",
      tool: CHANT_DEMO_TOOL,
      cycle: 610,
      scenario: "fan-out",
      step: "failed",
      pull: 773,
      commit: MERGE_773,
      chapter: { n: 2, of: 4, short: expect.any(String) },
      reports: { url: REPORTS_URL, plan: `773/${HEAD_773}`, apply: `773/${MERGE_773}` },
      scenarios: null,
      index: null,
    });
    expect(a.demo!.about).toMatchObject({ changes: expect.any(String), watch: expect.any(String), shows: expect.any(String) });
  });
  it("reads a step that carries only what the schema requires", async () => {
    const a = await readStep(memory({ "step.json": { $schema: DEMO_STEP_SCHEMA, contract: 1, demo: "fan-out-estate", cycle: 3, step: "reset" } }));
    expect(a.demo).toMatchObject({ cycle: 3, step: "reset", repo: null, scenario: "fan-out-estate", title: "", label: "", next: null, pull: null, commit: null, about: null, reports: null, at: null });
    expect(a.demo!.chapter).toBeUndefined();
  });
  it("ignores fields the schema doesn't name, as the contract asks", async () => {
    const a = await readStep(memory({ "step.json": step({ later: { added: true } }) }));
    expect(a.demo?.step).toBe("failed");
  });
  it("refuses another contract major, saying which one behold reads", async () => {
    const two = await readStep(memory({ "step.json": step({ contract: 2, $schema: DEMO_STEP_SCHEMA.replace("/v1/", "/v2/") }) }));
    expect(two).toMatchObject({ demo: null, code: "chant-demo", remedy: "Upgrade behold: this demo writes a newer contract than it knows." });
    expect("error" in two && two.error).toMatch(/demo-step contract 2; behold reads contract 1/);
    // The $schema's major alone is enough to refuse.
    const v2 = await readStep(memory({ "step.json": step({ $schema: DEMO_STEP_SCHEMA.replace("/v1/", "/v2/") }) }));
    expect("error" in v2 && v2.error).toMatch(/contract 2; behold reads contract 1/);
    expect(contractRefusal({ $schema: DEMO_STEP_SCHEMA, contract: 0 }, "demo-step")?.remedy).toBe("Upgrade the demo's chant.");
  });
  it("refuses a record keyed to no demo-step schema, or to the cycle's", async () => {
    expect(contractRefusal({ contract: 1 }, "demo-step")?.problem).toMatch(/\$schema is null/);
    expect(contractRefusal({ $schema: DEMO_CYCLE_SCHEMA, contract: 1 }, "demo-step")?.problem).toMatch(/not https:\/\/intentius\.io\/chant\/schemas\/demo\/demo-step\/v1/);
    expect(contractRefusal({ $schema: DEMO_STEP_SCHEMA }, "demo-step")?.problem).toMatch(/contract is null/);
  });
  it("refuses what the schema refuses: a report key not in reportKey(pr, commit) form, a report URL not s3:// or https://", async () => {
    const key = await readStep(memory({ "step.json": step({ reports: { url: REPORTS_URL, plan: "773/not-a-sha" } }) }));
    expect("error" in key && key.error).toMatch(/demo-step\/v1 format: \/reports\/plan must match pattern/);
    for (const url of ["file:///etc", "http://elsewhere/r", "/srv/reports"]) {
      const u = await readStep(memory({ "step.json": step({ reports: { url } }) }));
      expect("error" in u && u.error).toMatch(/\/reports\/url must match pattern "\^\(s3\|https\):\/\/"/);
    }
  });
  it("reads a step it doesn't know as unclassified, never refusing the record (chant#4102: steps are added within contract 1)", async () => {
    const a = await readStep(memory({ "step.json": step({ step: "rolling-back", label: "Something new." }) }));
    expect(a.demo).toMatchObject({ step: "rolling-back", label: "Something new.", chapter: { n: 2 } });
    expect(knownStep(a.demo!.step)).toBe(false);
    expect(knownStep("failed")).toBe(true);
    const c = json("cycles/latest.json");
    const steps = (c.steps as Record<string, unknown>[]).map((x, i) => (i === 3 ? { ...x, step: "rolling-back" } : x));
    const r = await readDemoCycle(memory({ "cycles/latest.json": { ...c, steps } }));
    expect(r.cycle!.steps[3]!.step).toBe("rolling-back");
    // The vendored schema keeps chant's enum; only the reader leaves it out.
    expect(JSON.stringify(readerSchema("demo-step"))).not.toContain('"rolling-back"');
  });
  it("reads the cycle's stages so far, in run order", async () => {
    const a = await readStep(records);
    expect(a.demo!.cycleReports!.map((r) => `${r.stage} ${r.pr}`)).toEqual(["plan 773", "apply 773"]);
  });
  it("says where the record is missing", async () => {
    const a = await readStep(memory({}));
    expect(a).toMatchObject({ demo: null, absent: expect.stringMatching(/has no step\.json/) });
  });
});

describe("cycles/latest.json, demo-cycle/v1 (behold#752)", () => {
  it("reads the cycle's steps and its report keys, one run id per stage in the order they ran", async () => {
    const a = await readDemoCycle(records);
    expect(a.cycle).toMatchObject({ tool: CHANT_DEMO_TOOL, repo: "chant-demo/fan-out-estate", scenario: "fan-out", cycle: 610, runs: [61001, 61002, 61003, 61004] });
    expect(a.cycle!.steps.map((s) => s.step)).toEqual(["pull-request", "planned", "waiting", "approved", "merged", "applying", "failed", "pull-request", "planned", "waiting", "approved", "merged", "applying", "applied", "reset"]);
    expect(a.cycle!.steps.map((s) => s.chapter?.n)).toEqual([1, 1, 1, 1, 1, 1, 2, 3, 3, 3, 3, 3, 3, 4, 4]);
    expect(a.cycle!.reports.map((r) => `${r.stage} ${r.key}`)).toEqual([`plan 773/${HEAD_773}`, `apply 773/${MERGE_773}`, `plan 774/${HEAD_774}`, `apply 774/${MERGE_774}`]);
  });
  it("refuses another contract major", async () => {
    const c = json("cycles/latest.json");
    const a = await readDemoCycle(memory({ "cycles/latest.json": { ...c, contract: 3 } }));
    expect("error" in a && a.error).toMatch(/demo-cycle contract 3; behold reads contract 1/);
  });
  it("refuses a step without its `at`", async () => {
    const c = json("cycles/latest.json");
    const steps = (c.steps as Record<string, unknown>[]).map(({ at: _a, ...s }) => s);
    const a = await readDemoCycle(memory({ "cycles/latest.json": { ...c, steps } }));
    expect("error" in a && a.error).toMatch(/\/steps\/0 must have required property 'at'/);
  });
});

describe("the demo's runs, from chant's run events under the step's report keys (behold#752)", () => {
  const app = () => {
    const a = new Hono();
    chantDemoRoutes(a, new ChantDemo({ source: FIX, sourceOf }));
    return a;
  };
  it("serves the step and the cycle", async () => {
    const a = app();
    expect(((await (await a.request("/api/chant/demo")).json()) as { demo: { step: string } }).demo.step).toBe("failed");
    expect(((await (await a.request("/api/chant/demo/cycle")).json()) as { cycle: { cycle: number } }).cycle.cycle).toBe(610);
  });
  it("lists one run per stage, newest first, each from its events", async () => {
    const r = await app().request("/api/chant/demo/runs");
    const idx = (await r.json()) as { doc: { schema: string; runs: DemoRun[] } };
    expect(idx.doc.schema).toBe("demo.runs/v1");
    expect(idx.doc.runs.map((x) => [x.id, x.trigger, x.pull, x.status])).toEqual([
      [61004, "merge", 774, "success"],
      [61003, "plan", 774, "success"],
      [61002, "merge", 773, "failure"],
      [61001, "plan", 773, "success"],
    ]);
    expect(idx.doc.runs[0]!.jobs[0]).not.toHaveProperty("steps");
    expect(JSON.stringify(idx)).not.toMatch(/terragucci/i);
  });
  it("a run's steps are its plan, its gate and each wave, logged from the events", async () => {
    const r = (await (await app().request(`/api/chant/demo/runs/${runIdFor(610, 2)}`)).json()) as { doc: DemoRun };
    const job = r.doc.jobs[0]!;
    expect(job.name).toBe("pr-apply");
    expect(job.steps!.map((s) => [s.name, s.status])).toEqual([
      ["plan", "success"],
      ["gate", "success"],
      ["wave 1", "success"],
      ["wave 2", "failure"],
      // As chant's wave-settle says: cluster-b's six applied; cluster-a's never started.
      ["wave 3", "success"],
    ]);
    const wave2 = job.steps!.find((s) => s.name === "wave 2")!.log.join("\n");
    expect(wave2).toMatch(/✗ cluster-a: failed/);
    expect(job.steps!.find((s) => s.name === "wave 3")!.log.join("\n")).toMatch(/app-01: blocked, never started/);
    expect(r.doc.reports).toBe(`${REPORTS_URL}/773/${MERGE_773}/`);
    expect(r.doc.origin).toMatch(/\/chant-demo\/fan-out-estate\/actions\/runs\/6782$/);
  });
  it("answers 404 for a run no stage names, and 400 for no id", async () => {
    expect((await app().request("/api/chant/demo/runs/99")).status).toBe(404);
    expect((await app().request("/api/chant/demo/runs/x")).status).toBe(400);
  });
});

describe("/api/chant/pr on the demo's repo reads the step's keys, not the workflow's --report-url (behold#752)", () => {
  // The checkout carries the generated workflow (chant#4093) with a --report-url the demo must not follow.
  const WORKFLOW = `jobs:
  plan:
    steps:
      - run: chant components pr-plan --base "$BASE_SHA" --pr "$PR_NUMBER" --env demo --gate pr-apply --output .chant/pr --forge forgejo --report-url s3://elsewhere/never
  apply:
    steps:
      - run: chant components pr-apply --base "$BASE_SHA" --env demo --gate pr-apply --output .chant/pr --forge forgejo --require-review --report-url s3://elsewhere/never
`;
  const checkout = (name = "fan-out-estate") => {
    const dir = join(mkdtempSync(join(tmpdir(), "behold-chant-demo-")), name);
    mkdirSync(join(dir, ".forgejo", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".forgejo", "workflows", "chant-pr.yml"), WORKFLOW);
    return dir;
  };
  const noGit = async () => ({ code: 1, stdout: "", stderr: "" });
  const noLedger = { history: async () => ({ found: false, via: "none" as const, fetch: { ok: false }, read: { at: "" }, logs: [], note: "" }), git: noGit };
  const asked: string[] = [];
  const watched = (url: string): TerragucciSource => {
    const s = sourceOf(url);
    if (!s) throw new Error(`behold read ${url}`);
    return { ...s, read: async (k: string) => (asked.push(`${url}|${k}`), s.read(k)) } as TerragucciSource;
  };
  const demo = new ChantDemo({ source: FIX, sourceOf });
  const deps = { ...noLedger, reportSource: watched, demoReports: (d: string) => demo.prReports(d, noGit) };

  it("the failed merge: pr-apply's report and its events at the step's key", async () => {
    const a = await readChantPr(checkout(), MERGE_773, deps);
    expect(a.apply).toMatchObject({ from: "report", status: "failed", pr: 773, head: MERGE_773 });
    expect(a.plan).toMatchObject({ from: "report", status: "planned" });
    expect(a.live).toMatchObject({ reportUrl: REPORTS_URL, via: "step" });
    expect(a.live!.apply!.components["cluster-a"]!.state).toBe("failed");
    // chant 0.124.28 wrote these events: no `blocked` status, and no graph edges given here to name the blocker.
    expect(a.live!.apply!.components["app-01"]).toMatchObject({ state: "blocked" });
    expect(asked.some((k) => k.startsWith("s3://elsewhere"))).toBe(false);
    expect(asked).toContain(`${REPORTS_URL}|773/${MERGE_773}/pr-apply.events.jsonl`);
  });
  it("the fix's merge: the seven it applies, and the eight the change's apply landed earlier in the cycle", async () => {
    const a = await readChantPr(checkout(), MERGE_774, deps);
    expect(a.apply).toMatchObject({ from: "report", status: "applied", pr: 774 });
    expect(a.live!.earlier).toEqual({ runs: [61002], applied: ["app-07", "app-08", "app-09", "app-10", "app-11", "app-12", "cluster-b", "network"] });
  });
  it("mid-cycle, with no published cycle: the step's cycle_reports name the change's apply", async () => {
    const fix = (json("cycles/latest.json").steps as Record<string, unknown>[])[12]!;
    expect(fix).toMatchObject({ step: "applying", pull: 774 });
    const only = new ChantDemo({ source: "mem", sourceOf: (u) => (u === "mem" ? memory({ "step.json": { ...fix, cycle: 611 } }) : sourceOf(u)) });
    const a = await readChantPr(checkout(), MERGE_774, { ...noLedger, reportSource: sourceOf, demoReports: (d: string) => only.prReports(d, noGit) });
    expect(a.live!.earlier).toEqual({ runs: [runIdFor(611, 2)], applied: ["app-07", "app-08", "app-09", "app-10", "app-11", "app-12", "cluster-b", "network"] });
  });
  it("without cycle_reports, falls back to the keys the steps read so far named", async () => {
    const all = json("cycles/latest.json").steps as Record<string, unknown>[];
    const bare = (i: number) => {
      const { cycle_reports: _c, ...x } = all[i]!;
      return { ...x, cycle: 611 };
    };
    const files: Record<string, unknown> = { "step.json": bare(12) };
    const late = new ChantDemo({ source: "mem", sourceOf: (u) => (u === "mem" ? memory(files) : sourceOf(u)) });
    const deps = { ...noLedger, reportSource: sourceOf, demoReports: (d: string) => late.prReports(d, noGit) };
    // Started at the fix's apply: it never saw the change's, so it can't name what that landed.
    expect((await readChantPr(checkout(), MERGE_774, deps)).live!.earlier).toBeUndefined();
    // One that read the failed step first remembers its apply.
    const seen = new ChantDemo({ source: "mem2", sourceOf: (u) => (u === "mem2" ? { ...memory({}), read: async (k: string) => (k === "step.json" ? JSON.stringify(files["step.json"]) : undefined) } as TerragucciSource : sourceOf(u)) });
    files["step.json"] = bare(6);
    await seen.readStep();
    await new Promise((r) => setTimeout(r, 2_100));
    files["step.json"] = bare(12);
    const b = await readChantPr(checkout(), MERGE_774, { ...deps, demoReports: (d: string) => seen.prReports(d, noGit) });
    expect(b.live!.earlier?.applied).toContain("cluster-b");
  });
  it("the pull request's plan before the merge", async () => {
    const a = await readChantPr(checkout(), `pull-774-${HEAD_774}`, deps);
    expect(a.plan).toMatchObject({ from: "report", status: "planned", pr: 774 });
    expect(a.apply).toBeNull();
    // No ledger read here, and the plan's report has no approval yet.
    expect(a.gate).toMatchObject({ op: "pr-774", state: "waiting", from: "report" });
  });
  it("another served checkout reads its own loop, as before", async () => {
    expect(await demo.prReports(checkout("demo-chant"), noGit)).toBeNull();
    const runs: RunDoc[] = [];
    const a = await readChantPr(checkout("demo-chant"), MERGE_773, { ...deps, source: memory({ "runs/index.json": { schema: "demo.runs/v1", runs } }) });
    expect(a.live).toBeNull();
    expect(a.loop?.reportUrl).toBe("s3://elsewhere/never");
  });
});

describe("the pages (behold#752)", () => {
  const WEB = join(import.meta.dirname, "..", "web");
  const page = async (a: Hono, path: string) => {
    const r = await a.request(path);
    return { status: r.status, html: await r.text() };
  };
  it("--chant-demo alone: /kiosk and /chant-fanout are chant's page, told their source", async () => {
    const a = new Hono();
    kioskRoute(a, WEB, false, [], { chantDemo: true });
    vendorRoutes(a, WEB, false, [], { chantDemo: true });
    for (const p of ["/kiosk", "/chant-fanout"]) {
      const { status, html } = await page(a, p);
      expect(status).toBe(200);
      expect(html).toContain('<meta name="kiosk-tool" content="chant-fanout" />');
      expect(html).toContain('<meta name="kiosk-source" content="chant-demo" />');
      expect(html).toContain("<title>behold · chant</title>");
    }
    // The other pages need terragucci's loop; an old tool's URL goes to the root.
    expect((await page(a, "/terraform")).status).toBe(302);
  });
  it("with --terragucci too, /kiosk follows terragucci's loop and /chant-fanout reads chant's records", async () => {
    const a = new Hono();
    kioskRoute(a, WEB, true, [], { chantDemo: true });
    vendorRoutes(a, WEB, true, [], { chantDemo: true });
    expect((await page(a, "/")).html).not.toContain('name="kiosk-source"');
    expect((await page(a, "/kiosk")).status).toBe(302);
    expect((await page(a, "/chant-fanout")).html).toContain('<meta name="kiosk-source" content="chant-demo" />');
    expect((await page(a, "/tofu-fanout")).status).toBe(302);
  });
  it("without --chant-demo every page is as before: no source tag, terragucci's reads", async () => {
    const a = new Hono();
    kioskRoute(a, WEB, true, []);
    vendorRoutes(a, WEB, true, []);
    for (const p of ["/"]) {
      const { status, html } = await page(a, p);
      expect(status).toBe(200);
      expect(html).not.toContain('name="kiosk-source"');
    }
    for (const p of ["/kiosk", "/chant-fanout", "/tofu-fanout", "/choudoufu-fanout", "/choudoufu-compose", "/terragrunt-choudoufu", "/atmos-choudoufu"]) expect((await page(a, p)).status).toBe(302);
    const off = new Hono();
    kioskRoute(off, WEB, false, []);
    vendorRoutes(off, WEB, false, []);
    expect((await page(off, "/kiosk")).status).toBe(404);
    expect((await page(off, "/chant-fanout")).status).toBe(302);
  });
});

describe("a saved cycle whose bucket this behold can't reach reads reports/ beside its records (behold#765)", () => {
  // The step names s3://chant-demo/…/reports; a copy of the demo's records (`--chant-demo <dir>`) carries the same
  // keys under reports/. Before #765 every read went to the bucket, failed, and the runs and the graph's waves were empty.
  const BESIDE = `${FIX}/reports`;
  const asked: string[] = [];
  const unreachable = { kind: "s3", location: REPORTS_URL, read: async (k: string) => { asked.push(k); throw new Error("connect ECONNREFUSED"); } } as TerragucciSource;
  const offline = (u: string): TerragucciSource => (u === FIX ? records : u === BESIDE ? reportsDir : u === REPORTS_URL ? unreachable : (undefined as never));
  const noGit = async () => ({ code: 1, stdout: "", stderr: "" });
  const noLedger = { history: async () => ({ found: false, via: "none" as const, fetch: { ok: false }, read: { at: "" }, logs: [], note: "" }), git: noGit };
  const WORKFLOW = `jobs:
  plan:
    steps:
      - run: chant components pr-plan --base "$BASE_SHA" --pr "$PR_NUMBER" --env demo --gate pr-apply --output .chant/pr --forge forgejo
`;
  const checkout = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "behold-chant-demo-")), "fan-out-estate");
    mkdirSync(join(dir, ".forgejo", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".forgejo", "workflows", "chant-pr.yml"), WORKFLOW);
    return dir;
  };

  it("the runs come from the copy, not the bucket", async () => {
    const a = new Hono();
    chantDemoRoutes(a, new ChantDemo({ source: FIX, sourceOf: offline }));
    const idx = (await (await a.request("/api/chant/demo/runs")).json()) as { doc: { runs: DemoRun[] } };
    expect(idx.doc.runs.map((x) => x.status)).toEqual(["success", "success", "failure", "success"]);
    expect(asked).toEqual([]);
  });
  it("/api/chant/pr reads the demo's URL through the demo's source: the failed merge's waves and states, then the fix's", async () => {
    const demo = new ChantDemo({ source: FIX, sourceOf: offline });
    const deps = { ...noLedger, reportSource: (u: string) => demo.reportSource(u) ?? offline(u), demoReports: (d: string) => demo.prReports(d, noGit) };
    const a = await readChantPr(checkout(), MERGE_773, deps);
    expect(a.apply).toMatchObject({ from: "report", status: "failed", pr: 773 });
    expect(a.live).toMatchObject({ reportUrl: REPORTS_URL, via: "step" });
    expect(a.live!.apply!.components["cluster-a"]!.state).toBe("failed");
    expect(a.live!.apply!.components["app-01"]!.state).toBe("blocked");
    const fix = await readChantPr(checkout(), MERGE_774, deps);
    expect(fix.apply).toMatchObject({ from: "report", status: "applied", pr: 774 });
    expect(fix.live!.earlier!.applied).toContain("cluster-b");
  });
  it("answers for the demo's own URL only: another checkout's loop reads as before", async () => {
    const demo = new ChantDemo({ source: FIX, sourceOf: offline });
    expect(demo.reportSource(REPORTS_URL)).toBeUndefined(); // no read has named it yet
    await demo.entries();
    expect(demo.reportSource(REPORTS_URL)).toBeDefined();
    expect(demo.reportSource("s3://elsewhere/never")).toBeUndefined();
  });
  it("--chant-report-url is read alone: serve named it, so nothing beside the records is asked", async () => {
    const seen: string[] = [];
    const sourceOf = (u: string): TerragucciSource => (seen.push(u), u === FIX ? records : reportsDir);
    const demo = new ChantDemo({ source: FIX, reportUrl: "s3://given/reports", sourceOf });
    await demo.run((await demo.entries()).entries[0]!, "chant-demo/fan-out-estate", "s3://given/reports");
    expect(seen).toContain("s3://given/reports");
    expect(seen).not.toContain(BESIDE);
  });
  it("besideFirst: the first source's object, else the second's; the first's failure is never the caller's", async () => {
    const one = memory({ a: 1 });
    const broken = { ...one, read: async () => { throw new Error("refused"); } } as TerragucciSource;
    const two = { ...memory({ a: 2, b: 3 }), kind: "s3", location: "s3://two" } as TerragucciSource;
    expect(await besideFirst(one, two).read("a")).toBe("1");
    expect(await besideFirst(one, two).read("b")).toBe("3");
    expect(await besideFirst(broken, two).read("a")).toBe("2");
    expect(await besideFirst(one, two).read("c")).toBeUndefined();
    expect(besideFirst(one, two).location).toBe("s3://two");
  });
});
