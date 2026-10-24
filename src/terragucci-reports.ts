/**
 * Reading what terragucci decided about an estate (#490), from the reports it
 * already writes. behold adds no drift of its own here and reads no cloud: a
 * Terraform root's colour in this view is terragucci's latest verdict, dated
 * by the run that made it.
 *
 * The reads are the ones terragucci's "The reports bucket" page names, each
 * one GET of one key:
 *
 * - `index.json`: every run, newest first. A row's `path` is its run's
 *   directory, relative to the index.
 * - `<run>/report.json`: one per run read, and only the newest runs: for each
 *   root, the newest tf-plan and tf-drift report that planned it, and the
 *   newest tf-apply wave that held it.
 * - `estate.json`, when the source has one: the counts and the waiting waves,
 *   taken as terragucci's estate page shows them, so behold never disagrees
 *   with it.
 *
 * Each document is checked against terragucci's own JSON Schema when the
 * `@intentius/terragucci` package is installed beside the served project or
 * beside behold (its `dist/` ships `report.schema.json`,
 * `report-index.schema.json` and `estate.schema.json`). Without it, behold
 * checks the fields it reads and the schema id, and refuses anything else,
 * structurally, the way carve refuses a report it can't read.
 */
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { terragucciApproveCommand } from "./terragucci-lifecycle.ts";
import type { TerragucciSource } from "./terragucci-source.ts";
import { coneView, readConePlans, type PlanConeView, type RootFacts } from "./terragucci-cone.ts";

export const REPORT_SCHEMA = "terragucci.report/v1";
export const INDEX_SCHEMA = "terragucci.report-index/v1";
export const ESTATE_SCHEMA = "terragucci.estate/v1";

/** How many runs of one stage behold reads before it stops looking for a root's newest. */
export const MAX_RUNS_PER_STAGE = 12;

export type Stage = "tf-plan" | "tf-drift" | "tf-apply";

/** The refusal every read answers with: `code: "terragucci-report"`. */
export interface TerragucciRefusal {
  error: string;
  code: "terragucci-report";
  remedy: string;
}

export class TerragucciReadError extends Error {
  constructor(readonly refusal: TerragucciRefusal) {
    super(refusal.error);
  }
}

const refuse = (error: string, remedy: string): never => {
  throw new TerragucciReadError({ error, code: "terragucci-report", remedy });
};

// ---------------------------------------------------------------------------
// The documents, as far as behold reads them. Every other field is ignored, as
// terragucci's v1 contract asks of a reader.
// ---------------------------------------------------------------------------

export interface IndexRow {
  project: string;
  commit: string;
  stage: Stage;
  wave?: number;
  finished: string;
  path: string;
  approval?: "waiting" | "approved" | "not-required";
  waiting_since?: string;
  applied?: string;
  pull_request?: string;
  pull_request_url?: string;
  commit_url?: string;
  job_url?: string;
  trace_url?: string;
}

export interface ReportChange {
  address: string;
  type?: string;
  action: string;
  module?: string;
  attributes?: ReportAttribute[];
}

/** One attribute of a change, as the report states it. A value the plan knows only after apply is `unknown`. */
export interface ReportAttribute {
  path: string;
  sensitive?: boolean;
  before?: unknown;
  after?: unknown;
  unknown?: boolean;
  /** behold#571: set by behold when a value's JSON ran past VALUE_CAP and was left out. */
  long?: boolean;
}

/** behold#571: the longest value, as JSON, an attribute carries to the page; a longer one is left out and flagged `long`. */
export const VALUE_CAP = 300;

/**
 * behold#571: an attribute as the page gets it: its path, and its before and
 * after values when the report states them, for the kiosk's popover. A
 * sensitive attribute never reaches here (the caller drops it), and a value
 * past VALUE_CAP is left out with `long` set.
 */
export function attributeValues(a: ReportAttribute): ReportAttribute {
  const out: ReportAttribute = { path: a.path };
  let long = false;
  for (const k of ["before", "after"] as const) {
    if (!(k in a) || a[k] === undefined) continue;
    const json = JSON.stringify(a[k]);
    if (json === undefined || json.length > VALUE_CAP) long = true;
    else out[k] = a[k];
  }
  if (a.unknown === true) out.unknown = true;
  if (long) out.long = true;
  return out;
}

/** A root's `terraform_remote_state` read of another root (minor 21, #568). */
export interface ReportRead {
  upstream: string;
  /** The data block's label. */
  data: string;
  /** `planned`: the upstream's plan in this run. `applied`: its state as it stands. */
  outputs: "planned" | "applied";
  /** With `planned`: the outputs it reads that are known only once the upstream applies. */
  unknown?: string[];
  /** With `applied` in a tf-plan: why it did not plan on the upstream's planned outputs. */
  why?: string;
  /** #568 step 3, minor 38 (INTENTIUS/terragucci#1013): a read of another member inside the composed run. */
  composed?: true;
}

// #568 step 3: the composed run's fields, report minor 38 (INTENTIUS/terragucci#1013,
// `report/schema.ts` and `report.schema.json` at terragucci main 11647640).

/** `Report.compose`: present when the run's config has `waves.compose: true`. */
export interface ReportCompose {
  /** The roots the change reaches plus the roots they read, followed upstream, sorted. */
  roots: string[];
  /** waves.compose_max. */
  max: number;
  /** The wave whose run composes them. Absent when the change applies in waves. */
  wave?: number;
  /** Why the change applies in waves: a kind, the root it is about when there is one, and a sentence. */
  fallback?: { kind: string; root?: string; reason: string };
}

export type ComposedApply = "applied" | "partial" | "failed" | "not-started" | "no-changes";
export type ComposedState = "written" | "unchanged" | "not-written";

