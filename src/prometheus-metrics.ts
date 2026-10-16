/**
 * behold#571: a pipeline's numbers from Prometheus, for the kiosk's
 * "Pipeline metrics" pane.
 *
 * terragucci sends each stage's gauges over OTLP to a collector, and
 * Prometheus scrapes them (terragucci's reference/observability). behold reads
 * them from the Prometheus `--prometheus <url>` (or BEHOLD_PROMETHEUS_URL)
 * names, with the FIXED queries in {@link QUERIES}: each one a constant
 * string, with nothing a viewer sent in it. A viewer names a repo (and
 * optionally a commit); behold picks that repo's series out of the answers.
 * The parameter is `project`, terragucci's word, since `repo` is the
 * checkout a `--repos` serve reads (src/view-repos.ts).
 *
 * - `GET /api/metrics?project=<owner>/<name>[&commit=<sha>]`: numbers, never a
 *   proxy. `run` is one commit's tf-apply waves: each wave's roots with their
 *   plan and apply seconds, the time an approval held it at its gate, the
 *   changes it applied by action, and when it started waiting or settled.
 *   The commit is the one asked for when Prometheus has it (`current: true`),
 *   otherwise the newest one it has. `dora` is the estate's four delivery
 *   metrics for the repo, from terragucci estate's gauges, or from the
 *   `dora.json` it writes beside the reports when Prometheus has none.
 *   Either is null when there is nothing to show.
 * - One read asks every query for every project, and is shared by every
 *   repo's request for {@link METRICS_TTL_MS}, as the reports read is: any
 *   number of open kiosks ask Prometheus at most that often.
 * - Without an address the route answers 404, and the pane shows nothing.
 *
 * A gauge carries `commit` and `run` only when the pipeline sets
 * TERRAGUCCI_METRICS_PER_RUN; without them the newest values are one run,
 * with no commit named.
 *
 * Nothing here writes, and the route is a GET, so `--public` keeps it.
 */
import type { Hono } from "hono";

/** How long one read of Prometheus is shared between kiosks. */
export const METRICS_TTL_MS = 30_000;

/** How far back a run's waves are looked for. */
export const RUN_WINDOW = "3h";
/** How far back the estate's DORA gauges are looked for: terragucci estate sends them when it runs. */
export const DORA_WINDOW = "7d";

/**
 * The queries behold asks, by name. Constant: nothing a request carries is
 * ever put in one. Each keeps only the labels behold reads.
 */
export const QUERIES = {
  waveSeconds: `max by (project, commit, run, wave) (last_over_time(terragucci_stage_duration_seconds{stage="tf-apply"}[${RUN_WINDOW}]))`,
  rootInit: `max by (project, commit, run, wave, root) (last_over_time(terragucci_root_init_seconds{stage="tf-apply"}[${RUN_WINDOW}]))`,
  rootPlan: `max by (project, commit, run, wave, root) (last_over_time(terragucci_root_plan_seconds{stage="tf-apply"}[${RUN_WINDOW}]))`,
  rootApply: `max by (project, commit, run, wave, root) (last_over_time(terragucci_root_apply_seconds{stage="tf-apply"}[${RUN_WINDOW}]))`,
  // A lock wait carries no wave: a root's wave is found from its other timings in the same run.
  lockWait: `max by (project, commit, run, root) (last_over_time(terragucci_lock_wait_seconds{stage="tf-apply"}[${RUN_WINDOW}]))`,
  held: `max by (project, commit, run, wave) (last_over_time(terragucci_wave_held_seconds[${RUN_WINDOW}]))`,
  changes: `max by (project, commit, run, wave, action) (last_over_time(terragucci_wave_changes[${RUN_WINDOW}]))`,
  settled: `max by (project, commit, run, wave) (last_over_time(terragucci_wave_settled_seconds[${RUN_WINDOW}]))`,
  waiting: `max by (project, commit, run, wave) (last_over_time(terragucci_wave_waiting_since_seconds[${RUN_WINDOW}]))`,
  deployments: `max by (project) (last_over_time(terragucci_dora_deployments_per_week[${DORA_WINDOW}]))`,
  leadTime: `max by (project) (last_over_time(terragucci_dora_lead_time_seconds{segment="total"}[${DORA_WINDOW}]))`,
  failureRate: `max by (project) (last_over_time(terragucci_dora_change_failure_ratio[${DORA_WINDOW}]))`,
  restore: `max by (project) (last_over_time(terragucci_dora_restore_seconds[${DORA_WINDOW}]))`,
} as const;

