/**
 * behold#752: chant's fan-out demo (INTENTIUS/chant#4085), read from the
 * demo's own bucket instead of terragucci's reports. The driver in chant's
 * `examples/fan-out-estate/demo` writes two records (chant#4092, schemas in
 * chant#4102):
 *
 * - `step.json` (`demo-step/v1`), rewritten at every step: the narration the
 *   kiosk shows, under the field names it already reads from terragucci's
 *   demo.json (`chapter` included), plus `reports`, the step's keys under
 *   chant's `--report-url` (`reportKey(pr, commit)`, chant's
 *   `pr-report-url.ts`).
 * - `cycles/latest.json` (`demo-cycle/v1`), published at each reset: the
 *   last full cycle's steps, and its report keys in place of terragucci's
 *   `runs` (copies of forge runs).
 *
 * `serve --chant-demo <s3://…|https://…|dir>` names the prefix both sit
 * under. Every read is one GET of one object, as the terragucci readers do,
 * so a GetObject-only identity and `--public` both work.
 *
 * The facts the kiosk draws come from chant's own contracts under each step's
 * `reports` (`pr-<stage>.json`, pr-report/v1; `pr-<stage>.events.jsonl`,
 * run-event/v1), never from the forge: the runs pane's runs are built here
 * from the run events (one run per report key), and /api/chant/pr reads the
 * stages at the step's keys instead of finding `--report-url` in the
 * workflow file (src/chant-pr.ts `demoReports`).
 *
 * ## The schemas, and the floor
 *
 * `./demo-schemas/` holds chant's two schemas, copied unchanged from
 * {@link DEMO_SCHEMA_SOURCE}, and every record is validated against its
 * schema before a field of it is read, as src/run-events.ts does with
 * run-event/v1. Before that, the floor: a record keyed to the kind's `$id`
 * at another major (`…/demo-step/v2/…`), or whose `contract` is not
 * {@link DEMO_CONTRACT}, is refused with the version behold reads, never
 * read field by field.
 *
 * One part of the schema is not enforced: `step`'s enum, which lists what a
 * writer may write in contract 1. Steps can be added within the contract, so
 * a step behold doesn't know is shown by its name and lights no stop of the
 * strip, never refused ({@link readerSchema}). Nor is `highlight`'s (chant#4106,
 * behold#757): one not of its form is left out, the step read as before.
 *
 * demo-step/v1 requires only `$schema`, `contract`, `demo`, `cycle` and
 * `step`; everything the kiosk shows is optional, so a missing field reads
 * as the kiosk's own "none" (an empty label, no chapter, no card). Fields
 * the schema doesn't name are ignored, as the contract asks.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Hono } from "hono";
import { parseRunEvents } from "./chant-pr-events.ts";
import { prStageOfReport, repoNameOf, reportSourceOf, type PrStageRead, type RunDoc } from "./chant-pr.ts";
import type { GitRun } from "./terragucci-lifecycle.ts";
import demoCycleSchema from "./demo-schemas/demo-cycle.schema.json" with { type: "json" };
import demoStepSchema from "./demo-schemas/demo-step.schema.json" with { type: "json" };
import { runEventLine, type RunLine } from "./run-events.ts";
import { chapterOf, DEMO_STEPS, highlightOf, type Cycle, type Demo, type DemoStep } from "./terragucci-demo.ts";
import { deniedWords, TerragucciDenied, terragucciSource, type AwsRun, type TerragucciSource } from "./terragucci-source.ts";

/**
 * Where the vendored schemas come from: chant's main, as chant#4102 (for chant#4092) wrote them and chant#4106 added
 * the optional `highlight` to a step (behold#757).
 */
export const DEMO_SCHEMA_SOURCE = {
  repo: "INTENTIUS/chant",
  path: "examples/fan-out-estate/demo/schemas/",
  pr: 4106,
  commit: "70357348d23a8f608198da327ae0190f7e0683b0",
} as const;

/** The demo contract version behold reads (`contract: 1`). */
export const DEMO_CONTRACT = 1;
/** The schemas' `$id`s, which every record carries as `$schema`. */
export const DEMO_STEP_SCHEMA: string = demoStepSchema.$id;
export const DEMO_CYCLE_SCHEMA: string = demoCycleSchema.$id;
export const STEP_KEY = "step.json";
export const LATEST_CYCLE_KEY = "cycles/latest.json";
/** Where the reports sit when a step names none (or one behold won't follow): beside the records. */
export const REPORTS_DIR = "reports";
/** The page the source feeds: chant's fan-out page (behold#746), which the step itself no longer names (the schema has no `tool`). */
export const CHANT_DEMO_TOOL = "chant-fanout";

