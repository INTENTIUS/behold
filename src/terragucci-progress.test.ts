import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";

// #511: a choudoufu wave's progress per resource, from terragucci's run view.
// Two recorded run views of terragucci's example, shaped field for field on
// terragucci's report/run-view.ts and apply-progress.ts at f85b3db1, and
// valid against the vendored run.schema.json (asserted below):
// - src/__fixtures__/terragucci-run-applying.json: wave 1 applied and every
//   resource done (a finished wave), wave 2 mid-apply (two done, one in
//   flight, two waiting, one of them a resource the checkout draws no card
//   for), wave 3 not started;
// - src/__fixtures__/terragucci-run-failed.json: the same run once wave 2's
//   apply failed, what it did not finish not applied.
// The estate read is mocked, as in terragucci-route.test.ts: it needs chant's
// terraform lexicon, which CI does not have.
vi.mock("./estate.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./estate.ts")>()),
  composeEstate: vi.fn(),
}));
import { composeEstate } from "./estate.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { checkoutRoots } from "./terragucci-view.ts";
import { TerragucciReadError, terragucciValidator } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";
import { TerragucciPoller, type PollEvent, type Probe } from "./terragucci-poll.ts";
import {
  compileRunSchema,
  joinProgress,
  newestApply,
  progressKey,
  runKey,
  structuralRun,
  TerragucciProgress,
  unsettled,
  type ProgressAnswer,
  type RunView,
} from "./terragucci-progress.ts";

const HERE = import.meta.dirname;
const EXAMPLE = join(HERE, "..", "example-terragucci-reports");
const FIX = join(HERE, "__fixtures__");
const SCHEMA = join(FIX, "terragucci-schemas", "run.schema.json");
const APPLYING = join(FIX, "terragucci-run-applying.json");
const FAILED = join(FIX, "terragucci-run-failed.json");
const COMMIT = "d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2";
const KEY = `github.com/acme/shop/runs/${COMMIT}/run.json`;
const IR = (): GraphIR => ({ ...(JSON.parse(readFileSync(join(FIX, "terragucci-example-ir.json"), "utf8")) as GraphIR), edges: [], groups: {} });
const run = (f: string): RunView => JSON.parse(readFileSync(f, "utf8")) as RunView;
const schemaValidator = () => compileRunSchema(JSON.parse(readFileSync(SCHEMA, "utf8")) as object, "0.4.7");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

/** terragucci's example checkout, as far as root discovery reads it: 15 roots, a terragucci.yml, a git root. */
function checkout(): string {
  const dir = join(scratch("behold-tg-progress-"), "tg-example");
  for (const env of ["dev", "staging", "prod"]) {
    for (const svc of ["platform", "email", "orders", "payments", "search"]) {
      mkdirSync(join(dir, "envs", env, svc), { recursive: true });
      writeFileSync(join(dir, "envs", env, svc, "main.tf"), 'terraform {\n  required_version = "~> 1.13.0"\n}\n\nresource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n');
    }
  }
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "terragucci.yml"), "binary: choudoufu\n");
  return dir;
}

/** A copy of the example bucket, with `runJson` at the run view's key when given. */
function bucket(runJson?: string): string {
  const d = join(scratch("behold-tg-progress-bucket-"), "reports");
  cpSync(EXAMPLE, d, { recursive: true });
  if (runJson !== undefined) {
    mkdirSync(join(d, "github.com", "acme", "shop", "runs", COMMIT), { recursive: true });
    writeFileSync(join(d, ...KEY.split("/")), runJson);
  }
  return d;
}

const ROOTS = () => checkoutRoots([checkout()]);

function reader(source: string, o: { probe?: Probe } = {}) {
  const probe = vi.fn(o.probe ?? (async (prev: string | undefined) => ({ tag: "t1", changed: prev !== undefined && prev !== "t1" })));
  const roots = ROOTS();
  const p = new TerragucciProgress({
    source: terragucciSource(source),
    context: async () => ({ nodes: IR().nodes as never, roots }),
    probe: () => probe,
    validators: () => ({ index: terragucciValidator(), run: schemaValidator() }),
    now: () => new Date("2026-10-08T09:45:00Z"),
  });
  return { p, probe };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TerragucciReadError) return e.refusal;
    throw e;
  }
  throw new Error("expected a refusal");
};

