/**
 * SQL Yodeler's report and drift, as dated marks (#526).
 *
 * `behold serve <dir> --yodel-report <file|dir>` reads JSON that the person or
 * their pipeline already wrote:
 *
 * - one `yodel report --json` output: every environment's migrations and the
 *   gaps its sources show, dated by the report's `generatedAt`;
 * - any `yodel drift <env> --json` output beside it: the declared objects
 *   changed out of band (`changed`) or gone (`missing`). A drift document
 *   carries no time of its own, so it is dated by when its file was written,
 *   and says so.
 *
 * behold never runs `yodel` and never connects to the database. Each document
 * is checked against SQL Yodeler's own JSON Schema: from `@intentius/sql-yodeler`
 * when it resolves beside the served project or beside behold, otherwise from
 * the copy pinned in src/sql-yodeler-schemas/ (sql-yodeler 19ebbff, unchanged
 * through e00fd61). A file that fails is refused by name with
 * `code: "yodel-report"`, and nothing from the read is drawn.
 *
 * What comes out is marks, never a status: nothing here writes `_status`.
 * The page places a drift mark on the card its object names, and lists the
 * objects no card is.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { Ajv2020 } from "ajv/dist/2020.js";
import pinnedCommon from "./sql-yodeler-schemas/common.schema.json" with { type: "json" };
import pinnedReport from "./sql-yodeler-schemas/report.schema.json" with { type: "json" };
import pinnedDrift from "./sql-yodeler-schemas/drift.schema.json" with { type: "json" };

/** The sql-yodeler commit the pinned schemas were copied from. */
export const PINNED_COMMIT = "19ebbffd70726e34fc470486f87e70c0d7370b8c";

export interface YodelRefusal {
  error: string;
  code: "yodel-report";
  remedy: string;
}

export class YodelReadError extends Error {
  constructor(readonly refusal: YodelRefusal) {
    super(refusal.error);
  }
}

const refuse = (error: string, remedy: string): never => {
  throw new YodelReadError({ error, code: "yodel-report", remedy });
};

// ---------------------------------------------------------------------------
// The documents, as far as behold reads them. Fields it does not know are
// ignored, as SQL Yodeler's v1 contract asks of a reader.
// ---------------------------------------------------------------------------

type MigrationState = "applied" | "pending" | "failed" | "started" | "reverted";

interface ReportMigration {
  id: string;
  state: MigrationState;
  inDirectory: boolean;
  at?: string;
  by?: string;
  digest?: string;
  approvedBy?: string;
  approvedAt?: string;
}

interface ReportEnvironment {
  name: string;
  history?: string;
  op?: { name: string; gate: string };
  error?: string;
  notes: string[];
  migrations: ReportMigration[];
}

interface ReportGap {
  environment: string;
  kind: "history-row" | "approval";
  detail: string;
}

interface Report {
  version: 1;
  generatedAt: string;
  project: string;
  dialect: "clickhouse" | "postgres";
  migrations: string[];
  environments: ReportEnvironment[];
  audit: unknown[];
  gaps: ReportGap[];
}

interface DriftChange {
  path?: string;
  kind?: string;
  declared?: unknown;
  live?: unknown;
}

interface DriftDoc {
  environment: string;
  dialect: string;
  server?: { address: string };
  changed: { name?: string; type?: string; changes: DriftChange[] }[];
  missing: string[];
  unobserved: { name: string; reason?: string }[];
  against?: { source: "src" } | { source: "history"; migration: string | null };
  drifted: boolean;
  fingerprint?: string;
}

// ---------------------------------------------------------------------------
// Validation: SQL Yodeler's schemas, installed or pinned.
// ---------------------------------------------------------------------------

export type YodelValidation = { by: "schema"; from: "package"; sqlYodeler: string } | { by: "schema"; from: "pinned"; commit: string };

export interface YodelValidator {
  validation: YodelValidation;
  /** Undefined when the document passes, else why the schema rejects it. */
  check(name: "report" | "drift", doc: unknown): string | undefined;
}

function compile(schemas: { common: object; report: object; drift: object }, validation: YodelValidation): YodelValidator {
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  ajv.addSchema(schemas.common);
  const compiled = { report: ajv.compile(schemas.report), drift: ajv.compile(schemas.drift) };
  return {
    validation,
    check(name, doc) {
      const v = compiled[name];
      if (v(doc)) return undefined;
      const e = v.errors?.[0];
      return `${name}.schema.json rejects it: ${e?.instancePath || "/"} ${e?.message ?? "is invalid"}`;
    },
  };
}

