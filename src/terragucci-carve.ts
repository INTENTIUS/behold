/**
 * The live carve (#715, for #711): each estate's roster and each estate
 * migration's progress, read from terragucci's reports, for the dots layer
 * (web/dots.js) to draw a carve as it is written.
 *
 * What it reads, every one a GET of one key under the `--terragucci` source,
 * the same reads as the rest of the reports (src/terragucci-source.ts), and
 * nothing from the cloud:
 *
 * - `estates.json` (terragucci#1132, schema `terragucci.estates/v1`): one
 *   entry per estate, `{estate, count, at, project, root, roster}`, where
 *   `roster` is the roster's key relative to estates.json.
 * - Each entry's roster, at most {@link MAX_ROSTERS}:
 *   `{estate, at, resources: [{address, type, live_id?, marked, follows?}]}`.
 *   A stock root has one too, written from its state, under the root's name.
 * - `demo.json`, for the migration a running step names: `next.action` reads
 *   "carve: 36 of 79 moved", or "adopt: 3 of 4 stamped" for an adoption
 *   (terragucci#1133).
 * - `<project>/migrations/<name>.json`, the migration's record, for its
 *   counts (its `progress`: moved, stamped, refused, skipped, left) and
 *   whether it finished.
 * - `<project>/migrations/<name>/progress.jsonl` (terragucci#1133), appended
 *   while the migration runs: each line is choudoufu's `-progress-json` line,
 *   `{at, estate_from, estate_to, address, live_id, outcome, reason?, follows?}`,
 *   with the `migration` and its `counts` once that line arrived.
 *
 * Which estates are drawn: the carved project's, since the demo's prefix
 * holds every demo repo's roots. demo.json's `repo` names the repo
 * (`<admin>/demo-terralith`), whose project is the estates.json project that
 * ends in it (`forgejo:3000/<admin>/demo-terralith`). To it are added each
 * followed migration's own project and the projects of the estates its
 * record and lines move resources into (`estate_to`), so the team repos
 * (`demo-terralith-team-a`, ...) join after a split, and stay in the team
 * beat, when demo.json names a team's repo. With no repo named and no
 * migration found, every estate is drawn, as for a plain `behold serve`.
 * A migration is looked for under the repo's project; with no repo named,
 * under every estate's project, else the reports index's (`index.json`).
 *
 * The gate: with a repo named, the answer is `live: true` only when its
 * projects hold choudoufu roots (an estate that is a live block's name, not a
 * stock root's path) or one of its estate migrations was found. The served
 * checkout does not open it, so while the demo runs a Terraform scenario the
 * layer stays off. With no repo named, it is `live: true` when the served
 * estate has choudoufu roots (a choudoufu member, or a terragucci config whose
 * binary is choudoufu) or the reports hold estate rosters. Shut, the page
 * mounts nothing: the kiosk and the app draw exactly what they drew before.
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
      /** The projects whose estates are drawn, or null when every estate is (no repo named and no migration found). */
      projects: string[] | null;
      estates: CarveRoster[];
      migrations: CarveMigration[];
      demo: CarveDemo | null;
      running: boolean;
      problems: string[];
    };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
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

/**
 * One progress line, or undefined when it is not one. choudoufu writes an
 * empty `estate_from` for an adoption's stamp (the resource had no estate);
 * the line then reads as from the estate it is stamped into.
 */
export function progressLine(v: unknown): CarveLine | undefined {
  if (!isRecord(v) || !str(v.at) || !str(v.address)) return undefined;
  if (!(CARVE_OUTCOMES as readonly string[]).includes(v.outcome as string)) return undefined;
  const to = str(v.estate_to) ? v.estate_to : str(v.estate_from) ? v.estate_from : "";
  if (!to) return undefined;
  return {
    at: v.at,
    estate_from: str(v.estate_from) ? v.estate_from : to,
    estate_to: to,
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
export function readProgress(text: string): { lines: CarveLine[]; bad: number; counts: CarveCounts | null } {
  const raw = text.split("\n");
  const lines: CarveLine[] = [];
  let bad = 0;
  // Each line carries the migration's counts once it arrived: the last one is the newest.
  let counts: CarveCounts | null = null;
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
    if (line) {
      lines.push(line);
      counts = countsIn(isRecord(doc) ? doc.counts : undefined) ?? counts;
    } else bad++;
  });
  return { lines, bad, counts };
}

/** The counts the lines say, when the record has none. */
export function countLines(lines: readonly CarveLine[]): CarveCounts {
  const c: CarveCounts = { moved: 0, stamped: 0, refused: 0, skipped: 0, left: null };
  for (const l of lines) c[l.outcome]++;
  return c;
}

/** A counts object, `{moved, stamped, refused, skipped, left}`; null when it is not one. */
function countsIn(c: unknown): CarveCounts | null {
  if (!isRecord(c)) return null;
  return { moved: count(c.moved) ?? 0, stamped: count(c.stamped) ?? 0, refused: count(c.refused) ?? 0, skipped: count(c.skipped) ?? 0, left: count(c.left) };
}

