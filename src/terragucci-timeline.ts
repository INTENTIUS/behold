/**
 * A timeline lane from terragucci's audit record (#506).
 *
 * terragucci's scheduled `terragucci audit` writes `<prefix>/audit.jsonl` at
 * the top of the reports prefix: one `terragucci.audit/v1` entry per line, an
 * approval, an approval request or revocation, a policy override, an apply, a
 * refused wave, a state migration, a lock's release, a state export, or an
 * ephemeral copy's apply or destroy, each with who, when and the evidence it
 * was built from (terragucci `packages/terragucci/src/report/audit.ts`;
 * reference page `reference/audit-trail`).
 *
 * behold reads it with one GET of `audit.jsonl` from the same `--terragucci`
 * source and writes nothing. When the source has no `audit.jsonl` (the job
 * does not run `terragucci audit`, or the source is one project's directory
 * rather than the prefix), the answer says so: that is not "no events".
 *
 * Each line is checked against `dist/audit.schema.json` when
 * `@intentius/terragucci` resolves (0.4.7 and newer ship it), otherwise
 * structurally: the schema id and the fields read here, with their types. One
 * line that fails is a refusal of the whole record, `code:
 * "terragucci-report"`, naming the line; behold never draws a timeline with a
 * gap it chose not to mention.
 *
 * An entry keeps its time (`at`) and its run. A report entry's run is the
 * wave report it was built from, as a key under the source (its
 * `evidence.key` from `<project>/` on, `report.html` for `report.json`); a
 * ledger entry of a wave gate takes the report of the newest report entry of
 * the same gate and digest, when the record holds one. The roots an entry
 * concerns are its `detail.roots`, or its `what` for a kind whose `what` is a
 * root, and an approval or its revocation, which names no root, takes the
 * roots of the entries of the same gate and digest.
 */
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { Ajv2020 } from "ajv/dist/2020.js";
import { TerragucciReadError, type Validation } from "./terragucci-reports.ts";
import type { TerragucciSource } from "./terragucci-source.ts";

export const AUDIT_SCHEMA = "terragucci.audit/v1";
/** The record's key, at the top of the reports prefix. */
export const AUDIT_KEY = "audit.jsonl";
export const AUDIT_SCHEMA_FILE = "audit.schema.json";
export const AUDIT_KINDS = [
  "approval-requested",
  "approval",
  "approval-revoked",
  "override-requested",
  "override",
  "override-revoked",
  "apply",
  "refused",
  "migration",
  "unlock",
  "state-export",
  "ephemeral-apply",
  "ephemeral-destroy",
] as const;

/** Kinds whose `what` is a root rather than a gate. */
const WHAT_IS_ROOT = new Set(["override-requested", "override", "override-revoked", "unlock", "state-export"]);

/** How many entries an answer carries by default, and at most. */
export const TIMELINE_LIMIT = 200;
export const TIMELINE_MAX = 1000;
/** How long a read of the record is reused. */
export const TIMELINE_TTL_MS = 30_000;

/** One line of audit.jsonl, as far as behold reads it. */
export interface AuditEntry {
  schema: string;
  id: string;
  kind: string;
  project: string;
  at: string;
  who: string | null;
  what: string;
  digest: string | null;
  result: string;
  evidence: { source: string; branch?: string; path?: string; commit?: string; bucket?: string; key?: string; url?: string; job_url?: string };
  detail?: Record<string, unknown>;
}

