import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CHANT_FLOORS, CI_RUN_LOCAL_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { APPLY_REFUSAL, defaultBase, localRunArgs, localRunOf, localRunRoutes, noteStdout, type CiRunFor, type Git, type LocalRun, type LocalRunRecord, type SpawnChant } from "./ci-local-run.ts";
import { Broadcaster } from "./events.ts";
import { OpRunner } from "./op-runner.ts";
import { publicReadRefusal } from "./public-mode.ts";
import { readRunLine } from "./run-events.ts";
import type { Workspace } from "./workspace.ts";

// behold#685. The fixtures are a real recording: chant main 7f1bd9130 (the
// local pack, labelled 0.124.32) ran `chant ci run plan --local --events-json
// --env prod --forge github --base <parent> --commit <head> --pr 7` in a
// throwaway two-commit workspace with one `other` member, `app`, whose bare
// origin was left as it was. The job's own command was a stand-in given with
// `--chant` (a script that writes a report and prints one line, exiting
// FAKE_EXIT), since pr-plan itself needs a member that plans. stdout is
// `plan-<ok|failed>.events.jsonl`, stderr `plan-<ok|failed>.stderr.txt`; the
// scratch path is replaced with /tmp/behold-685 and nothing else is changed.
const FIX = join(import.meta.dirname, "__fixtures__", "ci-local-run");
const lines = (file: string) => readFileSync(join(FIX, file), "utf8").split("\n").filter(Boolean);
const OK_SHA = "4843c95071fbe0651770c4d317c509a3126c94a6";

const record = (over: Partial<LocalRunRecord> = {}): LocalRunRecord => ({
  id: "local-1-x",
  ask: { job: "plan", env: "prod", commit: OK_SHA, base: "8923f557a02049b8266d98e1cb14ca6feb08716f", pr: 7, forge: "github", member: "app" },
  args: [],
  startedAt: "2026-10-20T17:50:08.000Z",
  endedAt: null,
  exitCode: null,
  events: [],
  output: [],
  refused: 0,
  ...over,
});
const replay = (stem: string, exitCode: number | null, drop: (l: string) => boolean = () => false): LocalRunRecord => {
  const rec = record({ exitCode, endedAt: exitCode === null ? null : "2026-10-20T17:50:09.000Z" });
  for (const l of lines(`${stem}.events.jsonl`)) if (!drop(l)) noteStdout(rec, l);
  rec.output.push(...lines(`${stem}.stderr.txt`));
  return rec;
};

describe("the recorded stream (behold#685)", () => {
  it("is run-event/v1: every stdout line passes the vendored schema, and says it ran locally", () => {
    for (const stem of ["plan-ok", "plan-failed"]) {
      const read = lines(`${stem}.events.jsonl`).map(readRunLine);
      expect(read.every((r) => r?.kind === "event")).toBe(true);
      const first = (read[0] as unknown as { event: Record<string, unknown> }).event;
      expect(first).toMatchObject({ type: "run-start", kind: "pipeline", name: "pr-plan", runtime: "local", runOrigin: { forge: "local" }, chant: "0.124.32" });
    }
  });
  it("has its floor in the registry, at the release that adds --local", () => {
    expect(CI_RUN_LOCAL_CHANT_FLOOR).toBe("0.124.32");
    expect(CHANT_FLOORS).toContain(floorFor("local CI run"));
  });
});

describe("localRunOf: the run in the runs pane's shape", () => {
  it("draws a passed plan as one job with a step per phase, its step output in the phase", () => {
    const v = localRunOf(replay("plan-ok", 0));
    expect(v).toMatchObject({ schema: "demo.run/v1", from: "chant-ci-local", status: "success", trigger: "plan", pull: 7, commit: OK_SHA, member: "app", runId: "chant-1792518608689", where: { forge: "local", runtime: "local" }, failure: null });
    const steps = v.jobs[0]!.steps!;
    expect(v.jobs[0]!.name).toBe("pr-plan");
    expect(steps.map((s) => `${s.name}:${s.status}`)).toEqual(["plan:success", "chant:success"]);
    expect(steps[0]!.log).toEqual(["▶ plan · shellCmd", "✓ plan · shellCmd: ok (184ms)", "shellCmd(cmd=/tmp/behold-685/bin/chant compo...) | planned 0 changes for pr-plan"]);
    expect(steps[1]!.log.at(-1)).toBe("  local run: the record stays on this machine, with no push, commit status or report upload");
  });
  it("draws a failed plan failed, with chant's failure code", () => {
    const v = localRunOf(replay("plan-failed", 1));
    expect(v).toMatchObject({ status: "failure", failure: "command-failed" });
    expect(v.jobs[0]!.steps!.map((s) => `${s.name}:${s.status}`)).toEqual(["plan:failure", "chant:failure"]);
  });
  it("is running while chant runs, and lost when chant ends without a run-settle", () => {
    const live = localRunOf(replay("plan-ok", null, (l) => l.includes('"type":"run-settle"') || l.includes('"phase-settle"')));
    expect(live.status).toBe("running");
    expect(live.jobs[0]!.steps!.map((s) => `${s.name}:${s.status}`)).toEqual(["plan:running", "chant:running"]);
    const lost = localRunOf(replay("plan-ok", 0, (l) => l.includes('"type":"run-settle"')));
    expect(lost.status).toBe("lost");
    expect(lost.jobs[0]!.steps!.at(-1)!.log.at(-1)).toMatch(/^chant exited 0 without settling the run: the stream was lost/);
  });
  it("says so when chant refused the job before it started", () => {
    const v = localRunOf(record({ exitCode: 1, endedAt: "2026-10-20T17:50:09.000Z", output: ["error: chant ci run: the plan job reads PR_NUMBER, which a forge fills from the event; pass --pr <number>"] }));
    expect(v.status).toBe("failure");
    expect(v.jobs[0]!.steps![0]!.log).toEqual(["error: chant ci run: the plan job reads PR_NUMBER, which a forge fills from the event; pass --pr <number>", "chant exited 1 before the run started."]);
  });
  it("counts a stdout line that fails the schema and leaves it out", () => {
    const rec = replay("plan-ok", 0);
    noteStdout(rec, JSON.stringify({ $schema: "https://intentius.io/chant/schemas/workspace/run-event/v1/run-event.schema.json", contract: 1, runId: "x", seq: 9 }));
    expect(localRunOf(rec).jobs[0]!.steps!.at(-1)).toMatchObject({ name: "refused lines", status: "failure" });
  });
});

