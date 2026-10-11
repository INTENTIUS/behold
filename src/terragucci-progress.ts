/**
 * A choudoufu wave's progress per resource, from terragucci's run view (#511).
 *
 * Since INTENTIUS/terragucci#786 a `tf-apply` wave job of a choudoufu repo
 * writes, while it applies, each resource its plans change into the run view
 * at `<prefix>/<project>/runs/<commit>/run.json` (terragucci
 * `packages/terragucci/src/apply-progress.ts`, `report/run-view.ts`):
 * `waves[].progress = {read, resources: [{root, address, action, status,
 * done_at?}]}`, `status` one of `done | in-flight | waiting | not-applied`,
 * and `read` when the job last read the estates' records.
 *
 * behold reads it for the newest commit `index.json` names a `tf-apply` run
 * of: one GET of `index.json` and one GET of that commit's `run.json`, never a
 * list. The run view's directory is the index row's own: a row's `path` is
 * `<project dir>/<yyyy>/<mm>/<commit>/tf-apply-wave-<k>` relative to the index,
 * so `runs/<commit>/run.json` sits beside the `<yyyy>` directory, whether
 * `--terragucci` names the top of the prefix or one project's directory.
 *
 * `run.json` is checked against `dist/run.schema.json` when
 * `@intentius/terragucci` resolves, structurally otherwise. A source without
 * one (no `reports.bucket`, a Terraform repo, a terragucci before #786) says
 * so; that is not "nothing is applying".
 *
 * What this produces is a dated mark per card, never a fill: each resource's
 * status as the job's records read at `progress.read` found it, and when a
 * read first found it done. The cards are joined the way
 * src/terragucci-overlay.ts joins a report's changes: the root's path to the
 * checkout's root, the instance address to its block's card.
 *
 * The #505 poll asks whether that `run.json` changed (`If-None-Match`, or the
 * file's mtime) only while the run is unsettled: a wave applying, or a
 * resource of a wave's progress in flight or waiting. Once every resource is
 * done or not applied it stops asking; the next `index.json` change makes the
 * page read this route again, which picks the newest commit afresh.
 *
 * Nothing here writes.
 */
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { Ajv2020 } from "ajv/dist/2020.js";
import { blockPath, type CheckoutRoot } from "./terragucci-overlay.ts";
import { pickProject, TerragucciReadError, type IndexRow, type Validation, type Validator } from "./terragucci-reports.ts";
import type { TerragucciSource } from "./terragucci-source.ts";
import type { Probe, ProgressPoll } from "./terragucci-poll.ts";

export const RUN_SCHEMA = "terragucci.run/v1";
export const RUN_SCHEMA_FILE = "run.schema.json";
/** How long a read is reused by the route, as the reports read is. */
export const PROGRESS_TTL_MS = 30_000;

export type ProgressStatus = "done" | "in-flight" | "waiting" | "not-applied";
export const PROGRESS_STATUSES: readonly ProgressStatus[] = ["done", "in-flight", "waiting", "not-applied"];
type WaveState = "not-started" | "planned" | "waiting" | "applying" | "applied" | "refused" | "failed";

/** The run view, as far as behold reads it. Every other field is ignored, as terragucci's v1 contract asks of a reader. */
export interface RunView {
  schema: string;
  project: string;
  commit: string;
  updated: string;
  waves: {
    number: number;
    state: WaveState;
    gate: string;
    roots: string[];
    progress?: { read: string; resources: { root: string; address: string; action: string; status: ProgressStatus; done_at?: string }[] };
  }[];
}

// ---------------------------------------------------------------------------
// Checking run.json.
// ---------------------------------------------------------------------------