beforeEach(() => {
  vi.mocked(composeEstate).mockReset();
  vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
});

describe("the fixtures are terragucci.run/v1 (#511)", () => {
  it("both run views pass the schema terragucci ships, and behold's structural check", () => {
    const v = schemaValidator();
    for (const f of [APPLYING, FAILED]) {
      expect(v.check(run(f))).toBeUndefined();
      expect(structuralRun(run(f))).toBeUndefined();
    }
  });

  it("a status terragucci does not write is refused by either check", () => {
    const bad = run(APPLYING);
    bad.waves[1]!.progress!.resources[0]!.status = "running" as never;
    expect(schemaValidator().check(bad)).toMatch(/run\.schema\.json rejects it/);
    expect(structuralRun(bad)).toMatch(/has status "running"/);
    expect(structuralRun({ ...bad, schema: "terragucci.run/v2" })).toMatch(/not terragucci\.run\/v1/);
  });
});

describe("which run view (#511)", () => {
  it("is the newest tf-apply commit's, beside the row's <yyyy> directory", () => {
    const rows = (JSON.parse(readFileSync(join(EXAMPLE, "index.json"), "utf8")) as { reports: never[] }).reports;
    const row = newestApply(rows, "github.com/acme/shop")!;
    expect(row.commit).toBe(COMMIT);
    expect(runKey(row)).toBe(KEY);
    // A project's own directory as the source: its rows start at <yyyy>.
    expect(runKey({ ...row, path: `2026/10/${COMMIT}/tf-apply-wave-2` })).toBe(`runs/${COMMIT}/run.json`);
    // A path behold cannot place falls back to terragucci's runViewKey from the top.
    expect(runKey({ ...row, path: "somewhere/else" })).toBe(KEY);
  });
});

describe("joinProgress: each resource's status on its card (#511)", () => {
  it("marks a mid-apply wave's cards, dated by the records read, and says what no card is", () => {
    const j = joinProgress(run(APPLYING), IR().nodes as never, ROOTS());
    expect(j.watching).toBe(true);
    expect(j.waves.map((w) => [w.number, w.state, w.read])).toEqual([
      [1, "applied", "2026-10-08T09:29:55.000Z"],
      [2, "applying", "2026-10-08T09:43:00.000Z"],
    ]);
    expect(j.waves[0]!.counts).toEqual({ done: 1, "in-flight": 0, waiting: 0, "not-applied": 0 });
    expect(j.waves[1]!.counts).toEqual({ done: 2, "in-flight": 1, waiting: 2, "not-applied": 0 });
    // Two instances of one block: the card is marked by the one still moving, and keeps both.
    const records = j.cards["tg-example/envs-prod-orders/module.service/aws_dynamodb_table.records"]!;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ wave: 2, state: "applying", read: "2026-10-08T09:43:00.000Z", status: "in-flight", counts: { done: 1, "in-flight": 1 } });
    expect(records[0]!.resources.map((r) => [r.address, r.status, r.done_at])).toEqual([
      ["module.service.aws_dynamodb_table.records[0]", "done", "2026-10-08T09:42:20.000Z"],
      ["module.service.aws_dynamodb_table.records[1]", "in-flight", undefined],
    ]);
    expect(j.cards["tg-example/envs-prod-payments/module.service/aws_sqs_queue.jobs"]![0]!.status).toBe("waiting");
    expect(j.cards["tg-example/envs-prod-platform/aws_s3_bucket.logs"]![0]).toMatchObject({ wave: 1, status: "done" });
    expect(j.unmatched).toEqual([{ root: "envs/prod/payments", address: "module.service.aws_iam_role.worker" }]);
    expect(j.waves[1]!.resources.find((r) => r.address === "module.service.aws_iam_role.worker")!.card).toBeUndefined();
  });

  it("a failed wave marks what it did not finish not applied, and is settled", () => {
    const j = joinProgress(run(FAILED), IR().nodes as never, ROOTS());
    expect(j.watching).toBe(false);
    expect(j.waves[1]!.counts).toEqual({ done: 2, "in-flight": 0, waiting: 0, "not-applied": 3 });
    expect(j.cards["tg-example/envs-prod-orders/module.service/aws_dynamodb_table.records"]![0]!.status).toBe("not-applied");
    expect(j.cards["tg-example/envs-prod-orders/module.service/aws_s3_bucket.files"]![0]!.status).toBe("done");
  });

  it("a run whose waves are all finished is settled; an applying wave without progress yet is not", () => {
    const finished = { waves: [run(APPLYING).waves[0]!] };
    expect(unsettled(finished)).toBe(false);
    expect(unsettled({ waves: [{ ...run(APPLYING).waves[2]!, state: "applying" as const }] })).toBe(true);
  });
});

