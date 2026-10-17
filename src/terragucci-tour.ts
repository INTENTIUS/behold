/**
 * Tours (behold.tour/v1): a cycle told as chapters, each standing on real
 * events and records. The tour file (web/tours/<name>.json, shipped with
 * behold, or a served repo's `.behold/tours/*.json`) names the chapters, what
 * fires each, the runs and facts it reads, and the visuals it shows. This
 * module finds the tour for the demo's cycle, reads what its runs and facts
 * name from terragucci's reports, and hands the page the tour with every
 * number, address and value resolved, plus the cycle's events. The page's
 * player (web/tour-player.js) decides the chapter from those events.
 *
 * Every value comes from a record: a report's index row and its report.json
 * and plan.json, a migration record, runs/index.json's jobs, demo.json. A
 * fact or visual whose record is not there yet is left out of the answer, so
 * the page never shows a 0 or a light no record backs.
 *
 * Reads, each a GET of one key under the `--terragucci` source:
 * `<project>/index.json` for each project a run names; for each run found,
 * its `report.json` and the `plan.json` of each of its roots that a visual
 * needs; `runs/index.json` for the waves' jobs. Report and plan documents are
 * written once and never change, so each is read once and kept.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { TerragucciSource } from "./terragucci-source.ts";
import { repoProjects } from "./terragucci-carve.ts";

export const TOUR_SCHEMA_ID = "behold.tour/v1";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// --- the tour file -------------------------------------------------------------

export type TourTrigger =
  | { beat?: string; step?: string }
  | { migration: string; line: "first" | "last" }
  | { wave: number; edge: "start" | "end"; after?: string }
  | { any: TourTrigger[] };

export interface TourRun {
  migration?: string;
  repo?: string;
  stage?: "tf-plan" | "tf-apply";
  wave?: number;
  pull?: null;
  after?: string;
  pick?: "first" | "last";
}

export type TourFact =
  | { run: string; value: "planned" | "changed" | "recreated" | "output" | "job"; output?: string }
  | { migration: string; value: "stamped" | "moved" | "refused" | "skipped" | "writes" | "version_id" | "approved_by" }
  | { sum: string[] }
  | { approvals: true }
  | { duration: { from: "started_at"; to: string } };

export interface TourShow {
  light?: string[];
  pulse?: string;
  travel?: string;
  output?: string;
  wave?: number;
  state?: string;
  checks?: string;
  counts?: "estates";
  card?: { label: string; text: string }[];
  when?: TourTrigger;
}

export interface TourChapter {
  id: string;
  trigger: TourTrigger;
  title: string;
  text?: string[];
  focus?: { boxes?: "source" | "all" | "lit" };
  show?: TourShow[];
}

export interface TourFile {
  schema: typeof TOUR_SCHEMA_ID;
  name: string;
  title?: string;
  match?: { tool?: string; scenario?: string };
  steps?: string[];
  runs?: Record<string, TourRun>;
  facts?: Record<string, TourFact>;
  chapters: TourChapter[];
}

/** web/, beside src/ in the repo and beside dist/ in the package. */
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
/** The tours behold ships, and the schema each tour file is checked against. */
export const TOURS_DIR = join(webRoot, "tours");
export const TOUR_SCHEMA_FILE = join(TOURS_DIR, "behold.tour.v1.schema.json");