describe("the command behold starts", () => {
  it("is chant ci run plan --local --events-json, with every value named", () => {
    expect(localRunArgs(record().ask)).toEqual(["ci", "run", "plan", "--local", "--events-json", "--env", "prod", "--base", "8923f557a02049b8266d98e1cb14ca6feb08716f", "--commit", OK_SHA, "--pr", "7", "--forge", "github"]);
  });
  it("plans a branch's commit against where it leaves the trunk, and a trunk commit against its parent", async () => {
    const answers: Record<string, string> = { "rev-parse --abbrev-ref origin/HEAD": "origin/main", "merge-base origin/main aaaaaaa": "bbbbbbb", "merge-base origin/main ccccccc": "ccccccc", "rev-parse --verify --quiet ccccccc^": "ddddddd" };
    const git: Git = async (_cwd, args) => {
      const a = answers[args.join(" ")];
      if (a === undefined) throw new Error(`unexpected git ${args.join(" ")}`);
      return a;
    };
    expect(await defaultBase(git, "/w", "aaaaaaa")).toBe("bbbbbbb");
    expect(await defaultBase(git, "/w", "ccccccc")).toBe("ddddddd");
  });
});

const WS: Workspace = { name: "acme", root: "/w", file: "chant.workspace.json", chant: "0.124.32", members: [{ name: "app", dir: "app", kind: "other", abs: "/w/app", reason: null, because: "the app" }] };
const FULL = (s: string) => s.padEnd(40, "0");

