/**
 * The kiosk's pipeline runs (#569, the Actions-like view): the demo's loop
 * driver copies each pipeline run of the demo repo from its forge into the
 * reports bucket (terragucci's stack/demo.sh, format `demo.runs/v1` and
 * `demo.run/v1`), and behold reads them from there, never from the forge:
 *
 * - `GET /api/terragucci/runs`: `<prefix>/runs/index.json`, the newest runs
 *   (at most `keep`), newest first, each with its jobs and their status.
 * - `GET /api/terragucci/runs/:id`: `<prefix>/runs/<id>.json`, one run with
 *   each job's steps and each step's log tail.
 *
 * One GET of one object each, shared for {@link RUNS_READ_TTL_MS} between
 * every open kiosk, so they work with a GetObject-only identity and under
 * `--public`. The runs are read from the `--terragucci` source, or from
 * `--terragucci-runs <source>` when given (a directory of fixtures, say).
 *
 * The format is the driver's, fixed: behold checks the fields it draws and
 * hands the documents back as they are. A run the driver has pruned answers
 * 404, which the kiosk says.
 */
import type { Hono } from "hono";
import { deniedWords, TerragucciDenied, type TerragucciSource } from "./terragucci-source.ts";

export const RUNS_INDEX_KEY = "runs/index.json";
export const runKey = (id: number): string => `runs/${id}.json`;

/** How long one read of a runs object is shared between kiosks. The driver rewrites a live run every few seconds. */
export const RUNS_READ_TTL_MS = 2_000;

export const RUN_STATUSES = ["queued", "running", "waiting", "success", "failure", "cancelled", "skipped"] as const;
export const RUN_TRIGGERS = ["plan", "merge", "resume", "reset", "base", "push"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const timeOrNull = (v: unknown): boolean => v === null || v === undefined || str(v);
const status = (v: unknown): boolean => str(v) && (RUN_STATUSES as readonly string[]).includes(v);

/** What is wrong with a job, or undefined. `steps` only on a run's own document. */
function jobProblem(j: unknown, withSteps: boolean, at: string): string | undefined {
  if (!isRecord(j)) return `${at} is not an object`;
  if (!int(j.id)) return `${at}.id is not an integer`;
  if (!str(j.name)) return `${at}.name is not a string`;
  if (!Array.isArray(j.needs) || !j.needs.every(str)) return `${at}.needs is not a list of job names`;
  if (!status(j.status)) return `${at}.status is not one of ${RUN_STATUSES.join(", ")}`;
  if (!timeOrNull(j.started_at) || !timeOrNull(j.ended_at)) return `${at}'s times are neither times nor null`;
  if (withSteps) {
    if (!Array.isArray(j.steps)) return `${at}.steps is not a list`;
    for (const [i, s] of j.steps.entries()) {
      const sat = `${at}.steps[${i}]`;
      if (!isRecord(s)) return `${sat} is not an object`;
      if (!str(s.name)) return `${sat}.name is not a string`;
      if (!str(s.status)) return `${sat}.status is not a string`;
      if (!Array.isArray(s.log) || !s.log.every(str)) return `${sat}.log is not a list of lines`;
      if (s.truncated !== undefined && !int(s.truncated)) return `${sat}.truncated is not an integer`;
    }
  }
  return undefined;
}

/** What is wrong with a run, or undefined. */
function runProblem(r: unknown, withSteps: boolean, at: string): string | undefined {
  if (!isRecord(r)) return `${at} is not an object`;
  if (!int(r.id)) return `${at}.id is not an integer`;
  if (!str(r.title)) return `${at}.title is not a string`;
  if (!status(r.status)) return `${at}.status is not one of ${RUN_STATUSES.join(", ")}`;
  if (r.trigger !== null && r.trigger !== undefined && !str(r.trigger)) return `${at}.trigger is not a string`;
  if (!timeOrNull(r.created_at) || !timeOrNull(r.started_at) || !timeOrNull(r.ended_at)) return `${at}'s times are neither times nor null`;
  if (!Array.isArray(r.jobs)) return `${at}.jobs is not a list`;
  for (const [i, j] of r.jobs.entries()) {
    const p = jobProblem(j, withSteps, `${at}.jobs[${i}]`);
    if (p) return p;
  }
  return undefined;
}

/** What is wrong with a `runs/index.json`, or undefined when it is the driver's format. */
export function runsIndexProblem(doc: unknown): string | undefined {
  if (!isRecord(doc)) return "it is not an object";
  if (doc.schema !== "demo.runs/v1") return `schema is ${JSON.stringify(doc.schema)}, not demo.runs/v1`;
  if (!Array.isArray(doc.runs)) return "runs is not a list";
  for (const [i, r] of doc.runs.entries()) {
    const p = runProblem(r, false, `runs[${i}]`);
    if (p) return p;
  }
  return undefined;
}

/** What is wrong with a `runs/<id>.json`, or undefined. */
export function runProblemOf(doc: unknown, id: number): string | undefined {
  if (!isRecord(doc)) return "it is not an object";
  if (doc.schema !== "demo.run/v1") return `schema is ${JSON.stringify(doc.schema)}, not demo.run/v1`;
  if (doc.id !== id) return `its id is ${JSON.stringify(doc.id)}, not ${id}`;
  return runProblem(doc, true, "the run");
}

export type RunsAnswer = { source: string; read: string; key: string } & (
  | { doc: unknown }
  | { doc: null; absent: string }
  | { doc: null; error: string; code: "terragucci-runs" }
);

async function readDoc(source: TerragucciSource, key: string, what: string, problem: (d: unknown) => string | undefined, now: Date): Promise<RunsAnswer> {
  const base = { source: source.location, read: now.toISOString(), key };
  let body: string | undefined;
  try {
    body = await source.read(key);
  } catch (e) {
    if (e instanceof TerragucciDenied) return { ...base, doc: null, error: deniedWords(e, what), code: "terragucci-runs" };
    return { ...base, doc: null, error: `behold could not read ${key} from ${source.location}: ${e instanceof Error ? e.message : String(e)}`, code: "terragucci-runs" };
  }
  if (body === undefined) return { ...base, doc: null, absent: `${source.location} has no ${key}: the demo's loop driver writes the pipeline runs there (terragucci's stack/demo.sh).` };
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return { ...base, doc: null, error: `${key} in ${source.location} is not JSON.`, code: "terragucci-runs" };
  }
  const p = problem(doc);
  if (p) return { ...base, doc: null, error: `${key} in ${source.location} is not the driver's format: ${p}.`, code: "terragucci-runs" };
  return { ...base, doc };
}