/** How long one read of step.json is shared, as demo.json's is. */
export const STEP_READ_TTL_MS = 2_000;
/** How long the latest cycle is shared: it changes once a cycle. */
export const CYCLE_READ_TTL_MS = 10_000;
/** How long one stage's run, built from its events, is shared. */
export const RUN_READ_TTL_MS = 2_000;

export type DemoKind = "demo-step" | "demo-cycle";

/** The step's keys under the report URL (`reportKey(pr, commit)`). */
export interface StepReports {
  url: string | null;
  plan: string | null;
  apply: string | null;
}

/** A demo-step/v1 write as the kiosk reads it: demo.json's fields, and the step's own. */
export type ChantStep = Omit<Demo, "step"> & {
  /** The step as written. One outside {@link DEMO_STEPS} is a step added within contract 1 that this behold can't classify: shown by its own name, never refused. */
  step: DemoStep | string;
  demo: string;
  at: string | null;
  reports: StepReports | null;
  /** `cycle_reports`: every stage of the cycle so far, in the order they ran; null when the step names none. */
  cycleReports: CycleReport[] | null;
};

/** One stage a cycle ran, by its report key. */
export interface CycleReport {
  stage: "plan" | "apply";
  pr: number | null;
  commit: string;
  key: string;
}

/** demo-cycle/v1 as the kiosk replays it: the terragucci reader's Cycle, its `runs` the ids behold gives each report. */
export type ChantCycle = Omit<Cycle, "steps"> & { steps: (ChantStep & { at: string })[]; reports: CycleReport[] };

export type StepAnswer =
  | { source: string; read: string; demo: ChantStep }
  | { source: string; read: string; demo: null; absent: string }
  | { source: string; read: string; demo: null; error: string; code: "chant-demo"; remedy?: string };

export type DemoCycleAnswer =
  | { source: string; read: string; cycle: ChantCycle }
  | { source: string; read: string; cycle: null; absent: string }
  | { source: string; read: string; cycle: null; error: string; code: "chant-demo"; remedy?: string };

/** chant's `reportKey(pr, commit)` as the schemas pattern it. */
const REPORT_KEY = /^([0-9]+)\/([0-9a-f]{40,64})$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const text = (v: unknown): string | null => (str(v) && v.trim() ? v.trim() : null);

/** A contract refusal: what is wrong, and what to do. */
export interface ContractRefusal {
  problem: string;
  remedy: string;
}

const SCHEMA_ID: Record<DemoKind, string> = { "demo-step": DEMO_STEP_SCHEMA, "demo-cycle": DEMO_CYCLE_SCHEMA };

/**
 * The floor every demo record passes before its schema is checked: its
 * `$schema` names the kind's schema at the major behold reads, and its
 * `contract` is that major. Another major says so, with what to upgrade.
 */
export function contractRefusal(doc: Record<string, unknown>, kind: DemoKind): ContractRefusal | undefined {
  const m = str(doc.$schema) ? new RegExp(`/${kind}/v(\\d+)/${kind}\\.schema\\.json$`).exec(doc.$schema) : null;
  const major = m ? Number(m[1]) : undefined;
  // A major in the $schema other than behold's is refused for it, whatever `contract` says.
  const said = major !== undefined && major !== DEMO_CONTRACT ? major : int(doc.contract) ? doc.contract : major;
  if (said !== undefined && said !== DEMO_CONTRACT) {
    return {
      problem: `it is written to ${kind} contract ${said}; behold reads contract ${DEMO_CONTRACT}`,
      remedy: said > DEMO_CONTRACT ? "Upgrade behold: this demo writes a newer contract than it knows." : "Upgrade the demo's chant.",
    };
  }
  if (doc.$schema !== SCHEMA_ID[kind]) {
    return { problem: `its $schema is ${JSON.stringify(doc.$schema ?? null)}, not ${SCHEMA_ID[kind]}`, remedy: `Point --chant-demo at the prefix the demo's driver writes ${kind === "demo-step" ? STEP_KEY : LATEST_CYCLE_KEY} under.` };
  }
  if (doc.contract !== DEMO_CONTRACT) return { problem: `its contract is ${JSON.stringify(doc.contract ?? null)}, not ${DEMO_CONTRACT}`, remedy: "The driver wrote something other than a demo record." };
  return undefined;
}

type Validator = ((v: unknown) => boolean) & { errors?: Array<{ instancePath?: string; message?: string }> | null };
const validators: Partial<Record<DemoKind, Validator>> = {};

