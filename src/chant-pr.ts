/**
 * behold#631: a chant project's pull-request loop, read from chant's own
 * records, so the components view of a repo whose CI runs `chant components
 * pr-plan` and `pr-apply` marks each component and the gate.
 *
 * What is read, and through what:
 *
 * - The loop itself: the generated pipeline (`chant build --components
 *   --generate <forge> --pr-loop`, or one written by hand) under
 *   `.forgejo/workflows/`, `.github/workflows/` or `.gitlab-ci.yml`, for the
 *   lines that run `chant components pr-plan|pr-apply` and their `--env`,
 *   `--gate` and `--output`. The forge is the directory it sits in.
 * - The components and their waves: `chant graph --components` (the graph
 *   route's IR, `groups.byWave`), not this module.
 * - Each stage's report: chant's pull-request report contract
 *   (`pr-report/v1`, `pr-report.schema.json`, PR_REPORT_SCHEMA_ID in chant's
 *   `pr-loop.ts`), where a reader can reach it: `<output>/pr-plan.json` and
 *   `pr-apply.json` in the served checkout, when chant ran there. In CI the
 *   report stays in the job (chant#4007), so the stage's run log stands in:
 *   the summary `pr-plan:` and `pr-apply:` print at the end of the step, a
 *   row per member, the digest and the approve or applied line. That is
 *   printed text, not a contract, and the answer says which one it read.
 * - The gate: its ledger on `chant/lifecycle` (`_gates/<op>.jsonl`), through
 *   chant's `lifecycle/gate-audit` (src/lifecycle-history.ts), for who
 *   approved which digest and when. A report's `approval` stands in when the
 *   ledger cannot be read.
 *
 * - The stage's run events (chant#4007, run-event/v1), when its pipeline
 *   line passes `--report-url <s3://… | file://…>` (chant 0.124.29): the
 *   stage uploads `pr-<stage>.events.jsonl` under `<url>/<pr>/<commit>/` after every
 *   wave, component and run settles. Folded by src/chant-pr-events.ts into
 *   per-wave and per-component state, in the answer's `live`, so an apply
 *   that runs shows each wave and component as it lands. A repo without
 *   events keeps the run log's summary, read at the end of the step.
 *
 * Nothing here writes. Without events, nothing is inferred that the records
 * do not say: an apply that is running shows as running, with no wave or
 * component marked until the summary says how each ended.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { stripAnsi } from "./ansi.ts";
import { composedReportOf, composedView, type ComposedReport, type ComposedView } from "./chant-compose.ts";
import { chantReportKey, eventsFileOf, readPrLive, type PrLive } from "./chant-pr-events.ts";
import { readHistory, historyFromLogs, type HistoryEntry, type HistoryRead } from "./lifecycle-history.ts";
import { realGit, type GitRun } from "./terragucci-lifecycle.ts";
import { readRun, readRunsIndex } from "./terragucci-runs.ts";
import { terragucciSource, type TerragucciSource } from "./terragucci-source.ts";

/** The pull-request report contract chant writes (chant `pr-loop.ts`, PR_REPORT_SCHEMA_ID). */
export const PR_REPORT_SCHEMA = "https://intentius.io/chant/schemas/workspace/pr-report/v1/pr-report.schema.json";
/** chant's default `--output` for the two stages. */
export const PR_OUTPUT_DIR = ".chant/pr";

/** The chant issues behind what this reader cannot see yet. */
export const CHANT_GAPS = {
  report: { issue: "INTENTIUS/chant#4007", url: "https://github.com/INTENTIUS/chant/issues/4007" },
  contracts: { issue: "INTENTIUS/chant#3990", url: "https://github.com/INTENTIUS/chant/issues/3990" },
} as const;

export type PrForge = "forgejo" | "github" | "gitlab";

/** The loop as the repo's pipeline runs it. */
export interface PrLoop {
  forge: PrForge;
  /** The pipeline file, relative to the repo. */
  workflow: string;
  env: string | null;
  gate: string;
  output: string;
  stages: ("plan" | "apply")[];
  /**
   * `--report-url` on a stage's line (chant 0.124.29): where the stage
   * uploads its events and reports. A `$VAR` or `${VAR}` is resolved from
   * the pipeline's own `VAR: value` lines; absent when no line passes it or
   * the variable is set outside the file (`reportUrlAs` then keeps it as written).
   */
  reportUrl?: string;
  reportUrlAs?: string;
  /** A stage's line passes `--events-json`. */
  events?: boolean;
}

