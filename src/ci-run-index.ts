/**
 * behold#815: the kiosk's runs from chant's own run index, not the forge.
 * chant's runner (`chant ci run --report-url <url>`, chant#4098) adds each job
 * it settles to `<url>/runs/index.json` (ci-run-index/v1, read contract 1,
 * floor chant 0.124.31), newest first. A job run with `--events-json` puts its
 * run-event/v1 lines at `<url>/<key>/pr-<job>.events.jsonl`, beside its report
 * `<url>/<key>/pr-<job>.json`.
 *
 * `serve --ci-report-url <url>` (or `BEHOLD_CI_REPORT_URL`) names the URL, or
 * (#818) a served workspace declares it, `ci.reportUrl` in its ls document
 * (chant#4160, floor 0.124.32); the flag wins, and each answer's `urlFrom`
 * says which. Two routes, both GET, so `--public` keeps them:
 *
 * - `GET /api/chant/ci/runs`: the index, as the runs pane's demo.runs/v1.
 * - `GET /api/chant/ci/runs/:runId`: one run, its log built from its events
 *   (src/chant-demo.ts `demoRunOf`, the fan-out demo's own builder).
 *
 * A run is read only by a run id the index lists, and its files only under
 * that entry's `key`, which must be `reportKey(pr, commit[, member])`'s form:
 * nothing from the request reaches a path.
 *
 * The index goes through src/workspace-reader.ts (`ciRunIndexOf`, refused at
 * any contract but 1), then its floor (the `chant` that wrote it, against
 * src/chant-floors.ts), then the vendored schema. The schema is chant's file,
 * copied unchanged from {@link CI_RUN_INDEX_SCHEMA_SOURCE}; the reader leaves
 * out its `status` and `job` enums, since v1 may add to them (an apply waiting
 * at a second-round gate, chant#4159), and ignores fields it doesn't name.
 * `signer` (chant#4156) is shown only when it is a string: signing is opt-in,
 * and an unsigned run is listed like any other. An entry the schema refuses is
 * left out and counted, never the whole index.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Hono } from "hono";
import { CI_RUN_INDEX_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { demoRunOf, type DemoRun } from "./chant-demo.ts";
import { parseRunEvents } from "./chant-pr-events.ts";
import { prStageOfReport, reportSourceOf, type PrStageRead } from "./chant-pr.ts";
import ciRunIndexSchema from "./ci-run-index-schema/ci-run-index.schema.json" with { type: "json" };
import { meetsFloor } from "./floor.ts";
import { deniedWords, TerragucciDenied, type AwsRun, type TerragucciSource } from "./terragucci-source.ts";
import { ciRunIndexOf, WorkspaceReadError } from "./workspace-reader.ts";

/**
 * Where the vendored schema comes from: chant's main after chant#4162 (for
 * chant#4156), which adds `signer` and runOrigin's `repo`, `url`, `jobId` and
 * `attempt` within v1 for chant 0.124.32. chant#4114 wrote the file, and 0.124.31
 * is the first release that writes the index, which stays the floor: an index
 * without the new fields reads the same.
 */
export const CI_RUN_INDEX_SCHEMA_SOURCE = {
  repo: "INTENTIUS/chant",
  path: "packages/core/src/workspace/ci-run-index.schema.json",
  pr: 4162,
  commit: "7294bc177af165bac0bc893bf646bb48c608cea1",
  floor: "0.124.31",
} as const;

export const CI_RUN_INDEX_SCHEMA_ID: string = ciRunIndexSchema.$id;
export const CI_RUN_INDEX_KEY = "runs/index.json";
/** How long one read is shared between kiosks: the runner rewrites the index as each job settles. */
export const CI_RUNS_READ_TTL_MS = 2_000;

/** `reportKey(pr, commit[, member])`: the only keys a run's files are read under. */
const KEY = /^(?:[1-9][0-9]{0,9}|unknown)\/[0-9a-f]{40,64}(?:\/[a-z0-9][a-z0-9-]{0,39})?$/;
/** A job name a file may be named after (`pr-<job>.json`). */
const JOB = "^[a-z][a-z0-9-]{0,39}$";
/** A run id as the route takes one. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A run's status as the runs pane draws it; one chant adds later is shown by its own word. */
const STATUS: Record<string, string> = { ok: "success", fail: "failure", waiting: "waiting" };
export const runStatusOf = (status: string): string => STATUS[status] ?? status;