/**
 * The schema behold validates with: chant's, less `step`'s enum. The enum is
 * what a writer may write in contract 1, and a step can be added within it, so
 * a reader takes any string there and leaves a step it doesn't know
 * unclassified (chant#4102). The vendored file stays as chant wrote it.
 */
export function readerSchema(kind: DemoKind): Record<string, unknown> {
  const schema = structuredClone(kind === "demo-step" ? demoStepSchema : demoCycleSchema) as Record<string, any>;
  const steps = kind === "demo-step" ? schema.properties?.step : schema.$defs?.cycleStep?.properties?.step;
  if (steps && Array.isArray(steps.enum)) {
    delete steps.enum;
    steps.type = "string";
  }
  // behold#757: a `highlight` not of chant#4106's form is ignored (highlightOf), never a refusal of the step it rides on.
  const props = kind === "demo-step" ? schema.properties : schema.$defs?.cycleStep?.properties;
  if (props && props.highlight) delete props.highlight;
  return schema;
}

/** What the vendored schema (as a reader takes it, {@link readerSchema}) says is wrong with `doc`, or undefined. */
export function schemaProblem(doc: unknown, kind: DemoKind): string | undefined {
  let v = validators[kind];
  if (!v) {
    const ajv = new Ajv2020({ strict: false, allErrors: false });
    v = validators[kind] = ajv.compile(readerSchema(kind)) as Validator;
  }
  if (v(doc)) return undefined;
  const e = v.errors?.[0];
  return e ? `${e.instancePath || "the record"} ${e.message ?? "does not match"}` : "it does not match the schema";
}

/** A report key's pull request and commit. */
export function keyParts(key: string): { pr: number; commit: string } {
  const m = REPORT_KEY.exec(key)!;
  return { pr: Number(m[1]), commit: m[2]! };
}

/**
 * A demo-step/v1 write, which its schema passed, as the kiosk reads
 * demo.json. What the schema leaves optional reads as the kiosk's "none":
 * no repo, the demo's name for the scenario, an empty title and label.
 */
export function stepOf(d: Record<string, unknown>): ChantStep {
  const next = isRecord(d.next) ? d.next : null;
  const about = isRecord(d.about) && ["changes", "watch", "shows"].every((f) => text((d.about as Record<string, unknown>)[f])) ? (d.about as Record<string, string>) : null;
  const r = isRecord(d.reports) ? d.reports : null;
  const chapter = chapterOf(d.chapter);
  // behold#757: chant#4106's optional `highlight`, floored as terragucci's is (src/terragucci-demo.ts highlightOf).
  const highlight = highlightOf(d.highlight);
  const demo = str(d.demo) ? d.demo : "";
  return {
    demo,
    cycle: d.cycle as number,
    scenario: text(d.scenario) ?? (demo || "demo"),
    title: str(d.title) ? d.title : "",
    step: d.step as string,
    label: str(d.label) ? d.label : "",
    started_at: str(d.started_at) ? d.started_at : str(d.at) ? d.at : "",
    next: next ? { action: str(next.action) ? next.action : "the next step", ...(str(next.from) ? { from: next.from } : {}), at: str(next.at) ? next.at : null } : null,
    pull: int(d.pull) ? d.pull : null,
    commit: str(d.commit) ? d.commit : null,
    about: about ? { changes: about.changes!.trim(), watch: about.watch!.trim(), shows: about.shows!.trim() } : null,
    intro: text(d.intro),
    name: text(d.name),
    // The schema has no `index`, `scenarios`, `beat`, `delivery` or `tool`: one demo, one page.
    scenarios: null,
    index: null,
    tool: CHANT_DEMO_TOOL,
    repo: text(d.repo),
    delivery: null,
    beat: null,
    ...(chapter ? { chapter } : {}),
    ...(highlight ? { highlight } : {}),
    at: str(d.at) ? d.at : null,
    reports: r ? { url: text(r.url), plan: str(r.plan) ? r.plan : null, apply: str(r.apply) ? r.apply : null } : null,
    cycleReports: Array.isArray(d.cycle_reports) ? reportsOf(d.cycle_reports) : null,
  };
}

/** demo-cycle's `reports` or a step's `cycle_reports`, which their schema passed, in the order the stages ran. */
const reportsOf = (list: unknown[]): CycleReport[] =>
  (list as Record<string, unknown>[]).map((r) => ({ stage: r.stage as "plan" | "apply", pr: r.pr as number, commit: r.commit as string, key: r.key as string }));