describe("TerragucciProgress: the read and the poll's watch (#511)", () => {
  it("reads index.json and the newest apply's run.json, one GET each", async () => {
    const src = terragucciSource(bucket(readFileSync(APPLYING, "utf8")));
    const read = vi.spyOn(src, "read");
    const roots = ROOTS();
    const p = new TerragucciProgress({ source: src, context: async () => ({ nodes: IR().nodes as never, roots }), probe: () => async () => ({ changed: false }), now: () => new Date("2026-10-08T09:45:00Z") });
    const a = await p.answer();
    expect(read.mock.calls.map((c) => c[0])).toEqual(["index.json", KEY]);
    expect(a).toMatchObject({ project: "github.com/acme/shop", read: "2026-10-08T09:45:00.000Z", watching: true, files: "/api/terragucci/file?key=" });
    expect(a.run).toEqual({ commit: COMMIT, key: KEY, present: true, updated: "2026-10-08T09:43:00.000Z", html: `github.com/acme/shop/runs/${COMMIT}/run.html` });
    await p.answer();
    expect(read).toHaveBeenCalledTimes(2); // cached
  });

  it("says so when the source has no run view, rather than nothing applying", async () => {
    const { p, probe } = reader(bucket());
    const a = await p.answer();
    expect(a.run).toEqual({ commit: COMMIT, key: KEY, present: false });
    expect(a.absent).toContain(`has no ${KEY}`);
    expect(a.absent).toContain("says nothing about whether the apply moved");
    expect(a.watching).toBe(false);
    expect(await p.poll()).toEqual({ asked: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it("refuses a run view that is not terragucci.run/v1, naming it", async () => {
    const bad = run(APPLYING);
    bad.waves[1]!.progress!.resources[0]!.status = "running" as never;
    const r = await refusal(reader(bucket(JSON.stringify(bad))).p.answer());
    expect(r.code).toBe("terragucci-report");
    expect(r.error).toContain(KEY);
    expect(r.error).toContain("run.schema.json rejects it");
  });

  it("asks about run.json while a wave moves, pushes the progress when it changed, and stops once settled", async () => {
    const dir = bucket(readFileSync(APPLYING, "utf8"));
    const tags = ["t1", "t1", "t2", "t3"];
    const { p, probe } = reader(dir, { probe: async (prev) => { const tag = tags.shift()!; return { tag, changed: prev !== undefined && prev !== tag }; } });
    const first = await p.answer();
    expect(first.watching).toBe(true);
    // The first ask has nothing to compare with, so it reads the view again; nothing moved, so nothing is pushed.
    expect(await p.poll()).toEqual({ asked: true, key: KEY, changed: true });
    expect(await p.poll()).toEqual({ asked: true, key: KEY, changed: false });
    // The wave fails: the view changes, and the new progress is pushed whole.
    writeFileSync(join(dir, ...KEY.split("/")), readFileSync(FAILED, "utf8"));
    const moved = await p.poll();
    expect(moved).toMatchObject({ asked: true, key: KEY, changed: true });
    const pushed = moved.answer as ProgressAnswer;
    expect(pushed.watching).toBe(false);
    expect(pushed.waves[1]!.state).toBe("failed");
    expect(progressKey(pushed)).not.toBe(progressKey(first));
    // The route now serves the pushed read without another GET.
    expect(await p.answer()).toBe(pushed);
    // Every resource is done or not applied: the poll asks no more.
    expect(await p.poll()).toEqual({ asked: false });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe.mock.calls.map((c) => c[0])).toEqual([undefined, "t1", "t1"]);
  });

  it("reads a settled run once and never asks about it", async () => {
    const { p, probe } = reader(bucket(readFileSync(FAILED, "utf8")));
    expect((await p.answer()).watching).toBe(false);
    expect(await p.poll()).toEqual({ asked: false });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("the poll's progress event (#511)", () => {
  it("pushes a moved progress as a `progress` event and names the ask in `polled`", async () => {
    const answers = [{ asked: true, key: KEY, changed: true, answer: { waves: [] } }, { asked: true, key: KEY, changed: false }, { asked: false }];
    const progress = vi.fn(async () => answers.shift() ?? { asked: false });
    const poller = new TerragucciPoller({ intervalMs: 20, probe: async () => ({ tag: "t", changed: false }), lifecycle: async () => ({ branch: "chant/lifecycle", found: false, via: "fetch", fetch: { ok: true }, read: { at: "x" }, gates: [], locks: [], note: "" }) as never, progress, now: () => new Date("2026-10-08T09:45:00Z") });
    const events: PollEvent[] = [];
    const off = poller.subscribe((e) => events.push(e));
    await vi.waitFor(() => expect(events.filter((e) => e.type === "polled").length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    off();
    await poller.settled();
    const pushed = events.filter((e) => e.type === "progress");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.data).toEqual({ waves: [] });
    const polled = events.filter((e) => e.type === "polled").map((e) => (e.data as { progress?: unknown }).progress);
    expect(polled.slice(0, 3)).toEqual([{ asked: true, key: KEY, changed: true }, { asked: true, key: KEY, changed: false }, { asked: false }]);
  });

  it("says a failed ask in `polled` and still reads the lane", async () => {
    const lifecycle = vi.fn(async () => ({ branch: "chant/lifecycle", found: false, via: "fetch", fetch: { ok: true }, read: { at: "x" }, gates: [], locks: [], note: "" }) as never);
    const poller = new TerragucciPoller({ intervalMs: 60_000, probe: async () => ({ changed: false }), lifecycle, progress: async () => { throw new Error("AccessDenied"); } });
    const events: PollEvent[] = [];
    const off = poller.subscribe((e) => events.push(e));
    await vi.waitFor(() => expect(events.some((e) => e.type === "polled")).toBe(true), { timeout: 2000 });
    off();
    await poller.settled();
    const polled = events.find((e) => e.type === "polled")!.data as { progress: { error: string } };
    expect(polled.progress.error).toBe("AccessDenied");
    expect(lifecycle).toHaveBeenCalled();
  });
});

describe("GET /api/terragucci/progress (#511)", () => {
  function served(source: string) {
    const dir = checkout();
    const broadcaster = new Broadcaster();
    return createApp(
      { projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source, pollSecs: 0 } },
      broadcaster,
      new FrameBuffer(),
      new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }),
    );
  }

  it("answers each wave's resources and the cards they land on, keyed as the marks are", async () => {
    const res = await served(bucket(readFileSync(APPLYING, "utf8"))).request("/api/terragucci/progress");
    expect(res.status).toBe(200);
    const j = (await res.json()) as ProgressAnswer;
    expect(j.project).toBe("github.com/acme/shop");
    expect(j.run).toMatchObject({ commit: COMMIT, key: KEY, present: true });
    expect(j.waves.map((w) => w.number)).toEqual([1, 2]);
    expect(Object.keys(j.cards).sort()).toEqual([
      "tg-example/envs-prod-orders/module.service/aws_dynamodb_table.records",
      "tg-example/envs-prod-orders/module.service/aws_s3_bucket.files",
      "tg-example/envs-prod-payments/module.service/aws_sqs_queue.jobs",
      "tg-example/envs-prod-platform/aws_s3_bucket.logs",
    ]);
    // The same ids /api/terragucci keys its marks by.
    const marks = (await (await served(bucket(readFileSync(APPLYING, "utf8"))).request("/api/terragucci")).json()) as { cards: Record<string, unknown> };
    expect(Object.keys(marks.cards).every((id) => id.startsWith("tg-example/envs-"))).toBe(true);
    expect(j.watching).toBe(true);
    // The run page opens through the file route.
    const page = await served(bucket(readFileSync(APPLYING, "utf8"))).request(`/api/terragucci/file?key=${encodeURIComponent(KEY)}`);
    expect(page.status).toBe(200);
  });

  it("answers 422 terragucci-report for a run view it cannot read", async () => {
    const res = await served(bucket("{not json")).request("/api/terragucci/progress");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("terragucci-report");
  });

  it("adds no write route", () => {
    const app = served(bucket());
    expect(app.routes.filter((r) => r.path.startsWith("/api/terragucci") && r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(app.routes.some((r) => r.method === "GET" && r.path === "/api/terragucci/progress")).toBe(true);
  });
});