/**
 * chant#4156: an apply refused for one of these exits 3, as pr-apply does:
 * the plan moved since its approval, or a gate waits for one. The index
 * records the refusal as the failure's code; the pane draws the run held, not
 * failed, with {@link MOVED_WORDS}.
 */
export const MOVED_OR_WAITING: ReadonlySet<string> = new Set(["not-approved", "plan-changed", "wave-not-approved", "wave-plan-changed"]);
export const MOVED_WORDS = "the plan moved or waits: re-plan and re-approve";
/**
 * #818: refusals that are not a moved plan. An apply whose entry records its
 * `exitCode` (chant#4165) as 3 is held like a moved plan unless its failure is
 * one of these: the report refused it for another reason.
 */
const OTHER_REFUSALS: ReadonlySet<string> = new Set(["not-a-reviewer", "no-pull-request", "refused"]);

/** Why an entry is held rather than failed: its moved refusal's code, `exit 3`, or null when it isn't held. */
export function heldBy(e: Pick<CiRunEntry, "status" | "job" | "failure" | "exitCode">): string | null {
  if (e.status !== "fail") return null;
  if (e.failure && MOVED_OR_WAITING.has(e.failure.code)) return e.failure.code;
  if (e.job === "apply" && e.exitCode === 3 && !(e.failure && OTHER_REFUSALS.has(e.failure.code))) return "exit 3";
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

/** One index entry, as the schema (as the reader takes it) passed it. */
export interface CiRunEntry {
  job: string;
  pr: number | null;
  commit: string;
  status: string;
  failure?: { code: string };
  member?: string;
  started: string;
  ended: string;
  runId: string;
  key: string;
  runOrigin: { forge: string } & Record<string, unknown>;
  /** chant#4156: who signed the run's record, null or absent when nobody did. */
  signer?: string | null;
  /**
   * chant#4165, not merged as this is written: the code the job's command
   * exited with (0, 1, 3). The field's name is the one chant's session gave;
   * the vendored schema doesn't carry it yet, and an entry without it reads as
   * before.
   */
  exitCode?: number;
}

/**
 * The vendored schema as a reader takes it: `status` any string and `job` any
 * name a file can carry, since v1 may add to either; everything else as chant
 * wrote it. `which` is the envelope (its runs unchecked) or one entry.
 */
export function readerSchema(which: "envelope" | "run"): Record<string, unknown> {
  const schema = structuredClone(ciRunIndexSchema) as Record<string, any>;
  const run = schema.$defs.run.properties;
  run.status = { type: "string" };
  run.job = { type: "string", pattern: JOB };
  if (which === "envelope") {
    schema.properties.runs = { type: "array" };
    return schema;
  }
  return { $schema: schema.$schema, $defs: schema.$defs, $ref: "#/$defs/run" };
}

type Validator = ((v: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
const validators: Partial<Record<"envelope" | "run", Validator>> = {};

/** What the reader's schema says is wrong with `doc`, or undefined. */
export function schemaProblem(doc: unknown, which: "envelope" | "run"): string | undefined {
  let v = validators[which];
  if (!v) {
    const ajv = new Ajv2020({ strict: false, allErrors: false });
    v = validators[which] = ajv.compile(readerSchema(which)) as Validator;
  }
  if (v(doc)) return undefined;
  const e = v.errors?.[0];
  return e ? `${e.instancePath || (which === "run" ? "the entry" : "the index")} ${e.message ?? "does not match"}` : "it does not match the schema";
}

/** A run of the index in the runs pane's shape (demo.run/v1), plus what the index says of it. */
export interface CiRun extends Omit<DemoRun, "id" | "cycle" | "jobs" | "schema" | "event" | "trigger"> {
  /** A job chant adds within v1 has neither, and the pane calls it "a run". */
  event: "pull_request" | "push" | null;
  trigger: "plan" | "merge" | null;
  schema: "demo.run/v1";
  id: string;
  cycle: null;
  /** Which reader built it, so the pane words a gate as chant's. */
  from: "ci-run-index";
  job: string;
  member: string | null;
  failure: string | null;
  /** {@link MOVED_WORDS} for a run that exited 3, else null. */
  moved: string | null;
  /** {@link heldBy}: what says it exited 3, the refusal or `exit 3`. */
  heldBy: string | null;
  exitCode: number | null;
  signer: string | null;
  key: string;
  jobs: { id: string; name: string; needs: string[]; status: string; started_at: string | null; ended_at: string | null; steps?: DemoRun["jobs"][number]["steps"] }[];
}

/** An entry with no file read: the sidebar's row, and the run before its events are. */
export function ciRunOf(e: CiRunEntry, url: string): CiRun {
  const held = heldBy(e);
  const moved = held !== null;
  const status = moved ? "waiting" : runStatusOf(e.status);
  // A run still waiting has not ended; one that exited 3 has, and waits for the next.
  const ended = e.status === "waiting" ? null : e.ended;
  const job = `pr-${e.job}`;
  const pr = e.pr === null ? "no pull request" : `pull request #${e.pr}`;
  return {
    schema: "demo.run/v1",
    id: e.runId,
    title: `chant ci run ${e.job} · ${e.job === "apply" && e.pr !== null ? `merge of #${e.pr}` : pr}${e.member ? ` · ${e.member}` : ""}`,
    repo: "",
    status,
    event: e.job === "plan" ? "pull_request" : e.job === "apply" ? "push" : null,
    trigger: e.job === "plan" ? "plan" : e.job === "apply" ? "merge" : null,
    pull: e.pr,
    commit: e.commit,
    ref: null,
    cycle: null,
    created_at: e.started,
    started_at: e.started,
    ended_at: ended,
    reports: `${url.replace(/\/+$/, "")}/${e.key}/`,
    // chant#4156: a forge job names its run by URL, whose host is the forge's own; `forge` says only github or gitlab.
    ...(str(e.runOrigin.url) && /^https?:\/\//.test(e.runOrigin.url) ? { origin: e.runOrigin.url } : {}),
    from: "ci-run-index",
    job: e.job,
    member: e.member ?? null,
    failure: e.failure ? e.failure.code : null,
    moved: moved ? MOVED_WORDS : null,
    heldBy: held,
    exitCode: Number.isInteger(e.exitCode) ? e.exitCode! : null,
    signer: str(e.signer) && e.signer ? e.signer : null,
    key: e.key,
    jobs: [{ id: e.runId, name: job, needs: [], status, started_at: e.started, ended_at: ended }],
  };
}

/** What a run's events file held: its events, the file missing, or a read that failed. */
export type EventsRead = { events: Record<string, unknown>[]; refused: number; reason?: string } | { absent: true } | { error: string };

/**
 * One run with its log: the steps chant's fan-out demo builds from the same
 * events (`demoRunOf`), the index's status over theirs (the runner settled the
 * job). A job run without `--events-json` has no events file, and its log
 * says so in one step rather than showing none.
 */
export function ciRunWithLog(e: CiRunEntry, url: string, read: EventsRead, report?: PrStageRead): CiRun {
  const base = ciRunOf(e, url);
  const file = `pr-${e.job}.events.jsonl`;
  if (!("events" in read)) {
    const said = report?.status ? ` Its report, pr-${e.job}.json, says ${report.status}.` : "";
    const line = "absent" in read ? `chant wrote no run events for this job: it ran without --events-json, so there is no ${file} under ${e.key}.${said}` : `${read.error}${said}`;
    return { ...base, jobs: base.jobs.map((j) => ({ ...j, steps: [{ name: "run events", status: base.status === "waiting" ? "waiting" : base.status, started_at: j.started_at, ended_at: j.ended_at, log: [line] }] })) };
  }
  const stage = e.job === "apply" ? "apply" : "plan";
  const built = demoRunOf({ stage, pr: e.pr, commit: e.commit, key: e.key, id: 0, cycle: 0 }, "", url, read.events as never, report);
  const steps = (built.jobs[0]?.steps ?? []).map((s) => (s.status === "running" && base.status !== "running" ? { ...s, status: base.status === "waiting" ? "success" : base.status } : s));
  if (read.refused) steps.push({ name: "refused lines", status: "failure", started_at: null, ended_at: null, log: [`${read.refused} line${read.refused === 1 ? "" : "s"} of ${file} failed run-event/v1's schema and are not shown${read.reason ? `: ${read.reason}` : ""}.`] });
  return { ...base, ...(built.origin && !base.origin ? { origin: built.origin } : {}), jobs: base.jobs.map((j) => ({ ...j, steps })) };
}

export type CiRunsAnswer = { source: string; read: string; key: string; urlFrom?: CiReportUrlFrom } & (
  | { doc: { schema: "demo.runs/v1"; runs: CiRun[] }; chant: string; updated: string; skipped: string[] }
  | { doc: null; absent: string }
  | { doc: null; error: string; code: string; remedy?: string }
);

/** One read of the index. Never throws. */
export async function readCiRunIndex(source: TerragucciSource, url: string, now: Date = new Date()): Promise<CiRunsAnswer & { entries?: CiRunEntry[] }> {
  const base = { source: source.location, read: now.toISOString(), key: CI_RUN_INDEX_KEY };
  const where = `${CI_RUN_INDEX_KEY} at ${source.location}`;
  let text: string | undefined;
  try {
    text = await source.read(CI_RUN_INDEX_KEY);
  } catch (e) {
    if (e instanceof TerragucciDenied) return { ...base, doc: null, error: deniedWords(e, "chant's run index"), code: "ci-runs" };
    return { ...base, doc: null, error: `behold could not read ${where}: ${e instanceof Error ? e.message : String(e)}`, code: "ci-runs" };
  }
  if (text === undefined) {
    return { ...base, doc: null, absent: `There is no ${where}. chant ${CI_RUN_INDEX_CHANT_FLOOR} or newer keeps it there once \`chant ci run --report-url\` settles a job.` };
  }
  let doc: Record<string, unknown>;
  try {
    doc = ciRunIndexOf(text, where);
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ...base, doc: null, ...e.refusal };
    throw e;
  }
  // The floor, before a field is read: the index names the chant that wrote it.
  const wrote = str(doc.chant) ? doc.chant : undefined;
  if (!meetsFloor(wrote, CI_RUN_INDEX_CHANT_FLOOR)) {
    const f = floorFor("CI run index");
    return { ...base, doc: null, error: `The ${f.read} needs chant ${f.floor} or newer; the one at ${source.location} was written by chant ${wrote}.`, code: "chant-too-old", remedy: `Upgrade @intentius/chant on the CI host to ${f.floor} or newer.` };
  }
  const p = schemaProblem(doc, "envelope");
  if (p) return { ...base, doc: null, error: `${where} is not ci-run-index/v1: ${p}.`, code: "ci-runs" };
  const entries: CiRunEntry[] = [];
  const skipped: string[] = [];
  (doc.runs as unknown[]).forEach((r, i) => {
    const q = schemaProblem(r, "run") ?? (isRecord(r) && str(r.key) && !KEY.test(r.key) ? `/key ${JSON.stringify(r.key)} is not <pr>/<commit>[/<member>]` : undefined);
    if (q) skipped.push(`runs[${i}]: ${q.replace(/^\/?/, "")}`);
    else entries.push(r as CiRunEntry);
  });
  return { ...base, doc: { schema: "demo.runs/v1", runs: entries.map((e) => ciRunOf(e, url)) }, chant: wrote ?? "", updated: String(doc.updated), skipped, entries };
}

/** One run's events file and report, under its entry's key. Never throws. */
export async function readCiRun(source: TerragucciSource, url: string, e: CiRunEntry): Promise<CiRun> {
  const at = (file: string) => `${e.key}/${file}`;
  const events: EventsRead = await source.read(at(`pr-${e.job}.events.jsonl`)).then(
    (text) => (text === undefined ? { absent: true as const } : parseRunEvents(text)),
    (err) => ({ error: err instanceof TerragucciDenied ? deniedWords(err, "the run's events") : `behold could not read ${at(`pr-${e.job}.events.jsonl`)} from ${source.location}: ${err instanceof Error ? err.message : String(err)}` }),
  );
  let report: PrStageRead | undefined;
  try {
    const text = await source.read(at(`pr-${e.job}.json`));
    report = text ? prStageOfReport(JSON.parse(text), at(`pr-${e.job}.json`)) : undefined;
  } catch {
    report = undefined;
  }
  return ciRunWithLog(e, url, events, report);
}

/** A run id as the route takes one, or null. */
export const runIdOf = (raw: string): string | null => (RUN_ID.test(raw) ? raw : null);

/** #818: where the report URL came from: `--ci-report-url` (or its variable), or the workspace declaration's `ci.reportUrl`. */
export type CiReportUrlFrom = "flag" | "declaration";

/** #818: the URL the runs pane reads and which named it. The flag overrides the declaration; neither, undefined. */
export function ciReportUrlOf(flag: string | undefined, declared: string | undefined): { url: string; from: CiReportUrlFrom } | undefined {
  if (flag) return { url: flag, from: "flag" };
  return declared ? { url: declared, from: "declaration" } : undefined;
}

export interface CiRunsOptions {
  /** `--ci-report-url`: s3://, https://, file:// or a directory; or the declaration's `ci.reportUrl`. */
  url: string;
  /** #818: which named it, said in each answer as `urlFrom`. The flag when not given. */
  from?: CiReportUrlFrom;
  aws?: AwsRun;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Tests: the source the URL is read through. */
  source?: TerragucciSource;
}

/** The two routes, each read shared for {@link CI_RUNS_READ_TTL_MS}. */
export function ciRunsRoutes(app: Hono, opts: CiRunsOptions): void {
  const source = opts.source ?? reportSourceOf(opts.url, { ...(opts.aws ? { aws: opts.aws } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const now = () => (opts.now ? opts.now() : new Date());
  const urlFrom: CiReportUrlFrom = opts.from ?? "flag";
  let index: { at: number; read: ReturnType<typeof readCiRunIndex> } | undefined;
  const runs = new Map<string, { at: number; read: Promise<CiRun> }>();
  const readIndex = () => {
    const t = Date.now();
    if (!index || t - index.at >= CI_RUNS_READ_TTL_MS) index = { at: t, read: readCiRunIndex(source, opts.url, now()).then((a) => ({ ...a, urlFrom })) };
    return index.read;
  };
  const readRun = (e: CiRunEntry) => {
    const t = Date.now();
    const k = `${e.runId}|${e.status}|${e.ended}|${e.key}`;
    const hit = runs.get(k);
    if (hit && t - hit.at < CI_RUNS_READ_TTL_MS) return hit.read;
    for (const [key, v] of runs) if (t - v.at >= CI_RUNS_READ_TTL_MS) runs.delete(key);
    const read = readCiRun(source, opts.url, e);
    runs.set(k, { at: t, read });
    return read;
  };
  const statusOf = (a: CiRunsAnswer) => ("error" in a ? 502 : "absent" in a ? 404 : 200) as 200 | 404 | 502;

  app.get("/api/chant/ci/runs", async (c) => {
    const { entries: _e, ...a } = await readIndex();
    return c.json(a, statusOf(a), { "cache-control": "no-store" });
  });
  app.get("/api/chant/ci/runs/:id", async (c) => {
    const id = runIdOf(c.req.param("id"));
    if (id === null) return c.json({ error: "a run id is letters, digits and . _ : -", code: "ci-runs" }, 400);
    const a = await readIndex();
    const key = `runs/${id}`;
    if (!a.doc || !a.entries) return c.json({ ...a, entries: undefined, key }, statusOf(a), { "cache-control": "no-store" });
    const e = a.entries.find((x) => x.runId === id);
    if (!e) return c.json({ source: a.source, urlFrom, read: a.read, key, doc: null, absent: `Run ${id} is not in chant's run index (it keeps the newest 200).` }, 404, { "cache-control": "no-store" });
    return c.json({ source: a.source, urlFrom, read: a.read, key, doc: await readRun(e) }, 200, { "cache-control": "no-store" });
  });
}