/** The migration record's counts, its `progress` field (terragucci#1133); null when it has none yet. */
export function recordCounts(doc: unknown): CarveCounts | null {
  return isRecord(doc) ? countsIn(doc.progress) : null;
}

/** The migration demo.json's `next` names while one runs ("carve: 36 of 79 moved"), or null. */
export function demoMigration(next: string | null | undefined): string | null {
  const m = typeof next === "string" ? /^\s*([A-Za-z0-9._~@+-]{1,128}):\s+\d+\s+of\s+\d+\s+(?:moved|stamped)\b/.exec(next) : null;
  return m ? m[1]! : null;
}

/** estates.json's schema (terragucci#1132). */
export const ESTATES_SCHEMA = "terragucci.estates/v1";
export const ESTATES_KEY = "estates.json";

interface EstateEntry {
  estate: string;
  count: number | null;
  at: string | null;
  project: string | null;
  root: string | null;
  /** The roster's key: relative to estates.json, which sits at the top of the prefix. */
  roster: string;
}

/** estates.json's entries, each with the key its roster is at. An entry with no safe roster key is left out. */
export function estateEntries(doc: unknown): EstateEntry[] {
  const list = isRecord(doc) && Array.isArray(doc.estates) ? doc.estates : [];
  const out: EstateEntry[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (!isRecord(e) || !str(e.estate) || seen.has(e.estate) || !str(e.roster)) continue;
    const roster = trim(e.roster);
    if (roster.split("/").some((p) => p === ".." || p === "." || p === "")) continue;
    seen.add(e.estate);
    out.push({ estate: e.estate, count: count(e.count), at: str(e.at) ? e.at : null, project: str(e.project) ? e.project : null, root: str(e.root) ? e.root : null, roster });
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

/** A stock root's estate name, as terragucci writes it (report/roster.ts stockEstate): its path, or `root` for the repo's top. */
export const stockEstate = (root: string): string => root.replace(/^\.(\/+|$)/, "").replace(/\/+$/, "") || "root";

/** Whether an estates.json entry is a choudoufu root's: its estate is a live block's name, not the stock root's path. */
const choudoufuEntry = (e: EstateEntry): boolean => e.root !== null && e.estate !== stockEstate(e.root);

/**
 * The projects a forge repo's reports are under, from the projects known:
 * `forgejo:3000/<admin>/demo-terralith` for `<admin>/demo-terralith`. With
 * none known, the repo under each forge host a known project names, so a
 * migration's files are found before the repo's first roster is written.
 */
export function repoProjects(repo: string, known: readonly string[]): string[] {
  const r = trim(repo).toLowerCase();
  const hit = known.filter((p) => p.toLowerCase() === r || p.toLowerCase().endsWith(`/${r}`));
  if (hit.length) return [...new Set(hit)].sort();
  const owners = r.split("/").length;
  const hosts = known.map((p) => p.split("/")).filter((s) => s.length > owners).map((s) => s.slice(0, s.length - owners).join("/"));
  return [...new Set(hosts.map((h) => key(h, trim(repo))))].sort();
}

/** The estates a migration record moves resources into: each `estate_to` (or `to_estate`) it holds, at any depth. */
export function recordTargets(doc: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || out.size >= 256) return;
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (isRecord(v))
      for (const [k, x] of Object.entries(v)) {
        if ((k === "estate_to" || k === "to_estate") && str(x)) out.add(x);
        else walk(x, depth + 1);
      }
  };
  walk(doc, 0);
  return [...out];
}

/**
 * The estates to draw: the carved project's, not every project the prefix
 * holds (the demo's prefix holds every demo repo's roots). The projects are
 * the repo demo.json names, each followed migration's own project, and the
 * projects of the estates its record and lines move resources into, so the
 * team repos join after a split. With no repo named and no migration found,
 * every estate, as for a plain `behold serve` of one estate.
 */
export function carvedEntries(
  entries: readonly EstateEntry[],
  scope: { repo: string[] | null; homes: readonly string[]; targets: ReadonlySet<string> },
): { entries: EstateEntry[]; projects: string[] | null } {
  if (scope.repo === null && !scope.homes.length) return { entries: [...entries], projects: null };
  const projects = new Set<string>([...(scope.repo ?? []), ...scope.homes]);
  for (const e of entries) if (e.project && scope.targets.has(e.estate)) projects.add(e.project);
  return { entries: entries.filter((e) => (e.project !== null && projects.has(e.project)) || scope.targets.has(e.estate)), projects: [...projects].sort() };
}

