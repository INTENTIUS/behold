/**
 * The live carve (#715, for #711): each estate's roster and each estate
 * migration's progress, read from terragucci's reports, for the dots layer
 * (web/dots.js) to draw a carve as it is written.
 *
 * What it reads, every one a GET of one key under the `--terragucci` source,
 * the same reads as the rest of the reports (src/terragucci-source.ts), and
 * nothing from the cloud:
 *
 * - `index.json`: its `estates` entries (terragucci#1130), one per estate
 *   with its resource count, and its `migrations` entries when it has them.
 *   A source whose index carries no `estates` is asked for
 *   `estates/index.json` instead, holding the same list.
 * - `estates/<estate>/roster.json` per entry (terragucci#1130):
 *   `{estate, at, resources: [{address, type, live_id?, marked, follows?}]}`.
 *   A stock root has one too, written from its state, under the root's name.
 * - `demo.json`, for the migration a running step names: `next.action` reads
 *   "carve: 36 of 79 moved" while a migration runs (terragucci#1129).
 * - `<project>/migrations/<name>.json`, the migration's record, for its
 *   counts (moved, stamped, refused, skipped, left) and whether it finished.
 * - `<project>/migrations/<name>/progress.jsonl` (terragucci#1129), appended
 *   while the migration runs, one line per resource:
 *   `{at, estate_from, estate_to, address, live_id, outcome, reason?, follows?}`.
 *   A source that keeps it at the top (`migrations/<name>/progress.jsonl`)
 *   is read there.
 *
 * The gate: the answer is `live: true` only when the served estate has
 * choudoufu roots (a choudoufu member, or a terragucci config whose binary
 * is choudoufu) or the reports hold estate rosters. With neither, it is
 * `live: false` and the page mounts nothing: the kiosk and the app draw
 * exactly what they drew before.
 *
 * `GET /api/terragucci/carve` answers it. One read is shared between pages
 * for {@link CARVE_READ_TTL_MS} while a migration runs, and for
 * {@link CARVE_IDLE_TTL_MS} otherwise, the way demo.json's read is shared.
 */
import type { Hono } from "hono";
import { readDemo } from "./terragucci-demo.ts";
import { TerragucciDenied, type TerragucciSource } from "./terragucci-source.ts";

/** How long one read is shared while a migration runs: the page polls every 2 s, so a move shows within a few seconds of its write. */
export const CARVE_READ_TTL_MS = 1_500;
/** And while none runs. */
export const CARVE_IDLE_TTL_MS = 10_000;
/** The most rosters one read takes, so a large estate list cannot turn one poll into hundreds of GETs. */
export const MAX_ROSTERS = 64;
/** The most migrations one read follows. */
export const MAX_MIGRATIONS = 8;

export type CarveOutcome = "moved" | "stamped" | "refused" | "skipped";
export const CARVE_OUTCOMES: readonly CarveOutcome[] = ["moved", "stamped", "refused", "skipped"];

export interface CarveResource {
  address: string;
  type: string;
  live_id?: string;
  /** It wears choudoufu's markers (adopted). */
  marked: boolean;
  /** The parent it moves with, for a resource that carries no markers of its own. */
  follows?: string;
}

export interface CarveRoster {
  estate: string;
  at: string | null;
  /** The index entry's count, else the roster's own length. */
  count: number;
  resources: CarveResource[];
  key: string;
}

export interface CarveLine {
  at: string;
  estate_from: string;
  estate_to: string;
  address: string;
  live_id?: string;
  outcome: CarveOutcome;
  reason?: string;
  follows?: string;
}

export interface CarveCounts {
  moved: number;
  stamped: number;
  refused: number;
  skipped: number;
  /** Null when the record has no counts yet and the lines cannot say. */
  left: number | null;
}

export interface CarveMigration {
  name: string;
  /** The key the lines were read from, or null when no progress file was found. */
  progress: string | null;
  lines: CarveLine[];
  counts: CarveCounts;
  /** The record's status, when one was read. */
  status: string | null;
  finished: string | null;
  /** Still writing: not finished, and either lines have come or the demo names it. */
  running: boolean;
}