/** One entry of the lane. */
export interface TimelineEntry {
  id: string;
  kind: string;
  /** When it happened, as the record says. */
  at: string;
  /** Who: the approver, the overrider, whoever removed the line. Null when nobody did. */
  who: string | null;
  /** The gate (`wave-<k>`, `pr-<n>`, a migration's name) or the root. */
  what: string;
  wave?: number;
  digest: string | null;
  result: string;
  /** The roots the entry concerns, by terragucci's path. */
  roots: string[];
  /** The run behind it: the code commit, the CI job and run, the pull request, and its report as a key under the source. */
  run: { commit?: string; job_url?: string; run_id?: string; pull_request?: string; report?: string };
  evidence: AuditEntry["evidence"];
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Checking a line.
// ---------------------------------------------------------------------------

export interface AuditValidator {
  validation: Validation;
  /** Why `doc` is not a terragucci.audit/v1 entry, or undefined when it is. */
  check(doc: unknown): string | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

/** behold's own check: the schema id and the fields the lane reads, with their types. */
export function structuralAudit(doc: unknown): string | undefined {
  if (!isRecord(doc)) return "it is not a JSON object";
  if (doc.schema !== AUDIT_SCHEMA) return `its schema is ${JSON.stringify(doc.schema)}, not ${AUDIT_SCHEMA}`;
  for (const f of ["id", "kind", "project", "at", "what", "result"] as const) if (!str(doc[f])) return `its ${f} is not a string`;
  if (Number.isNaN(Date.parse(doc.at as string))) return `its at, ${JSON.stringify(doc.at)}, is not a time`;
  if (doc.who !== null && !str(doc.who)) return "its who is neither a string nor null";
  if (doc.digest !== null && !str(doc.digest)) return "its digest is neither a string nor null";
  if (!isRecord(doc.evidence) || !str(doc.evidence.source)) return "its evidence has no source";
  if (doc.detail !== undefined && !isRecord(doc.detail)) return "its detail is not an object";
  return undefined;
}

/** A validator over a parsed `audit.schema.json`. The schema id is checked first, so a v2 line is refused by name. */
export function compileAuditSchema(schema: object, version: string): AuditValidator {
  const v = new Ajv2020({ strict: false, allErrors: false }).compile(schema);
  return {
    validation: { by: "schema", terragucci: version },
    check(doc) {
      const id = isRecord(doc) ? doc.schema : undefined;
      if (id !== AUDIT_SCHEMA) return `its schema is ${JSON.stringify(id)}, not ${AUDIT_SCHEMA}`;
      if (v(doc)) return undefined;
      const e = v.errors?.[0];
      return `${AUDIT_SCHEMA_FILE} rejects it: ${e?.instancePath || "/"} ${e?.message ?? "is invalid"}`;
    },
  };
}

/** Compiled audit schemas, by the package's dist directory and its files' mtimes, the way src/terragucci-reports.ts keeps its own (#500). */
const compiled = new Map<string, AuditValidator>();

/**
 * The validator for the record: `@intentius/terragucci`'s `dist/audit.schema.json`
 * when the package resolves from one of `dirs` (the served project first) or
 * from behold, otherwise the structural check. Looked up on every read.
 */
export function auditValidator(dirs: readonly string[] = []): AuditValidator {
  for (const from of [...dirs, dirname(fileURLToPath(import.meta.url))]) {
    let dist: string;
    try {
      dist = dirname(createRequire(join(resolve(from), "noop.js")).resolve("@intentius/terragucci/report.schema.json"));
    } catch {
      continue;
    }
    const pkg = join(dist, "..", "package.json");
    const file = join(dist, AUDIT_SCHEMA_FILE);
    let stamp: string;
    try {
      stamp = [dist, ...[pkg, file].map((f) => {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      })].join("\u0000");
    } catch {
      continue; // a terragucci older than the audit schema: the structural check runs
    }
    const hit = compiled.get(stamp);
    if (hit) return hit;
    let v: AuditValidator;
    try {
      const version = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "";
      v = compileAuditSchema(JSON.parse(readFileSync(file, "utf8")) as object, version);
    } catch {
      continue;
    }
    for (const k of compiled.keys()) if (k.startsWith(`${dist}\u0000`)) compiled.delete(k);
    compiled.set(stamp, v);
    return v;
  }
  return { validation: { by: "structural" }, check: structuralAudit };
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

const refuse = (error: string, remedy: string): never => {
  throw new TerragucciReadError({ error, code: "terragucci-report", remedy });
};

/** Every entry of `text`, in the record's order. A line that is not an entry refuses the whole record. */
export function parseAudit(text: string, location: string, v: AuditValidator): AuditEntry[] {
  const out: AuditEntry[] = [];
  const lines = text.split("\n");
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(line);
    } catch {
      refuse(`${AUDIT_KEY} in ${location}, line ${i + 1}, is not JSON.`, "Check that terragucci audit wrote it; its record is one JSON object per line.");
    }
    const why = v.check(doc);
    if (why) {
      refuse(
        `${AUDIT_KEY} in ${location}, line ${i + 1}, is not a terragucci ${AUDIT_SCHEMA} entry: ${why}.`,
        v.validation.by === "schema"
          ? `It was checked against @intentius/terragucci ${v.validation.terragucci}'s ${AUDIT_SCHEMA_FILE}. Check that this terragucci wrote it, or upgrade behold.`
          : "Install @intentius/terragucci beside behold to check it against terragucci's own JSON Schema, and check that terragucci wrote it.",
      );
    }
    out.push(doc as AuditEntry);
  }
  return out;
}

/** The roots an entry names itself: `detail.roots` (paths, or objects with a `root`), else `what` for a kind whose `what` is a root. */
function ownRoots(e: AuditEntry): string[] {
  const roots = new Set<string>();
  const listed = e.detail?.roots;
  if (Array.isArray(listed)) {
    for (const r of listed) {
      if (str(r)) roots.add(r);
      else if (isRecord(r) && str(r.root)) roots.add(r.root);
      else if (isRecord(r) && str(r.path)) roots.add(r.path);
    }
  }
  if (WHAT_IS_ROOT.has(e.kind)) roots.add(e.what);
  return [...roots];
}

/** A report entry's report page, as a key under the source: `<project>/<run>/report.html`. */
export function reportKey(e: AuditEntry): string | undefined {
  const k = e.evidence.key;
  if (e.evidence.source !== "report" || !str(k) || !k.endsWith("/report.json")) return undefined;
  const inner = k.indexOf(`/${e.project}/`);
  const from = k.startsWith(`${e.project}/`) ? 0 : inner < 0 ? -1 : inner + 1;
  if (from < 0) return undefined;
  return `${k.slice(from, -"report.json".length)}report.html`;
}

const at = (iso: string): number => Date.parse(iso);

/** The entries of `project`, newest first, each with its roots and its run. */
export function timelineEntries(entries: readonly AuditEntry[], project: string): TimelineEntry[] {
  const mine = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.project === project);
  const gate = (e: AuditEntry): string => `${e.what}\u0000${e.digest ?? ""}`;
  // The roots and the newest report of each gate and digest, from the entries that name them.
  const gateRoots = new Map<string, Set<string>>();
  const gateReport = new Map<string, { at: number; key: string }>();
  for (const { e } of mine) {
    if (WHAT_IS_ROOT.has(e.kind)) continue;
    const roots = ownRoots(e);
    if (roots.length) {
      const s = gateRoots.get(gate(e)) ?? new Set<string>();
      for (const r of roots) s.add(r);
      gateRoots.set(gate(e), s);
    }
    const key = reportKey(e);
    const prev = gateReport.get(gate(e));
    if (key && (!prev || at(e.at) >= prev.at)) gateReport.set(gate(e), { at: at(e.at), key });
  }
  const out = mine.map(({ e, i }) => {
    const d = e.detail ?? {};
    let roots = ownRoots(e);
    if (!roots.length && (e.kind === "approval" || e.kind === "approval-revoked")) roots = [...(gateRoots.get(gate(e)) ?? [])];
    const waveNo = typeof d.wave === "number" ? d.wave : /^wave-(\d+)$/.exec(e.what)?.[1];
    const report = reportKey(e) ?? (WHAT_IS_ROOT.has(e.kind) ? undefined : gateReport.get(gate(e))?.key);
    const pr = d.pull_request;
    const entry: TimelineEntry = {
      id: e.id,
      kind: e.kind,
      at: e.at,
      who: e.who,
      what: e.what,
      ...(waveNo !== undefined ? { wave: Number(waveNo) } : {}),
      digest: e.digest,
      result: e.result,
      roots,
      run: {
        ...(str(d.commit) ? { commit: d.commit } : {}),
        ...(str(e.evidence.job_url) ? { job_url: e.evidence.job_url } : {}),
        ...(str(d.run_id) ? { run_id: d.run_id } : {}),
        ...(str(pr) || typeof pr === "number" ? { pull_request: String(pr) } : {}),
        ...(report ? { report } : {}),
      },
      evidence: e.evidence,
      ...(e.detail ? { detail: e.detail } : {}),
    };
    return { entry, i };
  });
  // Newest first; two entries at one instant keep the record's order, reversed.
  out.sort((a, b) => at(b.entry.at) - at(a.entry.at) || b.i - a.i);
  return out.map((x) => x.entry);
}

