/**
 * behold#571: a pipeline run's traces from Tempo, for the kiosk's "Trace"
 * view of a job (web/kiosk-trace.js).
 *
 * terragucci sends each stage as one trace over OTLP to a collector, which
 * passes it to Tempo (terragucci's reference/observability). Each trace's
 * resource names the run: `terragucci.project`, `vcs.ref.head.revision`,
 * `cicd.pipeline.run.id` and `cicd.pipeline.task.name` (the job). behold
 * reads them from the Tempo `--tempo <url>` (or BEHOLD_TEMPO_URL) names, with
 * FIXED queries only:
 *
 * - a search by run id or by commit, from {@link searchQuery}: a constant
 *   TraceQL template whose one value is checked to be digits or hex first;
 * - a trace fetched by the id a search returned.
 *
 * A viewer never sends TraceQL, and the answer is a trimmed span tree per
 * job, never Tempo's own document: `GET /api/traces?project=<owner>/<name>&
 * run=<id>[&job=<name>]` (or `&commit=<sha>` in place of `run`). A search is
 * shared for {@link SEARCH_TTL_MS} and a trace for {@link TRACE_TTL_MS}, so
 * any number of open kiosks ask Tempo at most that often. Without an address
 * the route answers 404 and the kiosk shows no Trace view.
 *
 * Nothing here writes, and the route is a GET, so `--public` keeps it.
 */
import type { Hono } from "hono";
import { projectIs, validCommit, validRepo } from "./prometheus-metrics.ts";

/** How long one search of Tempo is shared between kiosks. A wave's trace lands when its job ends. */
export const SEARCH_TTL_MS = 10_000;
/** How long one fetched trace is shared. A stage sends its trace once, at its end. */
export const TRACE_TTL_MS = 60_000;
/** How many fetched traces are kept. */
export const TRACE_CACHE_MAX = 200;
/** How many traces a search returns: a run's jobs, with room for their re-runs. */
export const SEARCH_LIMIT = 40;
/** How far back a search looks; the demo's Tempo keeps 24 hours. */
export const SEARCH_WINDOW_S = 48 * 3600;
/** The most spans one job's tree carries; the rest are counted, not sent. */
export const MAX_SPANS = 1500;

/** A run id as the route takes one: a positive integer. */
const RUN = /^[1-9][0-9]{0,15}$/;
/** A job name as forges write them. */
const JOB = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,99}$/;

export const validRun = (v: string | undefined): v is string => !!v && RUN.test(v);
export const validJob = (v: string | undefined): v is string => !!v && JOB.test(v);

/**
 * The one TraceQL search behold asks: terragucci's traces of a run, or of a
 * commit. The value is checked here as well as at the route: a run id is
 * digits, a commit hex, so neither can carry a quote or an operator.
 */
export function searchQuery(by: { run: string } | { commit: string }): string {
  if ("run" in by) {
    if (!validRun(by.run)) throw new Error("a run id is digits");
    return `{ resource.service.name = "terragucci" && resource."cicd.pipeline.run.id" = "${by.run}" }`;
  }
  if (!validCommit(by.commit)) throw new Error("a commit is hex");
  return by.commit.length === 40 || by.commit.length === 64
    ? `{ resource.service.name = "terragucci" && resource."vcs.ref.head.revision" = "${by.commit}" }`
    : `{ resource.service.name = "terragucci" && resource."vcs.ref.head.revision" =~ "${by.commit}.*" }`;
}

/** The span attributes the view reads; every other attribute stays in Tempo. */
export const KEPT_ATTRIBUTES = [
  "terragucci.stage",
  "terragucci.phase",
  "terragucci.wave",
  "terragucci.root",
  "terragucci.result",
  "terragucci.status",
  "terragucci.gate.status",
  "terragucci.gate.held_seconds",
  "terragucci.gate.waiting_since",
  "terragucci.gate.approved_at",
  "terragucci.wait",
  "process.exit.code",
  "opentofu.resource_instance.address",
  "opentofu.resource_instance.action",
  "opentofu.resource.address",
  "opentofu.resource.type",
  "opentofu.provider.address",
  "opentofu.provider.source",
  "opentofu.state.backend",
  "rpc.method",
] as const;