export interface ReportComposedMember {
  root: string;
  /** Its address in the run, such as module.network. */
  module: string;
  /** tf-apply only: how its part of the apply ended. */
  apply?: ComposedApply;
  /** tf-apply only: how many of its planned changes completed. */
  changes?: { done: number; planned: number };
  /** tf-apply only: its state after the run. */
  state?: ComposedState;
  /** With not-written: where the state the run holds for it was kept, and that its lock is still held. */
  kept?: string;
  lock_held?: boolean;
  /** Why the write failed, or the first error of its part of the apply. */
  error?: string;
}

/** `ReportWave.composed`, on the wave that carries the run. */
export interface ReportComposedRun {
  /** The composed plan's digest; null when it failed to plan. */
  plan_digest: string | null;
  /** Each root in the run, upstreams first. */
  members: ReportComposedMember[];
  /** The members that read a value of another member unknown at plan time. Absent when there are none. */
  held_by_unknown?: string[];
  /** Why the run failed before or in its apply, when no member's own error says it. */
  error?: string;
}

export interface ReportRoot {
  path: string;
  status: "planned" | "failed";
  error?: string;
  changes: ReportChange[];
  /** minor 21 (#568). */
  reads?: ReportRead[];
  /** minor 23 (#568). */
  dependencies?: string[];
  /** Its changes by action, as its plan counts them. */
  counts?: Record<string, number>;
  /** #568 step 3, minor 38 (INTENTIUS/terragucci#1013): on each root in a composed run. */
  composed?: { wave: number; module: string };
  /** minor 34: a choudoufu root under a `live` block that a pull request planned with `plan -cone=<base>` (src/terragucci-cone.ts). */
  cone?: unknown;
  /** minor 18: the binary the root ran. */
  binary?: { name?: string; version?: string };
  /** The root's plan files beside the report, as keys relative to the run. */
  plan?: { text?: string; json?: string };
  /** minor 20: on a tf-apply wave, the state file its backend holds afterwards. */
  state?: unknown;
}

/** A wave's or a run's monthly cost (minor 12 and 19, #568). Null where the estimator gave no figure. */
export interface ReportCostSums {
  currency: string;
  monthly_delta: number | null;
  monthly_total: number | null;
  past_monthly_total: number | null;
  unestimated?: string[];
  approve_above?: number;
  over?: boolean;
}

/** `blocked` (minor 41, terragucci#1161): a tf-apply wave none of whose roots ran, since an upstream of each did not apply in the run. */
export type ReportWaveState = "planned" | "waiting" | "applying" | "applied" | "refused" | "failed" | "blocked";

export interface ReportWave {
  number: number;
  /**
   * The wave's roots by path. behold#741: a tf-apply wave may name each root
   * with its own apply outcome instead (`{ root, outcome, error }`, one of the
   * two shapes asked of terragucci#1164; see {@link waveOutcomes}): read
   * through {@link waveRootNames}.
   */
  roots: (string | ReportRootOutcome)[];
  set_digest: string | null;
  approval: string;
  waiting_since?: string;
  /** minor 9 (#568): the digest a pull request's review binds; null when no root of the wave changes, or when it plans again. */
  review_digest?: string | null;
  /** minor 9 (#568). */
  waits?: boolean;
  /** minor 19 (#568). */
  cost?: ReportCostSums;
  /** minor 21 (#568). */
  state?: ReportWaveState;
  /** minor 21 (#568): the waves whose roots' state its roots read. */
  reads?: number[];
  /** minor 21 (#568): a tf-plan wave that plans again after these waves apply. */
  replans_after?: number[];
  /** #568 step 3, minor 38 (INTENTIUS/terragucci#1013): on the wave that carries the composed run. */
  composed?: ReportComposedRun;
  /**
   * minor 41 (terragucci#1161): a tf-apply wave's roots that did not run
   * because an upstream did not apply in this run, each with the root whose
   * failure held it (past any root blocked in between). These roots are not
   * in `roots`. Absent when none is blocked.
   */
  blocked?: { root: string; blocked_by: string }[];
  /** behold#741: each root's own apply outcome, the other shape asked of terragucci#1164 (see {@link waveOutcomes}). */
  outcomes?: ReportRootOutcome[];
}

/** behold#741: a root's own apply outcome in its wave, with its error when it failed. */
export interface ReportRootOutcome {
  root?: string;
  path?: string;
  outcome?: string;
  error?: string;
}

export type RootOutcome = "applied" | "unchanged" | "failed";
const OUTCOMES: readonly string[] = ["applied", "unchanged", "failed"];

/** A wave's roots by path, whether it names them as paths or with their outcomes. Pure. */
export function waveRootNames(w: Pick<ReportWave, "roots"> | undefined): string[] {
  return (w && Array.isArray(w.roots) ? w.roots : []).flatMap((r) => (str(r) ? [r] : isRecord(r) && str(r.root ?? r.path) ? [String(r.root ?? r.path)] : []));
}

/**
 * behold#741: each root's own apply outcome in a tf-apply wave, so a root
 * that applied beside a failed one reads applied. terragucci#1164 adds it to
 * the published report; until its field is named, both shapes asked for are
 * read: `waves[].roots[].outcome` and `waves[].outcomes: [{ root, outcome,
 * error }]`. Other outcomes, and malformed rows, are skipped. Pure.
 */
export function waveOutcomes(w: Pick<ReportWave, "roots" | "outcomes"> | undefined): { root: string; outcome: RootOutcome; error?: string }[] {
  const rows = [...(w && Array.isArray(w.roots) ? w.roots : []), ...(w && Array.isArray(w.outcomes) ? w.outcomes : [])];
  const out = new Map<string, { root: string; outcome: RootOutcome; error?: string }>();
  for (const r of rows) {
    if (!isRecord(r)) continue;
    const root = r.root ?? r.path;
    if (!str(root) || !root || !str(r.outcome) || !OUTCOMES.includes(r.outcome) || out.has(root)) continue;
    out.set(root, { root, outcome: r.outcome as RootOutcome, ...(r.outcome === "failed" && str(r.error) && r.error ? { error: r.error } : {}) });
  }
  return [...out.values()];
}