/** Whether behold can classify a step: one of the steps it knows. Any other is shown by its name and lights no stop. */
export const knownStep = (step: string): step is DemoStep => (DEMO_STEPS as readonly string[]).includes(step);

/** The checks a step passes past its schema: none. An unknown `step` is unclassified, never a refusal (chant#4102). */
export function stepProblem(_d: Record<string, unknown>): string | undefined {
  return undefined;
}

/** The id the runs pane gives a cycle's `n`th stage (1-based): ordered as they ran, and unique across cycles. */
export const runIdFor = (cycle: number, n: number): number => cycle * 100 + n;

/** A demo-cycle/v1 document, which its schema passed, as the kiosk replays it. */
export function cycleOf(d: Record<string, unknown>): ChantCycle {
  const cycle = d.cycle as number;
  const steps = (d.steps as Record<string, unknown>[]).map((s) => {
    // A step as written may leave out what the cycle says: its demo, repo and cycle.
    const step = stepOf({ demo: d.demo, ...(str(d.repo) ? { repo: d.repo } : {}), cycle, ...s });
    return { ...step, at: s.at as string };
  });
  // In the order the stages ran (chant#4102), which the run ids keep.
  const reports = reportsOf(Array.isArray(d.reports) ? d.reports : []);
  const repo = text(d.repo) ?? steps.map((s) => s.repo).find((x) => !!x) ?? "";
  return {
    tool: CHANT_DEMO_TOOL,
    repo,
    scenario: steps[0]?.scenario ?? (str(d.demo) ? d.demo : "demo"),
    cycle,
    started: str(d.started) ? d.started : (steps[0]?.at ?? null),
    ended: str(d.ended) ? d.ended : (steps[steps.length - 1]?.at ?? null),
    steps,
    runs: reports.map((_, i) => runIdFor(cycle, i + 1)),
    reports,
  };
}

/** The cycle's own check past its schema: a step to replay. */
export function cycleProblem(d: Record<string, unknown>): string | undefined {
  return (d.steps as unknown[]).length ? undefined : "steps is empty";
}

type Read<T> = { ok: T } | { absent: true } | { error: string; remedy?: string };