export interface TraceSpan {
  id: string;
  parent: string | null;
  name: string;
  /** Who sent it: `terragucci`, or the binary (OpenTofu, choudoufu). */
  service: string;
  /** Unix milliseconds, to the microsecond. */
  start: number;
  /** Milliseconds, to the microsecond. */
  ms: number;
  error?: string;
  attrs: Record<string, string | number | boolean>;
}

export interface JobTrace {
  trace_id: string;
  /** terragucci's project name, `<forge host>/<owner>/<name>`. */
  project: string;
  /** The job, from `cicd.pipeline.task.name`, or null when the trace names none. */
  job: string | null;
  stage: string | null;
  wave: number | null;
  result: string | null;
  commit: string | null;
  start: number;
  ms: number;
  spans: TraceSpan[];
  /** Spans past {@link MAX_SPANS}, not sent. */
  left_out: number;
}

export interface TracesAnswer {
  read: string;
  repo: string;
  project: string | null;
  run: string | null;
  commit: string | null;
  /** Every trace of the run (of the job, when one was asked for), oldest first. */
  traces: JobTrace[];
  /** The jobs that have a trace, whether or not one was asked for. */
  jobs: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** An OTLP AnyValue's scalar. */
function scalar(v: unknown): string | number | boolean | undefined {
  if (!isObj(v)) return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.intValue === "string" || typeof v.intValue === "number") return Number(v.intValue);
  if (typeof v.doubleValue === "number") return v.doubleValue;
  return undefined;
}

function attrsOf(v: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of list(v)) {
    if (!isObj(kv) || typeof kv.key !== "string") continue;
    const s = scalar(kv.value);
    if (s !== undefined) out[kv.key] = s;
  }
  return out;
}

/** Tempo writes ids as base64 in its JSON, and hex in OTLP/JSON proper: hex either way here. */
export function idHex(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  if (/^[0-9a-f]{16}$|^[0-9a-f]{32}$/i.test(v)) return v.toLowerCase();
  try {
    const hex = Buffer.from(v, "base64").toString("hex");
    return hex.length === 16 || hex.length === 32 ? hex : null;
  } catch {
    return null;
  }
}

const nanosToMs = (v: unknown): number | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  try {
    const n = BigInt(v);
    return Number(n / 1000n) / 1000;
  } catch {
    return undefined;
  }
};

/**
 * One trace as the view draws it, from Tempo's answer for a trace id
 * (`/api/v2/traces/<id>`: `{ trace: { resourceSpans } }`, or the v1 shapes).
 * Null when it is not one of terragucci's traces of `repo`.
 */