/** A changed resource and the resources that depend on it, nearest first (minor 31, #568). */
export interface ReportBlastResource {
  root: string;
  address: string;
  actions: string[];
  /** `depth` (minor 36, #568 step 2): the distance from the changed resource, 1 for a resource that refers to it, one more per resource in between and per hop from a root's output into its reader. Absent before minor 36. */
  reaches: { root: string; address: string; depth?: number; through?: { root: string; output: string } }[];
}

/** A tf-plan run's blast radius (minor 22 and 31, #568). */
export interface ReportBlast {
  roots: string[];
  downstream: { root: string; reads: string[]; depth: number; wave?: number; planned: boolean }[];
  resources?: ReportBlastResource[];
}

/** The run's cost estimate (minor 12, #568). */
export interface ReportCost extends ReportCostSums {
  estimator: string;
  roots: { root: string; monthly_delta: number | null; monthly_total: number | null; past_monthly_total: number | null; error?: string }[];
}

export interface Report {
  schema: string;
  minor?: number;
  run: {
    project: string;
    commit: string;
    stage: Stage;
    wave?: number;
    finished: string;
    pull_request?: string;
    pull_request_url?: string;
    commit_url?: string;
    job_url?: string;
    trace_url?: string;
    report_url?: string;
  };
  roots: ReportRoot[];
  waves: ReportWave[];
  named?: { root: string; address?: string; action: string; reason?: string }[];
  /** Changes by action across the run's roots (#568). */
  totals?: Record<string, number>;
  /** minor 35 (#568 step 2): how many roots `totals` counts a change of. */
  totals_roots?: number;
  /** minor 12 (#568). */
  cost?: ReportCost;
  /** minor 22 (#568). */
  blast?: ReportBlast;
  /** #568 step 3, minor 38 (INTENTIUS/terragucci#1013). */
  compose?: ReportCompose;
}

export interface EstateWaiting {
  project: string;
  wave: number;
  commit: string;
  since: string;
  age_seconds: number;
  report?: string;
}

export interface Estate {
  schema: string;
  generated: string;
  totals: Record<string, number>;
  projects: { project: string; status: string; drifted: number; failed: number; waiting: EstateWaiting[]; index?: string }[];
}

// ---------------------------------------------------------------------------
// Checking a document.
// ---------------------------------------------------------------------------

type DocName = "report" | "index" | "estate";
const SCHEMA_FILES: Record<DocName, string> = { report: "report.schema.json", index: "report-index.schema.json", estate: "estate.schema.json" };
const SCHEMA_IDS: Record<DocName, string> = { report: REPORT_SCHEMA, index: INDEX_SCHEMA, estate: ESTATE_SCHEMA };

/** How the documents were checked: terragucci's JSON Schemas, or behold's own reading of the fields it uses. */
export type Validation = { by: "schema"; terragucci: string } | { by: "structural" };

