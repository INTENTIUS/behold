import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CHANT_FLOORS, CI_RUN_INDEX_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import ciRunIndexSchema from "./ci-run-index-schema/ci-run-index.schema.json" with { type: "json" };
import { CI_RUN_INDEX_SCHEMA_ID, CI_RUN_INDEX_SCHEMA_SOURCE, ciReportUrlOf, ciRunsRoutes, ciRunWithLog, readCiRunIndex, readerSchema, runIdOf, type CiRun, type CiRunEntry } from "./ci-run-index.ts";
import { kioskRoute, vendorRoutes } from "./terragucci-demo.ts";
import { terragucciSource, TerragucciDenied, type TerragucciSource } from "./terragucci-source.ts";

// behold#815: chant's run index. The fixture is hand-made: chant ci run needs
// a forge-shaped checkout to run a job, so the index was written by hand to
// ci-run-index/v1 over the fan-out demo's four real stages (their run-event/v1
// and pr-report/v1 files, src/__fixtures__/chant-demo/reports), plus a member's
// plan with no events file and a signer. It validates against the vendored
// schema below, and chant 0.124.31's `chant ci runs --report-url file://…`
// lists all five entries from it.
const REPORTS = join(import.meta.dirname, "__fixtures__", "chant-demo", "reports");
const URL = "s3://chant-demo/fan-out-estate/reports";
const fixture = terragucciSource(REPORTS);
const indexDoc = () => JSON.parse(readFileSync(join(REPORTS, "runs", "index.json"), "utf8")) as Record<string, unknown> & { runs: Record<string, unknown>[] };
/** A source holding the fixture with the index replaced by `doc`. */
const withIndex = (doc: unknown): TerragucciSource => ({ ...fixture, read: async (k: string) => (k === "runs/index.json" ? JSON.stringify(doc) : fixture.read(k)) });