export function trimTrace(traceId: string, body: unknown, repo: string, maxSpans = MAX_SPANS): JobTrace | null {
  const doc = isObj(body) && isObj(body.trace) ? body.trace : body;
  const batches = isObj(doc) ? list(doc.resourceSpans ?? doc.batches) : [];
  const spans: TraceSpan[] = [];
  let own: Record<string, string | number | boolean> | undefined;
  for (const rs of batches) {
    if (!isObj(rs)) continue;
    const resource = attrsOf(isObj(rs.resource) ? rs.resource.attributes : undefined);
    const service = typeof resource["service.name"] === "string" ? resource["service.name"] : "unknown";
    if (service === "terragucci" && typeof resource["terragucci.project"] === "string") own ??= resource;
    for (const ss of list(rs.scopeSpans ?? rs.instrumentationLibrarySpans)) {
      if (!isObj(ss)) continue;
      for (const s of list(ss.spans)) {
        if (!isObj(s) || typeof s.name !== "string") continue;
        const id = idHex(s.spanId);
        const start = nanosToMs(s.startTimeUnixNano);
        const end = nanosToMs(s.endTimeUnixNano);
        if (!id || start === undefined || end === undefined) continue;
        const all = attrsOf(s.attributes);
        const attrs: Record<string, string | number | boolean> = {};
        for (const k of KEPT_ATTRIBUTES) if (all[k] !== undefined) attrs[k] = all[k]!;
        const status = isObj(s.status) ? s.status : {};
        const failed = status.code === 2 || status.code === "STATUS_CODE_ERROR";
        spans.push({
          id,
          parent: idHex(s.parentSpanId),
          name: s.name.slice(0, 200),
          service,
          start,
          ms: Math.max(0, Math.round((end - start) * 1000) / 1000),
          ...(failed ? { error: typeof status.message === "string" && status.message ? status.message.slice(0, 200) : "error" } : {}),
          attrs,
        });
      }
    }
  }
  if (!own || !projectIs(String(own["terragucci.project"]), repo) || spans.length === 0) return null;
  spans.sort((a, b) => a.start - b.start);
  const stage = spans.find((s) => s.parent === null && typeof s.attrs["terragucci.stage"] === "string") ?? spans.find((s) => s.parent === null) ?? spans[0]!;
  // The job's own time is its stage span's: a gate's hold, which began in an earlier job, reaches before it.
  const start = stage.parent === null ? stage.start : Math.min(...spans.map((s) => s.start));
  const end = stage.parent === null ? stage.start + stage.ms : Math.max(...spans.map((s) => s.start + s.ms));
  // Past the budget, the deepest spans go first: the run's shape stays whole.
  let kept = spans;
  if (spans.length > maxSpans) {
    const byId = new Map(spans.map((s) => [s.id, s]));
    const depth = (s: TraceSpan): number => {
      let d = 0;
      for (let p = s.parent ? byId.get(s.parent) : undefined; p && d < 64; p = p.parent ? byId.get(p.parent) : undefined) d++;
      return d;
    };
    const order = spans.map((s) => ({ s, d: depth(s) })).sort((a, b) => a.d - b.d || a.s.start - b.s.start);
    const keep = new Set(order.slice(0, maxSpans).map((x) => x.s));
    kept = spans.filter((s) => keep.has(s));
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const wave = Number(stage.attrs["terragucci.wave"]);
  return {
    trace_id: traceId,
    project: String(own["terragucci.project"]),
    job: str(own["cicd.pipeline.task.name"]),
    stage: str(stage.attrs["terragucci.stage"]),
    wave: Number.isInteger(wave) && wave > 0 ? wave : null,
    result: str(stage.attrs["terragucci.result"]),
    commit: str(own["vcs.ref.head.revision"]),
    start,
    ms: Math.round((end - start) * 1000) / 1000,
    spans: kept,
    left_out: spans.length - kept.length,
  };
}

/** The trace ids a Tempo search answered with, newest last. */
export function searchIds(body: unknown): string[] {
  const traces = isObj(body) ? list(body.traces) : [];
  return traces
    .filter(isObj)
    .map((t) => ({ id: typeof t.traceID === "string" && /^[0-9a-f]{1,32}$/i.test(t.traceID) ? t.traceID.toLowerCase().padStart(32, "0") : null, at: nanosToMs(t.startTimeUnixNano) ?? 0 }))
    .filter((t): t is { id: string; at: number } => t.id !== null)
    .sort((a, b) => a.at - b.at)
    .map((t) => t.id);
}

/** The Tempo address from `--tempo` or BEHOLD_TEMPO_URL: an http(s) URL with no query, or undefined. */
export function tempoAddress(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.search || u.hash) return undefined;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export interface TracesOptions {
  /** Tempo's address, as {@link tempoAddress} gives it; the route answers 404 without one. */
  tempo?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** A small cache of shared reads: a failed read is not kept. */
class Shared<T> {
  private readonly map = new Map<string, { at: number; read: Promise<T> }>();
  constructor(private readonly ttl: number, private readonly max: number) {}
  get(key: string, read: () => Promise<T>): Promise<T> {
    const t = Date.now();
    const hit = this.map.get(key);
    if (hit && t - hit.at < this.ttl) return hit.read;
    for (const [k, v] of this.map) if (t - v.at >= this.ttl) this.map.delete(k);
    while (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    const p = read();
    this.map.set(key, { at: t, read: p });
    p.catch(() => {
      if (this.map.get(key)?.read === p) this.map.delete(key);
    });
    return p;
  }
}

/** `GET /api/traces`: a run's traces from Tempo, trimmed to span trees, each read shared. */
export function tracesRoute(app: Hono, opts: TracesOptions): void {
  const fetchFn = opts.fetch ?? fetch;
  const searches = new Shared<string[]>(SEARCH_TTL_MS, 100);
  const traces = new Shared<unknown>(TRACE_TTL_MS, TRACE_CACHE_MAX);
  const search = (q: string): Promise<string[]> =>
    searches.get(q, async () => {
      const end = Math.floor(Date.now() / 1000) + 60;
      const u = `${opts.tempo}/api/search?${new URLSearchParams({ q, limit: String(SEARCH_LIMIT), start: String(end - SEARCH_WINDOW_S), end: String(end) })}`;
      const res = await fetchFn(u, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`Tempo answered ${res.status} to the search`);
      return searchIds(await res.json());
    });
  const trace = (id: string): Promise<unknown> =>
    traces.get(id, async () => {
      const res = await fetchFn(`${opts.tempo}/api/v2/traces/${id}`, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Tempo answered ${res.status} to trace ${id}`);
      return res.json();
    });
  app.get("/api/traces", async (c) => {
    if (!opts.tempo) return c.json({ error: "behold reads no Tempo: start it with --tempo <url>", code: "traces-off" }, 404);
    const repo = c.req.query("project");
    if (!validRepo(repo)) return c.json({ error: "project must be a forge repo's <owner>/<name>", code: "traces-project" }, 400);
    const run = c.req.query("run");
    const commit = c.req.query("commit");
    const job = c.req.query("job");
    if (run !== undefined && !validRun(run)) return c.json({ error: "run must be a pipeline run's id", code: "traces-run" }, 400);
    if (commit !== undefined && !validCommit(commit)) return c.json({ error: "commit must be a commit's hex id", code: "traces-commit" }, 400);
    if (run === undefined && commit === undefined) return c.json({ error: "name a run or a commit", code: "traces-run" }, 400);
    if (job !== undefined && !validJob(job)) return c.json({ error: "job must be a job's name", code: "traces-job" }, 400);
    let found: JobTrace[];
    try {
      const ids = await search(searchQuery(run !== undefined ? { run } : { commit: commit! }));
      const bodies = await Promise.all(ids.map((id) => trace(id)));
      found = ids.map((id, i) => (bodies[i] ? trimTrace(id, bodies[i], repo) : null)).filter((t): t is JobTrace => t !== null);
    } catch (e) {
      return c.json({ error: `behold could not read Tempo: ${e instanceof Error ? e.message : String(e)}`, code: "traces-read" }, 502, { "cache-control": "no-store" });
    }
    found.sort((a, b) => a.start - b.start);
    const body: TracesAnswer = {
      read: (opts.now ? opts.now() : new Date()).toISOString(),
      repo,
      project: found[0]?.project ?? null,
      run: run ?? null,
      commit: commit ?? found[0]?.commit ?? null,
      jobs: [...new Set(found.map((t) => t.job).filter((j): j is string => j !== null))].sort((x, y) => x.localeCompare(y, "en", { numeric: true })),
      traces: job !== undefined ? found.filter((t) => t.job === job) : found,
    };
    return c.json(body, 200, { "cache-control": "no-store" });
  });
}