export interface Validator {
  validation: Validation;
  /** Why `doc` is not a `name`, or undefined when it is. */
  check(name: DocName, doc: unknown): string | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

/** behold's own check: the schema id, and the fields this module reads, with their types. */
function structural(name: DocName, doc: unknown): string | undefined {
  if (!isRecord(doc)) return "it is not a JSON object";
  if (doc.schema !== SCHEMA_IDS[name]) return `its schema is ${JSON.stringify(doc.schema)}, not ${SCHEMA_IDS[name]}`;
  if (name === "index") {
    if (!Array.isArray(doc.reports)) return "it has no reports array";
    for (const [i, r] of doc.reports.entries()) {
      if (!isRecord(r) || !str(r.project) || !str(r.commit) || !str(r.stage) || !str(r.finished) || !str(r.path)) return `row ${i} lacks project, commit, stage, finished or path`;
    }
  } else if (name === "report") {
    const run = doc.run;
    if (!isRecord(run) || !str(run.project) || !str(run.commit) || !str(run.stage) || !str(run.finished)) return "its run lacks project, commit, stage or finished";
    if (!Array.isArray(doc.roots) || !Array.isArray(doc.waves)) return "it has no roots or waves array";
    for (const [i, r] of doc.roots.entries()) {
      if (!isRecord(r) || !str(r.path) || (r.status !== "planned" && r.status !== "failed") || !Array.isArray(r.changes)) return `root ${i} lacks path, status or changes`;
      for (const c of r.changes) if (!isRecord(c) || !str(c.address) || !str(c.action)) return `a change in root ${String(r.path)} lacks address or action`;
    }
  } else {
    if (!str(doc.generated) || !isRecord(doc.totals) || !Array.isArray(doc.projects)) return "it lacks generated, totals or projects";
    for (const p of doc.projects) if (!isRecord(p) || !str(p.project) || !Array.isArray(p.waiting)) return "a project lacks project or waiting";
  }
  return undefined;
}

/**
 * Compiled schema validators, by the package's `dist/` directory and the
 * mtimes of its package.json and three schemas (#500). A read asks for the
 * validator every time; a package installed, upgraded or removed since the
 * last read gives a new key and is compiled afresh, and an unchanged one costs
 * four stats.
 */
const compiledSchemas = new Map<string, Validator>();

/** The key `dist` is cached under, or undefined when one of its files is missing. */
function schemaStamp(dist: string): string | undefined {
  try {
    const files = [join(dist, "..", "package.json"), ...Object.values(SCHEMA_FILES).map((f) => join(dist, f))];
    return [dist, ...files.map((f) => {
      const st = statSync(f);
      return `${st.mtimeMs}:${st.size}`;
    })].join("\u0000");
  } catch {
    return undefined;
  }
}

function compileSchemas(dist: string): Validator {
  const version = (JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")) as { version?: string }).version ?? "";
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  const compiled = Object.fromEntries(
    (Object.keys(SCHEMA_FILES) as DocName[]).map((n) => [n, ajv.compile(JSON.parse(readFileSync(join(dist, SCHEMA_FILES[n]), "utf8")) as object)]),
  ) as Record<DocName, ReturnType<Ajv2020["compile"]>>;
  return {
    validation: { by: "schema", terragucci: version },
    check(name, doc) {
      const id = isRecord(doc) ? doc.schema : undefined;
      if (id !== SCHEMA_IDS[name]) return `its schema is ${JSON.stringify(id)}, not ${SCHEMA_IDS[name]}`;
      if (compiled[name](doc)) return undefined;
      const e = compiled[name].errors?.[0];
      return `${SCHEMA_FILES[name]} rejects it: ${e?.instancePath || "/"} ${e?.message ?? "is invalid"}`;
    },
  };
}

/**
 * The validator for documents read for the project at `dirs[0]`: terragucci's
 * schemas when `@intentius/terragucci` resolves from one of `dirs` (the served
 * project first, then behold itself), otherwise behold's structural check.
 * The schema id is always checked first, so a v2 document is refused by name
 * whichever check runs.
 *
 * Looked up on every call, so a serve that outlives an install or upgrade of
 * `@intentius/terragucci` checks with the package now on disk (#500); the
 * compile is cached by the package's path and its files' mtimes.
 */
export function terragucciValidator(dirs: readonly string[] = []): Validator {
  for (const from of [...dirs, dirname(fileURLToPath(import.meta.url))]) {
    let entry: string;
    try {
      entry = createRequire(join(resolve(from), "noop.js")).resolve("@intentius/terragucci/report.schema.json");
    } catch {
      continue;
    }
    const dist = dirname(entry);
    // A package without one of the three schemas (an older terragucci) is
    // no reason to refuse; the structural check still runs.
    const stamp = schemaStamp(dist);
    if (!stamp) continue;
    const hit = compiledSchemas.get(stamp);
    if (hit) return hit;
    let v: Validator;
    try {
      v = compileSchemas(dist);
    } catch {
      continue;
    }
    for (const k of compiledSchemas.keys()) if (k.startsWith(`${dist}\u0000`)) compiledSchemas.delete(k);
    compiledSchemas.set(stamp, v);
    return v;
  }
  return { validation: { by: "structural" }, check: structural };
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

/** One root, as one run left it. */
export interface RootRun {
  stage: Stage;
  finished: string;
  commit: string;
  wave?: number;
  pull_request?: string;
  pull_request_url?: string;
  commit_url?: string;
  job_url?: string;
  trace_url?: string;
  /** The run's report.html, as a key under the source. */
  report: string;
  status: "planned" | "failed";
  error?: string;
  changes: ReportChange[];
  /** A tf-apply wave's gate, from its index row. */
  approval?: IndexRow["approval"];
  applied?: string;
}

export interface WaitingWave {
  wave: number;
  commit: string;
  since: string;
  /** The roots the wave holds, from its kept report. */
  roots: string[];
  set_digest: string | null;
  /** What the wave would destroy or replace, as `root: address`. */
  destroys: string[];
  report: string;
  job_url?: string;
  /** The line a person runs at their shell. behold never runs it. */
  command: string;
  /** Where the waves came from: terragucci's estate.json, or the index when there is none. */
  from: "estate" | "index";
}

/**
 * The pull request stage (#568): the newest tf-plan report that planned a
 * pull request, as it planned it. terragucci's run view starts at the merge,
 * so before it this is what the card view has of a change: which root read
 * which root's planned outputs, what it read before it was known, which wave
 * plans again after which, the blast radius, the totals and the cost.
 */
export interface PullRequestPlan {
  run: {
    commit: string;
    finished: string;
    pull_request: string;
    pull_request_url?: string;
    job_url?: string;
    /** The run's report.html, as a key under the source. */
    report: string;
  };
  /** Each planned root's reads of another root's state, in report order. */
  reads: (ReportRead & { root: string })[];
  /** The roots it planned, in report order: a root of the checkout not here was not planned. */
  roots: string[];
  waves: {
    number: number;
    roots: string[];
    state?: ReportWaveState;
    set_digest: string | null;
    review_digest?: string | null;
    waits?: boolean;
    reads?: number[];
    replans_after?: number[];
    cost?: ReportCostSums;
    /** #568 step 3: the composed run this wave carries, each member with its own changes by action. */
    composed?: ReportComposedRun & { members: (ReportComposedMember & { counts?: Record<string, number> })[] };
  }[];
  /** #568 step 3: whether the change's roots compose, and if not, why (absent when `waves.compose` is off). */
  compose?: ReportCompose;
  totals?: Record<string, number>;
  /** #568 step 2: how many roots `totals` counts a change of (minor 35). */
  totals_roots?: number;
  cost?: ReportCost;
  blast?: ReportBlast;
  /** behold#741: each planned root's changes by action, as its plan counts them; absent when no root carries counts. */
  counts?: Record<string, Record<string, number>>;
  /** behold#741: each planned root's upstreams, the roots it reads and its `dependencies` (minor 23); absent when none has any. */
  upstreams?: Record<string, string[]>;
  /**
   * minor 34: when a root of the plan carries `cone`, every root of the
   * estate as the plan treated it: planned as a cone (with the instances its
   * plan.json planned), planned in full by choudoufu's guard and why, planned
   * with no cone, or not planned. Absent on every other plan.
   */
  cone?: PlanConeView;
}

/**
 * behold#741 (terragucci#1161): the roots the newest tf-apply commit's waves
 * blocked, each with its wave and the root whose failure held it, from each
 * wave's newest report. Absent when no wave blocked a root, and always from
 * reports older than minor 41, which carry no `blocked`.
 */
export interface BlockedRead {
  commit: string;
  roots: Record<string, { wave: number; by: string }>;
}

/** behold#741: each root's own apply outcome in the newest tf-apply commit's waves, each wave by its newest report. */
export interface OutcomesRead {
  commit: string;
  roots: Record<string, { wave: number; outcome: RootOutcome; error?: string }>;
}

/** A wave's `blocked` rows, each as `{ root, by }`; malformed rows are skipped, and a wave without the field has none. Pure. */
export function waveBlocked(w: Pick<ReportWave, "blocked"> | undefined): { root: string; by: string }[] {
  const rows = w && Array.isArray(w.blocked) ? w.blocked : [];
  return rows.flatMap((b) => (isRecord(b) && str(b.root) && b.root && str(b.blocked_by) && b.blocked_by ? [{ root: b.root, by: b.blocked_by }] : []));
}

/**
 * behold#751: how a tf-apply wave came out, as its own report says it, for the
 * wave's words in place of its Forgejo job's status. terragucci ends a wave's
 * job as a failure while any root of it is blocked (terragucci#1161), so the
 * commit status isn't green with roots unapplied; the report's `state`
 * (terragucci's waveState) is `applied` for a wave that applied all it
 * planned and blocked the rest, `blocked` only when it planned nothing, and
 * `failed` when a root of its own failed. `finished` is the report's, so a
 * reader can tell a report of an earlier run on the commit from this one's.
 */
export interface WaveResult {
  wave: number;
  state: ReportWaveState;
  finished: string;
  /** The roots that applied a change; the wave's roots, less the blocked, when the report names no outcome. */
  applied: string[];
  /** The roots whose apply changed nothing. */
  unchanged: string[];
  failed: { root: string; error?: string }[];
  blocked: { root: string; by: string }[];
}

/** behold#751: how many tf-apply commits, newest first, {@link TerragucciRead.results} keeps the waves of. */
export const RESULT_COMMITS = 4;

/** behold#751: a tf-apply wave's result from its report; none for a report without the wave's `state` (before minor 21). Pure. */
export function waveResult(w: ReportWave | undefined, finished: string): WaveResult | undefined {
  if (!w || !Number.isInteger(w.number) || !str(w.state) || !w.state) return undefined;
  const outcomes = waveOutcomes(w);
  const blocked = waveBlocked(w);
  const held = new Set(blocked.map((b) => b.root));
  return {
    wave: w.number,
    state: w.state,
    finished,
    applied: outcomes.length ? outcomes.filter((o) => o.outcome === "applied").map((o) => o.root) : w.state === "applied" ? waveRootNames(w).filter((r) => !held.has(r)) : [],
    unchanged: outcomes.filter((o) => o.outcome === "unchanged").map((o) => o.root),
    failed: outcomes.filter((o) => o.outcome === "failed").map((o) => ({ root: o.root, ...(o.error ? { error: o.error } : {}) })),
    blocked,
  };
}

export interface TerragucciRead {
  source: string;
  kind: TerragucciSource["kind"];
  project: string;
  validation: Validation;
  /** When behold read it. Every mark's age is the run's, not this. */
  read: string;
  /** How many report.json files were read. */
  reports: number;
  /** The newest run of each stage that planned each root, by root path. */
  roots: Record<string, { plan?: RootRun; drift?: RootRun; apply?: RootRun; wrote?: RootRun }>;
  waiting: WaitingWave[];
  /**
   * The binary each root ran by the newest report read that names it (`roots[].binary`, minor 18), by root path.
   * Absent when no report names one. A read between two choudoufu roots is of the estate's outputs, not a state file.
   */
  binaries?: Record<string, string>;
  /** #568: the newest pull request's plan, when the index holds one. */
  pull_request?: PullRequestPlan;
  /**
   * terragucci's estate page for this project, when the source has one: the counts it shows, as it shows them.
   * `behind` when the index holds a run of the project finished after the page was generated: the counts are
   * older than the newest run, and `waiting` came from the index instead (behold#571).
   */
  estate?: { generated: string; html: string; drifted: number; failed: number; waiting: number; status: string; behind?: true };
  /** behold#741: the roots the newest apply's waves blocked (report minor 41); absent when none. */
  blocked?: BlockedRead;
  /** behold#741: each root's own outcome in the newest apply's waves; absent when no report carries one. */
  outcomes?: OutcomesRead;
  /**
   * behold#751: each wave's result by its own report, for the newest
   * {@link RESULT_COMMITS} tf-apply commits, by commit, each wave by its
   * newest report. Absent when no report carries a wave's `state`.
   */
  results?: Record<string, WaveResult[]>;
}

export interface ReadOptions {
  /** The project, `<host>/<path>`, when the index holds more than one. */
  project?: string;
  /** The checkout's own project name, from its git remote: the default pick among several. */
  checkoutProject?: string;
  /**
   * behold#749: the request reads another checkout than the serve's own (`serve --repos`, `?repo=`): its project is
   * the one its remote names (matchProject) or none, never `--terragucci-project`'s nor the index's only project.
   */
  strict?: boolean;
  /** The roots the checkout declares, by path: the read stops once each has its newest plan and drift. */
  roots?: readonly string[];
  validator?: Validator;
  now?: Date;
}

async function readDoc<T>(source: TerragucciSource, key: string, name: DocName, v: Validator): Promise<T | undefined> {
  let text: string | undefined;
  try {
    text = await source.read(key);
  } catch (e) {
    refuse(`Could not read ${key} from ${source.location}: ${e instanceof Error ? e.message : String(e)}`, readRemedy(source));
  }
  if (text === undefined) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    refuse(`${key} in ${source.location} is not JSON.`, "Point --terragucci at a terragucci reports directory or bucket prefix, the one holding index.json.");
  }
  const why = v.check(name, doc);
  if (why) {
    refuse(
      `${key} in ${source.location} is not a terragucci ${SCHEMA_IDS[name]} document: ${why}.`,
      v.validation.by === "schema"
        ? `It was checked against @intentius/terragucci ${v.validation.terragucci}'s ${SCHEMA_FILES[name]}. Check that this terragucci wrote it, or upgrade behold.`
        : "Install @intentius/terragucci beside behold to check it against terragucci's own JSON Schemas, and check that terragucci wrote it.",
    );
  }
  return doc as T;
}

const readRemedy = (source: TerragucciSource): string =>
  source.kind === "s3"
    ? "behold reads the bucket with your aws CLI: check `aws s3 cp <key> -` works for this prefix with GetObject on its *index.json, */report.json and estate.json."
    : source.kind === "http"
      ? "Check the address serves the bucket's objects."
      : "Check the directory exists and holds terragucci's reports.";

const under = (base: string, rel: string): string => [base, rel].filter(Boolean).join("/");

/**
 * behold#749: the project among `projects` that a checkout's remote names: the same `<host>/<path>`, else the one
 * project with the same path (`<owner>/<name>`). A demo host's checkouts are cloned from the forge's published port
 * (`localhost:3300/terragucci-admin/demo-fanout`) while its pipeline names the project by the forge's own address
 * (`forgejo:3000/terragucci-admin/demo-fanout`), so the host can't be the key; the owner and name are the repo.
 * Two projects with that path on different hosts name none.
 */
export function matchProject(projects: readonly string[], checkout: string | undefined): string | undefined {
  if (!checkout) return undefined;
  if (projects.includes(checkout)) return checkout;
  const path = (p: string): string => p.slice(p.indexOf("/") + 1).toLowerCase();
  if (!checkout.includes("/")) return undefined;
  const same = projects.filter((p) => p.includes("/") && path(p) === path(checkout));
  return same.length === 1 ? same[0] : undefined;
}

export function pickProject(rows: IndexRow[], opts: ReadOptions, source: TerragucciSource): string {
  const projects = [...new Set(rows.map((r) => r.project))].sort();
  // behold#749: another checkout's request takes its own project or none, so a frame for another scenario's repo
  // draws no plan rather than the pinned project's.
  if (opts.strict) {
    const mine = matchProject(projects, opts.checkoutProject);
    if (mine) return mine;
    return refuse(
      `${source.location}/index.json lists no runs of this checkout's project${opts.checkoutProject ? ` (${opts.checkoutProject})` : ""}.`,
      projects.length ? `Projects in it: ${projects.join(", ")}. A checkout picked with ?repo= reads the project its git remote names, matched by <owner>/<name>.` : "It lists no runs at all yet.",
    );
  }
  if (opts.project) {
    if (!projects.includes(opts.project)) {
      refuse(
        `${source.location}/index.json lists no runs of ${opts.project}.`,
        projects.length ? `Projects in it: ${projects.join(", ")}.` : "It lists no runs at all yet.",
      );
    }
    return opts.project;
  }
  if (projects.length === 1) return projects[0]!;
  const mine = matchProject(projects, opts.checkoutProject);
  if (mine) return mine;
  if (projects.length === 0) refuse(`${source.location}/index.json lists no runs yet.`, "Run terragucci's pipeline once, or point --terragucci at a prefix it has written to.");
  return refuse(
    `${source.location}/index.json lists ${projects.length} projects, and none is this checkout's${opts.checkoutProject ? ` (${opts.checkoutProject})` : ""}.`,
    `Name one with --terragucci-project: ${projects.join(", ")}.`,
  );
}

const newestFirst = (a: IndexRow, b: IndexRow): number => (a.finished < b.finished ? 1 : a.finished > b.finished ? -1 : 0);

/** Read an estate's newest verdicts from `source`. Throws {@link TerragucciReadError} with a structured refusal. */
export async function readTerragucci(source: TerragucciSource, opts: ReadOptions = {}): Promise<TerragucciRead> {
  const v = opts.validator ?? terragucciValidator();
  const index = await readDoc<{ reports: IndexRow[] }>(source, "index.json", "index", v);
  if (!index) {
    refuse(
      `${source.location} has no index.json.`,
      "Point --terragucci at terragucci's report directory (a run's terragucci-report/ has none; a synced bucket prefix or <prefix>/<project> does).",
    );
  }
  const project = pickProject(index!.reports, opts, source);
  const rows = index!.reports.filter((r) => r.project === project).sort(newestFirst);

  const cache = new Map<string, Promise<Report | undefined>>();
  // minor 34: what the reports read say of each root besides the pull request (its binary, a state file), for the cone view.
  const facts: Record<string, RootFacts> = {};
  const seenRoots = new Set<string>();
  const note = (doc: Report | undefined): void => {
    for (const r of doc?.roots ?? []) {
      seenRoots.add(r.path);
      const f = (facts[r.path] ??= {});
      if (f.binary === undefined && r.binary && typeof r.binary.name === "string") f.binary = r.binary.name;
      if (doc!.run.stage === "tf-apply" && r.state && typeof r.state === "object") f.state = true;
    }
  };
  const report = (row: IndexRow): Promise<Report | undefined> => {
    const key = under(row.path, "report.json");
    if (!cache.has(key)) {
      const p = readDoc<Report>(source, key, "report", v);
      cache.set(key, p);
      void p.then(note, () => undefined);
    }
    return cache.get(key)!;
  };

  const wanted = opts.roots ? new Set(opts.roots) : undefined;
  const roots: TerragucciRead["roots"] = {};
  const slot = { "tf-plan": "plan", "tf-drift": "drift", "tf-apply": "apply" } as const;
  for (const stage of ["tf-plan", "tf-drift", "tf-apply"] as const) {
    const key = slot[stage];
    let read = 0;
    for (const row of rows.filter((r) => r.stage === stage)) {
      if (wanted && [...wanted].every((p) => roots[p]?.[key])) break;
      if (read++ >= MAX_RUNS_PER_STAGE) break;
      const doc = await report(row);
      if (!doc) continue; // a row whose run directory is gone: the next one may still hold the root
      for (const r of doc.roots) {
        if (wanted && !wanted.has(r.path)) continue;
        const entry = (roots[r.path] ??= {});
        // The push back to the base after a run is a no-op apply that becomes a root's newest; the run before it still says what the change wrote.
        if (entry[key] && !(stage === "tf-apply" && !entry.wrote && entry.apply && !entry.apply.changes.length && r.changes.length && row.applied)) continue;
        const built: RootRun = {
          stage,
          finished: doc.run.finished,
          commit: doc.run.commit,
          ...(doc.run.wave !== undefined ? { wave: doc.run.wave } : {}),
          ...(doc.run.pull_request ? { pull_request: doc.run.pull_request } : {}),
          ...(doc.run.pull_request_url ? { pull_request_url: doc.run.pull_request_url } : {}),
          ...(doc.run.commit_url ? { commit_url: doc.run.commit_url } : {}),
          ...(doc.run.job_url ? { job_url: doc.run.job_url } : {}),
          ...(doc.run.trace_url ? { trace_url: doc.run.trace_url } : {}),
          report: under(row.path, "report.html"),
          status: r.status,
          ...(r.error ? { error: r.error } : {}),
          changes: r.changes.map((c) => ({
            address: c.address,
            action: c.action,
            ...(c.type ? { type: c.type } : {}),
            ...(c.module ? { module: c.module } : {}),
            attributes: (c.attributes ?? []).filter((a) => !a.sensitive).map(attributeValues),
          })),
          ...(stage === "tf-apply" && row.approval ? { approval: row.approval } : {}),
          ...(stage === "tf-apply" && row.applied ? { applied: row.applied } : {}),
        };
        if (entry[key]) entry.wrote = built;
        else entry[key] = built;
      }
    }
  }

  // #568: the pull request stage, from the newest tf-plan that planned one.
  let pullRequest: PullRequestPlan | undefined;
  const prRow = rows.find((r) => r.stage === "tf-plan" && r.pull_request);
  const prDoc = prRow ? await report(prRow) : undefined;
  if (prRow && prDoc) pullRequest = pullRequestPlan(prDoc, under(prRow.path, "report.html"));

  // The estate page lives at the top of the prefix; a project directory has none.
  const estateDoc = await readDoc<Estate>(source, "estate.json", "estate", v);
  const estateProject = estateDoc?.projects.find((p) => p.project === project);
  // behold#571: estate.json is terragucci's view as of the moment `terragucci
  // estate` ran. A run indexed after that is newer than the page (the demo
  // loop runs estate once a cycle, so the next cycle's waves wait and apply
  // after the page was written): the waiting waves then come from the index,
  // by terragucci's own rule, and the page's counts carry `behind`.
  const behind = !!estateProject && rows.length > 0 && (Date.parse(rows[0]!.finished) || 0) > (Date.parse(estateDoc!.generated) || 0);
  const fromEstate = !!estateProject && !behind;

  const waiting: WaitingWave[] = [];
  const waitingRows: { row: IndexRow; since: string }[] = [];
  if (fromEstate) {
    for (const w of estateProject!.waiting) {
      const row = rows.find((r) => r.stage === "tf-apply" && r.commit === w.commit && r.wave === w.wave);
      if (row) waitingRows.push({ row, since: w.since });
    }
  } else {
    // terragucci's own rule (estate.ts projectState): the waves of the newest
    // commit that ran tf-apply, each by its newest row, waiting.
    const applies = rows.filter((r) => r.stage === "tf-apply");
    const commit = applies[0]?.commit;
    const seen = new Set<number>();
    for (const r of applies.filter((a) => a.commit === commit)) {
      if (r.wave === undefined || seen.has(r.wave)) continue;
      seen.add(r.wave);
      if (r.approval === "waiting") waitingRows.push({ row: r, since: r.waiting_since ?? r.finished });
    }
  }
  for (const { row, since } of waitingRows) {
    const doc = await report(row);
    const wave = doc?.waves.find((w) => w.number === row.wave) ?? doc?.waves[0];
    const digest = wave?.set_digest ?? null;
    waiting.push({
      wave: row.wave!,
      commit: row.commit,
      since,
      roots: waveRootNames(wave),
      set_digest: digest,
      destroys: (doc?.named ?? []).filter((n) => n.action === "delete" || n.action === "replace").map((n) => `${n.root}: ${n.address ?? ""} (${n.action})`),
      report: under(row.path, "report.html"),
      ...(row.job_url ? { job_url: row.job_url } : {}),
      command: terragucciApproveCommand(row.wave!, digest),
      from: fromEstate ? "estate" : "index",
    });
  }

  // behold#741 (terragucci#1161): the roots the newest apply's waves blocked, each wave by its newest report.
  let blocked: BlockedRead | undefined;
  let outcomes: OutcomesRead | undefined;
  {
    const applies = rows.filter((r) => r.stage === "tf-apply");
    const commit = applies[0]?.commit;
    const seen = new Set<number>();
    const found: BlockedRead["roots"] = {};
    const own: OutcomesRead["roots"] = {};
    for (const r of applies.filter((a) => a.commit === commit)) {
      if (r.wave === undefined || seen.has(r.wave)) continue;
      seen.add(r.wave);
      const doc = await report(r);
      const wave = doc?.waves.find((w) => w.number === r.wave) ?? doc?.waves[0];
      for (const b of waveBlocked(wave)) if (!found[b.root]) found[b.root] = { wave: r.wave, by: b.by };
      for (const o of waveOutcomes(wave)) if (!own[o.root]) own[o.root] = { wave: r.wave, outcome: o.outcome, ...(o.error ? { error: o.error } : {}) };
    }
    if (commit && Object.keys(found).length) blocked = { commit, roots: found };
    if (commit && Object.keys(own).length) outcomes = { commit, roots: own };
  }

  // behold#751: each wave's result by its report, for the newest tf-apply commits (a fix's apply, and the change's before it),
  // each wave by its newest report: a wave's words follow what it did ("applied 6, 6 blocked by cluster-a"), not its job's
  // exit, which terragucci fails while roots are blocked.
  const results: Record<string, WaveResult[]> = {};
  {
    const applies = rows.filter((r) => r.stage === "tf-apply" && r.wave !== undefined);
    for (const commit of [...new Set(applies.map((r) => r.commit))].slice(0, RESULT_COMMITS)) {
      const seen = new Set<number>();
      const out: WaveResult[] = [];
      for (const r of applies.filter((a) => a.commit === commit)) {
        if (seen.has(r.wave!)) continue;
        seen.add(r.wave!);
        const doc = await report(r);
        const res = waveResult(doc?.waves.find((w) => w.number === r.wave) ?? doc?.waves[0], doc?.run.finished ?? r.finished);
        if (res) out.push({ ...res, wave: r.wave! });
      }
      if (out.length) results[commit] = out.sort((a, b) => a.wave - b.wave);
    }
  }

  // minor 34: a cone plan, with every root of the estate the read knows and the instances each cone's plan.json planned.
  if (pullRequest && prRow && prDoc) {
    await Promise.all([...cache.values()].map((p) => p.catch(() => undefined)));
    const planned = prDoc.roots.some((r) => r.cone !== undefined) ? await readConePlans(source, prRow.path, prDoc) : {};
    const cone = coneView(prDoc, { roots: [...new Set([...(opts.roots ?? []), ...seenRoots])], planned, facts });
    if (cone) pullRequest.cone = cone;
  }

  return {
    source: source.location,
    kind: source.kind,
    project,
    validation: v.validation,
    read: (opts.now ?? new Date()).toISOString(),
    reports: cache.size,
    roots,
    waiting,
    ...(pullRequest ? { pull_request: pullRequest } : {}),
    ...(Object.values(facts).some((f) => f.binary) ? { binaries: Object.fromEntries(Object.entries(facts).filter(([, f]) => f.binary).map(([p, f]) => [p, f.binary!])) } : {}),
    ...(estateDoc && estateProject
      ? {
          estate: {
            generated: estateDoc.generated,
            html: "estate.html",
            drifted: estateProject.drifted,
            failed: estateProject.failed,
            waiting: estateProject.waiting.length,
            status: estateProject.status,
            ...(behind ? { behind: true } : {}),
          },
        }
      : {}),
    ...(blocked ? { blocked } : {}),
    ...(outcomes ? { outcomes } : {}),
    ...(Object.keys(results).length ? { results } : {}),
  };
}

/** The pull request stage of one tf-plan report (#568). Pure. */
export function pullRequestPlan(doc: Report, report: string): PullRequestPlan {
  return {
    run: {
      commit: doc.run.commit,
      finished: doc.run.finished,
      pull_request: doc.run.pull_request ?? "",
      ...(doc.run.pull_request_url ? { pull_request_url: doc.run.pull_request_url } : {}),
      ...(doc.run.job_url ? { job_url: doc.run.job_url } : {}),
      report,
    },
    reads: doc.roots.flatMap((r) =>
      (r.reads ?? []).map((x) => ({
        root: r.path,
        upstream: x.upstream,
        data: x.data,
        outputs: x.outputs,
        ...(x.unknown?.length ? { unknown: [...x.unknown] } : {}),
        ...(x.why ? { why: x.why } : {}),
        ...(x.composed ? { composed: true } : {}),
      })),
    ),
    roots: doc.roots.map((r) => r.path),
    waves: doc.waves.map((w) => ({
      number: w.number,
      roots: waveRootNames(w),
      ...(w.state ? { state: w.state } : {}),
      // A wave that plans again has no digest a review binds until it does.
      set_digest: w.replans_after?.length ? null : w.set_digest,
      ...(w.review_digest !== undefined ? { review_digest: w.replans_after?.length ? null : w.review_digest } : {}),
      ...(w.waits !== undefined ? { waits: w.waits } : {}),
      ...(w.reads?.length ? { reads: w.reads } : {}),
      ...(w.replans_after?.length ? { replans_after: w.replans_after } : {}),
      ...(w.cost ? { cost: w.cost } : {}),
      // #568 step 3: each member's changes come from its own slice, under its own name.
      ...(w.composed
        ? {
            composed: {
              ...w.composed,
              members: w.composed.members.map((m) => {
                const counts = doc.roots.find((r) => r.path === m.root)?.counts;
                return { ...m, ...(counts ? { counts } : {}) };
              }),
            },
          }
        : {}),
    })),
    ...(doc.compose ? { compose: doc.compose } : {}),
    ...(doc.totals ? { totals: doc.totals } : {}),
    ...(doc.totals_roots !== undefined ? { totals_roots: doc.totals_roots } : {}),
    ...(doc.cost ? { cost: doc.cost } : {}),
    ...(doc.blast ? { blast: doc.blast } : {}),
    ...((): Pick<PullRequestPlan, "counts" | "upstreams"> => {
      // behold#741: per root, for the kiosk's reach and its cards' counts.
      const counts: Record<string, Record<string, number>> = {};
      const upstreams: Record<string, string[]> = {};
      for (const r of doc.roots) {
        if (r.counts && Object.keys(r.counts).length) counts[r.path] = { ...r.counts };
        const ups = [...new Set([...(r.reads ?? []).map((x) => x.upstream), ...(r.dependencies ?? [])])].filter((u) => typeof u === "string" && u && u !== r.path).sort();
        if (ups.length) upstreams[r.path] = ups;
      }
      return { ...(Object.keys(counts).length ? { counts } : {}), ...(Object.keys(upstreams).length ? { upstreams } : {}) };
    })(),
  };
}