/** The routes over a fake chant that replays a fixture, and a git that knows two commits. */
function served({ version = "0.124.32", preview = false, ciRunFor, hold = false }: { version?: string; preview?: boolean; ciRunFor?: CiRunFor; hold?: boolean } = {}) {
  const broadcaster = new Broadcaster();
  const said: string[] = [];
  broadcaster.subscribe((type, data) => type === "op" && said.push(data));
  const runner = new OpRunner({ projectDir: "/w", broadcaster, onDone: () => {} });
  const spawned: { args: string[]; cwd: string }[] = [];
  let release: (code: number) => void = () => {};
  const spawn: SpawnChant = (args, cwd, out, err) => {
    spawned.push({ args, cwd });
    for (const l of lines("plan-ok.events.jsonl")) out(l);
    for (const l of lines("plan-ok.stderr.txt")) err(l);
    return { done: hold ? new Promise<number>((r) => (release = r)) : Promise.resolve(0) };
  };
  const git: Git = async (_cwd, args) => {
    const key = args.join(" ");
    if (key === `rev-parse --verify --quiet ${OK_SHA.slice(0, 12)}^{commit}`) return OK_SHA;
    if (key === `rev-parse --verify --quiet ${FULL("8923f557")}^{commit}`) return FULL("8923f557");
    if (key.startsWith("rev-parse --abbrev-ref")) return "origin/main";
    if (key === `merge-base origin/main ${OK_SHA}`) return FULL("8923f557");
    throw new Error(`no ${key}`);
  };
  const app = new Hono();
  localRunRoutes(app, { workspace: () => WS, runner, broadcaster, env: "prod", preview: () => preview, chantVersion: () => version, spawn, git, ...(ciRunFor ? { ciRunFor } : {}) });
  const post = (body: unknown) => app.request("/api/chant/ci/local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, post, spawned, said, runner, release: (c: number) => release(c) };
}

describe("the routes (behold#685)", () => {
  it("starts the plan in the member's directory and answers the run, with no CI run beside it without the index", async () => {
    const s = served();
    const r = await s.post({ job: "plan", commit: OK_SHA.slice(0, 12), pr: 7, member: "app", forge: "github" });
    expect(r.status).toBe(202);
    const started = (await r.json()) as { id: string; command: string };
    expect(s.spawned).toEqual([{ args: ["ci", "run", "plan", "--local", "--events-json", "--env", "prod", "--base", FULL("8923f557"), "--commit", OK_SHA, "--pr", "7", "--forge", "github"], cwd: "/w/app" }]);
    await vi.waitFor(() => expect(s.runner.running).toBeNull());
    expect(s.said[0]).toBe(`▶ ${started.command}`);
    expect(s.said).toContain("✓ plan · shellCmd: ok (184ms)");
    const one = (await (await s.app.request(`/api/chant/ci/local/${started.id}`)).json()) as { doc: LocalRun; ci: { doc: null; absent: string } };
    expect(one.doc).toMatchObject({ status: "success", where: { forge: "local", runtime: "local" } });
    expect(one.ci.absent).toMatch(/no --ci-report-url/);
    const list = (await (await s.app.request("/api/chant/ci/local")).json()) as { offer: { jobs: string[]; refusal: null; apply: string }; runs: { id: string }[] };
    expect(list.offer).toMatchObject({ jobs: ["plan"], refusal: null, apply: APPLY_REFUSAL, env: "prod", members: ["app"], ciIndex: false });
    expect(list.runs.map((x) => x.id)).toEqual([started.id]);
  });
  it("answers CI's run of the same job at the same commit beside it", async () => {
    const asked: unknown[] = [];
    const ci = { schema: "demo.run/v1", id: "6783", status: "success" };
    const s = served({ ciRunFor: async (...a) => (asked.push(a), { doc: ci as never }) });
    const { id } = (await (await s.post({ job: "plan", commit: OK_SHA.slice(0, 12), pr: 7, forge: "github" })).json()) as { id: string };
    const one = (await (await s.app.request(`/api/chant/ci/local/${id}`)).json()) as { ci: { doc: unknown } };
    expect(one.ci.doc).toEqual(ci);
    expect(asked).toEqual([["plan", OK_SHA, null]]);
  });
  it("never starts an apply, and says why", async () => {
    const s = served();
    const r = await s.post({ job: "apply", commit: OK_SHA.slice(0, 12), pr: 7, forge: "github" });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ code: "local-apply", error: APPLY_REFUSAL });
    expect(s.spawned).toEqual([]);
  });
  it("refuses below the floor, naming the chant that adds --local, and offers no job", async () => {
    const s = served({ version: "0.124.31" });
    const r = await s.post({ job: "plan", commit: OK_SHA.slice(0, 12), pr: 7, forge: "github" });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "chant-too-old", error: "Local CI run needs chant 0.124.32 or newer. This project has chant 0.124.31." });
    const offer = ((await (await s.app.request("/api/chant/ci/local")).json()) as { offer: { jobs: string[]; refusal: { code: string } } }).offer;
    expect(offer.jobs).toEqual([]);
    expect(offer.refusal.code).toBe("chant-too-old");
    expect(s.spawned).toEqual([]);
  });
  it("refuses in preview mode, a missing pull request, an unknown member or commit, and a second run while one runs", async () => {
    expect((await served({ preview: true }).post({ job: "plan", commit: OK_SHA, pr: 7, forge: "github" })).status).toBe(403);
    const s = served({ hold: true });
    expect(await (await s.post({ job: "plan", commit: OK_SHA.slice(0, 12), forge: "github" })).json()).toMatchObject({ code: "local-run", error: expect.stringMatching(/^pr is the pull request's number/) });
    expect((await s.post({ job: "plan", commit: OK_SHA.slice(0, 12), pr: 7, member: "../etc", forge: "github" })).status).toBe(400);
    expect((await s.post({ job: "plan", commit: "zzz", pr: 7, forge: "github" })).status).toBe(400);
    expect((await s.post({ job: "plan", commit: "abcdef0", pr: 7, forge: "github" })).status).toBe(400);
    expect((await s.post({ job: "plan", commit: OK_SHA.slice(0, 12), pr: 7, forge: "github" })).status).toBe(202);
    expect(await (await s.post({ job: "plan", commit: OK_SHA.slice(0, 12), pr: 7, forge: "github" })).json()).toMatchObject({ code: "busy" });
    s.release(0);
    await vi.waitFor(() => expect(s.runner.running).toBeNull());
    expect(s.spawned).toHaveLength(1);
  });
  it("is refused whole in a public view", () => {
    expect(publicReadRefusal("/api/chant/ci/local", new URLSearchParams())).toMatch(/a public view starts nothing/);
    expect(publicReadRefusal("/api/chant/ci/local/local-1-x", new URLSearchParams())).toBeDefined();
  });
});