export interface CarveDemo {
  cycle: number;
  scenario: string;
  title: string;
  step: string;
  label: string;
  next: string | null;
}

export type CarveAnswer =
  | { source: string; read: string; live: false; reason: string; problems: string[] }
  | {
      source: string;
      read: string;
      live: true;
      gate: { choudoufu: boolean; rosters: number };
      estates: CarveRoster[];
      migrations: CarveMigration[];
      demo: CarveDemo | null;
      running: boolean;
      problems: string[];
    };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** A name a key may carry: no slash, no dot segment. */
const SAFE = /^(?!\.{1,2}$)[A-Za-z0-9._~@+-]{1,128}$/;
const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");
const key = (...p: string[]): string => p.map(trim).filter(Boolean).join("/");

/** One resource of a roster, or undefined when it is not one. */
export function rosterResource(v: unknown): CarveResource | undefined {
  if (!isRecord(v) || !str(v.address)) return undefined;
  return {
    address: v.address,
    type: str(v.type) ? v.type : (/(?:^|\.)((?:aws|google|azurerm|kubernetes)_[a-z0-9_]+)\./.exec(v.address)?.[1] ?? ""),
    ...(str(v.live_id) ? { live_id: v.live_id } : {}),
    marked: v.marked === true,
    ...(str(v.follows) ? { follows: v.follows } : {}),
  };
}

/** One progress line, or undefined when it is not one. */
export function progressLine(v: unknown): CarveLine | undefined {
  if (!isRecord(v) || !str(v.at) || !str(v.address) || !str(v.estate_from)) return undefined;
  if (!(CARVE_OUTCOMES as readonly string[]).includes(v.outcome as string)) return undefined;
  return {
    at: v.at,
    estate_from: v.estate_from,
    estate_to: str(v.estate_to) ? v.estate_to : v.estate_from,
    address: v.address,
    ...(str(v.live_id) ? { live_id: v.live_id } : {}),
    outcome: v.outcome as CarveOutcome,
    ...(str(v.reason) ? { reason: v.reason } : {}),
    ...(str(v.follows) ? { follows: v.follows } : {}),
  };
}

/**
 * progress.jsonl's text as lines. A line that is not JSON is left out; the
 * last one may be half written while the job appends, so it is left out
 * without a word, and any other is counted.
 */
export function readProgress(text: string): { lines: CarveLine[]; bad: number } {
  const raw = text.split("\n");
  const lines: CarveLine[] = [];
  let bad = 0;
  raw.forEach((l, i) => {
    if (!l.trim()) return;
    let doc: unknown;
    try {
      doc = JSON.parse(l);
    } catch {
      if (i < raw.length - 1 && raw.slice(i + 1).some((r) => r.trim())) bad++;
      return;
    }
    const line = progressLine(doc);
    if (line) lines.push(line);
    else bad++;
  });
  return { lines, bad };
}

/** The counts the lines say, when the record has none. */
export function countLines(lines: readonly CarveLine[]): CarveCounts {
  const c: CarveCounts = { moved: 0, stamped: 0, refused: 0, skipped: 0, left: null };
  for (const l of lines) c[l.outcome]++;
  return c;
}

/** The record's counts, each one it has; null when it has none. */
export function recordCounts(doc: unknown): CarveCounts | null {
  const c = isRecord(doc) && isRecord(doc.counts) ? doc.counts : null;
  if (!c) return null;
  return { moved: count(c.moved) ?? 0, stamped: count(c.stamped) ?? 0, refused: count(c.refused) ?? 0, skipped: count(c.skipped) ?? 0, left: count(c.left) };
}

/** The migration demo.json's `next` names while one runs ("carve: 36 of 79 moved"), or null. */
export function demoMigration(next: string | null | undefined): string | null {
  const m = typeof next === "string" ? /^\s*([A-Za-z0-9._~@+-]{1,128}):\s+\d+\s+of\s+\d+\b/.exec(next) : null;
  return m ? m[1]! : null;
}

interface EstateEntry {
  estate: string;
  count: number | null;
  at: string | null;
  roster: string;
}