export interface RunValidator {
  validation: Validation;
  /** Why `doc` is not a terragucci.run/v1 view, or undefined when it is. */
  check(doc: unknown): string | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

/** behold's own check: the schema id and the fields read here, with their types. */
export function structuralRun(doc: unknown): string | undefined {
  if (!isRecord(doc)) return "it is not a JSON object";
  if (doc.schema !== RUN_SCHEMA) return `its schema is ${JSON.stringify(doc.schema)}, not ${RUN_SCHEMA}`;
  for (const f of ["project", "commit", "updated"] as const) if (!str(doc[f])) return `its ${f} is not a string`;
  if (!Array.isArray(doc.waves)) return "it has no waves array";
  for (const [i, w] of doc.waves.entries()) {
    if (!isRecord(w) || typeof w.number !== "number" || !str(w.state) || !str(w.gate) || !Array.isArray(w.roots)) return `wave ${i} lacks number, state, gate or roots`;
    if (w.progress === undefined) continue;
    const p = w.progress;
    if (!isRecord(p) || !str(p.read) || !Array.isArray(p.resources)) return `wave ${String(w.number)}'s progress lacks read or resources`;
    for (const r of p.resources) {
      if (!isRecord(r) || !str(r.root) || !str(r.address) || !str(r.action)) return `a resource of wave ${String(w.number)}'s progress lacks root, address or action`;
      if (!PROGRESS_STATUSES.includes(r.status as ProgressStatus)) return `a resource of wave ${String(w.number)}'s progress has status ${JSON.stringify(r.status)}`;
      if (r.done_at !== undefined && !str(r.done_at)) return `a resource of wave ${String(w.number)}'s progress has a done_at that is not a string`;
    }
  }
  return undefined;
}

/** A validator over a parsed `run.schema.json`. The schema id is checked first, so a v2 view is refused by name. */
export function compileRunSchema(schema: object, version: string): RunValidator {
  const v = new Ajv2020({ strict: false, allErrors: false }).compile(schema);
  return {
    validation: { by: "schema", terragucci: version },
    check(doc) {
      const id = isRecord(doc) ? doc.schema : undefined;
      if (id !== RUN_SCHEMA) return `its schema is ${JSON.stringify(id)}, not ${RUN_SCHEMA}`;
      if (v(doc)) return undefined;
      const e = v.errors?.[0];
      return `${RUN_SCHEMA_FILE} rejects it: ${e?.instancePath || "/"} ${e?.message ?? "is invalid"}`;
    },
  };
}

/** Compiled run schemas, by the package's dist directory and its files' mtimes (#500). */
const compiled = new Map<string, RunValidator>();

/**
 * `@intentius/terragucci`'s `dist/run.schema.json` when the package resolves
 * from one of `dirs` (the served project first) or from behold, otherwise the
 * structural check. Looked up on every read.
 */
export function runValidator(dirs: readonly string[] = []): RunValidator {
  for (const from of [...dirs, dirname(fileURLToPath(import.meta.url))]) {
    let dist: string;
    try {
      dist = dirname(createRequire(join(resolve(from), "noop.js")).resolve("@intentius/terragucci/report.schema.json"));
    } catch {
      continue;
    }
    const pkg = join(dist, "..", "package.json");
    const file = join(dist, RUN_SCHEMA_FILE);
    let stamp: string;
    try {
      stamp = [dist, ...[pkg, file].map((f) => {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      })].join("\u0000");
    } catch {
      continue; // a terragucci without the run schema: the structural check runs
    }
    const hit = compiled.get(stamp);
    if (hit) return hit;
    let v: RunValidator;
    try {
      const version = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "";
      v = compileRunSchema(JSON.parse(readFileSync(file, "utf8")) as object, version);
    } catch {
      continue;
    }
    for (const k of compiled.keys()) if (k.startsWith(`${dist}\u0000`)) compiled.delete(k);
    compiled.set(stamp, v);
    return v;
  }
  return { validation: { by: "structural" }, check: structuralRun };
}

// ---------------------------------------------------------------------------
// Which run view.
// ---------------------------------------------------------------------------

const refuse = (error: string, remedy: string): never => {
  throw new TerragucciReadError({ error, code: "terragucci-report", remedy });
};

const newestFirst = (a: IndexRow, b: IndexRow): number => (a.finished < b.finished ? 1 : a.finished > b.finished ? -1 : 0);

/** The newest `tf-apply` row of `project`, or undefined when the index has none. */
export function newestApply(rows: readonly IndexRow[], project: string): IndexRow | undefined {
  return rows.filter((r) => r.project === project && r.stage === "tf-apply").sort(newestFirst)[0];
}

/**
 * The run view's key under the source, from the row's own directory:
 * `<project dir>/<yyyy>/<mm>/<commit>/<run>` gives `<project dir>/runs/<commit>/run.json`.
 * A path that does not hold the commit at that depth falls back to
 * terragucci's `runViewKey`, `<project>/runs/<commit>`, from the top of the prefix.
 */
export function runKey(row: Pick<IndexRow, "path" | "commit" | "project">): string {
  const segs = row.path.split("/").filter(Boolean);
  const at = segs.lastIndexOf(row.commit);
  const base = at >= 2 && /^\d{4}$/.test(segs[at - 2]!) && /^\d{2}$/.test(segs[at - 1]!) ? segs.slice(0, at - 2) : row.project.split("/").filter(Boolean);
  return [...base, "runs", row.commit, "run.json"].join("/");
}

// ---------------------------------------------------------------------------
// The join onto the cards.
// ---------------------------------------------------------------------------

type Node = { id: string; attrs?: Record<string, unknown> };

export type ProgressCounts = Record<ProgressStatus, number>;

export interface ProgressResource {
  root: string;
  address: string;
  action: string;
  status: ProgressStatus;
  done_at?: string;
  /** The card it lands on, when the checkout draws one. */
  card?: string;
}

export interface ProgressWave {
  number: number;
  /** The wave's state in the run view. */
  state: WaveState;
  gate: string;
  /** When the job last read the estates' records: what every status of this wave is as of. */
  read: string;
  counts: ProgressCounts;
  resources: ProgressResource[];
}

/** One wave's progress on one card: its instances, and the status the card is marked with. */
export interface CardProgress {
  wave: number;
  state: WaveState;
  /** When the records the statuses come from were read. */
  read: string;
  /** The card's mark: not applied, else in flight, else waiting, else done. */
  status: ProgressStatus;
  counts: ProgressCounts;
  resources: { root: string; address: string; action: string; status: ProgressStatus; done_at?: string }[];
}

export interface ProgressJoin {
  waves: ProgressWave[];
  cards: Record<string, CardProgress[]>;
  /** Resources no card is: said, never dropped. */
  unmatched: { root: string; address: string }[];
  /** Whether the poll asks about run.json: a wave applying, or a resource in flight or waiting. */
  watching: boolean;
}

const zero = (): ProgressCounts => ({ done: 0, "in-flight": 0, waiting: 0, "not-applied": 0 });
const MARK_ORDER: ProgressStatus[] = ["not-applied", "in-flight", "waiting", "done"];

/** Whether a run view still moves: a wave applying, or a resource of any wave's progress in flight or waiting. */
export function unsettled(run: Pick<RunView, "waves">): boolean {
  return run.waves.some((w) => w.state === "applying" || (w.progress?.resources ?? []).some((r) => r.status === "in-flight" || r.status === "waiting"));
}

/** Join a run view's progress onto the checkout's cards. Pure. */
export function joinProgress(run: Pick<RunView, "waves">, nodes: readonly Node[], roots: readonly CheckoutRoot[]): ProgressJoin {
  // Cards by member and root name, then block path: the same index the marks use.
  const byRoot = new Map<string, Map<string, string>>();
  for (const n of nodes) {
    const root = n.attrs?.root;
    if (typeof root !== "string") continue;
    const at = n.id.indexOf(`/${root}/`);
    if (at < 0) continue;
    const key = `${n.id.slice(0, at)}\u0000${root}`;
    if (!byRoot.has(key)) byRoot.set(key, new Map());
    byRoot.get(key)!.set(n.id.slice(at + root.length + 2), n.id);
  }
  const rootByPath = new Map(roots.map((r) => [r.path, r]));

  const waves: ProgressWave[] = [];
  const cards: Record<string, CardProgress[]> = {};
  const unmatched: { root: string; address: string }[] = [];
  for (const w of run.waves) {
    if (!w.progress) continue;
    const counts = zero();
    const resources: ProgressResource[] = [];
    const onCard = new Map<string, CardProgress>();
    for (const r of w.progress.resources) {
      counts[r.status]++;
      const root = rootByPath.get(r.root);
      const card = root ? byRoot.get(`${root.member}\u0000${root.name}`)?.get(blockPath(r.address)) : undefined;
      const own = { root: r.root, address: r.address, action: r.action, status: r.status, ...(r.done_at ? { done_at: r.done_at } : {}) };
      resources.push({ ...own, ...(card ? { card } : {}) });
      if (!card) {
        unmatched.push({ root: r.root, address: r.address });
        continue;
      }
      const m = onCard.get(card) ?? { wave: w.number, state: w.state, read: w.progress.read, status: "done" as ProgressStatus, counts: zero(), resources: [] };
      m.counts[r.status]++;
      m.resources.push(own);
      onCard.set(card, m);
    }
    for (const [card, m] of onCard) {
      m.status = MARK_ORDER.find((s) => m.counts[s] > 0) ?? "done";
      (cards[card] ??= []).push(m);
    }
    waves.push({ number: w.number, state: w.state, gate: w.gate, read: w.progress.read, counts, resources });
  }
  return { waves, cards, unmatched, watching: unsettled(run) };
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

export interface ProgressAnswer extends ProgressJoin {
  source: string;
  kind: TerragucciSource["kind"];
  project: string;
  validation: Validation;
  /** When behold read run.json. Each wave's statuses are as of its own `read`. */
  read: string;
  /** The run view read: the newest commit with a tf-apply run. Null when the index has none. */
  run: { commit: string; key: string; present: boolean; updated?: string; html?: string } | null;
  /** Present when there is no run view to read, saying so. */
  absent?: string;
  /** Where a key (`run.html`) opens. */
  files: string;
}

/** The reason a card join could not be made: the checkout's roots could not be read. */
export class ProgressGraphError extends Error {}

export interface ProgressOptions {
  source: TerragucciSource;
  /** `--terragucci-project`. */
  project?: string;
  /** The checkout's project, from its git remote, asked per read. */
  checkoutProject?: () => string | undefined;
  /** The validators, asked per read. */
  validators?: () => { index: Validator; run: RunValidator };
  /** The checkout's cards and roots, asked per join. */
  context: () => Promise<{ nodes: readonly Node[]; roots: readonly CheckoutRoot[] }>;
  /** The conditional read of a key: `indexProbe(source, {key})`. */
  probe: (key: string) => Probe;
  now?: () => Date;
}

const FILES = "/api/terragucci/file?key=";

/** What makes two answers the same picture: everything but when behold read it. */
export const progressKey = (a: ProgressAnswer): string => JSON.stringify([a.run, a.waves, a.unmatched]);

/**
 * The route's read and the poll's watch over one run view. `answer()` reads
 * the index and the run view; `poll()` asks only whether the run view it last
 * read changed, and only while that view is unsettled.
 */
export class TerragucciProgress {
  private cached: { at: number; key: string; answer: Promise<ProgressAnswer> } | undefined;
  /** The run view the poll watches: its key, the tag last seen, and the answer last given. */
  private watch: { key: string; commit: string; project: string; tag?: string; last: ProgressAnswer } | undefined;
  private probes = new Map<string, Probe>();

  constructor(private readonly o: ProgressOptions) {}

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  /** The answer, from the 30 s cache unless `fresh`. */
  answer(fresh = false): Promise<ProgressAnswer> {
    const key = this.o.checkoutProject?.() ?? "";
    const at = Date.now();
    if (!fresh && this.cached && this.cached.key === key && at - this.cached.at < PROGRESS_TTL_MS) return this.cached.answer;
    const p = this.read();
    this.cached = { at, key, answer: p };
    p.catch(() => (this.cached = undefined));
    return p;
  }

  /** Drop the cached answer: the index changed, so the newest commit may have. */
  forget(): void {
    this.cached = undefined;
  }

  private async read(): Promise<ProgressAnswer> {
    const v = this.o.validators?.();
    const src = this.o.source;
    let text: string | undefined;
    try {
      text = await src.read("index.json");
    } catch (e) {
      refuse(`Could not read index.json from ${src.location}: ${e instanceof Error ? e.message : String(e)}`, "Check the source serves terragucci's reports prefix.");
    }
    if (text === undefined) refuse(`${src.location} has no index.json.`, "Point --terragucci at terragucci's report directory or bucket prefix, the one holding index.json.");
    let doc: unknown;
    try {
      doc = JSON.parse(text!);
    } catch {
      refuse(`index.json in ${src.location} is not JSON.`, "Point --terragucci at a terragucci reports directory or bucket prefix, the one holding index.json.");
    }
    const why = v?.index.check("index", doc);
    if (why) refuse(`index.json in ${src.location} is not a terragucci terragucci.report-index/v1 document: ${why}.`, "Check that terragucci wrote it.");
    const rows = (doc as { reports: IndexRow[] }).reports;
    const checkout = this.o.checkoutProject?.();
    const project = pickProject(rows, { ...(this.o.project ? { project: this.o.project } : {}), ...(checkout ? { checkoutProject: checkout } : {}) }, src);
    const row = newestApply(rows, project);
    if (!row) {
      this.watch = undefined;
      return {
        ...this.base(project, v?.run.validation),
        run: null,
        absent: `index.json lists no tf-apply run of ${project} yet, so there is no run view to read.`,
        waves: [],
        cards: {},
        unmatched: [],
        watching: false,
      };
    }
    const key = runKey(row);
    const a = await this.readRun(project, row.commit, key, v?.run);
    this.watch = { key, commit: row.commit, project, last: a };
    return a;
  }

  private base(project: string, validation: Validation | undefined) {
    return { source: this.o.source.location, kind: this.o.source.kind, project, validation: validation ?? ({ by: "structural" } as Validation), read: this.now().toISOString(), files: FILES };
  }

  /** One GET of run.json, checked and joined. */
  private async readRun(project: string, commit: string, key: string, v: RunValidator | undefined): Promise<ProgressAnswer> {
    const src = this.o.source;
    const validator = v ?? runValidator();
    let text: string | undefined;
    try {
      text = await src.read(key);
    } catch (e) {
      refuse(
        `Could not read ${key} from ${src.location}: ${e instanceof Error ? e.message : String(e)}`,
        src.kind === "s3" ? "behold reads the bucket with your aws CLI or the environment's credentials: check GetObject on <prefix>/*/runs/*/run.json." : "Check the source serves the reports prefix.",
      );
    }
    const html = key.replace(/run\.json$/, "run.html");
    if (text === undefined) {
      return {
        ...this.base(project, validator.validation),
        run: { commit, key, present: false },
        absent: `${src.location} has no ${key}: terragucci writes the run view when reports.bucket is set, and a wave's progress per resource only for a choudoufu wave (terragucci 0.4.7 and newer). This says nothing about whether the apply moved.`,
        waves: [],
        cards: {},
        unmatched: [],
        watching: false,
      };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      refuse(`${key} in ${src.location} is not JSON.`, "Check that terragucci wrote it.");
    }
    const why = validator.check(doc);
    if (why) {
      refuse(
        `${key} in ${src.location} is not a terragucci ${RUN_SCHEMA} document: ${why}.`,
        validator.validation.by === "schema"
          ? `It was checked against @intentius/terragucci ${validator.validation.terragucci}'s ${RUN_SCHEMA_FILE}. Check that this terragucci wrote it, or upgrade behold.`
          : "Install @intentius/terragucci beside behold to check it against terragucci's own JSON Schema, and check that terragucci wrote it.",
      );
    }
    const run = doc as RunView;
    let ctx: { nodes: readonly Node[]; roots: readonly CheckoutRoot[] };
    try {
      ctx = await this.o.context();
    } catch (e) {
      throw new ProgressGraphError(`behold could not read the checkout's roots to place the progress on: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      ...this.base(project, validator.validation),
      run: { commit, key, present: true, updated: run.updated, html },
      ...joinProgress(run, ctx.nodes, ctx.roots),
    };
  }

  /**
   * One tick of the #505 poll: ask whether the watched run.json changed, only
   * while it is unsettled. A first ask after a read has no tag to compare, so
   * it reads the view again rather than miss a write made in between.
   */
  async poll(): Promise<ProgressPoll> {
    const w = this.watch;
    if (!w || !w.last.watching) return { asked: false };
    let probe = this.probes.get(w.key);
    if (!probe) {
      probe = this.o.probe(w.key);
      this.probes.set(w.key, probe);
    }
    const p = await probe(w.tag);
    const changed = p.changed || w.tag === undefined;
    w.tag = p.tag;
    if (!changed) return { asked: true, key: w.key, changed: false };
    const v = this.o.validators?.();
    const a = await this.readRun(w.project, w.commit, w.key, v?.run);
    // The watch may have moved to a newer commit while this read ran.
    if (this.watch !== w) return { asked: true, key: w.key, changed: true };
    const moved = progressKey(a) !== progressKey(w.last);
    w.last = a;
    this.cached = { at: Date.now(), key: this.o.checkoutProject?.() ?? "", answer: Promise.resolve(a) };
    return { asked: true, key: w.key, changed: true, ...(moved ? { answer: a } : {}) };
  }
}

/** `GET /api/terragucci/progress`: read-only, one GET of index.json and one of run.json per read, cached 30 s (`?fresh=1` skips it). */
export function terragucciProgressRoute(app: Hono, progress: TerragucciProgress): void {
  app.get("/api/terragucci/progress", async (c) => {
    try {
      return c.json(await progress.answer(new URL(c.req.url).searchParams.get("fresh") === "1"));
    } catch (e) {
      if (e instanceof TerragucciReadError) return c.json(e.refusal, 422);
      if (e instanceof ProgressGraphError) return c.json({ error: e.message, code: "terragucci-graph", remedy: "`behold doctor` names what the Terraform read needs." }, 422);
      throw e;
    }
  });
}