/** One GET of one record: its floor, then its schema, then what the kiosk needs of it. Never throws. */
async function readRecord<T>(source: TerragucciSource, key: string, kind: DemoKind, what: string, problem: (d: Record<string, unknown>) => string | undefined, of: (d: Record<string, unknown>) => T): Promise<Read<T>> {
  let body: string | undefined;
  try {
    body = await source.read(key);
  } catch (e) {
    if (e instanceof TerragucciDenied) return { error: deniedWords(e, what) };
    return { error: `behold could not read ${key} from ${source.location}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (body === undefined) return { absent: true };
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return { error: `${key} in ${source.location} is not JSON.` };
  }
  if (!isRecord(doc)) return { error: `${key} in ${source.location} is not a ${kind} record: it is not an object.` };
  const floor = contractRefusal(doc, kind);
  if (floor) return { error: `behold refuses ${key} in ${source.location}: ${floor.problem}.`, remedy: floor.remedy };
  const p = schemaProblem(doc, kind) ?? problem(doc);
  if (p) return { error: `${key} in ${source.location} is not the ${kind}/v${DEMO_CONTRACT} format: ${p}.` };
  return { ok: of(doc) };
}

/** One read of step.json. Never throws: a refusal is an answer the kiosk shows. */
export async function readStep(source: TerragucciSource, now: Date = new Date()): Promise<StepAnswer> {
  const base = { source: source.location, read: now.toISOString() };
  const r = await readRecord(source, STEP_KEY, "demo-step", "the demo's narration", stepProblem, stepOf);
  if ("ok" in r) return { ...base, demo: r.ok };
  if ("absent" in r) return { ...base, demo: null, absent: `${source.location} has no ${STEP_KEY}: the demo's driver writes it at every step (chant's examples/fan-out-estate/demo).` };
  return { ...base, demo: null, error: r.error, code: "chant-demo", ...(r.remedy ? { remedy: r.remedy } : {}) };
}

/** One read of cycles/latest.json. Never throws. */
export async function readDemoCycle(source: TerragucciSource, now: Date = new Date()): Promise<DemoCycleAnswer> {
  const base = { source: source.location, read: now.toISOString() };
  const r = await readRecord(source, LATEST_CYCLE_KEY, "demo-cycle", "the demo's last cycle", cycleProblem, cycleOf);
  if ("ok" in r) return { ...base, cycle: r.ok };
  if ("absent" in r) return { ...base, cycle: null, absent: `${source.location} has no ${LATEST_CYCLE_KEY}: the demo's driver publishes it when a cycle reaches its reset.` };
  return { ...base, cycle: null, error: r.error, code: "chant-demo", ...(r.remedy ? { remedy: r.remedy } : {}) };
}

// ---------------------------------------------------------------------------
// The runs: one per stage a report key names, built from its run events.

/** A stage of a cycle with the id the runs pane shows it by. */
export interface DemoRunEntry extends CycleReport {
  id: number;
  cycle: number;
}

/** A job's step in the runs pane (demo.run/v1's shape, which web/kiosk-runs.js draws). */
interface RunStep {
  name: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  log: string[];
}

/** A run in demo.run/v1's shape, built from a stage's events and report. */
export interface DemoRun {
  schema: "demo.run/v1";
  id: number;
  title: string;
  repo: string;
  status: string;
  event: "pull_request" | "push";
  trigger: "plan" | "merge";
  pull: number | null;
  commit: string;
  ref: string | null;
  cycle: number;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** Where chant's records for the run are: `<report url>/<key>/`. */
  reports: string;
  /** The run's origin as chant's events name it (`runOrigin.url`), shown and never keyed off (chant#4085 section 6). */
  origin?: string;
  jobs: { id: number; name: string; needs: string[]; status: string; started_at: string | null; ended_at: string | null; steps?: RunStep[] }[];
}

type Ev = Record<string, unknown> & { type: string };

const RUN_STATUS: Record<string, string> = { ok: "success", failed: "failure", gated: "waiting", waiting: "waiting" };
const COMPONENT_STATUS: Record<string, string> = { ok: "success", failed: "failure", gated: "waiting", waiting: "waiting", blocked: "skipped", "already-applied": "success" };

/**
 * A stage's run as the runs pane draws one: a job named after the stage
 * (`pr-plan`, `pr-apply`), its steps the stage's parts in the order the
 * events give them (the plan, the gate, then each wave), each step's log the
 * events' own lines (src/run-events.ts `runEventLine`). Without events yet,
 * a queued run. The report, when there is one, ends a run the events left open.
 */
export function demoRunOf(entry: DemoRunEntry, repo: string, reportsAt: string, events: readonly Ev[], report?: PrStageRead): DemoRun {
  const job = `pr-${entry.stage}`;
  const first = events[0];
  const settle = [...events].reverse().find((e) => e.type === "run-settle");
  const at = (e: Ev | undefined): string | null => (e && str(e.at) ? e.at : null);
  const origin = first && isRecord(first.runOrigin) && str(first.runOrigin.url) ? first.runOrigin.url : undefined;
  const steps: RunStep[] = [];
  const part = (name: string, e: Ev): RunStep => {
    let s = steps.find((x) => x.name === name);
    if (!s) {
      s = { name, status: "running", started_at: at(e), ended_at: null, log: [] };
      steps.push(s);
    }
    return s;
  };
  for (const e of events) {
    const line = runEventLine(e as unknown as RunLine);
    const wave = int(e.wave) ? e.wave : null;
    const phase = str(e.phase) ? e.phase : null;
    let s: RunStep | null = null;
    if (wave !== null) s = part(`wave ${wave}`, e);
    else if (phase === "gate" || e.type === "gate-waiting" || e.type === "gate-resolved") s = part("gate", e);
    else if (phase === "plan") s = part("plan", e);
    if (!s) continue;
    if (line) s.log.push(line);
    if (e.type === "component-start") s.log.push(`▶ ${String(e.component)} · wave ${wave}`);
    if (e.type === "component-settle") {
      const by = str(e.blockedBy) ? ` by ${e.blockedBy}` : "";
      s.log.push(`${e.status === "ok" || e.status === "already-applied" ? "✓" : e.status === "failed" ? "✗" : "•"} ${String(e.component)}: ${String(e.status)}${by}${str(e.error) ? `: ${e.error}` : ""}`);
    }
    if (e.type === "wave-settle" || (e.type === "phase-settle" && !str(e.component))) {
      s.status = COMPONENT_STATUS[String(e.status)] ?? "success";
      s.ended_at = at(e);
    }
    if (e.type === "step-settle" && phase === "gate") {
      s.status = COMPONENT_STATUS[String(e.status)] ?? s.status;
      s.ended_at = at(e);
    }
    if (e.type === "gate-resolved") {
      s.status = "success";
      s.ended_at = at(e);
    }
  }
  // Once the run settled: a wave run-start listed that never started was blocked behind a failure, and so was a
  // component of a started wave with no start or settle of its own (chant before 0.124.29 writes no `blocked`).
  const start = events.find((e) => e.type === "run-start");
  if (start && Array.isArray(start.waves) && settle) {
    const seen = new Set(events.filter((e) => e.type === "component-start" || e.type === "component-settle").map((e) => String(e.component)));
    start.waves.forEach((w, i) => {
      const name = `wave ${i + 1}`;
      const s = steps.find((x) => x.name === name);
      if (!s) steps.push({ name, status: "skipped", started_at: null, ended_at: null, log: ["• blocked: an earlier wave failed"] });
      else if (Array.isArray(w)) for (const c of w) if (!seen.has(String(c))) s.log.push(`• ${String(c)}: blocked, never started`);
    });
  }
  const settled = settle ? RUN_STATUS[String(settle.status)] ?? "failure" : null;
  const fromReport = report?.status === "applied" || report?.status === "planned" ? "success" : report?.status === "failed" || report?.status === "refused" ? "failure" : null;
  const status = settled ?? fromReport ?? (events.length ? "running" : "queued");
  for (const s of steps) if (s.status === "running" && status !== "running") s.status = status === "waiting" ? "success" : status;
  const title = entry.stage === "plan" ? `chant components pr-plan · pull request #${entry.pr ?? "?"}` : `chant components pr-apply · merge of #${entry.pr ?? "?"}`;
  return {
    schema: "demo.run/v1",
    id: entry.id,
    title,
    repo,
    status,
    event: entry.stage === "plan" ? "pull_request" : "push",
    trigger: entry.stage === "plan" ? "plan" : "merge",
    pull: entry.pr,
    commit: entry.commit,
    ref: null,
    cycle: entry.cycle,
    created_at: at(first),
    started_at: at(first),
    ended_at: settle ? at(settle) : null,
    reports: `${reportsAt.replace(/\/+$/, "")}/${entry.key}/`,
    ...(origin ? { origin } : {}),
    jobs: [{ id: entry.id, name: job, needs: [], status, started_at: at(first), ended_at: settle ? at(settle) : null, steps }],
  };
}

/** The runs index entry: the run without its steps. */
const indexEntry = (r: DemoRun): Omit<DemoRun, "jobs"> & { jobs: Omit<DemoRun["jobs"][number], "steps">[] } => ({ ...r, jobs: r.jobs.map(({ steps: _s, ...j }) => j) });

export interface ChantDemoOptions {
  /** `--chant-demo`: the prefix step.json and cycles/ sit under. */
  source: string;
  /** `--chant-report-url`: where the reports are, over what the step says. */
  reportUrl?: string;
  aws?: AwsRun;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Tests: the source a URL is read through. */
  sourceOf?: (url: string) => TerragucciSource;
}

/**
 * The demo's reads, shared between kiosks: the step, the latest cycle, the
 * reports' URL, and the runs. The cycle in progress has no record of its own
 * (the step names only its pull request's keys), so the stages its steps
 * named are kept as the steps are read: the fix's apply still knows the
 * change's.
 */
export class ChantDemo {
  readonly source: TerragucciSource;
  private readonly opts: ChantDemoOptions;
  private step?: { at: number; read: Promise<StepAnswer> };
  private latest?: { at: number; read: Promise<DemoCycleAnswer> };
  private readonly runs = new Map<string, { at: number; read: Promise<DemoRun> }>();
  private live: { cycle: number; reports: CycleReport[] } | null = null;
  private readonly sources = new Map<string, TerragucciSource>();
  /** behold#765: the report URLs {@link entries} has named, the ones {@link reportSource} answers for. */
  private readonly reportUrls = new Set<string>();

  constructor(opts: ChantDemoOptions) {
    this.opts = opts;
    this.source = this.sourceOf(opts.source);
  }

  private sourceOf(url: string): TerragucciSource {
    const hit = this.sources.get(url);
    if (hit) return hit;
    const via = { ...(this.opts.aws ? { aws: this.opts.aws } : {}), ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) };
    const of = (u: string): TerragucciSource => (this.opts.sourceOf ? this.opts.sourceOf(u) : u === this.opts.source ? terragucciSource(u, via) : reportSourceOf(u, via));
    // behold#765: a step's URL (not serve's --chant-report-url) is read after the copy beside the records, which a saved
    // cycle carries: its bucket may be one this behold can't reach, and a key names one commit's stage, so both hold the same.
    const beside = this.besideUrl();
    const near = url !== this.opts.source && url !== beside && !this.opts.reportUrl ? of(beside) : undefined;
    const s = near ? besideFirst(near, of(url)) : of(url);
    this.sources.set(url, s);
    return s;
  }

  /** `reports/` beside the records. */
  private besideUrl(): string {
    return `${this.opts.source.replace(/\/+$/, "")}/${REPORTS_DIR}`;
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  /** step.json, shared for {@link STEP_READ_TTL_MS}; each step read adds its keys to the cycle in progress. */
  readStep(): Promise<StepAnswer> {
    const t = Date.now();
    if (!this.step || t - this.step.at >= STEP_READ_TTL_MS) {
      const read = readStep(this.source, this.now()).then((a) => {
        if (a.demo) this.note(a.demo);
        return a;
      });
      this.step = { at: t, read };
    }
    return this.step.read;
  }

  /** cycles/latest.json, shared for {@link CYCLE_READ_TTL_MS}. */
  readCycle(): Promise<DemoCycleAnswer> {
    const t = Date.now();
    if (!this.latest || t - this.latest.at >= CYCLE_READ_TTL_MS) this.latest = { at: t, read: readDemoCycle(this.source, this.now()) };
    return this.latest.read;
  }

  /**
   * The cycle in progress's stages: the step's `cycle_reports` when it writes
   * them (in run order), else the keys the steps read so far named, a list a
   * behold started mid-cycle only has from its start. Then the step's own keys
   * not in it yet (a stage whose report isn't written).
   */
  private note(step: ChantStep): void {
    if (step.cycleReports) this.live = { cycle: step.cycle, reports: [...step.cycleReports] };
    else if (!this.live || this.live.cycle !== step.cycle) this.live = { cycle: step.cycle, reports: [] };
    for (const stage of ["plan", "apply"] as const) {
      const key = step.reports?.[stage];
      if (!key || this.live.reports.some((r) => r.stage === stage && r.key === key)) continue;
      const k = keyParts(key);
      this.live.reports.push({ stage, pr: k.pr, commit: k.commit, key });
    }
  }

  /**
   * Where chant's reports are read: `--chant-report-url` when serve was given
   * one; else the step's `reports.url`, which the schema holds to s3:// or
   * https:// (a record with another is refused whole); else, with no valid
   * record naming one (step.json refused or not there, and no cycle step with
   * a URL), `reports/` beside the records.
   */
  reportsUrl(step: { reports: StepReports | null } | null): string {
    if (this.opts.reportUrl) return this.opts.reportUrl;
    const u = step?.reports?.url;
    if (u) return u;
    return this.besideUrl();
  }

  /** Every stage the runs pane may show: the latest cycle's, and the cycle in progress's, each with its id. */
  async entries(): Promise<{ entries: DemoRunEntry[]; repo: string | null; url: string; latest: ChantCycle | null }> {
    const [s, c] = await Promise.all([this.readStep(), this.readCycle()]);
    const latest = c.cycle;
    const out: DemoRunEntry[] = [];
    if (latest) latest.reports.forEach((r, i) => out.push({ ...r, id: runIdFor(latest.cycle, i + 1), cycle: latest.cycle }));
    const live = this.live;
    if (live && (!latest || live.cycle !== latest.cycle)) live.reports.forEach((r, i) => out.push({ ...r, id: runIdFor(live.cycle, i + 1), cycle: live.cycle }));
    const step = s.demo;
    const withUrl = step ?? (latest ? latest.steps.find((x) => x.reports && x.reports.url) ?? null : null);
    const url = this.reportsUrl(withUrl);
    this.reportUrls.add(url);
    return { entries: out, repo: step ? step.repo : latest ? latest.repo : null, url, latest };
  }

  /** One stage's run, built from its events (and its report, to end a run the events left open). Shared for {@link RUN_READ_TTL_MS}. */
  run(entry: DemoRunEntry, repo: string, url: string): Promise<DemoRun> {
    const k = `${url}|${entry.stage}|${entry.key}|${entry.id}`;
    const t = Date.now();
    const hit = this.runs.get(k);
    if (hit && t - hit.at < RUN_READ_TTL_MS) return hit.read;
    for (const [key, v] of this.runs) if (t - v.at >= RUN_READ_TTL_MS) this.runs.delete(key);
    const src = this.sourceOf(url);
    const read = (async () => {
      const get = async (file: string): Promise<string | undefined> => {
        try {
          return await src.read(`${entry.key}/${file}`);
        } catch {
          return undefined;
        }
      };
      const [events, report] = await Promise.all([get(`pr-${entry.stage}.events.jsonl`), get(`pr-${entry.stage}.json`)]);
      let stage: PrStageRead | undefined;
      try {
        stage = report ? prStageOfReport(JSON.parse(report), `${entry.key}/pr-${entry.stage}.json`) : undefined;
      } catch {
        stage = undefined;
      }
      return demoRunOf(entry, repo, url, events ? (parseRunEvents(events).events as Ev[]) : [], stage);
    })();
    this.runs.set(k, { at: t, read });
    return read;
  }

  /**
   * src/chant-pr.ts's runs for a chant demo: each stage the cycles' steps
   * named, as the runs a pin picks from (a plan on its pull request's head, an
   * apply on its merge), each with its report key, and the URL they sit under.
   * Null for a checkout (`dir`) that is not the demo's repo.
   */
  async prReports(dir?: string, git?: GitRun): Promise<{ url: string; runs: RunDoc[] } | null> {
    const { entries, url, repo } = await this.entries();
    // Another served checkout than the demo's repo reads its own loop, as before.
    if (dir !== undefined) {
      const here = await repoNameOf(dir, git);
      const want = repo ?? "";
      if (!want || !(here.full === want || here.name === want.slice(want.lastIndexOf("/") + 1))) return null;
    }
    // Newest first, as a runs index is: the entries are in run order (chant#4102), so reversed.
    const runs: RunDoc[] = entries.map((e) => ({ id: e.id, event: e.stage === "plan" ? "pull_request" : "push", trigger: e.stage === "plan" ? "plan" : "merge", commit: e.commit, pull: e.pr, cycle: e.cycle, status: "success", jobs: [], reportKey: e.key })).reverse();
    return { url, runs };
  }

  /**
   * behold#765: the source /api/chant/pr reads a report URL through, when it is the demo's (the URL its records
   * name, or the one serve gave): the runs' own, so the graph's waves read what the runs pane does. Undefined for
   * any other URL (another served checkout's loop), which reads as before.
   */
  reportSource(url: string): TerragucciSource | undefined {
    return this.reportUrls.has(url) ? this.sourceOf(url) : undefined;
  }
}

/**
 * behold#765: `first`'s object at a key, else `then`'s. A read `first` can't make (absent, refused, unreachable)
 * goes to `then`, whose own failure is the caller's. Listing is `then`'s, else `first`'s.
 */
export function besideFirst(first: TerragucciSource, then: TerragucciSource): TerragucciSource {
  const lister = then.list ? then : first.list ? first : null;
  return {
    kind: then.kind,
    location: then.location,
    async read(key) {
      const a = await first.read(key).catch(() => undefined);
      return a !== undefined ? a : then.read(key);
    },
    ...(lister ? { list: (prefix: string, max: number) => lister.list!(prefix, max) } : {}),
  };
}

/** The routes, all GET: the step, the latest cycle, and the runs built from chant's run events. */
export function chantDemoRoutes(app: Hono, demo: ChantDemo): void {
  app.get("/api/chant/demo", async (c) => {
    const a = await demo.readStep();
    return c.json(a, "error" in a ? 502 : 200, { "cache-control": "no-store" });
  });
  app.get("/api/chant/demo/cycle", async (c) => {
    const a = await demo.readCycle();
    return c.json(a, "error" in a ? 502 : "absent" in a ? 404 : 200, { "cache-control": "no-store" });
  });
  const read = (now: Date) => ({ source: demo.source.location, read: now.toISOString() });
  app.get("/api/chant/demo/runs", async (c) => {
    const { entries, repo, url } = await demo.entries();
    const runs = await Promise.all(entries.map((e) => demo.run(e, repo ?? "", url)));
    return c.json({ ...read(new Date()), key: "runs", doc: { schema: "demo.runs/v1", runs: [...runs].reverse().map(indexEntry) } }, 200, { "cache-control": "no-store" });
  });
  app.get("/api/chant/demo/runs/:id", async (c) => {
    const raw = c.req.param("id");
    const id = /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : null;
    if (id === null) return c.json({ error: "a run id is a positive integer", code: "chant-demo" }, 400);
    const { entries, repo, url } = await demo.entries();
    const e = entries.find((x) => x.id === id);
    if (!e) return c.json({ ...read(new Date()), key: `runs/${id}`, doc: null, absent: `Run #${id} is not one of the stages the demo's last cycles named.` }, 404, { "cache-control": "no-store" });
    return c.json({ ...read(new Date()), key: `runs/${id}`, doc: await demo.run(e, repo ?? "", url) }, 200, { "cache-control": "no-store" });
  });
}