/** An index's estate entries (terragucci#1130), each with the key its roster is at. */
export function estateEntries(doc: unknown): EstateEntry[] {
  const list = isRecord(doc) && Array.isArray(doc.estates) ? doc.estates : [];
  const out: EstateEntry[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (!isRecord(e) || !str(e.estate) || !SAFE.test(e.estate) || seen.has(e.estate)) continue;
    seen.add(e.estate);
    const roster = str(e.roster) && !e.roster.split("/").some((s) => s === ".." || s === ".") ? trim(e.roster) : key("estates", e.estate, "roster.json");
    out.push({ estate: e.estate, count: count(e.count), at: str(e.at) ? e.at : null, roster });
  }
  return out;
}

interface MigrationEntry {
  name: string;
  project: string | null;
  counts: CarveCounts | null;
  status: string | null;
}

/** An index's migration entries, when it carries them. */
export function migrationEntries(doc: unknown): MigrationEntry[] {
  const list = isRecord(doc) && Array.isArray(doc.migrations) ? doc.migrations : [];
  const out: MigrationEntry[] = [];
  for (const m of list) {
    if (!isRecord(m) || !str(m.name) || !SAFE.test(m.name)) continue;
    out.push({ name: m.name, project: str(m.project) ? m.project : null, counts: recordCounts(m), status: str(m.status) ? m.status : null });
  }
  return out;
}

const projectsOf = (doc: unknown): string[] => {
  const rows = isRecord(doc) && Array.isArray(doc.reports) ? doc.reports : [];
  return [...new Set(rows.filter(isRecord).map((r) => r.project).filter(str))].sort();
};

const FINISHED = new Set(["applied", "refused", "failed", "proof-failed", "done", "finished"]);

export interface CarveReadOptions {
  /** Whether the served estate has choudoufu roots. Asked per read, since a project switch changes it. */
  choudoufu: () => boolean;
  /** Migrations seen before (a name demo.json named a step ago), so a finished one stays drawn. */
  remembered?: Set<string>;
  /** Where each migration's files were found, so the next read asks one key, not every candidate. */
  places?: Map<string, string | null>;
  now?: Date;
}

