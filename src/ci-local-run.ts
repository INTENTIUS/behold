/**
 * behold#685: run a pipeline job on this machine, the way CI runs it, and
 * show it beside CI's run of the same job at the same commit.
 *
 * behold starts `chant ci run plan --local --events-json --env <env> --base
 * <sha> --commit <sha> --pr <n>` (chant#4161, floor {@link
 * CI_RUN_LOCAL_CHANT_FLOOR}) in the workspace, or in a member's directory for
 * a member's job. chant runs the job in a fresh worktree of the commit and
 * writes nothing beyond this machine: no push, no commit status, nothing
 * under a report URL and nothing in the run index. Its record stays on the
 * local chant/lifecycle with `runOrigin: {forge: "local"}`, and its events
 * say `runtime: "local"`. stdout carries the run-event/v1 lines, one per
 * line, each read through src/run-events.ts's `readRunLine` (chant's schema,
 * vendored); stderr carries the job's step output (`[<phase>] <step> | ...`)
 * and chant's summary.
 *
 * Plan only. `--local` does not make an apply safe: `ci run apply --local`
 * still changes the environment's real infrastructure and pushes release
 * records and gate facts. behold has no notion of an emulator environment
 * that would hold for it either: `serve --local` points behold's own process
 * at chant's emulators, but `ci run` gives the job a clean environment that
 * keeps HOME, so the operator's own cloud credentials would apply. An apply is
 * refused with the command to run by hand ({@link APPLY_REFUSAL}).
 *
 * The run is drawn in the runs pane's shape (demo.run/v1, web/kiosk-runs.js
 * `renderRun`): one job named after chant's Op (`pr-plan`), a step per phase
 * of the stream, each with its event lines and its step output. The verdict is
 * the stream's own `run-settle`; a stream that ends without one is `lost`.
 *
 * behold keeps the runs it started in memory, newest first, the last
 * {@link LOCAL_RUNS_KEPT}. chant keeps the record.
 */
import { execFile, spawn } from "node:child_process";
import type { Hono } from "hono";
import { stripAnsi } from "./ansi.ts";
import { resolveChant, pipeLines } from "./chant.ts";
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import { readRunLine, runEventLine, type RunLine } from "./run-events.ts";
import { pipelineForge, PIPELINE_FORGES } from "./pipeline-marks.ts";
import type { Workspace } from "./workspace.ts";
import type { Broadcaster } from "./events.ts";
import type { Runner } from "./public-mode.ts";
import type { CiRun } from "./ci-run-index.ts";

/** How many runs behold keeps in memory. */
export const LOCAL_RUNS_KEPT = 20;

/** The jobs behold runs locally. */
export const LOCAL_JOBS: readonly string[] = ["plan"];

/** Why behold does not start `ci run apply --local`. */
export const APPLY_REFUSAL =
  "behold runs plan jobs locally, never apply: chant ci run apply --local still changes the environment's real infrastructure and pushes its release records and gate facts, and the job's clean environment keeps HOME, so your own cloud credentials would apply.";

const SHA = /^[0-9a-f]{7,64}$/;
const ENV = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const ID = /^local-[a-z0-9-]{1,40}$/;

/** What a local run was asked for, checked. */
export interface LocalRunAsk {
  job: "plan";
  env: string;
  commit: string;
  base: string;
  pr: number;
  forge: string;
  member: string | null;
}

/** `chant ci run` argv for an ask. Every value is checked before it gets here. */
export function localRunArgs(a: LocalRunAsk): string[] {
  return ["ci", "run", a.job, "--local", "--events-json", "--env", a.env, "--base", a.base, "--commit", a.commit, "--pr", String(a.pr), "--forge", a.forge];
}

