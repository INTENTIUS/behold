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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { TerragucciSource } from "./terragucci-source.ts";

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
  attributes?: { path: string; sensitive?: boolean }[];
}

export interface ReportRoot {
  path: string;
  status: "planned" | "failed";
  error?: string;
  changes: ReportChange[];
}

export interface ReportWave {
  number: number;
  roots: string[];
  set_digest: string | null;
  approval: string;
  waiting_since?: string;
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
 * The validator for documents read for the project at `dirs[0]`: terragucci's
 * schemas when `@intentius/terragucci` resolves from one of `dirs` (the served
 * project first, then behold itself), otherwise behold's structural check.
 * The schema id is always checked first, so a v2 document is refused by name
 * whichever check runs.
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
    try {
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
    } catch {
      // A package without one of the three schemas (an older terragucci) is
      // no reason to refuse; the structural check still runs.
      continue;
    }
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
  roots: Record<string, { plan?: RootRun; drift?: RootRun; apply?: RootRun }>;
  waiting: WaitingWave[];
  /** terragucci's estate page for this project, when the source has one: the counts it shows, as it shows them. */
  estate?: { generated: string; html: string; drifted: number; failed: number; waiting: number; status: string };
}

export interface ReadOptions {
  /** The project, `<host>/<path>`, when the index holds more than one. */
  project?: string;
  /** The checkout's own project name, from its git remote: the default pick among several. */
  checkoutProject?: string;
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

function pickProject(rows: IndexRow[], opts: ReadOptions, source: TerragucciSource): string {
  const projects = [...new Set(rows.map((r) => r.project))].sort();
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
  if (opts.checkoutProject && projects.includes(opts.checkoutProject)) return opts.checkoutProject;
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
  const report = (row: IndexRow): Promise<Report | undefined> => {
    const key = under(row.path, "report.json");
    if (!cache.has(key)) cache.set(key, readDoc<Report>(source, key, "report", v));
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
        if (entry[key]) continue;
        entry[key] = {
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
            attributes: (c.attributes ?? []).filter((a) => !a.sensitive).map((a) => ({ path: a.path })),
          })),
          ...(stage === "tf-apply" && row.approval ? { approval: row.approval } : {}),
          ...(stage === "tf-apply" && row.applied ? { applied: row.applied } : {}),
        };
      }
    }
  }

  // The estate page lives at the top of the prefix; a project directory has none.
  const estateDoc = await readDoc<Estate>(source, "estate.json", "estate", v);
  const estateProject = estateDoc?.projects.find((p) => p.project === project);

  const waiting: WaitingWave[] = [];
  const waitingRows: { row: IndexRow; since: string }[] = [];
  if (estateProject) {
    for (const w of estateProject.waiting) {
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
      roots: wave?.roots ?? [],
      set_digest: digest,
      destroys: (doc?.named ?? []).filter((n) => n.action === "delete" || n.action === "replace").map((n) => `${n.root}: ${n.address ?? ""} (${n.action})`),
      report: under(row.path, "report.html"),
      ...(row.job_url ? { job_url: row.job_url } : {}),
      command: `npx terragucci approve wave-${row.wave}${digest ? ` --plan ${digest}` : ""}`,
      from: estateProject ? "estate" : "index",
    });
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
    ...(estateDoc && estateProject
      ? {
          estate: {
            generated: estateDoc.generated,
            html: "estate.html",
            drifted: estateProject.drifted,
            failed: estateProject.failed,
            waiting: estateProject.waiting.length,
            status: estateProject.status,
          },
        }
      : {}),
  };
}