const flag = (line: string, name: string): string | null => {
  const m = new RegExp(`--${name}[ =]("[^"]*"|'[^']*'|\\S+)`).exec(line);
  return m ? m[1]!.replace(/^["']|["']$/g, "") : null;
};

/** What a pipeline expression can be filled from: the checkout's own repository, as `owner/name`. */
export interface PipelineContext {
  repository?: string;
}

/**
 * The forge's expressions for the repository a pipeline runs in, filled from
 * the checkout's origin: `${{ github.repository }}` (GitHub, and Forgejo,
 * which accepts the github context), `${{ forgejo.repository }}` /
 * `${{ gitea.repository }}`, and GitLab's `$CI_PROJECT_PATH`. Null when the
 * value still holds an expression it cannot fill.
 */
export function resolveExpressions(value: string, ctx: PipelineContext = {}): string | null {
  let unresolved = false;
  const out = value
    .replace(/\$\{\{\s*([A-Za-z_.]+)\s*\}\}/g, (_m, expr: string) => {
      if (ctx.repository && /^(github|forgejo|gitea)\.repository$/.test(expr)) return ctx.repository;
      unresolved = true;
      return "";
    })
    .replace(/\$\{?CI_PROJECT_PATH\}?/g, () => ctx.repository ?? ((unresolved = true), ""));
  return unresolved ? null : out;
}

/**
 * A flag's value with its `$VAR` / `${VAR}` references filled from the
 * pipeline's own `VAR: value` lines (an `env:` block), and the forge's
 * repository expressions from `ctx` ({@link resolveExpressions}), or null
 * when one is set nowhere in the file (a secret, a repository variable, the
 * runner's).
 */
export function resolveVars(value: string, text: string, ctx: PipelineContext = {}): string | null {
  let unresolved = false;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b)!;
    if (name === "CI_PROJECT_PATH" && ctx.repository) return ctx.repository;
    const m = new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "m").exec(text);
    const raw = m ? m[1]!.replace(/^["']|["']$/g, "") : null;
    const v = raw === null ? null : resolveExpressions(raw, ctx);
    if (!v || v.includes("$")) {
      unresolved = true;
      return "";
    }
    return v;
  });
  if (unresolved) return null;
  return resolveExpressions(out, ctx);
}