let pinned: YodelValidator | undefined;
const installed = new Map<string, YodelValidator>();

/** The package's root when `@intentius/sql-yodeler` resolves from `from`. */
function packageRoot(from: string): string | undefined {
  let entry: string;
  try {
    entry = createRequire(join(resolve(from), "noop.js")).resolve("@intentius/sql-yodeler");
  } catch {
    return undefined;
  }
  // The entry is <root>/dist/index.js; walk up to the package.json that names the package.
  for (let d = dirname(entry); d !== dirname(d); d = dirname(d)) {
    try {
      const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "@intentius/sql-yodeler") return d;
    } catch {
      // keep walking
    }
  }
  return undefined;
}

/**
 * SQL Yodeler's schemas from `@intentius/sql-yodeler` when it resolves from one
 * of `dirs` (the served project first, then behold itself), else behold's
 * pinned copy. Looked up per read, so an install during a serve is used.
 */
export function yodelValidator(dirs: readonly string[] = []): YodelValidator {
  for (const from of [...dirs, dirname(fileURLToPath(import.meta.url))]) {
    const root = packageRoot(from);
    if (!root) continue;
    try {
      const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "";
      const key = `${root}\u0000${version}`;
      let v = installed.get(key);
      if (!v) {
        const load = (n: string) => JSON.parse(readFileSync(join(root, "schemas", `${n}.schema.json`), "utf8")) as object;
        v = compile({ common: load("common"), report: load("report"), drift: load("drift") }, { by: "schema", from: "package", sqlYodeler: version });
        installed.set(key, v);
      }
      return v;
    } catch {
      // An install without its schemas: fall through to the pinned copy.
    }
  }
  pinned ??= compile({ common: pinnedCommon, report: pinnedReport, drift: pinnedDrift }, { by: "schema", from: "pinned", commit: PINNED_COMMIT.slice(0, 7) });
  return pinned;
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

/** Where a mark came from and when. */
export interface Dated {
  at: string;
  /** `generatedAt`: the report's own time. `file-written`: a drift file's mtime, since drift JSON carries no time. */
  by: "generatedAt" | "file-written";
  /** The file it was read from, as named on the command line or in the directory. */
  file: string;
}

export interface EnvironmentMarks {
  name: string;
  history?: string;
  op?: { name: string; gate: string };
  error?: string;
  notes: string[];
  applied: ReportMigration[];
  /** Every migration not applied, with its state (pending, failed, started, reverted). */
  other: ReportMigration[];
  gaps: ReportGap[];
  dated: Dated;
}

/** One drift mark: an object the drift read named, for the page to place on its card. */
export interface DriftMark {
  object: string;
  type?: string;
  kind: "changed" | "missing";
  environment: string;
  /** In the drift read's words: "changed out of band", "gone from the server". */
  words: string;
  changes: DriftChange[];
  against?: DriftDoc["against"];
  dated: Dated;
}

export interface DriftRead {
  file: string;
  environment: string;
  drifted: boolean;
  changed: number;
  missing: number;
  unobserved: { name: string; reason?: string }[];
  server?: string;
  fingerprint?: string;
  dated: Dated;
}

export interface YodelRead {
  source: string;
  validation: YodelValidation;
  report: { file: string; project: string; dialect: string; generatedAt: string; migrations: number } | null;
  environments: EnvironmentMarks[];
  drift: DriftRead[];
  /** Drift marks; the page joins each to the card whose id its object names. */
  marks: DriftMark[];
  /** JSON files in the directory that are neither a report nor drift. Said, never dropped silently. */
  ignored: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const looksLikeReport = (d: unknown) => isRecord(d) && "generatedAt" in d && "environments" in d;
const looksLikeDrift = (d: unknown) => isRecord(d) && "environment" in d && ("drifted" in d || "changed" in d);

/** The files a source names: the file and the JSON beside it, or the JSON in a directory. */
function filesOf(source: string): { dir: string; files: string[]; named?: string } {
  let st;
  try {
    st = statSync(source);
  } catch {
    return refuse(`--yodel-report ${source}: no such file or directory`, "Point --yodel-report at the file `yodel report --json` wrote, or the directory holding it.");
  }
  const dir = st.isDirectory() ? source : dirname(source);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
  return st.isDirectory() ? { dir, files } : { dir, files, named: resolve(source) };
}

/** Read a report and the drift beside it. Throws {@link YodelReadError} on anything it cannot read. */
export function readYodelReport(source: string, validator: YodelValidator): YodelRead {
  const { files, named } = filesOf(resolve(source));
  let report: { file: string; doc: Report } | undefined;
  const drifts: { file: string; doc: DriftDoc; mtime: string }[] = [];
  const ignored: string[] = [];
  const remedy = "behold reads `yodel report --json` and `yodel drift <env> --json` as SQL Yodeler writes them. Write the file again with yodel, or move it out of the directory.";
  for (const file of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      // A file in the directory that is not JSON is someone else's, unless it is the one named.
      if (file === named) refuse(`${basename(file)} is not JSON: ${e instanceof Error ? e.message : String(e)}`, remedy);
      ignored.push(basename(file));
      continue;
    }
    const kind = file === named ? (looksLikeDrift(doc) ? "drift" : "report") : looksLikeReport(doc) ? "report" : looksLikeDrift(doc) ? "drift" : undefined;
    // A named report is the one read; another report beside it is not.
    if (!kind || (kind === "report" && named && file !== named)) {
      ignored.push(basename(file));
      continue;
    }
    const why = validator.check(kind, doc);
    if (why) refuse(`${basename(file)} is not a SQL Yodeler ${kind} document: ${why}`, remedy);
    if (kind === "report") {
      if (report) refuse(`${source} holds two reports, ${basename(report.file)} and ${basename(file)}`, "Name the one to read: --yodel-report <file>.");
      report = { file, doc: doc as Report };
    } else {
      drifts.push({ file, doc: doc as DriftDoc, mtime: statSync(file).mtime.toISOString() });
    }
  }
  if (!report && drifts.length === 0) {
    refuse(`${source} holds no yodel report or drift JSON`, "Write one with `yodel report --json > report.json` (and `yodel drift <env> --json > drift-<env>.json`), then point --yodel-report at it.");
  }

  const environments: EnvironmentMarks[] = [];
  if (report) {
    const dated: Dated = { at: report.doc.generatedAt, by: "generatedAt", file: basename(report.file) };
    for (const e of report.doc.environments) {
      environments.push({
        name: e.name,
        ...(e.history ? { history: e.history } : {}),
        ...(e.op ? { op: e.op } : {}),
        ...(e.error ? { error: e.error } : {}),
        notes: e.notes,
        applied: e.migrations.filter((m) => m.state === "applied"),
        other: e.migrations.filter((m) => m.state !== "applied"),
        gaps: report.doc.gaps.filter((g) => g.environment === e.name),
        dated,
      });
    }
  }

  const marks: DriftMark[] = [];
  const drift: DriftRead[] = [];
  for (const d of drifts) {
    const dated: Dated = { at: d.mtime, by: "file-written", file: basename(d.file) };
    drift.push({
      file: basename(d.file),
      environment: d.doc.environment,
      drifted: d.doc.drifted,
      changed: d.doc.changed.length,
      missing: d.doc.missing.length,
      unobserved: d.doc.unobserved,
      ...(d.doc.server ? { server: d.doc.server.address } : {}),
      ...(d.doc.fingerprint ? { fingerprint: d.doc.fingerprint } : {}),
      dated,
    });
    for (const c of d.doc.changed) {
      if (typeof c.name !== "string") continue;
      marks.push({ object: c.name, ...(c.type ? { type: c.type } : {}), kind: "changed", environment: d.doc.environment, words: "changed out of band", changes: c.changes, ...(d.doc.against ? { against: d.doc.against } : {}), dated });
    }
    for (const m of d.doc.missing) {
      marks.push({ object: m, kind: "missing", environment: d.doc.environment, words: "gone from the server", changes: [], ...(d.doc.against ? { against: d.doc.against } : {}), dated });
    }
  }

  return {
    source,
    validation: validator.validation,
    report: report
      ? { file: basename(report.file), project: report.doc.project, dialect: report.doc.dialect, generatedAt: report.doc.generatedAt, migrations: report.doc.migrations.length }
      : null,
    environments,
    drift,
    marks,
    ignored,
  };
}

/** `GET /api/yodel-report`: the read, or the refusal (422). Read per request: the files are local and small. */
export function yodelReportRoute(app: Hono, source: string, dirs: () => string[]): void {
  app.get("/api/yodel-report", (c) => {
    try {
      return c.json(readYodelReport(source, yodelValidator(dirs())));
    } catch (e) {
      if (e instanceof YodelReadError) return c.json(e.refusal, 422);
      throw e;
    }
  });
}