export type QueryName = keyof typeof QUERIES;

/** One series of an instant vector: its labels and its value. */
export interface Sample {
  labels: Record<string, string>;
  value: number;
}

export interface WaveRoot {
  root: string;
  init_seconds?: number;
  plan_seconds?: number;
  apply_seconds?: number;
  /** Time spent waiting for the root's state lock, where the binary reports it (choudoufu). */
  lock_wait_seconds?: number;
}

export interface WaveMetrics {
  wave: number;
  /** The pipeline run the numbers are from, when the gauges name it. */
  run: string | null;
  /** The wave job's own time, from its stage's start to its end. */
  seconds?: number;
  roots: WaveRoot[];
  /** How long an approval held the wave at its gate. */
  held_seconds?: number;
  /** The changes the wave applied, by action, each above zero. */
  changes: Record<string, number>;
  /** When the wave started waiting, Unix seconds, while that is its newest news. */
  waiting_since?: number;
  /** When the wave last stopped waiting, Unix seconds. */
  settled_at?: number;
}

export interface RunMetrics {
  /** The commit, or null when the gauges carry none. */
  commit: string | null;
  /** Whether it is the commit the request asked for. */
  current: boolean;
  waves: WaveMetrics[];
}

export interface DoraMetrics {
  /** Where the numbers came from. */
  from: "prometheus" | "dora.json";
  deployments_per_week?: number;
  lead_time_seconds?: number;
  change_failure_ratio?: number;
  restore_seconds?: number;
}

export interface MetricsAnswer {
  read: string;
  repo: string;
  /** terragucci's project name for the repo, `<forge host>/<owner>/<name>`, when Prometheus or dora.json named one. */
  project: string | null;
  run: RunMetrics | null;
  dora: DoraMetrics | null;
}