async function readText(source: TerragucciSource, k: string, problems: string[]): Promise<string | undefined> {
  try {
    return await source.read(k);
  } catch (e) {
    problems.push(e instanceof TerragucciDenied ? `${e.url} is not readable with these credentials` : `behold could not read ${k} from ${source.location}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

function parse(text: string | undefined, k: string, problems: string[]): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    problems.push(`${k} is not JSON`);
    return undefined;
  }
}

/** One read of the live carve. Never throws: a key it cannot read is a problem the answer names. */
export async function readCarve(source: TerragucciSource, opts: CarveReadOptions): Promise<CarveAnswer> {
  const now = opts.now ?? new Date();
  const base = { source: source.location, read: now.toISOString() };
  const problems: string[] = [];
  const index = parse(await readText(source, "index.json", problems), "index.json", problems);
  let entries = estateEntries(index);
  if (!entries.length) entries = estateEntries(parse(await readText(source, "estates/index.json", problems), "estates/index.json", problems));
  const choudoufu = opts.choudoufu();
  if (!choudoufu && !entries.length) {
    return { ...base, live: false, reason: "The estate has no choudoufu roots and the reports hold no estate rosters, so there is no carve to draw.", problems };
  }

  const estates: CarveRoster[] = [];
  for (const e of entries.slice(0, MAX_ROSTERS)) {
    const doc = parse(await readText(source, e.roster, problems), e.roster, problems);
    if (doc === undefined) continue;
    if (!isRecord(doc) || !Array.isArray(doc.resources)) {
      problems.push(`${e.roster} is not a roster: it has no resources list`);
      continue;
    }
    const resources = doc.resources.map(rosterResource).filter((r): r is CarveResource => !!r);
    estates.push({ estate: str(doc.estate) ? doc.estate : e.estate, at: str(doc.at) ? doc.at : e.at, count: e.count ?? resources.length, resources, key: e.roster });
  }
  if (entries.length > MAX_ROSTERS) problems.push(`the index lists ${entries.length} estates; the first ${MAX_ROSTERS} are drawn`);

  const demoAnswer = await readDemo(source, now);
  const d = demoAnswer.demo;
  const demo: CarveDemo | null = d ? { cycle: d.cycle, scenario: d.scenario, title: d.title, step: d.step, label: d.label, next: d.next ? d.next.action : null } : null;
  const named = demoMigration(demo?.next);

  const wanted = new Map<string, MigrationEntry>();
  for (const m of migrationEntries(index)) wanted.set(m.name, m);
  for (const n of opts.remembered ?? []) if (!wanted.has(n)) wanted.set(n, { name: n, project: null, counts: null, status: null });
  if (named && !wanted.has(named)) wanted.set(named, { name: named, project: null, counts: null, status: null });
  if (named) opts.remembered?.add(named);

  const projects = projectsOf(index);
  const migrations: CarveMigration[] = [];
  for (const m of [...wanted.values()].slice(0, MAX_MIGRATIONS)) {
    // Where its record and lines are: under its project (terragucci's migration
    // records are at <project>/migrations/<name>.json), else at the top.
    const homes = m.project ? [m.project] : [...projects, ""];
    const known = opts.places?.get(m.name);
    const tries = known !== undefined && known !== null ? [known] : homes;
    let record: unknown;
    let progress: string | null = null;
    let text: string | undefined;
    for (const h of tries) {
      const pk = key(h, "migrations", m.name, "progress.jsonl");
      text = await readText(source, pk, problems);
      if (text !== undefined) {
        progress = pk;
        record = parse(await readText(source, key(h, "migrations", `${m.name}.json`), problems), key(h, "migrations", `${m.name}.json`), problems);
        opts.places?.set(m.name, h);
        break;
      }
      const rk = key(h, "migrations", `${m.name}.json`);
      record = parse(await readText(source, rk, problems), rk, problems);
      if (record !== undefined) {
        opts.places?.set(m.name, h);
        break;
      }
    }
    const { lines, bad } = text !== undefined ? readProgress(text) : { lines: [], bad: 0 };
    if (bad) problems.push(`${progress}: ${bad} line${bad === 1 ? " is" : "s are"} not a progress record`);
    const counts = recordCounts(record) ?? m.counts ?? countLines(lines);
    const status = isRecord(record) && str(record.status) ? record.status : m.status;
    const finished = isRecord(record) && str(record.finished) ? record.finished : null;
    const done = !!finished || (status !== null && FINISHED.has(status)) || (counts.left === 0 && lines.length > 0 && named !== m.name);
    if (!lines.length && record === undefined && named !== m.name) continue;
    migrations.push({ name: m.name, progress, lines, counts, status, finished, running: !done && (lines.length > 0 || named === m.name) });
  }

  return {
    ...base,
    live: true,
    gate: { choudoufu, rosters: estates.length },
    estates,
    migrations,
    demo,
    running: migrations.some((m) => m.running),
    problems,
  };
}

/** `GET /api/terragucci/carve`: the live carve's one read, shared between pages. */
export function terragucciCarveRoute(app: Hono, source: TerragucciSource, opts: { choudoufu: () => boolean; now?: () => Date }): void {
  let cached: { at: number; read: Promise<CarveAnswer>; ttl: number } | undefined;
  const remembered = new Set<string>();
  const places = new Map<string, string | null>();
  let cycle: number | null = null;
  app.get("/api/terragucci/carve", async (c) => {
    const at = Date.now();
    if (!cached || at - cached.at >= cached.ttl) {
      const read = readCarve(source, { choudoufu: opts.choudoufu, remembered, places, ...(opts.now ? { now: opts.now() } : {}) });
      const entry = { at, read, ttl: CARVE_READ_TTL_MS };
      cached = entry;
      void read.then((a) => {
        if (!a.live) {
          entry.ttl = CARVE_IDLE_TTL_MS;
          return;
        }
        entry.ttl = a.running ? CARVE_READ_TTL_MS : CARVE_IDLE_TTL_MS;
        // A new cycle of the demo's loop starts from its own migrations.
        if (a.demo && cycle !== null && a.demo.cycle !== cycle) {
          remembered.clear();
          places.clear();
        }
        if (a.demo) cycle = a.demo.cycle;
      });
    }
    return c.json(await cached.read, 200, { "cache-control": "no-store" });
  });
}