/** A run behold started, as it streams. */
export interface LocalRunRecord {
  id: string;
  ask: LocalRunAsk;
  args: string[];
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  events: (Record<string, unknown> & { type: string })[];
  /** stderr, line by line: the job's step output and chant's summary. */
  output: string[];
  refused: number;
  reason?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Fold one stdout line into the record. Returns the event, or null for a line that was not one. */
export function noteStdout(rec: LocalRunRecord, line: string): RunLine | null {
  const r = readRunLine(line);
  if (!r) {
    // A line on stdout that is not an event (a warning chant prints there) is kept with the output.
    if (line.trim()) rec.output.push(stripAnsi(line));
    return null;
  }
  if (r.kind === "refused") {
    rec.refused++;
    rec.reason ??= r.reason;
    return null;
  }
  // `--progress-json` never comes from ci run; a legacy line here is not read.
  if (r.kind !== "event") return null;
  rec.events.push(r.event as unknown as LocalRunRecord["events"][number]);
  return r.event;
}

const RUN_STATUS: Record<string, string> = { ok: "success", failed: "failure", gated: "waiting", waiting: "waiting" };
const STEP_STATUS: Record<string, string> = { ok: "success", failed: "failure", gated: "waiting", waiting: "waiting", skipped: "skipped" };

/** A local run in the runs pane's shape, plus what it was asked for. */
export interface LocalRun extends Omit<CiRun, "from" | "signer" | "key" | "moved"> {
  from: "chant-ci-local";
  /** chant's run id, from run-start; null until it arrives. */
  runId: string | null;
  /** The run-start's runOrigin.forge and runtime: `local` and `local` from a chant that ran it locally. */
  where: { forge: string | null; runtime: string | null };
  base: string;
  env: string;
  command: string;
}

/**
 * The run as the runs pane draws one. A step per phase, in the order chant
 * started them, holding its event lines and the step output chant tagged with
 * it (`[<phase>] ...`); what chant printed outside a phase is the last step,
 * "chant". Pure.
 */
export function localRunOf(rec: LocalRunRecord): LocalRun {
  type Step = { name: string; status: string; started_at: string | null; ended_at: string | null; log: string[] };
  const steps: Step[] = [];
  const at = (e: Record<string, unknown> | undefined): string | null => (e && str(e.at) ? e.at : null);
  const step = (name: string, e?: Record<string, unknown>): Step => {
    let s = steps.find((x) => x.name === name);
    if (!s) {
      s = { name, status: "running", started_at: at(e), ended_at: null, log: [] };
      steps.push(s);
    }
    return s;
  };
  const start = rec.events.find((e) => e.type === "run-start");
  const settle = [...rec.events].reverse().find((e) => e.type === "run-settle");
  for (const e of rec.events) {
    const phase = str(e.phase) ? e.phase : null;
    if (!phase) continue;
    const s = step(phase, e);
    const line = runEventLine(e as unknown as RunLine);
    if (line) s.log.push(line);
    if (e.type === "phase-settle" && !str(e.component)) {
      s.status = STEP_STATUS[String(e.status)] ?? "success";
      s.ended_at = at(e);
    }
  }
  // Step output: chant tags each line with its phase, as `[plan] shellCmd(...) | <line>`.
  const loose: string[] = [];
  for (const raw of rec.output) {
    const m = /^\[([^\]]+)\] (.*)$/.exec(raw);
    const s = m ? steps.find((x) => x.name === m[1]) : undefined;
    if (s && m) s.log.push(m[2]!);
    else loose.push(raw);
  }
  const ended = rec.exitCode !== null;
  let status = settle ? (RUN_STATUS[String(settle.status)] ?? "failure") : ended ? "lost" : rec.events.length ? "running" : "queued";
  if (!settle && ended && rec.exitCode !== 0 && !rec.events.length) status = "failure";
  for (const s of steps) if (s.status === "running" && status !== "running") s.status = status === "lost" ? "cancelled" : status;
  const failure = settle && isRecord(settle.failure) && str(settle.failure.code) ? settle.failure.code : null;
  const tail: string[] = [...loose];
  if (settle && str(settle.error)) tail.push(`run ${String(settle.status)}: ${settle.error}`);
  if (ended && !settle) tail.push(rec.events.length ? `chant exited ${rec.exitCode} without settling the run: the stream was lost, and the run's last settled step is where it stopped.` : `chant exited ${rec.exitCode} before the run started.`);
  if (tail.length || ended) steps.push({ name: "chant", status: ended ? (status === "lost" ? "cancelled" : status) : "running", started_at: null, ended_at: rec.endedAt, log: tail });
  if (rec.refused) steps.push({ name: "refused lines", status: "failure", started_at: null, ended_at: null, log: [`${rec.refused} line${rec.refused === 1 ? "" : "s"} on chant's stdout failed run-event/v1's schema and are not shown${rec.reason ? `: ${rec.reason}` : ""}.`] });
  const origin = start && isRecord(start.runOrigin) && str(start.runOrigin.forge) ? start.runOrigin.forge : null;
  const job = `pr-${rec.ask.job}`;
  const startedAt = at(start) ?? rec.startedAt;
  const endedAt = settle ? at(settle) : rec.endedAt;
  return {
    schema: "demo.run/v1",
    id: rec.id,
    title: `chant ci run ${rec.ask.job} --local · pull request #${rec.ask.pr}${rec.ask.member ? ` · ${rec.ask.member}` : ""} · ${rec.ask.env}`,
    repo: "",
    status,
    event: "pull_request",
    trigger: "plan",
    pull: rec.ask.pr,
    commit: rec.ask.commit,
    ref: null,
    cycle: null,
    created_at: rec.startedAt,
    started_at: startedAt,
    ended_at: endedAt,
    reports: "",
    from: "chant-ci-local",
    job: rec.ask.job,
    member: rec.ask.member,
    failure,
    runId: start && str(start.runId) ? start.runId : null,
    where: { forge: origin, runtime: start && str(start.runtime) ? start.runtime : null },
    base: rec.ask.base,
    env: rec.ask.env,
    command: `chant ${rec.args.join(" ")}`,
    jobs: [{ id: rec.id, name: job, needs: [], status, started_at: startedAt, ended_at: endedAt, steps }],
  };
}