/** `owner/name`, or a bare `name`: what a forge repo is called, and nothing else. */
const REPO = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/)?[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

export const validRepo = (v: string | undefined): v is string => !!v && REPO.test(v) && !v.split("/").some((p) => p === "." || p === "..");
export const validCommit = (v: string | undefined): v is string => !!v && COMMIT.test(v);

/** Whether terragucci's project name (`<host>/<owner>/<name>`) is this repo. */
export function projectIs(project: string | undefined, repo: string): boolean {
  if (!project) return false;
  return project === repo || project.endsWith(`/${repo}`);
}

/** An instant vector from Prometheus's /api/v1/query answer; non-finite values are left out. */
export function parseVector(body: unknown): Sample[] {
  const b = body as { status?: string; data?: { resultType?: string; result?: unknown } } | null;
  if (!b || b.status !== "success" || !b.data || b.data.resultType !== "vector" || !Array.isArray(b.data.result)) {
    throw new Error("Prometheus did not answer with an instant vector");
  }
  const out: Sample[] = [];
  for (const r of b.data.result as { metric?: Record<string, unknown>; value?: unknown[] }[]) {
    const v = Array.isArray(r.value) ? Number(r.value[1]) : NaN;
    if (!Number.isFinite(v)) continue;
    const labels: Record<string, string> = {};
    for (const [k, x] of Object.entries(r.metric ?? {})) if (typeof x === "string") labels[k] = x;
    out.push({ labels, value: v });
  }
  return out;
}

export type Answers = Record<QueryName, Sample[]>;

const key = (s: Sample) => `${s.labels.commit ?? ""}\u0000${s.labels.run ?? ""}\u0000${s.labels.wave ?? ""}`;

/**
 * One commit's waves from the answers, for one repo. Each wave's numbers are
 * its newest run's (a wave that waited is run again once approved). Null when
 * Prometheus holds no wave of the repo.
 */
export function runOf(a: Answers, repo: string, commit?: string): RunMetrics | null {
  const mine = (xs: Sample[]) => xs.filter((s) => projectIs(s.labels.project, repo) && /^\d+$/.test(s.labels.wave ?? ""));
  const rows = { ...a, waveSeconds: mine(a.waveSeconds), rootInit: mine(a.rootInit), rootPlan: mine(a.rootPlan), rootApply: mine(a.rootApply), held: mine(a.held), changes: mine(a.changes), settled: mine(a.settled), waiting: mine(a.waiting) };
  // When each (commit, run, wave) last moved: it settled, or it started waiting.
  const moved = new Map<string, { commit: string; run: string; wave: number; at: number }>();
  const note = (s: Sample) => {
    const k = key(s);
    const had = moved.get(k);
    if (!had || s.value > had.at) moved.set(k, { commit: s.labels.commit ?? "", run: s.labels.run ?? "", wave: Number(s.labels.wave), at: s.value });
  };
  for (const s of [...rows.settled, ...rows.waiting]) note(s);
  // A run whose wave sent only root timings still counts, with no time of its own.
  for (const s of [...rows.waveSeconds, ...rows.rootInit, ...rows.rootPlan, ...rows.rootApply]) if (!moved.has(key(s))) moved.set(key(s), { commit: s.labels.commit ?? "", run: s.labels.run ?? "", wave: Number(s.labels.wave), at: 0 });
  if (moved.size === 0) return null;
  const commits = new Map<string, number>();
  for (const m of moved.values()) commits.set(m.commit, Math.max(commits.get(m.commit) ?? 0, m.at));
  const asked = commit ? [...commits.keys()].find((c) => c && (c === commit || c.startsWith(commit) || commit.startsWith(c))) : undefined;
  const chosen = asked ?? [...commits.entries()].sort((x, y) => y[1] - x[1])[0][0];
  const waves = new Map<number, { run: string; at: number }>();
  for (const m of moved.values()) {
    if (m.commit !== chosen) continue;
    const had = waves.get(m.wave);
    if (!had || m.at > had.at) waves.set(m.wave, { run: m.run, at: m.at });
  }
  const of = (xs: Sample[], wave: number, run: string) => xs.filter((s) => (s.labels.commit ?? "") === chosen && (s.labels.run ?? "") === run && Number(s.labels.wave) === wave);
  const out: WaveMetrics[] = [];
  for (const [wave, { run }] of [...waves.entries()].sort((x, y) => x[0] - y[0])) {
    const roots = new Map<string, WaveRoot>();
    const put = (root: string, v: Partial<WaveRoot>) => roots.set(root, { ...(roots.get(root) ?? { root }), ...v });
    for (const s of of(rows.rootInit, wave, run)) if (s.labels.root) put(s.labels.root, { init_seconds: s.value });
    for (const s of of(rows.rootPlan, wave, run)) if (s.labels.root) roots.set(s.labels.root, { ...(roots.get(s.labels.root) ?? { root: s.labels.root }), plan_seconds: s.value });
    for (const s of of(rows.rootApply, wave, run)) if (s.labels.root) roots.set(s.labels.root, { ...(roots.get(s.labels.root) ?? { root: s.labels.root }), apply_seconds: s.value });
    for (const s of a.lockWait) {
      const r = s.labels.root;
      if (r && roots.has(r) && projectIs(s.labels.project, repo) && (s.labels.commit ?? "") === chosen && (s.labels.run ?? "") === run) put(r, { lock_wait_seconds: s.value });
    }
    const wall = of(rows.waveSeconds, wave, run)[0];
    const changes: Record<string, number> = {};
    for (const s of of(rows.changes, wave, run)) if (s.labels.action && s.value > 0) changes[s.labels.action] = s.value;
    const held = of(rows.held, wave, run)[0];
    const settled = of(rows.settled, wave, run)[0];
    const waiting = of(rows.waiting, wave, run)[0];
    out.push({
      wave,
      run: run || null,
      ...(wall ? { seconds: wall.value } : {}),
      roots: [...roots.values()].sort((x, y) => x.root.localeCompare(y.root)),
      ...(held ? { held_seconds: held.value } : {}),
      changes,
      ...(waiting && (!settled || waiting.value > settled.value) ? { waiting_since: waiting.value } : {}),
      ...(settled ? { settled_at: settled.value } : {}),
    });
  }
  return { commit: chosen || null, current: !!asked, waves: out };
}

/** The repo's DORA numbers from terragucci estate's gauges, or null when it sent none for the repo. */
export function doraOf(a: Answers, repo: string): DoraMetrics | null {
  const pick = (xs: Sample[]) => xs.find((s) => projectIs(s.labels.project, repo))?.value;
  const d = { deployments_per_week: pick(a.deployments), lead_time_seconds: pick(a.leadTime), change_failure_ratio: pick(a.failureRate), restore_seconds: pick(a.restore) };
  const set = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
  return Object.keys(set).length ? { from: "prometheus", ...set } : null;
}

/** The repo's DORA numbers from terragucci estate's dora.json (terragucci.dora/v1), or null. */
export function doraFromFile(text: string | undefined, repo: string): { dora: DoraMetrics; project: string } | null {
  if (!text) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const projects = (doc as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return null;
  const p = projects.find((x) => x && typeof x === "object" && projectIs((x as { project?: string }).project, repo)) as
    | { project: string; per_week?: unknown; lead_time?: { median_seconds?: unknown }; change_failure?: { rate?: unknown }; restore?: { median_seconds?: unknown } }
    | undefined;
  if (!p) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const d = {
    deployments_per_week: num(p.per_week),
    lead_time_seconds: num(p.lead_time?.median_seconds),
    change_failure_ratio: num(p.change_failure?.rate),
    restore_seconds: num(p.restore?.median_seconds),
  };
  const set = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
  return Object.keys(set).length ? { dora: { from: "dora.json", ...set }, project: p.project } : null;
}

/** The Prometheus address from `--prometheus` or BEHOLD_PROMETHEUS_URL: an http(s) URL with no query, or undefined. */
export function prometheusAddress(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.search || u.hash) return undefined;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

export interface MetricsOptions {
  /** Prometheus's address, as {@link prometheusAddress} gives it; the route answers 404 without one. */
  prometheus?: string;
  /** dora.json beside the reports, when behold reads terragucci's reports. */
  doraFile?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Every named query, asked at once. Throws when Prometheus cannot answer. */
export async function askAll(base: string, fetchFn: typeof fetch = fetch): Promise<Answers> {
  const names = Object.keys(QUERIES) as QueryName[];
  const answers = await Promise.all(
    names.map(async (n) => {
      const res = await fetchFn(`${base}/api/v1/query?query=${encodeURIComponent(QUERIES[n])}`, { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`Prometheus answered ${res.status} to ${n}`);
      return parseVector(await res.json());
    }),
  );
  return Object.fromEntries(names.map((n, i) => [n, answers[i]])) as Answers;
}

/** `GET /api/metrics`: a repo's pipeline numbers from Prometheus, shared for {@link METRICS_TTL_MS}. */
export function metricsRoute(app: Hono, opts: MetricsOptions): void {
  let shared: { at: number; read: Promise<Answers> } | undefined;
  let dora: { at: number; read: Promise<string | undefined> } | undefined;
  const answers = (): Promise<Answers> => {
    const t = Date.now();
    if (!shared || t - shared.at >= METRICS_TTL_MS) {
      const read = askAll(opts.prometheus!, opts.fetch);
      shared = { at: t, read };
      // A failed read is not kept: the next request asks again.
      read.catch(() => {
        if (shared?.read === read) shared = undefined;
      });
    }
    return shared.read;
  };
  const doraText = (): Promise<string | undefined> => {
    if (!opts.doraFile) return Promise.resolve(undefined);
    const t = Date.now();
    if (!dora || t - dora.at >= METRICS_TTL_MS) dora = { at: t, read: opts.doraFile().catch(() => undefined) };
    return dora.read;
  };
  app.get("/api/metrics", async (c) => {
    if (!opts.prometheus) return c.json({ error: "behold reads no Prometheus: start it with --prometheus <url>", code: "metrics-off" }, 404);
    const repo = c.req.query("project");
    if (!validRepo(repo)) return c.json({ error: "project must be a forge repo's <owner>/<name>", code: "metrics-project" }, 400);
    const asked = c.req.query("commit");
    if (asked !== undefined && !validCommit(asked)) return c.json({ error: "commit must be a commit's hex id", code: "metrics-commit" }, 400);
    let a: Answers;
    try {
      a = await answers();
    } catch (e) {
      return c.json({ error: `behold could not read Prometheus: ${e instanceof Error ? e.message : String(e)}`, code: "metrics-read" }, 502, { "cache-control": "no-store" });
    }
    const run = runOf(a, repo, asked);
    let d = doraOf(a, repo);
    let project = [...a.settled, ...a.waiting, ...a.rootPlan, ...a.deployments].find((s) => projectIs(s.labels.project, repo))?.labels.project ?? null;
    if (!d) {
      const f = doraFromFile(await doraText(), repo);
      if (f) {
        d = f.dora;
        project ??= f.project;
      }
    }
    const body: MetricsAnswer = { read: (opts.now ? opts.now() : new Date()).toISOString(), repo, project, run, dora: d };
    return c.json(body, 200, { "cache-control": "no-store" });
  });
}