/** `owner/name` from the checkout's `origin` remote in `.git/config`, or undefined. */
export function originRepository(dir: string): string | undefined {
  try {
    const cfg = readFileSync(join(dir, ".git", "config"), "utf8");
    const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(cfg);
    if (!m) return undefined;
    const path = m[1]!.replace(/\.git$/, "").replace(/^[a-z+]+:\/\/[^/]+\//, "").replace(/^[^@]+@[^:]+:/, "");
    const parts = path.split("/").filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
  } catch {
    return undefined;
  }
}

/** The loop in one pipeline file's text, or undefined when it runs no `chant components pr-plan|pr-apply`. */
export function prLoopIn(text: string, forge: PrForge, workflow: string, ctx: PipelineContext = {}): PrLoop | undefined {
  const lines = text.split("\n").filter((l) => /\bchant components pr-(plan|apply)\b/.test(l));
  if (!lines.length) return undefined;
  const stages = [...new Set(lines.map((l) => (/pr-plan\b/.test(l) ? "plan" : "apply") as "plan" | "apply"))];
  const first = (name: string) => lines.map((l) => flag(l, name)).find((v) => v && !v.startsWith("$")) ?? null;
  // The apply's line first: it is the one that uploads after every wave.
  const byApply = [...lines].sort((a, b) => Number(/pr-plan\b/.test(a)) - Number(/pr-plan\b/.test(b)));
  const urlAs = byApply.map((l) => flag(l, "report-url")).find((v) => !!v) ?? null;
  const reportUrl = urlAs ? resolveVars(urlAs, text, ctx) : null;
  const events = lines.some((l) => /--events-json\b/.test(l));
  return {
    forge,
    workflow,
    env: first("env"),
    gate: first("gate") ?? "pr-apply",
    output: first("output") ?? PR_OUTPUT_DIR,
    stages,
    ...(reportUrl ? { reportUrl } : {}),
    ...(urlAs && urlAs !== reportUrl ? { reportUrlAs: urlAs } : {}),
    ...(events ? { events } : {}),
  };
}

/** The source a report URL names: `s3://bucket/prefix`, an http(s) address, `file://<path>` or a plain path. */
export function reportSourceOf(url: string, opts: Parameters<typeof terragucciSource>[1] = {}): TerragucciSource {
  return terragucciSource(url.startsWith("file://") ? fileURLToPath(url) : url, opts);
}

/** The repo's pull-request loop: the first pipeline file that runs it. */
export function prLoopOf(dir: string): PrLoop | undefined {
  const repository = originRepository(dir);
  const ctx: PipelineContext = repository ? { repository } : {};
  const dirs: [string, PrForge][] = [
    [".forgejo/workflows", "forgejo"],
    [".gitea/workflows", "forgejo"],
    [".github/workflows", "github"],
  ];
  for (const [d, forge] of dirs) {
    const abs = join(dir, d);
    if (!existsSync(abs)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(abs).filter((n) => /\.ya?ml$/.test(n)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      let text = "";
      try {
        text = readFileSync(join(abs, n), "utf8");
      } catch {
        continue;
      }
      const loop = prLoopIn(text, forge, `${d}/${n}`, ctx);
      if (loop) return loop;
    }
  }
  const gl = join(dir, ".gitlab-ci.yml");
  if (existsSync(gl)) {
    try {
      return prLoopIn(readFileSync(gl, "utf8"), "gitlab", ".gitlab-ci.yml", ctx);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface PrCounts {
  create: number;
  update: number;
  replace: number;
  delete: number;
}

export interface PrMemberRead {
  member: string;
  /** The component whose step planned it; the log names the member alone, so a log read leaves this out. */
  component?: string;
  status: string;
  counts: PrCounts;
  error?: string;
  inputsMoved?: string[];
}

/** One stage as a report or a run log says it ended. */
export interface PrStageRead {
  stage: "plan" | "apply";
  /** `report`: chant's pr-report/v1 document. `log`: the summary the stage printed in its run's log. */
  from: "report" | "log";
  /** The file or run it came from. */
  source: string;
  run?: number;
  pr: number | null;
  head: string | null;
  status: string | null;
  refusal?: string;
  message?: string;
  digest: string | null;
  op: string | null;
  gate: string | null;
  approval?: { status: string; approvedBy?: string[]; approved?: string };
  /** The components in dependency order, a wave per entry; only a report carries it. */
  waves?: string[][];
  members: PrMemberRead[];
  approveCommand?: string;
  /** behold#969: a composed run's parts (src/chant-compose.ts); only a report of a composed run carries it. */
  composed?: ComposedReport;
}

const MEMBER_ROW = /^\s+(\S+)\s+(planned|plan-failed|applied|failed|blocked)\s+create (\d+) update (\d+) replace (\d+) delete (\d+)(?:\s{2}(.*))?$/;

/** A log line as chant printed it: its colours and a `warning: ` prefix taken off. */
const clean = (line: string): string => stripAnsi(line).replace(/\r$/, "").replace(/^warning: /, "");

/**
 * The stages a run's log prints: `pr-plan: <n> member(s), <status>` or
 * `pr-apply: <status> (<refusal>)`, then a row per member, then the digest
 * and the approve line (plan) or the applied line (apply). Chant prints these
 * at the end of the step (chant's handlers/pr.ts), so a stage still running
 * has none. The newest block of each stage wins.
 */
export function prStagesInLog(lines: readonly string[], source: string, run?: number): PrStageRead[] {
  const out: PrStageRead[] = [];
  let cur: PrStageRead | null = null;
  const start = (stage: "plan" | "apply", status: string, refusal?: string): PrStageRead => {
    const s: PrStageRead = { stage, from: "log", source, ...(run !== undefined ? { run } : {}), pr: null, head: null, status, ...(refusal ? { refusal } : {}), digest: null, op: null, gate: null, members: [] };
    out.push(s);
    return s;
  };
  for (const raw of lines) {
    const line = clean(raw);
    let m: RegExpExecArray | null;
    if ((m = /^pr-plan: \d+ member\(s\), (\S+)$/.exec(line))) {
      cur = start("plan", m[1]!);
      continue;
    }
    if ((m = /^pr-apply: (\S+?)(?: \((\S+)\))?$/.exec(line))) {
      cur = start("apply", m[1]!, m[2]);
      continue;
    }
    if (!cur) continue;
    if ((m = MEMBER_ROW.exec(line))) {
      cur.members.push({ member: m[1]!, status: m[2]!, counts: { create: +m[3]!, update: +m[4]!, replace: +m[5]!, delete: +m[6]! }, ...(m[7] ? { error: m[7] } : {}) });
      continue;
    }
    if ((m = /^plan\s+: (\S+)$/.exec(line))) {
      cur.digest = m[1]!;
      continue;
    }
    if ((m = /^approve : (chant approve (\S+) (\S+) --plan (\S+).*)$/.exec(line))) {
      cur.approveCommand = m[1]!;
      cur.op = m[2]!;
      cur.gate = m[3]!;
      cur.digest = cur.digest ?? m[4]!;
      cur.approval = { status: "pending" };
      continue;
    }
    if ((m = /^approved by (.+)$/.exec(line))) {
      cur.approval = { status: "approved", approvedBy: m[1]!.split(", ") };
      continue;
    }
    if ((m = /^applied the plan (\S+) approved by (.+)$/.exec(line))) {
      cur.digest = m[1]!;
      cur.approval = { status: "approved", approvedBy: m[2]!.split(", ") };
      continue;
    }
    if (cur.stage === "apply" && (m = /approved: (\S+?);? planned now: (\S+?)\.?\s/.exec(`${line} `))) {
      cur.digest = m[2]!;
      cur.approval = { status: "changed", approved: m[1]! };
      cur.message = line;
    }
  }
  return out;
}

/** A pr-report/v1 document as a stage read, or undefined when it is not one. */
export function prStageOfReport(doc: unknown, source: string): PrStageRead | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const r = doc as Record<string, unknown>;
  if (r.$schema !== PR_REPORT_SCHEMA || (r.stage !== "plan" && r.stage !== "apply") || !Array.isArray(r.members)) return undefined;
  const sel = r.selection as { waves?: unknown } | undefined;
  const waves = sel && Array.isArray(sel.waves) && sel.waves.every((w) => Array.isArray(w)) ? (sel.waves as string[][]) : undefined;
  return {
    stage: r.stage,
    from: "report",
    source,
    pr: typeof r.pr === "number" ? r.pr : null,
    head: typeof r.head === "string" ? r.head : null,
    status: typeof r.status === "string" ? r.status : null,
    ...(typeof r.refusal === "string" ? { refusal: r.refusal } : {}),
    ...(typeof r.message === "string" ? { message: r.message } : {}),
    digest: typeof r.digest === "string" ? r.digest : null,
    op: typeof r.op === "string" ? r.op : null,
    gate: typeof r.gate === "string" ? r.gate : null,
    ...(r.approval && typeof r.approval === "object" ? { approval: r.approval as PrStageRead["approval"] } : {}),
    ...(waves ? { waves } : {}),
    ...(composedReportOf(r) ? { composed: composedReportOf(r)! } : {}),
    members: (r.members as Record<string, unknown>[]).map((m) => ({
      member: String(m.member),
      ...(typeof m.component === "string" ? { component: m.component } : {}),
      status: String(m.status),
      counts: (m.counts as PrCounts) ?? { create: 0, update: 0, replace: 0, delete: 0 },
      ...(typeof m.error === "string" ? { error: m.error } : {}),
      ...(Array.isArray(m.inputsMoved) ? { inputsMoved: m.inputsMoved as string[] } : {}),
    })),
  };
}

/** A run as the reports bucket holds it (demo.run/v1), the fields read here. */
export interface RunDoc {
  id: number;
  repo?: string;
  event?: string;
  trigger?: string | null;
  commit?: string | null;
  pull?: number | null;
  /** The demo driver's cycle when it started or saw the run (demo.runs/v1), null when it could not place it. */
  cycle?: number | null;
  status: string;
  created_at?: string | null;
  started_at?: string | null;
  jobs: { name: string; status: string; started_at?: string | null; steps?: { name: string; status: string; log: string[] }[] }[];
  /** behold#752: the stage's key under the report URL (`reportKey(pr, commit)`), when the run is a chant demo step's, not a forge run. */
  reportKey?: string;
}

const sameSha = (a?: string | null, b?: string | null): boolean => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/** What the frame's `run` pin asks for: a pull request's plan (`pull-<n>[-<sha>]`), a commit's runs, or nothing. */
export function pinOf(pin: string | null): { pull: number | null; commit: string | null; none: boolean } {
  if (!pin) return { pull: null, commit: null, none: false };
  if (pin === "base" || pin === "none") return { pull: null, commit: null, none: true };
  const m = /^pull(?:-(\d+)(?:-([0-9a-f]{7,40}))?)?$/.exec(pin);
  if (m) return { pull: m[1] ? Number(m[1]) : null, commit: m[2] ?? null, none: false };
  return /^[0-9a-f]{7,40}$/.test(pin) ? { pull: null, commit: pin, none: false } : { pull: null, commit: null, none: true };
}

const isPlanRun = (r: RunDoc): boolean => r.event === "pull_request" || r.trigger === "plan";
const isApplyRun = (r: RunDoc): boolean => r.event === "push" || r.trigger === "merge" || r.trigger === "push";

/** The runs of a cycle the pin names, newest first: the pull request's plan runs, and the merge's apply run. */
export function cycleRunsOf(runs: readonly RunDoc[], pin: ReturnType<typeof pinOf>): { plan: RunDoc | null; apply: RunDoc | null; pull: number | null } {
  if (pin.none) return { plan: null, apply: null, pull: null };
  const byCommit = pin.commit ? runs.find((r) => sameSha(r.commit, pin.commit)) : undefined;
  const pull = pin.pull ?? (byCommit && typeof byCommit.pull === "number" ? byCommit.pull : null) ?? (pin.commit ? null : (runs.find((r) => typeof r.pull === "number")?.pull ?? null));
  if (pull === null && !byCommit) return { plan: null, apply: null, pull: null };
  const ofPull = runs.filter((r) => (pull !== null ? r.pull === pull : r === byCommit));
  // A pull request's plan is the run on its head: the pinned commit's, else the newest.
  const plans = ofPull.filter(isPlanRun);
  const plan = (pin.commit && (!byCommit || isPlanRun(byCommit)) ? plans.find((r) => sameSha(r.commit, pin.commit)) : undefined) ?? plans[0] ?? null;
  // The merge's apply only once the pin is past the plan: on its commit, or with no pin.
  const applies = ofPull.filter(isApplyRun);
  const apply = byCommit && isApplyRun(byCommit) ? byCommit : !pin.commit && !pin.pull ? (applies[0] ?? null) : null;
  return { plan, apply, pull };
}

/** Every line of a run's log, job by job, step by step. */
const runLines = (r: RunDoc): string[] => r.jobs.flatMap((j) => (j.steps ?? []).flatMap((s) => s.log ?? []));

/** The run's job that is still going, if any: chant prints its summary only at the end. */
const going = (r: RunDoc | null) => {
  if (!r) return null;
  const j = r.jobs.find((x) => x.status === "running" || x.status === "queued" || x.status === "waiting");
  return j ? { run: r.id, job: j.name, status: j.status, started_at: j.started_at ?? r.started_at ?? null } : null;
};

/** Where the approval of a digest stands, from the gate ledger (gate-audit's entries) and the reports. */
export interface PrGate {
  op: string;
  gate: string;
  digest: string | null;
  /** `waiting`: no approval of this digest yet. `approved`. `changed`: an approval stands for another digest. `refused`: the apply refused. */
  state: "waiting" | "approved" | "changed" | "refused";
  by?: string;
  at?: string;
  seal?: string;
  ledgerCommit?: string;
  refusal?: string;
  from: "ledger" | "report" | "log";
  approveCommand?: string;
}

const hexOf = (d?: string | null): string => (d ? d.slice(d.lastIndexOf(":") + 1).toLowerCase() : "");
const sameDigest = (a?: string | null, b?: string | null): boolean => !!hexOf(a) && hexOf(a) === hexOf(b);

export function prGate(plan: PrStageRead | null, apply: PrStageRead | null, entries: readonly HistoryEntry[], loop: PrLoop | null, pull: number | null): PrGate | null {
  const s = apply ?? plan;
  const op = s?.op ?? (pull !== null ? `pr-${pull}` : null);
  if (!s || !op) return null;
  const gate = s.gate ?? loop?.gate ?? "pr-apply";
  const digest = s.digest ?? plan?.digest ?? null;
  const base = { op, gate, digest, ...(plan?.approveCommand ? { approveCommand: plan.approveCommand } : {}) };
  if (apply && apply.status === "refused") {
    return { ...base, state: apply.refusal === "plan-changed" ? "changed" : "refused", ...(apply.refusal ? { refusal: apply.refusal } : {}), from: apply.from };
  }
  const approved = entries
    .filter((e) => e.kind === "approved" && e.op === op && e.gate === gate && sameDigest(e.digest, digest))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (approved) {
    return { ...base, state: "approved", ...(approved.actor ? { by: approved.actor } : {}), at: approved.at, ...(approved.seal ? { seal: String(approved.seal) } : {}), ...(approved.source.commit ? { ledgerCommit: approved.source.commit } : {}), from: "ledger" };
  }
  const a = s.approval;
  if (a && a.status === "approved") return { ...base, state: "approved", ...(a.approvedBy?.length ? { by: a.approvedBy.join(", ") } : {}), from: s.from };
  if (a && a.status === "changed") return { ...base, state: "changed", from: s.from };
  return { ...base, state: "waiting", from: s.from };
}

export interface ChantPrAnswer {
  schema: "behold.chant-pr/v1";
  read: string;
  loop: PrLoop | null;
  pull: number | null;
  plan: PrStageRead | null;
  apply: PrStageRead | null;
  /** A stage's job still going: its summary isn't printed yet. */
  running: { stage: "plan" | "apply"; run: number; job: string; status: string; started_at: string | null } | null;
  gate: PrGate | null;
  /** What was read, each named by its chant contract or its source. */
  reads: { what: string; contract: string | null; from: string }[];
  /** What chant does not record yet that the view would draw, with the issue that asks for it. */
  gaps: { what: string; issue: string; url: string }[];
  /**
   * Each stage's run events folded (src/chant-pr-events.ts), when the stage
   * uploaded them under the report URL: per-wave and per-component state
   * while it runs, and after. Null for a repo without events.
   */
  live: ChantPrLive | null;
  /** Whether the stages upload run events (a report URL, the pipeline's or serve's), so a view can say "starting" before the first upload lands. */
  eventsExpected: boolean;
}

export interface ChantPrLive {
  /** Where the events were looked for, and whether that came from the pipeline, serve's `--chant-report-url`, or (behold#752) the demo's step. */
  reportUrl: string;
  via: "pipeline" | "serve" | "step";
  plan: PrLive | null;
  apply: PrLive | null;
  /**
   * What earlier applies of the same cycle applied (the runs index's
   * `cycle`): a fix's apply runs only what the first left, and the rest
   * landed then. Absent when there was no earlier apply in the cycle.
   */
  earlier?: { runs: number[]; applied: string[] };
}

export interface ChantPrDeps {
  /** The reports source's runs (runs/index.json, runs/<id>.json), when serve has one. */
  source?: TerragucciSource;
  history?: (dir: string) => Promise<HistoryRead>;
  git?: GitRun;
  now?: () => Date;
  readFile?: (path: string) => string | undefined;
  /** serve's `--chant-report-url`: where the stages upload their events, over what the pipeline says. */
  reportUrl?: string;
  /** The source a report URL is read through; defaults to {@link reportSourceOf}. */
  reportSource?: (url: string) => TerragucciSource;
  /**
   * behold#752 `--chant-demo`: the stages chant's fan-out demo named, each a run keyed by its report key, and the URL
   * they sit under (src/chant-demo.ts `prReports`). Given, the runs index and the pipeline's `--report-url` are not
   * read: the stages' reports (pr-report/v1) and run events come from the keys, never from forge runs or the workflow file.
   * Null for a checkout that is not the demo's repo, which reads as before.
   */
  demoReports?: (dir: string, git?: GitRun) => Promise<{ url: string; runs: RunDoc[] } | null>;
  /** Component -> the components it depends on, from the components graph, for a blocked component's blocker when chant's events don't name it. */
  dependsOn?: (dir: string) => Record<string, readonly string[]> | undefined;
  /** Component -> its wave in the components graph, for placing a component the run's own waves do not list (a resume's already-applied). */
  componentWaves?: (dir: string) => Record<string, number> | undefined;
}

const readText = (p: string): string | undefined => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

/** The forge's `<owner>/<repo>` for the checkout: its origin's path, else its directory's name (a `.change` view is the same repo). */
export async function repoNameOf(dir: string, git: GitRun = realGit): Promise<{ full: string | null; name: string }> {
  const name = basename(dir).replace(/\.change$/, "");
  const r = await git(["-C", dir, "remote", "get-url", "origin"]);
  const m = r.code === 0 ? /[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(r.stdout.trim()) : null;
  return { full: m ? m[1]! : null, name };
}

const runOfRepo = (r: { repo?: string }, repo: { full: string | null; name: string }): boolean =>
  !r.repo || (repo.full ? r.repo === repo.full : false) || r.repo === repo.name || r.repo.endsWith(`/${repo.name}`);

/** One read of the loop for the checkout `dir` at the pin. Never throws. */
export async function readChantPr(dir: string, pinRaw: string | null, deps: ChantPrDeps = {}): Promise<ChantPrAnswer> {
  const now = (deps.now ?? (() => new Date()))();
  const read = deps.readFile ?? readText;
  const loop = prLoopOf(dir) ?? null;
  const pin = pinOf(pinRaw);
  const reads: ChantPrAnswer["reads"] = [];
  const gaps: ChantPrAnswer["gaps"] = [];
  const answer = (rest: Partial<ChantPrAnswer>): ChantPrAnswer => ({ schema: "behold.chant-pr/v1", read: now.toISOString(), loop, pull: null, plan: null, apply: null, running: null, gate: null, reads, gaps, live: null, eventsExpected: !!(loop && (deps.demoReports || deps.reportUrl || loop.reportUrl)), ...rest });
  if (!loop) return answer({});
  if (loop) reads.push({ what: "the pull-request loop", contract: null, from: loop.workflow });

  // The reports chant wrote in this checkout, when it ran here (pr-report/v1).
  const reports: Record<"plan" | "apply", PrStageRead | undefined> = { plan: undefined, apply: undefined };
  for (const stage of ["plan", "apply"] as const) {
    const rel = `${loop.output.replace(/\/+$/, "")}/pr-${stage}.json`;
    const text = read(join(dir, rel));
    if (!text) continue;
    try {
      const s = prStageOfReport(JSON.parse(text), rel);
      if (s) reports[stage] = s;
    } catch {
      /* not JSON: not a report */
    }
  }

  // The runs the reports bucket holds for this repo, newest first.
  // behold#752: for chant's demo, the stages its steps named instead, each by its report key.
  const demo = deps.demoReports ? await deps.demoReports(dir, deps.git).catch(() => null) : null;
  let runs: RunDoc[] = [];
  if (demo) runs = demo.runs;
  else if (deps.source) {
    const idx = await readRunsIndex(deps.source, now);
    const repo = await repoNameOf(dir, deps.git);
    const listed = idx.doc && Array.isArray((idx.doc as { runs?: unknown }).runs) ? ((idx.doc as { runs: RunDoc[] }).runs) : [];
    runs = listed.filter((r) => runOfRepo(r, repo));
  }
  const cyc = cycleRunsOf(runs, pin);
  const docOf = async (r: RunDoc | null): Promise<RunDoc | null> => {
    if (!r || !deps.source) return null;
    const a = await readRun(deps.source, r.id, now);
    return a.doc ? (a.doc as RunDoc) : null;
  };
  const [planDoc, applyDoc] = await Promise.all([docOf(demo ? null : cyc.plan), docOf(demo ? null : cyc.apply)]);
  // behold#752: a demo stage's report (pr-report/v1) at its key, over a report the checkout holds.
  if (demo) {
    const src = demoSource(deps, demo.url);
    await Promise.all(
      (["plan", "apply"] as const).map(async (stage) => {
        const r = stage === "plan" ? cyc.plan : cyc.apply;
        if (!src || !r?.reportKey) return;
        const key = `${r.reportKey}/pr-${stage}.json`;
        try {
          const text = await src.read(key);
          const s = text ? prStageOfReport(JSON.parse(text), `${src.location.replace(/\/+$/, "")}/${key}`) : undefined;
          if (s) reports[stage] = s;
        } catch {
          /* not there yet, refused, or not JSON: the stage has no report yet */
        }
      }),
    );
  }
  const fromLog = (doc: RunDoc | null, stage: "plan" | "apply"): PrStageRead | null => {
    if (!doc) return null;
    const found = prStagesInLog(runLines(doc), `run #${doc.id}`, doc.id).filter((s) => s.stage === stage);
    const s = found[found.length - 1];
    if (!s) return null;
    s.pr = typeof doc.pull === "number" ? doc.pull : null;
    s.head = doc.commit ?? null;
    return s;
  };
  const fits = (s: PrStageRead | undefined, run: RunDoc | null): s is PrStageRead =>
    !!s && (!pin.commit && !pin.pull ? true : run ? sameSha(s.head, run.commit) : pin.commit ? sameSha(s.head, pin.commit) : s.pr === pin.pull);
  const plan = fits(reports.plan, cyc.plan) ? reports.plan : fromLog(planDoc, "plan");
  const apply = fits(reports.apply, cyc.apply) ? reports.apply : fromLog(applyDoc, "apply");
  for (const s of [plan, apply]) {
    if (!s) continue;
    reads.push(
      s.from === "report"
        ? { what: `chant components pr-${s.stage}'s report`, contract: "pr-report/v1", from: s.source }
        : { what: `chant components pr-${s.stage}'s summary in its run's log`, contract: null, from: s.source },
    );
  }
  if ((plan && plan.from === "log") || (apply && apply.from === "log")) {
    gaps.push({ what: "the pull-request report a reader can fetch", ...CHANT_GAPS.report });
  }
  const run = (applyDoc && going(applyDoc) && { stage: "apply" as const, ...going(applyDoc)! }) || (!apply && planDoc && going(planDoc) && { stage: "plan" as const, ...going(planDoc)! }) || null;

  // The stages' run events, under the report URL at the cycle's pull request and each run's commit.
  // The cycle's earlier applies, oldest first: the runs the index places in the same cycle, before this one.
  const cycleOf = (cyc.apply ?? cyc.plan)?.cycle;
  const earlierRuns =
    typeof cycleOf === "number"
      ? runs.filter((r) => isApplyRun(r) && r.cycle === cycleOf && r !== cyc.apply && (!cyc.apply || r.id < cyc.apply.id) && !!r.commit).sort((a, b) => a.id - b.id).slice(-3)
      : [];
  const live = await readLive(dir, loop, deps, cyc.pull ?? pin.pull, cyc.plan, cyc.apply, earlierRuns, demo?.url);
  for (const l of [live?.plan, live?.apply]) if (l) reads.push({ what: `chant components pr-${l.stage}'s run events`, contract: "run-event/v1", from: l.source });
  if (run && run.stage === "apply" && !live?.apply) gaps.push({ what: "progress per wave and component while the apply runs", ...CHANT_GAPS.report });

  // The gate's ledger, through chant's gate-audit.
  let entries: HistoryEntry[] = [];
  if (plan || apply) {
    try {
      const h = await (deps.history ?? ((d) => readHistory(d, deps.git ? { git: deps.git } : {})))(dir);
      if (h.found) {
        entries = historyFromLogs(h.logs).entries;
        reads.push({ what: "the gate's ledger", contract: "chant lifecycle/gate-audit", from: `chant/lifecycle ${h.via === "fetch" ? "fetched" : "checkout ref"}` });
      }
    } catch {
      /* the gate falls back to the report's approval */
    }
  }
  const pull = plan?.pr ?? apply?.pr ?? cyc.pull ?? pin.pull ?? null;
  return answer({ pull, plan, apply, running: run, gate: prGate(plan, apply, entries, loop, pull), live });
}

/**
 * Each stage's `pr-<stage>.events.jsonl` under the report URL (serve's
 * override, else the pipeline's `--report-url`), at `<pr>/<commit>/` of the
 * stage's run, `<pr>` being `unknown` when the cycle has none (chant#4083).
 * Null when there is no URL or neither stage uploaded any. Never throws.
 */
async function readLive(dir: string, loop: PrLoop, deps: ChantPrDeps, pull: number | null, plan: RunDoc | null, apply: RunDoc | null, earlierRuns: readonly RunDoc[] = [], demoUrl?: string): Promise<ChantPrLive | null> {
  // behold#752: a demo's stages are read under the URL its step names, never the workflow file's.
  const url = demoUrl ?? deps.reportUrl ?? loop.reportUrl;
  if (!url) return null;
  let src: TerragucciSource;
  try {
    src = (deps.reportSource ?? ((u: string) => reportSourceOf(u)))(url);
  } catch {
    return null;
  }
  const safely = <T,>(f: () => T): T | undefined => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  const dependsOn = safely(() => deps.dependsOn?.(dir));
  const componentWaves = safely(() => deps.componentWaves?.(dir));
  const one = async (stage: "plan" | "apply", r: RunDoc | null, prOf: number | null = pull): Promise<PrLive | null> => {
    const commit = r?.commit;
    if (!commit) return null;
    try {
      const key = r?.reportKey ? `${r.reportKey}/${eventsFileOf(stage)}` : await eventsKey(src, prOf, commit, eventsFileOf(stage));
      const text = await src.read(key);
      return readPrLive(text, { stage, source: `${src.location.replace(/\/+$/, "")}/${key}`, ...(dependsOn ? { dependsOn } : {}), ...(componentWaves ? { componentWaves } : {}) });
    } catch {
      return null;
    }
  };
  const [p, a, ...before] = await Promise.all([one("plan", plan), one("apply", apply), ...earlierRuns.map((r) => one("apply", r, typeof r.pull === "number" ? r.pull : null))]);
  const landed = new Set<string>();
  const from: number[] = [];
  before.forEach((l, i) => {
    if (!l) return;
    from.push(earlierRuns[i]!.id);
    for (const c of Object.values(l.components)) if (c.state === "applied" || c.state === "already-applied") landed.add(c.component);
  });
  if (!p && !a && !landed.size) return null;
  return { reportUrl: url, via: demoUrl ? "step" : deps.reportUrl ? "serve" : "pipeline", plan: p, apply: a, ...(landed.size ? { earlier: { runs: from, applied: [...landed].sort() } } : {}) };
}

/** behold#752: the source a demo's report URL is read through, or undefined when it can't be made. */
function demoSource(deps: ChantPrDeps, url: string): TerragucciSource | undefined {
  try {
    return (deps.reportSource ?? ((u: string) => reportSourceOf(u)))(url);
  } catch {
    return undefined;
  }
}

/**
 * The events' key for the pull request at `commit`: the full commit's,
 * else, when the run named a shortened commit and the source can list, the
 * one commit directory under `<pr>/` it starts.
 */
async function eventsKey(src: TerragucciSource, pull: number | null, commit: string, file: string): Promise<string> {
  if (commit.length >= 40 || !src.list) return chantReportKey(pull, commit, file);
  try {
    const l = await src.list(pull === null ? "unknown" : `${pull}`, 200);
    const hit = l.prefixes.map((p) => p.replace(/\/+$/, "").split("/").pop() ?? "").find((c) => sameSha(c, commit));
    return chantReportKey(pull, hit ?? commit, file);
  } catch {
    return chantReportKey(pull, commit, file);
  }
}

/** `GET /api/chant/pr?pin=<run pin>`: the served chant project's pull-request loop at the pin. Read-only. */
export function chantPrRoute(app: Hono, dir: () => string, deps: ChantPrDeps = {}): void {
  const cache = new Map<string, { at: number; read: Promise<ChantPrAnswer> }>();
  app.get("/api/chant/pr", async (c) => {
    const q = new URL(c.req.url).searchParams;
    const pin = q.get("pin");
    const d = dir();
    const key = `${d}|${pin ?? ""}`;
    const t = Date.now();
    const hit = cache.get(key);
    const r = hit && t - hit.at < 2_000 && q.get("fresh") !== "1" ? hit.read : readChantPr(d, pin, deps);
    if (r !== hit?.read) {
      cache.set(key, { at: t, read: r });
      r.catch(() => cache.delete(key));
    }
    // The composed run's parts are for /api/terragucci below, not for this answer.
    const a = await r;
    const bare = (s: PrStageRead | null): PrStageRead | null => {
      if (!s?.composed) return s;
      const { composed: _, ...rest } = s;
      return rest;
    };
    return c.json({ ...a, plan: bare(a.plan), apply: bare(a.apply) }, 200, { "cache-control": "no-store" });
  });
  // behold#969: a chant demo whose run is composed is read by the kiosk's ask mode like a composed estate run. Any other
  // chant demo (the fan-out) has no such read here, as before.
  if (deps.demoReports) {
    const composed = async (c: Context): Promise<ComposedView | null> => {
      const a = await readChantPr(dir(), new URL(c.req.url).searchParams.get("pin"), deps);
      return composedView(a.plan?.composed, a.apply?.composed);
    };
    app.get("/api/terragucci", async (c, next) => {
      const v = await composed(c);
      if (!v) return next();
      return c.json(v.answer, 200, { "cache-control": "no-store" });
    });
    app.get("/api/terragucci/progress", async (c, next) => {
      const v = await composed(c);
      if (!v) return next();
      return c.json(v.progress ?? { run: null, states: [], reads: [], waves: [], cards: {}, unmatched: [], watching: false }, 200, { "cache-control": "no-store" });
    });
  }
}

/** What the components view draws a loop's wave boxes and marks from: the loop, the tools, each component's wave, each member's component. */
export interface ChantPrFacets {
  forge: PrForge;
  workflow: string;
  env: string | null;
  gate: string;
  tools: string[];
  waves: Record<string, number>;
  members: Record<string, string>;
  /** Component -> the components it depends on (the graph's `dependsOn` edges), for naming a blocked component's blocker. */
  needs: Record<string, string[]>;
}

/**
 * The facets for a components graph of `dir` (`chant graph --components`'s
 * IR: `groups.byWave`, and each component's `attrs.liveNames`, the members
 * its steps deploy). Undefined when the repo runs no pull-request loop.
 */
export function chantPrFacets(dir: string, ir: { nodes: readonly { id: string; attrs?: Record<string, unknown> }[]; edges?: readonly { from: string; to: string }[]; groups?: object }, engine?: string): ChantPrFacets | undefined {
  const loop = prLoopOf(dir);
  if (!loop) return undefined;
  const waves: Record<string, number> = {};
  const byWave = ((ir.groups as { byWave?: Record<string, string[]> } | undefined)?.byWave ?? {});
  for (const [k, ids] of Object.entries(byWave)) {
    const m = /^wave-(\d+)$/.exec(k);
    if (m && Array.isArray(ids)) for (const id of ids) waves[id] = Number(m[1]);
  }
  for (const n of ir.nodes) if (waves[n.id] === undefined && typeof n.attrs?.wave === "number") waves[n.id] = n.attrs.wave as number;
  const members: Record<string, string> = {};
  for (const n of ir.nodes) {
    const names = Array.isArray(n.attrs?.liveNames) ? (n.attrs!.liveNames as unknown[]).filter((x): x is string => typeof x === "string") : [];
    for (const name of names.length ? names : [n.id]) members[name] = n.id;
  }
  // Consumer -> producer, between components.
  const ids = new Set(ir.nodes.map((n) => n.id));
  const needs: Record<string, string[]> = {};
  for (const e of ir.edges ?? []) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    const list = (needs[e.from] ??= []);
    if (!list.includes(e.to)) list.push(e.to);
  }
  return { forge: loop.forge, workflow: loop.workflow, env: loop.env, gate: loop.gate, tools: ["chant", ...(engine ? [engine] : [])], waves, members, needs };
}