/** Starts chant with stdout and stderr apart. Tests pass their own. */
export type SpawnChant = (args: string[], cwd: string, onStdout: (line: string) => void, onStderr: (line: string) => void) => { done: Promise<number> };

const defaultSpawn: SpawnChant = (args, cwd, onStdout, onStderr) => {
  const proc = spawn(resolveChant(cwd).bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  pipeLines(proc.stdout, onStdout);
  pipeLines(proc.stderr, onStderr);
  const done = new Promise<number>((res) => {
    proc.on("error", () => res(127));
    proc.on("close", (c) => res(c ?? 1));
  });
  return { done };
};

/** `git` in the workspace, for the commit and its base. */
export type Git = (cwd: string, args: string[]) => Promise<string>;
const defaultGit: Git = (cwd, args) =>
  new Promise((res, rej) => execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (err, out) => (err ? rej(err) : res(String(out).trim()))));

/**
 * The base a plan of `commit` is planned against, when the page names none:
 * where the commit leaves the trunk (`git merge-base` with origin's default
 * branch, else main or master), or the commit's parent when the commit is on
 * the trunk already.
 */
export async function defaultBase(git: Git, root: string, commit: string): Promise<string | null> {
  const trunks = [await git(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).catch(() => ""), "origin/main", "main", "origin/master", "master"].filter(Boolean);
  for (const t of trunks) {
    const base = await git(root, ["merge-base", t, commit]).catch(() => "");
    if (!base) continue;
    if (base !== commit) return base;
    return git(root, ["rev-parse", "--verify", "--quiet", `${commit}^`]).catch(() => null);
  }
  return git(root, ["rev-parse", "--verify", "--quiet", `${commit}^`]).catch(() => null);
}

/** CI's run of the same job at the same commit, from chant's run index. */
export type CiRunFor = (job: string, commit: string, member: string | null) => Promise<{ doc: CiRun } | { doc: null; absent: string } | { doc: null; error: string }>;