describe("the vendored schema (behold#815)", () => {
  it("is chant's, named by its commit, and the fixture validates against it unchanged", () => {
    expect(CI_RUN_INDEX_SCHEMA_ID).toBe("https://intentius.io/chant/schemas/workspace/ci-run-index/v1/ci-run-index.schema.json");
    expect(CI_RUN_INDEX_SCHEMA_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    const v = new Ajv2020({ strict: false }).compile(ciRunIndexSchema);
    expect(v(indexDoc())).toBe(true);
  });
  it("is read without its status and job enums, which v1 may add to (chant#4159)", () => {
    const run = (readerSchema("run").$defs as Record<string, { properties: Record<string, unknown> }>).run!.properties;
    expect(run.status).toEqual({ type: "string" });
    expect(run.job).toEqual({ type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$" });
    // The vendored file keeps chant's enums; only the reader leaves them out.
    expect(ciRunIndexSchema.$defs.run.properties.status.enum).toEqual(["ok", "fail"]);
  });
  it("has its floor in the registry, at the release that first writes the index", () => {
    expect(CI_RUN_INDEX_CHANT_FLOOR).toBe(CI_RUN_INDEX_SCHEMA_SOURCE.floor);
    expect(CHANT_FLOORS).toContain(floorFor("CI run index"));
  });
});

describe("readCiRunIndex", () => {
  it("reads the runs newest first, each in the runs pane's shape", async () => {
    const a = await readCiRunIndex(fixture, URL);
    expect("doc" in a && a.doc).toBeTruthy();
    if (!a.doc) return;
    expect(a).toMatchObject({ chant: "0.124.31", updated: "2026-10-19T02:31:40.512Z", skipped: [] });
    expect(a.doc.runs.map((r) => `${r.id} ${r.job} ${r.status}`)).toEqual(["chant-1792376662004 plan success", "6784 apply success", "6783 plan success", "6782 apply failure", "6780 plan success"]);
    const [member, , , failed] = a.doc.runs;
    expect(member).toMatchObject({ schema: "demo.run/v1", from: "ci-run-index", member: "web", signer: "ci-runner@chant-demo", trigger: "plan", pull: 775, reports: `${URL}/775/9b1e3f0c2d4a5b6c7d8e9f00112233445566778a/web/` });
    expect(member!.jobs).toEqual([{ id: "chant-1792376662004", name: "pr-plan", needs: [], status: "success", started_at: "2026-10-19T02:31:02.004Z", ended_at: "2026-10-19T02:31:40.410Z" }]);
    expect(failed).toMatchObject({ failure: "failed", moved: null, signer: null, member: null, trigger: "merge", title: "chant ci run apply · merge of #773" });
    // chant#4156: the forge's run by its URL, the real host; `forge: "github"` is not shown.
    expect(failed!.origin).toBe("http://forgejo:3000/chant-demo/fan-out-estate/actions/runs/6782");
    expect(member!.origin).toBeUndefined();
  });
  it("draws an apply that exited 3 (the plan moved, or a gate waits) as held, not failed (chant#4156)", async () => {
    const d = indexDoc();
    for (const [i, code] of [[1, "plan-changed"], [2, "wave-not-approved"]] as const) d.runs[i] = { ...d.runs[i], status: "fail", failure: { code } };
    const a = await readCiRunIndex(withIndex(d), URL);
    expect(a.doc!.runs.slice(1, 4).map((r) => [r.status, r.moved, r.failure, r.ended_at !== null])).toEqual([
      ["waiting", "the plan moved or waits: re-plan and re-approve", "plan-changed", true],
      ["waiting", "the plan moved or waits: re-plan and re-approve", "wave-not-approved", true],
      ["failure", null, "failed", true],
    ]);
  });
  // #818: exitCode follows chant#4165, which hasn't merged; the vendored schema doesn't name it.
  it("draws an apply whose entry says it exited 3, with no refusal, as held the same way (chant#4165)", async () => {
    const d = indexDoc();
    // The schema asks a failed entry for its failure, so "no refusal" is a code that isn't one.
    d.runs[1] = { ...d.runs[1], status: "fail", failure: { code: "command-failed" }, exitCode: 3 };
    d.runs[3] = { ...d.runs[3], exitCode: 3 };
    d.runs[2] = { ...d.runs[2], status: "fail", failure: { code: "failed" }, exitCode: 3 };
    d.runs[4] = { ...d.runs[4], status: "fail", failure: { code: "failed" }, exitCode: 3 };
    const a = await readCiRunIndex(withIndex(d), URL);
    expect(a.doc!.runs.slice(1).map((r) => [r.job, r.status, r.moved, r.heldBy, r.exitCode])).toEqual([
      ["apply", "waiting", "the plan moved or waits: re-plan and re-approve", "exit 3", 3],
      // A plan that exited 3 is not an apply held at its approval.
      ["plan", "failure", null, null, 3],
      ["apply", "waiting", "the plan moved or waits: re-plan and re-approve", "exit 3", 3],
      ["plan", "failure", null, null, 3],
    ]);
  });
  it("keeps a failure whose report refused it for another reason, and reads an entry without exitCode as before", async () => {
    const d = indexDoc();
    d.runs[3] = { ...d.runs[3], failure: { code: "not-a-reviewer" }, exitCode: 3 };
    const a = await readCiRunIndex(withIndex(d), URL);
    expect(a.doc!.runs[3]).toMatchObject({ status: "failure", moved: null, heldBy: null, failure: "not-a-reviewer", exitCode: 3 });
    // An approver who wrote the change is a refusal too (chant#4145), never a moved plan.
    d.runs[3] = { ...d.runs[3], failure: { code: "author-approved" }, exitCode: 3 };
    expect((await readCiRunIndex(withIndex(d), URL)).doc!.runs[3]).toMatchObject({ status: "failure", heldBy: null });
    const before = (await readCiRunIndex(fixture, URL)).doc!.runs;
    expect(before.map((r) => [r.status, r.moved, r.exitCode])).toEqual(before.map((r) => [r.status, null, null]));
    expect(before[3]).toMatchObject({ status: "failure", failure: "failed", heldBy: null });
  });
  it("links no origin that is not an http(s) URL", async () => {
    const d = indexDoc();
    d.runs[1] = { ...d.runs[1], runOrigin: { forge: "github", url: "javascript:alert(1)" } };
    expect((await readCiRunIndex(withIndex(d), URL)).doc!.runs[1]!.origin).toBeUndefined();
  });
  it("tolerates what v1 adds: a field it doesn't know, a status and a job it doesn't know, a run waiting at a gate", async () => {
    const d = indexDoc();
    d.runs[0] = { ...d.runs[0], later: { added: true }, status: "waiting" };
    d.runs[1] = { ...d.runs[1], status: "cancelled-by-host", job: "verify" };
    d.later = 1;
    const a = await readCiRunIndex(withIndex(d), URL);
    if (!a.doc) throw new Error(JSON.stringify(a));
    expect(a.doc.runs[0]).toMatchObject({ status: "waiting", ended_at: null });
    expect(a.doc.runs[1]).toMatchObject({ status: "cancelled-by-host", job: "verify", trigger: null, event: null });
    expect(a.skipped).toEqual([]);
  });
  it("never needs a signer: a run without one, or with null, reads the same", async () => {
    const d = indexDoc();
    d.runs[0] = { ...d.runs[0], signer: null };
    const a = await readCiRunIndex(withIndex(d), URL);
    expect(a.doc!.runs[0]!.signer).toBeNull();
    expect(a.doc!.runs).toHaveLength(5);
  });
  it("leaves out an entry the schema refuses, or whose key is not reportKey's form, and says which", async () => {
    const d = indexDoc();
    d.runs[1] = { ...d.runs[1], key: "../../etc" };
    const { runId: _r, ...noId } = d.runs[2]!;
    d.runs[2] = noId;
    const a = await readCiRunIndex(withIndex(d), URL);
    expect(a.doc!.runs.map((r) => r.id)).toEqual(["chant-1792376662004", "6782", "6780"]);
    expect("skipped" in a && a.skipped).toEqual([expect.stringMatching(/^runs\[1\]: key "\.\.\/\.\.\/etc" is not/), expect.stringMatching(/^runs\[2\]: .*runId/)]);
  });
  it("refuses another contract through the workspace reader", async () => {
    const a = await readCiRunIndex(withIndex({ ...indexDoc(), contract: 2 }), URL);
    expect(a).toMatchObject({ doc: null, code: "workspace-contract", error: "chant ci runs wrote a document with contract 2; behold reads contract 1." });
  });
  it("refuses an index written by a chant below the floor, naming both", async () => {
    const a = await readCiRunIndex(withIndex({ ...indexDoc(), chant: "0.124.30" }), URL);
    expect(a).toMatchObject({ doc: null, code: "chant-too-old" });
    expect("error" in a && a.error).toBe(`The CI run index needs chant 0.124.31 or newer; the one at ${REPORTS} was written by chant 0.124.30.`);
  });
  it("says where the index is missing, and what writes it", async () => {
    const a = await readCiRunIndex({ ...fixture, read: async () => undefined }, URL);
    expect("absent" in a && a.absent).toMatch(/There is no runs\/index\.json at .*chant 0\.124\.31 or newer keeps it there once `chant ci run --report-url` settles a job\./);
  });
  it("says what a refused read needs, and what is not JSON", async () => {
    const denied = await readCiRunIndex({ ...fixture, read: async () => { throw new TerragucciDenied("runs/index.json", "s3://b/runs/index.json", "s3"); } }, URL);
    expect("error" in denied && denied.error).toMatch(/grant s3:GetObject on runs\/index\.json/);
    const junk = await readCiRunIndex({ ...fixture, read: async () => "{" }, URL);
    expect(junk).toMatchObject({ code: "ci-runs", error: expect.stringMatching(/is not JSON/) });
  });
});

const entry = (over: Partial<CiRunEntry> = {}): CiRunEntry => ({ ...(indexDoc().runs[3] as unknown as CiRunEntry), ...over });

describe("a run's log (ciRunWithLog)", () => {
  it("is the events' own lines, built as the fan-out demo builds them, with the index's status", () => {
    const events = readFileSync(join(REPORTS, "773/a7cf3abc45abd6f77d8835939e0ceca3a6b88440/pr-apply.events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const r = ciRunWithLog(entry(), URL, { events, refused: 0 });
    expect(r.status).toBe("failure");
    const steps = r.jobs[0]!.steps!;
    expect(steps.map((s) => s.name)).toEqual(["plan", "gate", "wave 1", "wave 2", "wave 3"]);
    expect(steps.flatMap((s) => s.log).some((l) => /cluster-a: failed/.test(l))).toBe(true);
    expect(r.origin).toMatch(/actions\/runs\/6782$/);
  });
  it("says a job ran without --events-json, rather than drawing an empty log", () => {
    const r = ciRunWithLog(entry(), URL, { absent: true });
    expect(r.jobs[0]!.steps).toEqual([
      expect.objectContaining({ name: "run events", status: "failure", log: ["chant wrote no run events for this job: it ran without --events-json, so there is no pr-apply.events.jsonl under 773/a7cf3abc45abd6f77d8835939e0ceca3a6b88440."] }),
    ]);
  });
  it("says what a refused events read needs, and counts lines the schema refused", () => {
    expect(ciRunWithLog(entry(), URL, { error: "denied" }).jobs[0]!.steps![0]!.log).toEqual(["denied"]);
    const r = ciRunWithLog(entry(), URL, { events: [], refused: 2, reason: "/type must be equal to one of the allowed values" });
    expect(r.jobs[0]!.steps!.at(-1)).toMatchObject({ name: "refused lines", log: ["2 lines of pr-apply.events.jsonl failed run-event/v1's schema and are not shown: /type must be equal to one of the allowed values."] });
  });
});

describe("GET /api/chant/ci/runs (behold#815)", () => {
  const app = (source: TerragucciSource = fixture) => {
    const a = new Hono();
    ciRunsRoutes(a, { url: URL, source });
    return a;
  };
  it("answers the index as the runs pane reads it", async () => {
    const r = await app().request("/api/chant/ci/runs");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { doc: { schema: string; runs: CiRun[] }; entries?: unknown };
    expect(body.doc.schema).toBe("demo.runs/v1");
    expect(body.doc.runs).toHaveLength(5);
    expect(body.entries).toBeUndefined();
  });
  it("answers one run with its log, read under its own key", async () => {
    const reads: string[] = [];
    const watched: TerragucciSource = { ...fixture, read: (k) => (reads.push(k), fixture.read(k)) };
    const r = (await (await app(watched).request("/api/chant/ci/runs/6784")).json()) as { doc: CiRun };
    expect(r.doc).toMatchObject({ id: "6784", status: "success", job: "apply" });
    expect(r.doc.jobs[0]!.steps!.length).toBeGreaterThan(1);
    expect(reads.sort()).toEqual(["774/80eef4a5e0eb747fddb04a7067e91ea59dd8dade/pr-apply.events.jsonl", "774/80eef4a5e0eb747fddb04a7067e91ea59dd8dade/pr-apply.json", "runs/index.json"]);
  });
  it("answers the member's run, which has no events file, with a log that says so", async () => {
    const r = (await (await app().request("/api/chant/ci/runs/chant-1792376662004")).json()) as { doc: CiRun };
    expect(r.doc.jobs[0]!.steps![0]!.log[0]).toMatch(/^chant wrote no run events for this job: it ran without --events-json/);
  });
  it("reads only a run the index lists: another id is 404, a malformed one 400", async () => {
    expect((await app().request("/api/chant/ci/runs/9999")).status).toBe(404);
    expect((await app().request("/api/chant/ci/runs/..%2F..%2Fetc")).status).toBe(400);
    expect(runIdOf("../x")).toBeNull();
    expect(runIdOf("chant-1792376662004")).toBe("chant-1792376662004");
  });
  it("says which named the URL: the flag unless told the declaration did (#818)", async () => {
    expect(await (await app().request("/api/chant/ci/runs")).json()).toMatchObject({ urlFrom: "flag" });
    const a = new Hono();
    ciRunsRoutes(a, { url: URL, from: "declaration", source: fixture });
    expect(await (await a.request("/api/chant/ci/runs")).json()).toMatchObject({ urlFrom: "declaration" });
    expect(await (await a.request("/api/chant/ci/runs/6784")).json()).toMatchObject({ urlFrom: "declaration" });
    expect(await (await a.request("/api/chant/ci/runs/9999")).json()).toMatchObject({ urlFrom: "declaration" });
  });
  it("takes the flag over the declaration, the declaration without the flag, and neither as no runs pane of chant's (#818)", () => {
    expect(ciReportUrlOf("s3://flag/reports", "s3://acme-ci/reports")).toEqual({ url: "s3://flag/reports", from: "flag" });
    expect(ciReportUrlOf(undefined, "s3://acme-ci/reports")).toEqual({ url: "s3://acme-ci/reports", from: "declaration" });
    expect(ciReportUrlOf("", undefined)).toBeUndefined();
  });
  it("answers the refusal on both routes when the index is refused", async () => {
    const old = app(withIndex({ ...indexDoc(), chant: "0.124.20" }));
    const a = await old.request("/api/chant/ci/runs");
    expect(a.status).toBe(502);
    expect(await a.json()).toMatchObject({ code: "chant-too-old", remedy: "Upgrade @intentius/chant on the CI host to 0.124.31 or newer." });
    expect((await old.request("/api/chant/ci/runs/6784")).status).toBe(502);
  });
});

describe("CI's run of a job at a commit, for a local run beside it (behold#685)", () => {
  const lookup = (source: TerragucciSource = fixture) => ciRunsRoutes(new Hono(), { url: URL, source });
  it("finds the job at the commit, and the member's run only for the member", async () => {
    expect(await lookup()("plan", "47f4df6dc66e00aa3cff1d8a1512554ee3bb8404", null)).toMatchObject({ doc: { id: "6783", job: "plan", status: "success" } });
    expect(await lookup()("plan", "9b1e3f0c2d4a5b6c7d8e9f00112233445566778a", "web")).toMatchObject({ doc: { id: "chant-1792376662004", member: "web" } });
    expect(await lookup()("plan", "9b1e3f0c2d4a5b6c7d8e9f00112233445566778a", null)).toMatchObject({ doc: null, absent: expect.stringMatching(/^chant's run index has no plan job at 9b1e3f0c2d4a/) });
    // An apply at a plan's commit is another job.
    expect((await lookup()("apply", "47f4df6dc66e00aa3cff1d8a1512554ee3bb8404", null)).doc).toBeNull();
  });
  it("says why when the index is refused", async () => {
    expect(await lookup(withIndex({ ...indexDoc(), chant: "0.124.20" }))("plan", "47f4df6dc66e00aa3cff1d8a1512554ee3bb8404", null)).toMatchObject({ doc: null, error: expect.stringContaining("needs chant 0.124.31") });
  });
});

describe("the kiosk page names chant's run index only when serve has --ci-report-url", () => {
  const web = join(import.meta.dirname, "..", "web");
  const page = async (ciRuns: boolean, path: string) => {
    const a = new Hono();
    kioskRoute(a, web, true, [], { ciRuns });
    vendorRoutes(a, web, true, [], { ciRuns, chantDemo: true });
    return (await a.request(path)).text();
  };
  it("tags /kiosk and a tool's page with it, and leaves them as they were without it", async () => {
    for (const path of ["/kiosk", "/terraform", "/chant-fanout"]) {
      expect(await page(true, path)).toContain('<meta name="kiosk-runs" content="chant-ci" />');
      expect(await page(false, path)).not.toContain("kiosk-runs");
    }
  });
});