export interface TimelineRead {
  source: string;
  kind: TerragucciSource["kind"];
  validation: Validation;
  /** When behold read it. */
  read: string;
  /** Whether the source has the record. */
  present: boolean;
  /** The project the entries are of; null when nothing names one (an empty or absent record, no --terragucci-project). */
  project: string | null;
  /** Every project the record holds. */
  projects: string[];
  /** How many lines the record holds, every project. */
  lines: number;
  entries: TimelineEntry[];
}

export interface TimelineOptions {
  /** `--terragucci-project`. */
  project?: string;
  /** The checkout's own project, from its git remote: the pick among several. */
  checkoutProject?: string;
  validator?: AuditValidator;
  now?: Date;
}

/** Read the record from `source` with one GET. Throws {@link TerragucciReadError} with a structured refusal. */
export async function readTimeline(source: TerragucciSource, opts: TimelineOptions = {}): Promise<TimelineRead> {
  const v = opts.validator ?? auditValidator();
  let text: string | undefined;
  try {
    text = await source.read(AUDIT_KEY);
  } catch (e) {
    refuse(
      `Could not read ${AUDIT_KEY} from ${source.location}: ${e instanceof Error ? e.message : String(e)}`,
      source.kind === "s3" ? "behold reads the bucket with your aws CLI or the environment's credentials: check GetObject on <prefix>/audit.jsonl." : "Check the source serves the reports prefix.",
    );
  }
  const base = { source: source.location, kind: source.kind, validation: v.validation, read: (opts.now ?? new Date()).toISOString() };
  if (text === undefined) return { ...base, present: false, project: opts.project ?? opts.checkoutProject ?? null, projects: [], lines: 0, entries: [] };
  const all = parseAudit(text, source.location, v);
  const projects = [...new Set(all.map((e) => e.project))].sort();
  let project: string | null;
  if (opts.project) project = opts.project;
  else if (projects.length <= 1) project = projects[0] ?? opts.checkoutProject ?? null;
  else if (opts.checkoutProject && projects.includes(opts.checkoutProject)) project = opts.checkoutProject;
  else {
    project = refuse(
      `${source.location}/${AUDIT_KEY} holds ${projects.length} projects, and none is this checkout's${opts.checkoutProject ? ` (${opts.checkoutProject})` : ""}.`,
      `Name one with --terragucci-project: ${projects.join(", ")}.`,
    );
  }
  return { ...base, present: true, project, projects, lines: all.length, entries: project ? timelineEntries(all, project) : [] };
}