export interface LocalRunOptions {
  workspace: () => Workspace | undefined;
  runner: Runner;
  broadcaster: Broadcaster;
  /** `serve --env`: the environment a run is for when the page names none. */
  env?: string;
  preview?: () => boolean;
  /** Set when `--ci-report-url` names chant's run index. */
  ciRunFor?: CiRunFor;
  chantVersion?: (dir: string) => string | undefined;
  spawn?: SpawnChant;
  git?: Git;
  now?: () => Date;
}

type Refusal = { error: string; code: string; remedy?: string };

/**
 * The three routes. `GET /api/chant/ci/local`: what behold offers and the
 * runs it started. `POST /api/chant/ci/local`: start one, from a JSON body
 * `{job, commit, pr, env?, base?, member?, forge?}`. `GET
 * /api/chant/ci/local/:id`: one run, and CI's run of the same job at the same
 * commit when the run index is configured.
 */
export function localRunRoutes(app: Hono, opts: LocalRunOptions): void {
  const runs: LocalRunRecord[] = [];
  const git = opts.git ?? defaultGit;
  const spawnChant = opts.spawn ?? defaultSpawn;
  const now = () => (opts.now ? opts.now() : new Date());
  const versionOf = (dir: string) => (opts.chantVersion ?? ((d: string) => resolveChant(d).version))(dir);
  const floor = floorFor("local CI run");
  let seq = 0;

  /** Why nothing can start here, before any field is read. */
  const closed = (ws: Workspace | undefined): Refusal | undefined => {
    if (!ws) return { error: "behold isn't serving a declared chant workspace, so there is no pipeline job to run locally.", code: "no-workspace" };
    if (opts.preview?.()) return { error: "running a job locally is disabled in preview mode", code: "preview" };
    const version = versionOf(ws.root);
    if (!floorMet(floor, version)) return floorRefusal(floor, version);
    return undefined;
  };

  app.get("/api/chant/ci/local", (c) => {
    const ws = opts.workspace();
    const refusal = closed(ws);
    return c.json(
      {
        offer: {
          jobs: refusal ? [] : LOCAL_JOBS,
          refusal: refusal ?? null,
          apply: APPLY_REFUSAL,
          env: opts.env ?? null,
          members: ws ? ws.members.map((m) => m.name) : [],
          ciIndex: !!opts.ciRunFor,
        },
        runs: runs.map((r) => {
          const v = localRunOf(r);
          return { id: v.id, status: v.status, title: v.title, commit: v.commit, pull: v.pull, member: v.member, job: v.job, started_at: v.started_at, ended_at: v.ended_at };
        }),
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  app.post("/api/chant/ci/local", async (c) => {
    const ws = opts.workspace();
    const refusal = closed(ws);
    if (refusal) return c.json(refusal, refusal.code === "no-workspace" ? 404 : refusal.code === "preview" ? 403 : 409);
    const root = ws!.root;
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      body = isRecord(parsed) ? parsed : {};
    } catch {
      return c.json({ error: "the body is JSON: {job, commit, pr, env?, base?, member?, forge?}", code: "local-run" }, 400);
    }
    const bad = (error: string) => c.json({ error, code: "local-run" }, 400);
    if (body.job === "apply") return c.json({ error: APPLY_REFUSAL, code: "local-apply", remedy: "Run chant ci run apply --local yourself, against an environment you know is safe to change." }, 422);
    if (body.job !== "plan") return bad("job is plan");
    if (!str(body.commit) || !SHA.test(body.commit)) return bad("commit is a commit's hex sha");
    const pr = typeof body.pr === "number" ? body.pr : typeof body.pr === "string" && /^[0-9]+$/.test(body.pr) ? Number(body.pr) : NaN;
    if (!Number.isInteger(pr) || pr < 1 || pr > 999_999_999) return bad("pr is the pull request's number: chant's plan job reads it as PR_NUMBER");
    const env = str(body.env) ? body.env : opts.env;
    if (!env || !ENV.test(env)) return bad("env names the environment the pull-request pipeline is for, as chant build --pr-loop took it");
    if (body.base !== undefined && body.base !== null && body.base !== "" && !(str(body.base) && SHA.test(body.base))) return bad("base is a commit's hex sha");
    let member: Workspace["members"][number] | undefined;
    if (body.member !== undefined && body.member !== null && body.member !== "") {
      member = ws!.members.find((m) => m.name === body.member);
      if (!member) return bad(`no member named ${JSON.stringify(body.member)} in the workspace`);
    }
    let forge = str(body.forge) ? body.forge : pipelineForge(undefined, root)?.forge;
    if (!forge) return bad("behold could not tell which forge runs the pipeline (no single .github, .gitlab-ci.yml or .forgejo), so name it: forge is github, gitlab or forgejo");
    if (!(PIPELINE_FORGES as readonly string[]).includes(forge)) return bad("forge is github, gitlab or forgejo");
    const commit = await git(root, ["rev-parse", "--verify", "--quiet", `${body.commit}^{commit}`]).catch(() => "");
    if (!commit) return bad(`${body.commit} is not a commit in this checkout`);
    const base = str(body.base) ? await git(root, ["rev-parse", "--verify", "--quiet", `${body.base}^{commit}`]).catch(() => "") : await defaultBase(git, root, commit);
    if (!base) return bad(str(body.base) ? `${body.base} is not a commit in this checkout` : `behold found no base for ${commit.slice(0, 12)}: name one`);
    const ask: LocalRunAsk = { job: "plan", env, commit, base, pr, forge, member: member ? member.name : null };
    const args = localRunArgs(ask);
    const id = `local-${(++seq).toString(36)}-${now().getTime().toString(36)}`;
    const rec: LocalRunRecord = { id, ask, args, startedAt: now().toISOString(), endedAt: null, exitCode: null, events: [], output: [], refused: 0 };
    const cwd = member ? member.abs : root;
    const label = `chant ci run plan --local at ${commit.slice(0, 8)}`;
    const nudge = () => opts.broadcaster.emit("local-run", id);
    const started = opts.runner.track(label, async (io) => {
      io.line(`▶ chant ${args.join(" ")}`);
      const run = spawnChant(
        args,
        cwd,
        (line) => {
          const e = noteStdout(rec, line);
          const said = e ? runEventLine(e) : null;
          if (said) io.line(said);
          nudge();
        },
        (line) => {
          const text = stripAnsi(line);
          rec.output.push(text);
          io.line(text);
          nudge();
        },
      );
      const code = await run.done;
      rec.exitCode = code;
      rec.endedAt = now().toISOString();
      nudge();
      return code;
    });
    if (!started) return c.json({ error: `busy: ${opts.runner.running} is running`, code: "busy" }, 409);
    runs.unshift(rec);
    runs.splice(LOCAL_RUNS_KEPT);
    return c.json({ started: true, id, command: `chant ${args.join(" ")}`, cwd: member ? member.dir : "." }, 202);
  });

  app.get("/api/chant/ci/local/:id", async (c) => {
    const id = c.req.param("id");
    const rec = ID.test(id) ? runs.find((r) => r.id === id) : undefined;
    if (!rec) return c.json({ doc: null, absent: `behold has no local run ${id}: it keeps the last ${LOCAL_RUNS_KEPT} it started, in memory.` }, 404, { "cache-control": "no-store" });
    const doc = localRunOf(rec);
    const ci = opts.ciRunFor
      ? await opts.ciRunFor(rec.ask.job, rec.ask.commit, rec.ask.member).catch((e) => ({ doc: null, error: `behold could not read chant's run index: ${e instanceof Error ? e.message : String(e)}` }))
      : { doc: null, absent: "behold reads CI's runs from chant's run index, and serve has no --ci-report-url, so there is no CI run to show beside this one." };
    return c.json({ doc, ci }, 200, { "cache-control": "no-store" });
  });
}