let validator: ((doc: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null } = null as never;
/** What is wrong with a tour file against behold.tour/v1, or undefined when it is one. */
export function tourProblem(doc: unknown): string | undefined {
  if (!validator) validator = new Ajv2020({ strict: false, allErrors: false }).compile(JSON.parse(readFileSync(TOUR_SCHEMA_FILE, "utf8")) as object) as never;
  if (validator(doc)) {
    const t = doc as TourFile;
    // A name the file uses must be one it defines.
    const runs = new Set(Object.keys(t.runs ?? {}));
    const facts = new Set(Object.keys(t.facts ?? {}));
    for (const [n, r] of Object.entries(t.runs ?? {})) if (r.after && !runs.has(r.after)) return `run ${n} is after ${r.after}, which the tour does not define`;
    for (const [n, f] of Object.entries(t.facts ?? {})) {
      if ("run" in f && !runs.has(f.run)) return `fact ${n} reads run ${f.run}, which the tour does not define`;
      if ("sum" in f) for (const x of f.sum) if (!facts.has(x)) return `fact ${n} sums ${x}, which the tour does not define`;
      if ("duration" in f && !runs.has(f.duration.to)) return `fact ${n} runs to ${f.duration.to}, which the tour does not define`;
    }
    for (const c of t.chapters) {
      for (const l of [...(c.text ?? []), ...(c.show ?? []).flatMap((s) => (s.card ?? []).map((r) => r.text))]) {
        for (const m of l.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) if (!facts.has(m[1]!)) return `chapter ${c.id} names {${m[1]}}, which the tour does not define`;
      }
      for (const s of c.show ?? []) for (const r of [...(s.light ?? []), s.pulse, s.travel, s.checks].filter(str)) if (!runs.has(r)) return `chapter ${c.id} shows run ${r}, which the tour does not define`;
    }
    return undefined;
  }
  const e = validator.errors?.[0];
  return e ? `${e.instancePath || "the file"} ${e.message ?? "is not behold.tour/v1"}` : "it is not behold.tour/v1";
}

export interface LoadedTour {
  tour: TourFile;
  /** Where it was read from: "behold" for one behold ships, else the file's path. */
  from: string;
}

/** The tours in a directory: each `*.json` that is a behold.tour/v1 file. A file that is not one is a problem. */
export function toursIn(dir: string, from: (file: string) => string, problems: string[]): LoadedTour[] {
  if (!existsSync(dir)) return [];
  const out: LoadedTour[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".schema.json")).sort();
  } catch {
    return [];
  }
  for (const f of names) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      problems.push(`${join(dir, f)} is not JSON`);
      continue;
    }
    const p = tourProblem(doc);
    if (p) problems.push(`${join(dir, f)} is not a ${TOUR_SCHEMA_ID} tour: ${p}`);
    else out.push({ tour: doc as TourFile, from: from(join(dir, f)) });
  }
  return out;
}

/**
 * The tour for the demo's cycle: a served repo's `.behold/tours/*.json`
 * first, so a customer's tour wins, then the ones behold ships. A tour
 * matches when each of its `match` fields equals demo.json's.
 */
export function findTour(demo: { tool?: string | null; scenario?: string | null } | null, dirs: readonly string[], problems: string[], shipped = TOURS_DIR): LoadedTour | null {
  if (!demo) return null;
  const all = [...dirs.flatMap((d) => toursIn(join(d, ".behold", "tours"), (f) => f, problems)), ...toursIn(shipped, () => "behold", problems)];
  const fits = (t: TourFile): boolean => !!t.match && Object.entries(t.match).every(([k, v]) => (demo as Record<string, unknown>)[k] === v);
  return all.find((t) => fits(t.tour)) ?? null;
}

// --- the records ---------------------------------------------------------------

export interface TourRow {
  project: string;
  commit: string;
  stage: string;
  wave: number | null;
  finished: string;
  path: string;
  pull_request: string | null;
  pull_request_url: string | null;
  job_url: string | null;
  approval: string | null;
}

/** An index row, or undefined when it is not one. */
export function tourRow(v: unknown): TourRow | undefined {
  if (!isRecord(v) || !str(v.project) || !str(v.commit) || !str(v.stage) || !str(v.finished) || !str(v.path)) return undefined;
  return {
    project: v.project,
    commit: v.commit,
    stage: v.stage,
    wave: num(v.wave),
    finished: v.finished,
    path: v.path,
    pull_request: str(v.pull_request) ? v.pull_request : typeof v.pull_request === "number" ? String(v.pull_request) : null,
    pull_request_url: str(v.pull_request_url) ? v.pull_request_url : null,
    job_url: str(v.job_url) ? v.job_url : null,
    approval: str(v.approval) ? v.approval : null,
  };
}