/** The sentence an answer carries when the source has no record. */
export const absentWords = (location: string): string =>
  `${location} has no ${AUDIT_KEY}: terragucci writes its audit record at the top of the reports prefix when the estate job runs \`terragucci audit\`. This says nothing about whether anything happened.`;

export interface TimelineAnswer {
  source: string;
  kind: TerragucciSource["kind"];
  project: string | null;
  validation: Validation;
  read: string;
  record: { key: typeof AUDIT_KEY; present: boolean };
  /** Present when the source has no record, saying so. */
  absent?: string;
  /** Where a `run.report` key opens. */
  files: string;
  /** The root asked for, when one was. */
  root?: string;
  /** Entries of the project (of the root, when asked) before the limit. */
  total: number;
  limit: number;
  entries: TimelineEntry[];
}

/** The answer for one request: the project's entries, of `root` when asked, newest first, at most `limit`. */
export function timelineAnswer(r: TimelineRead, q: { root?: string; limit?: number } = {}): TimelineAnswer {
  const limit = q.limit ?? TIMELINE_LIMIT;
  const matched = q.root ? r.entries.filter((e) => e.roots.includes(q.root!)) : r.entries;
  return {
    source: r.source,
    kind: r.kind,
    project: r.project,
    validation: r.validation,
    read: r.read,
    record: { key: AUDIT_KEY, present: r.present },
    ...(r.present ? {} : { absent: absentWords(r.source) }),
    files: "/api/terragucci/file?key=",
    ...(q.root ? { root: q.root } : {}),
    total: matched.length,
    limit,
    entries: matched.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// The route.
// ---------------------------------------------------------------------------

export interface TimelineRouteOptions {
  project?: string;
  /** The checkout's project, asked per request (a project switch changes it). */
  checkoutProject?: () => string | undefined;
  /** The validator, asked per read. */
  validator?: () => AuditValidator;
  now?: () => Date;
}

/** `GET /api/terragucci/timeline?root=<path>&limit=<n>`: the lane. Read-only: one GET of audit.jsonl per read, cached 30 s. */
export function terragucciTimelineRoute(app: Hono, source: TerragucciSource, opts: TimelineRouteOptions = {}): void {
  let cached: { at: number; key: string; read: Promise<TimelineRead> } | undefined;
  app.get("/api/terragucci/timeline", async (c) => {
    const q = new URL(c.req.url).searchParams;
    const rawLimit = q.get("limit");
    let limit: number | undefined;
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > TIMELINE_MAX) {
        return c.json({ error: `limit must be a whole number from 1 to ${TIMELINE_MAX}, not ${JSON.stringify(rawLimit)}`, code: "terragucci-timeline" }, 400);
      }
    }
    const root = q.get("root") || undefined;
    const checkout = opts.checkoutProject?.();
    const key = checkout ?? "";
    const now = Date.now();
    if (q.get("fresh") === "1" || !cached || cached.key !== key || now - cached.at >= TIMELINE_TTL_MS) {
      const p = readTimeline(source, {
        ...(opts.project ? { project: opts.project } : {}),
        ...(checkout ? { checkoutProject: checkout } : {}),
        ...(opts.validator ? { validator: opts.validator() } : {}),
        ...(opts.now ? { now: opts.now() } : {}),
      });
      cached = { at: now, key, read: p };
      p.catch(() => (cached = undefined));
    }
    let r: TimelineRead;
    try {
      r = await cached!.read;
    } catch (e) {
      if (e instanceof TerragucciReadError) return c.json(e.refusal, 422);
      throw e;
    }
    return c.json(timelineAnswer(r, { ...(root ? { root } : {}), ...(limit ? { limit } : {}) }));
  });
}