/** One read of the live carve. Never throws: a key it cannot read is a problem the answer names. */
export async function readCarve(source: TerragucciSource, opts: CarveReadOptions): Promise<CarveAnswer> {
  const now = opts.now ?? new Date();
  const base = { source: source.location, read: now.toISOString() };
  const problems: string[] = [];
  const estatesDoc = parse(await readText(source, ESTATES_KEY, problems), ESTATES_KEY, problems);
  const isEstates = isRecord(estatesDoc) && estatesDoc.schema === ESTATES_SCHEMA;
  if (estatesDoc !== undefined && !isEstates) problems.push(`${ESTATES_KEY} is not a ${ESTATES_SCHEMA} document`);
  const all = isEstates ? estateEntries(estatesDoc) : [];

  const demoAnswer = await readDemo(source, now);
  const d = demoAnswer.demo;
  const demo: CarveDemo | null = d ? { cycle: d.cycle, scenario: d.scenario, title: d.title, step: d.step, label: d.label, next: d.next ? d.next.action : null } : null;
  const named = demoMigration(demo?.next);
  const repo = d?.repo ?? null;

  const wanted = new Set<string>(opts.remembered ?? []);
  if (named) {
    wanted.add(named);
    opts.remembered?.add(named);
  }

  // The projects a migration may be under: the named repo's, else every estate's, else the reports index's.
  const entryProjects = [...new Set(all.map((e) => e.project).filter((p): p is string => !!p))].sort();
  let indexProjects: string[] | undefined;
  const index = async (): Promise<string[]> => (indexProjects ??= projectsOf(parse(await readText(source, "index.json", problems), "index.json", problems)));
  let ofRepo: string[] | null = null;
  if (repo) {
    ofRepo = repoProjects(repo, entryProjects);
    if (!ofRepo.some((p) => entryProjects.includes(p)) && wanted.size) ofRepo = repoProjects(repo, [...entryProjects, ...(await index())]);
  }
  let projects = ofRepo ?? entryProjects;
  if (!projects.length && wanted.size) projects = await index();

  const migrations: CarveMigration[] = [];
  const homes = new Set<string>();
  const targets = new Set<string>();
  for (const name of [...wanted].slice(0, MAX_MIGRATIONS)) {
    const m = { name };
    // Its record and its lines are under its project: <project>/migrations/<name>.json and <name>/progress.jsonl.
    const known = opts.places?.get(m.name);
    const tries = known !== undefined && known !== null ? [known] : projects;
    let record: unknown;
    let progress: string | null = null;
    let text: string | undefined;
    let home: string | null = null;
    for (const h of tries) {
      const pk = key(h, "migrations", m.name, "progress.jsonl");
      text = await readText(source, pk, problems);
      if (text !== undefined) {
        progress = pk;
        record = parse(await readText(source, key(h, "migrations", `${m.name}.json`), problems), key(h, "migrations", `${m.name}.json`), problems);
        home = h;
        break;
      }
      const rk = key(h, "migrations", `${m.name}.json`);
      record = parse(await readText(source, rk, problems), rk, problems);
      if (record !== undefined) {
        home = h;
        break;
      }
    }
    if (home !== null) opts.places?.set(m.name, home);
    const { lines, bad, counts: lineCounts } = text !== undefined ? readProgress(text) : { lines: [], bad: 0, counts: null };
    if (bad) problems.push(`${progress}: ${bad} line${bad === 1 ? " is" : "s are"} not a progress record`);
    const counts = recordCounts(record) ?? lineCounts ?? countLines(lines);
    const status = isRecord(record) && str(record.status) ? record.status : null;
    const finished = isRecord(record) && str(record.finished) ? record.finished : null;
    const done = !!finished || (status !== null && FINISHED.has(status)) || (counts.left === 0 && lines.length > 0 && named !== m.name);
    if (!lines.length && record === undefined && named !== m.name) continue;
    if (home !== null && (lines.length || record !== undefined)) {
      homes.add(home);
      for (const l of lines) targets.add(l.estate_to);
      for (const t of recordTargets(record)) targets.add(t);
    }
    migrations.push({ name: m.name, progress, lines, counts, status, finished, running: !done && (lines.length > 0 || named === m.name) });
  }

  // Only the carved project's estates: the demo's prefix holds every demo repo's roots.
  const carved = carvedEntries(all, { repo: ofRepo, homes: [...homes], targets });
  const entries = carved.entries;
  // With a repo named, the gate is that repo's carve: its projects hold choudoufu roots, or one of its migrations was found.
  // The served checkout is not the demo's repo, so it does not open the gate there.
  const choudoufu = ofRepo !== null ? homes.size > 0 || entries.some(choudoufuEntry) : opts.choudoufu();
  const open = ofRepo !== null ? choudoufu : choudoufu || entries.length > 0;
  if (!open) {
    const reason =
      ofRepo !== null
        ? `demo.json names ${repo}, whose projects hold no choudoufu roots and no estate migration, so there is no carve to draw.`
        : "The estate has no choudoufu roots and the reports hold no estate rosters, so there is no carve to draw.";
    return { ...base, live: false, reason, problems };
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

  return {
    ...base,
    live: true,
    gate: { choudoufu, rosters: estates.length },
    projects: carved.projects,
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