/** One read of `runs/index.json`. Never throws. */
export function readRunsIndex(source: TerragucciSource, now: Date = new Date()): Promise<RunsAnswer> {
  return readDoc(source, RUNS_INDEX_KEY, "the demo's pipeline runs", runsIndexProblem, now);
}

/** One read of `runs/<id>.json`. Never throws. */
export function readRun(source: TerragucciSource, id: number, now: Date = new Date()): Promise<RunsAnswer> {
  return readDoc(source, runKey(id), `pipeline run ${id}`, (d) => runProblemOf(d, id), now);
}

/** A run id as the route takes one: a positive integer, nothing else. */
export function runIdOf(raw: string): number | null {
  return /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;
}

/** The two routes, each read shared for {@link RUNS_READ_TTL_MS}. */
export function terragucciRunsRoutes(app: Hono, source: TerragucciSource, opts: { now?: () => Date } = {}): void {
  const cache = new Map<string, { at: number; read: Promise<RunsAnswer> }>();
  const shared = (key: string, read: () => Promise<RunsAnswer>): Promise<RunsAnswer> => {
    const at = Date.now();
    const hit = cache.get(key);
    if (hit && at - hit.at < RUNS_READ_TTL_MS) return hit.read;
    // Old runs age off the bucket; so do their entries here.
    for (const [k, v] of cache) if (at - v.at >= RUNS_READ_TTL_MS) cache.delete(k);
    const p = read();
    cache.set(key, { at, read: p });
    return p;
  };
  const answer = (a: RunsAnswer) => {
    const status = "error" in a ? 502 : "absent" in a ? 404 : 200;
    return { body: a, status: status as 200 | 404 | 502 };
  };
  const now = () => (opts.now ? opts.now() : new Date());

  app.get("/api/terragucci/runs", async (c) => {
    const { body, status } = answer(await shared(RUNS_INDEX_KEY, () => readRunsIndex(source, now())));
    return c.json(body, status, { "cache-control": "no-store" });
  });
  app.get("/api/terragucci/runs/:id", async (c) => {
    const id = runIdOf(c.req.param("id"));
    if (id === null) return c.json({ error: "a run id is a positive integer", code: "terragucci-runs" }, 400);
    const { body, status } = answer(await shared(runKey(id), () => readRun(source, id, now())));
    return c.json(body, status, { "cache-control": "no-store" });
  });
}