/** A migration the carve read followed: its record and lines, and the project it is under. */
export interface TourMigration {
  name: string;
  home: string;
  record: unknown;
  lines: { at: string }[];
  running: boolean;
}

export interface TourContext {
  demo: {
    cycle: number;
    beat: string | null;
    step: string;
    started_at: string;
    repo: string | null;
    pull: number | null;
    next_from: string | null;
  };
  /** This cycle's estates.json entries: which estate each root of each project is. */
  entries: { estate: string; project: string | null; root: string | null }[];
  migrations: TourMigration[];
  /** The projects known (estates.json's, the reports index's), for a repo's project. */
  known: string[];
  now: Date;
}

const docs = new Map<string, unknown>();
/** A report or plan document: written once, so read once and kept (the newest 96). */
async function readDoc(source: TerragucciSource, k: string, problems: string[]): Promise<unknown> {
  if (docs.has(k)) return docs.get(k);
  let text: string | undefined;
  try {
    text = await source.read(k);
  } catch (e) {
    problems.push(`behold could not read ${k}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  if (text === undefined) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    problems.push(`${k} is not JSON`);
    return undefined;
  }
  docs.set(k, doc);
  if (docs.size > 96) docs.delete(docs.keys().next().value as string);
  return doc;
}

const keyOf = (...p: string[]): string =>
  p
    .join("/")
    .split("/")
    .filter((s) => s && s !== ".")
    .join("/");

/** A root's path as estates.json names it: "." for a repo's top. */
const rootPath = (p: string): string => p.replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";

/** How many resource instances a report's roots planned, in all, by action. */
export function planCounts(report: unknown, roots: readonly string[] | null = null): { planned: number; changed: number; recreated: number; deleted: number } | null {
  if (!isRecord(report) || !Array.isArray(report.roots)) return null;
  let planned = 0;
  let changed = 0;
  let recreated = 0;
  let deleted = 0;
  let any = false;
  for (const r of report.roots) {
    if (!isRecord(r) || !isRecord(r.counts)) continue;
    if (roots && !roots.includes(rootPath(String(r.path ?? ".")))) continue;
    any = true;
    for (const [a, n] of Object.entries(r.counts)) {
      const c = num(n) ?? 0;
      planned += c;
      if (a !== "no-op" && a !== "read") changed += c;
      if (a === "create" || a === "replace") recreated += c;
      if (a === "delete") deleted += c;
    }
  }
  return any ? { planned, changed, recreated, deleted } : null;
}

/** The roots of a report's wave `n` (its `waves` list), or null when the report does not split by wave. */
function waveRoots(report: unknown, n: number | undefined): string[] | null {
  if (n === undefined || !isRecord(report) || !Array.isArray(report.waves)) return null;
  const w = report.waves.find((x) => isRecord(x) && x.number === n);
  return isRecord(w) && Array.isArray(w.roots) ? w.roots.filter(str).map(rootPath) : null;
}

/** A plan.json's resource instances, each with whether its plan changes it. */
export function planAddresses(plan: unknown): { address: string; changed: boolean }[] {
  if (!isRecord(plan) || !Array.isArray(plan.resource_changes)) return [];
  const out: { address: string; changed: boolean }[] = [];
  for (const rc of plan.resource_changes) {
    if (!isRecord(rc) || !str(rc.address) || rc.mode === "data") continue;
    const acts = isRecord(rc.change) && Array.isArray(rc.change.actions) ? rc.change.actions.filter(str) : [];
    out.push({ address: rc.address, changed: !acts.every((a) => a === "no-op" || a === "read") });
  }
  return out;
}

/** An output's planned value in a plan.json, or undefined when the plan does not know it. */
export function plannedOutput(plan: unknown, name: string): string | number | boolean | undefined {
  if (!isRecord(plan) || !isRecord(plan.output_changes)) return undefined;
  const o = plan.output_changes[name];
  if (!isRecord(o) || o.after_unknown === true || o.after_sensitive === true) return undefined;
  const v = o.after;
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined;
}

/** "9 min 21 s". */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

/** The job number in a job URL (Forgejo/GitHub `/actions/runs/<n>`, GitLab `/-/jobs/<n>`). */
export function jobOf(url: string | null): number | null {
  const m = url ? /\/(?:actions\/runs|-\/jobs|jobs)\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return m ? Number(m[1]) : null;
}

interface FoundRun {
  name: string;
  row: TourRow;
  report?: unknown;
}

const FINAL = new Set(["applied", "refused", "failed", "proof-failed", "done", "finished"]);

/** The live answer's tour: the file with every fact and visual resolved, and the cycle's events. */
export interface TourAnswer {
  name: string;
  title: string | null;
  from: string;
  steps: string[];
  step: string;
  beat: string | null;
  facts: Record<string, string | number>;
  chapters: (Omit<TourChapter, "show" | "trigger"> & { trigger: unknown; show: Record<string, unknown>[] })[];
  events: { kind: string; at: number; [k: string]: unknown }[];
  /** "Follow along": the pull request and the job the cycle is on now, from the newest report row that names them. */
  links: { pull: { n: string; url: string } | null; job: { n: number; url: string } | null };
  /** Each followed migration's apply run: its job, for a landed dot's provenance. */
  migrationRuns: Record<string, { job: number | null; job_url: string | null; tool: string }>;
  problems: string[];
}

/** One read of a tour's records. Never throws. */
export async function resolveTour(source: TerragucciSource, loaded: LoadedTour, ctx: TourContext, runsIndex: unknown): Promise<TourAnswer> {
  const t = loaded.tour;
  const problems: string[] = [];
  const from = Date.parse(ctx.demo.started_at);
  const repo = ctx.demo.repo ?? "";
  const projectOf = (tpl: string): string | null => {
    const name = tpl.replace(/\{repo\}/g, repo);
    return name ? (repoProjects(name, ctx.known)[0] ?? null) : null;
  };

  // The cycle's index rows, per project, oldest first.
  const rows = new Map<string, TourRow[]>();
  const rowsOf = async (project: string): Promise<TourRow[]> => {
    if (rows.has(project)) return rows.get(project)!;
    let text: string | undefined;
    try {
      text = await source.read(keyOf(project, "index.json"));
    } catch (e) {
      problems.push(`behold could not read ${project}/index.json: ${e instanceof Error ? e.message : String(e)}`);
    }
    let doc: unknown;
    try {
      doc = text ? JSON.parse(text) : undefined;
    } catch {
      problems.push(`${project}/index.json is not JSON`);
    }
    const list = (isRecord(doc) && Array.isArray(doc.reports) ? doc.reports : [])
      .map(tourRow)
      .filter((r): r is TourRow => !!r && (Number.isNaN(from) || Date.parse(r.finished) >= from))
      .sort((a, b) => Date.parse(a.finished) - Date.parse(b.finished));
    rows.set(project, list);
    return list;
  };

  // The named runs, in the order the file gives them, so `after` names one already found.
  const found = new Map<string, FoundRun>();
  for (const [name, spec] of Object.entries(t.runs ?? {})) {
    let row: TourRow | undefined;
    if (spec.migration) {
      const m = ctx.migrations.find((x) => x.name === spec.migration);
      const commit = m && isRecord(m.record) && str(m.record.commit) ? m.record.commit : null;
      if (m && commit) row = (await rowsOf(m.home)).find((r) => r.commit === commit && r.stage === "tf-apply");
    } else if (spec.repo && spec.stage) {
      const project = projectOf(spec.repo);
      if (!project) continue;
      const after = spec.after ? found.get(spec.after) : undefined;
      if (spec.after && !after) continue;
      const cands = (await rowsOf(project)).filter(
        (r) =>
          r.stage === spec.stage &&
          (spec.wave === undefined || r.wave === spec.wave) &&
          (spec.pull !== null || r.pull_request === null) &&
          (!after || Date.parse(r.finished) > Date.parse(after.row.finished)),
      );
      row = spec.pick === "last" ? cands[cands.length - 1] : cands[0];
    }
    if (row) found.set(name, { name, row });
  }
  const reportOf = async (f: FoundRun): Promise<unknown> => (f.report ??= await readDoc(source, keyOf(f.row.project, f.row.path, "report.json"), problems));
  const planOf = async (f: FoundRun, root: Record<string, unknown>): Promise<unknown> => {
    const p = isRecord(root.plan) && str(root.plan.json) ? root.plan.json : null;
    return p ? readDoc(source, keyOf(f.row.project, f.row.path, p), problems) : undefined;
  };
  const rootsOf = async (f: FoundRun): Promise<Record<string, unknown>[]> => {
    const rep = await reportOf(f);
    return isRecord(rep) && Array.isArray(rep.roots) ? rep.roots.filter(isRecord) : [];
  };
  /** The estates a project's root is: this cycle's estates.json entries for it. */
  const estatesOf = (project: string, root: string): string[] => {
    const rp = rootPath(root);
    return [...new Set(ctx.entries.filter((e) => e.project === project && e.root !== null && rootPath(e.root) === rp).map((e) => e.estate))];
  };

  // Facts.
  const facts: Record<string, string | number> = {};
  const recordOf = (name: string): Record<string, unknown> | null => {
    const m = ctx.migrations.find((x) => x.name === name);
    return m && isRecord(m.record) ? m.record : null;
  };
  for (const [name, f] of Object.entries(t.facts ?? {})) {
    let v: string | number | undefined;
    if ("run" in f) {
      const r = found.get(f.run);
      if (!r) continue;
      if (f.value === "job") v = jobOf(r.row.job_url) ?? undefined;
      else if (f.value === "output") {
        for (const root of await rootsOf(r)) {
          const out = plannedOutput(await planOf(r, root), f.output ?? "");
          if (out !== undefined) {
            v = typeof out === "boolean" ? String(out) : out;
            break;
          }
        }
      } else {
        const c = planCounts(await reportOf(r));
        if (c) v = c[f.value];
      }
    } else if ("migration" in f) {
      const rec = recordOf(f.migration);
      if (!rec) continue;
      const p = isRecord(rec.progress) ? rec.progress : null;
      if (f.value === "version_id") {
        const root = Array.isArray(rec.roots) ? rec.roots.find((x) => isRecord(x) && isRecord(x.source) && str(x.source.version_id)) : undefined;
        if (isRecord(root) && isRecord(root.source)) v = root.source.version_id as string;
      } else if (f.value === "approved_by") v = str(rec.approved_by) ? rec.approved_by : undefined;
      else if (p) v = f.value === "writes" ? (num(p.moved) ?? 0) + (num(p.stamped) ?? 0) : (num(p[f.value]) ?? undefined);
    } else if ("sum" in f) {
      if (f.sum.every((x) => typeof facts[x] === "number")) v = f.sum.reduce((s, x) => s + (facts[x] as number), 0);
    } else if ("approvals" in f) {
      // The gates passed by a person: each migration approved, and each wave whose approval was given.
      const migs = ctx.migrations.filter((m) => isRecord(m.record) && str(m.record.approved_by)).length;
      let waves = 0;
      for (const list of rows.values()) waves += list.filter((r) => r.stage === "tf-apply" && r.approval === "approved").length;
      if (ctx.migrations.length || rows.size) v = migs + waves;
    } else if ("duration" in f) {
      const r = found.get(f.duration.to);
      if (r && !Number.isNaN(from)) v = durationWords(Date.parse(r.row.finished) - from);
    }
    if (v !== undefined) facts[name] = v;
  }

  // Visuals.
  const runLinks = (r: FoundRun) => ({
    job: jobOf(r.row.job_url),
    job_url: r.row.job_url,
    pull: r.row.pull_request,
    pull_url: r.row.pull_request_url,
    stage: r.row.stage,
    wave: r.row.wave,
    finished: r.row.finished,
  });
  const resolveShow = async (s: TourShow): Promise<Record<string, unknown> | null> => {
    const base = s.when ? { when: trig(s.when) } : {};
    if (s.light) {
      for (const n of s.light) {
        const r = found.get(n);
        if (!r) continue;
        const only = waveRoots(await reportOf(r), s.wave);
        const lit: { estates: string[]; address: string; changed: boolean }[] = [];
        for (const root of await rootsOf(r)) {
          const rp = rootPath(String(root.path ?? "."));
          if (only && !only.includes(rp)) continue;
          const estates = estatesOf(r.row.project, rp);
          for (const a of planAddresses(await planOf(r, root))) lit.push({ estates, address: a.address, changed: a.changed });
        }
        if (!lit.length) continue;
        return { ...base, kind: "light", run: n, lit, changed: lit.filter((x) => x.changed).length, ...runLinks(r) };
      }
      return null;
    }
    if (s.pulse) {
      const r = found.get(s.pulse);
      if (!r) return null;
      const only = waveRoots(await reportOf(r), s.wave);
      const estates = (await rootsOf(r)).map((x) => rootPath(String(x.path ?? "."))).filter((p) => !only || only.includes(p)).map((p) => estatesOf(r.row.project, p));
      return estates.length ? { ...base, kind: "pulse", run: s.pulse, ...runLinks(r), wave: s.wave ?? null, estates } : null;
    }
    if (s.travel) {
      const r = found.get(s.travel);
      if (!r) return null;
      const roots = await rootsOf(r);
      const threads: { from: string[]; to: string[] }[] = [];
      let value: string | number | undefined;
      for (const root of roots) {
        const reads = Array.isArray(root.reads) ? root.reads.filter(isRecord) : [];
        for (const rd of reads) {
          if (!str(rd.upstream)) continue;
          threads.push({ from: estatesOf(r.row.project, rd.upstream), to: estatesOf(r.row.project, String(root.path ?? ".")) });
          if (value === undefined) {
            const up = roots.find((x) => rootPath(String(x.path ?? ".")) === rootPath(rd.upstream as string));
            const out = up ? plannedOutput(await planOf(r, up), s.output ?? "") : undefined;
            if (out !== undefined) value = typeof out === "boolean" ? String(out) : out;
          }
        }
      }
      return threads.length ? { ...base, kind: "travel", run: s.travel, output: s.output ?? null, threads, ...(value !== undefined ? { value } : {}), ...runLinks(r) } : null;
    }
    if (s.state) {
      const rec = recordOf(s.state);
      const root = rec && Array.isArray(rec.roots) ? rec.roots.find((x) => isRecord(x) && isRecord(x.source) && str(x.source.version_id)) : undefined;
      if (!isRecord(root) || !isRecord(root.source)) return null;
      const m = ctx.migrations.find((x) => x.name === s.state)!;
      return {
        ...base,
        kind: "state",
        migration: s.state,
        version_id: root.source.version_id,
        location: str(root.source.location) ? root.source.location : null,
        estates: estatesOf(m.home, String(root.root ?? ".")),
        status: str(rec!.status) ? rec!.status : null,
        finished: str(rec!.finished) ? rec!.finished : null,
      };
    }
    if (s.checks) {
      const r = found.get(s.checks);
      if (!r) return null;
      const checks = (await rootsOf(r)).filter((x) => isRecord(x.counts)).map((x) => {
        const rp = rootPath(String(x.path ?? "."));
        const counts = x.counts as Record<string, number>;
        return { root: rp, estates: estatesOf(r.row.project, rp), noChange: Object.entries(counts).every(([a, n]) => a === "no-op" || !n), counts };
      });
      return checks.length ? { ...base, kind: "checks", run: s.checks, checks, ...runLinks(r) } : null;
    }
    if (s.counts) return { ...base, kind: "counts" };
    if (s.card) return { ...base, kind: "card", card: s.card };
    return null;
  };
  // A trigger as the player reads it: a named run's finish resolved into after_at, or blocked while it does not exist.
  function trig(tr: TourTrigger): unknown {
    if ("any" in tr) return { any: tr.any.map(trig) };
    if ("wave" in tr && tr.after) {
      const r = found.get(tr.after);
      return r ? { wave: tr.wave, edge: tr.edge, after_at: Date.parse(r.row.finished) } : { wave: tr.wave, edge: tr.edge, blocked: true };
    }
    return { ...tr };
  }
  const chapters: TourAnswer["chapters"] = [];
  for (const c of t.chapters) {
    const show: Record<string, unknown>[] = [];
    for (const s of c.show ?? []) {
      const x = await resolveShow(s);
      if (x) show.push(x);
    }
    chapters.push({ id: c.id, title: c.title, ...(c.text ? { text: c.text } : {}), ...(c.focus ? { focus: c.focus } : {}), trigger: trig(c.trigger), show });
  }

  // Events: demo.json's beat and step now, each migration's first and last line, each wave's job starting and ending.
  const events: TourAnswer["events"] = [];
  const beatAt = Date.parse(ctx.demo.next_from ?? "") || ctx.now.getTime();
  events.push({ kind: "beat", beat: ctx.demo.beat, step: ctx.demo.step, at: beatAt });
  for (const m of ctx.migrations) {
    const ats = m.lines.map((l) => Date.parse(l.at)).filter((x) => !Number.isNaN(x));
    if (!ats.length) continue;
    events.push({ kind: "line", migration: m.name, line: "first", at: Math.min(...ats) });
    const rec = isRecord(m.record) ? m.record : null;
    const done = !m.running && !!rec && (str(rec.finished) || (str(rec.status) && FINAL.has(rec.status)));
    if (done) events.push({ kind: "line", migration: m.name, line: "last", at: Math.max(...ats) });
  }
  const runs = isRecord(runsIndex) && Array.isArray(runsIndex.runs) ? runsIndex.runs.filter(isRecord) : [];
  for (const run of runs) {
    if (run.cycle !== ctx.demo.cycle || !str(run.repo) || !(run.repo === repo || run.repo.startsWith(`${repo}-`))) continue;
    for (const j of Array.isArray(run.jobs) ? run.jobs.filter(isRecord) : []) {
      const w = str(j.name) ? /^apply-wave-(\d+)$/.exec(j.name) : null;
      if (!w) continue;
      const wave = Number(w[1]);
      if (str(j.started_at)) events.push({ kind: "wave", wave, edge: "start", at: Date.parse(j.started_at), run: run.id, repo: run.repo });
      if (str(j.ended_at)) events.push({ kind: "wave", wave, edge: "end", at: Date.parse(j.ended_at), run: run.id, repo: run.repo });
    }
  }
  events.sort((a, b) => a.at - b.at);

  // Follow along: the newest row of the demo's repo now that names its pull request, and the newest job.
  const nowProject = projectOf("{repo}");
  let pull: TourAnswer["links"]["pull"] = null;
  let job: TourAnswer["links"]["job"] = null;
  if (nowProject) {
    const list = await rowsOf(nowProject);
    const pr = ctx.demo.pull !== null ? [...list].reverse().find((r) => r.pull_request === String(ctx.demo.pull) && r.pull_request_url) : undefined;
    if (pr) pull = { n: pr.pull_request!, url: pr.pull_request_url! };
    const last = [...list].reverse().find((r) => r.job_url && jobOf(r.job_url) !== null);
    if (last) job = { n: jobOf(last.job_url)!, url: last.job_url! };
  }

  // Each migration's apply run, for the provenance of the dots it moved.
  const migrationRuns: TourAnswer["migrationRuns"] = {};
  for (const m of ctx.migrations) {
    const rec = isRecord(m.record) ? m.record : null;
    const tool = rec && rec.change === "adopt" ? "live-import" : "live-mv";
    const commit = rec && str(rec.commit) ? rec.commit : null;
    const row = commit ? (await rowsOf(m.home)).find((r) => r.commit === commit && r.stage === "tf-apply") : undefined;
    migrationRuns[m.name] = { job: row ? jobOf(row.job_url) : null, job_url: row?.job_url ?? null, tool };
  }

  return {
    name: t.name,
    title: t.title ?? null,
    from: loaded.from,
    steps: t.steps ?? [],
    step: ctx.demo.step,
    beat: ctx.demo.beat,
    facts,
    chapters,
    events,
    links: { pull, job },
    migrationRuns,
    problems,
  };
}
