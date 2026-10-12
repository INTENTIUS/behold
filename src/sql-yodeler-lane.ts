/**
 * #524: a SQL Yodeler repo's lifecycle lane, read from `chant/lifecycle` with
 * the product-neutral reader of #520 and #521 (`readLifecycle` with a spec).
 *
 * SQL Yodeler writes two kinds of gate there (sql-yodeler src/waves/index.ts,
 * src/versioned/op.ts):
 *
 * - `_gates/yodel-apply.jsonl`: the apply pipeline's environment waves, gates
 *   `yodel-apply-wave-<k>`, chant op waves with spent approvals. Read with
 *   `opWavesLane("yodel-apply")`.
 * - `_gates/migrate-<env>.jsonl`: one op per environment with one plan-bound
 *   gate, `approve-migrate-<env>`. These are not waves, so each op gets a spec
 *   of its own whose `waveOf` takes only that gate.
 *
 * Environments and their order come from `yodel-waves.json` (one wave per
 * environment) and the checkout's `ops/migrate-<env>.op.ts` files. A waiting
 * gate shows `npx yodel approve <env> --plan <digest>`, which approves either
 * kind; behold never runs it. Nothing here writes: the reads share one fetch
 * into behold's own cache, as the terragucci lane's do.
 *
 * #537: a project that is a chant workspace member keeps all of these under
 * `_members/<member>/` on the branch (chant's `resolveMemberLedger`, see
 * src/member-ledger.ts), and its `yodel-waves.json` at base is read in its
 * own directory. When the waves name different approval modes, each wave is
 * decided under its own. Under `pr-review` the heads a pull request's
 * pipeline recorded plans for (`_wave-plans/yodel-apply/<head>.json`) are
 * matched to a waiting wave's digest.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { headPlansPath } from "@intentius/chant/lifecycle/wave-plans";
import type { Hono } from "hono";
import {
  chantApprovalMode,
  opWavesLane,
  readLifecycle,
  realGit,
  waveOfGate,
  type ApprovalRule,
  type GateApprovalSource,
  type GateEntry,
  type GateLaneSpec,
  type GitRun,
  type LifecycleAnswer,
  type LifecycleOptions,
} from "./terragucci-lifecycle.ts";
import { WAVES_SPEC_FILE } from "./lifecycle-releases.ts";
import { memberNote, projectLedger, type ProjectLedger } from "./member-ledger.ts";

/** The apply pipeline's op (sql-yodeler src/waves/record.ts WAVES_PIPELINE). */
export const YODEL_APPLY_OP = "yodel-apply";

/** Where the pull request job records each head's plans (chant's `headPlansPath(YODEL_APPLY_OP, head)`). */
export const YODEL_HEAD_PLANS_DIR = headPlansPath(YODEL_APPLY_OP, "").dir;

/** One wave of `yodel-waves.json`, the parts read here. */
export interface YodelWave {
  /** 1-based, in the spec's order: the `k` of `yodel-apply-wave-<k>`. */
  k: number;
  /** The environment the wave applies (sql-yodeler names a wave after it). */
  env: string;
  /** Its targets: the environment, or each tenant of it. */
  targets: string[];
  /** The migrations op each target runs. */
  ops: string[];
  /** The gate policy (`always`, `on-destructive`, `never`), when the spec names one. */
  gate?: string;
  /** The approval mode, when the spec names one other than ledger. */
  approval?: GateApprovalSource;
}

/** `yodel-waves.json` read for the lane: its waves in order, or why it could not be read. */
export interface YodelWaves {
  path: string;
  waves: YodelWave[];
  error?: string;
}

/** The waves `text` (a `yodel-waves.json`) declares, in order. Pure. */
export function parseYodelWaves(text: string, path = WAVES_SPEC_FILE): YodelWaves {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { path, waves: [], error: `${path} is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const raw = doc && typeof doc === "object" && Array.isArray((doc as { waves?: unknown }).waves) ? ((doc as { waves: unknown[] }).waves) : undefined;
  if (!raw) return { path, waves: [], error: `${path} has no waves list` };
  const waves: YodelWave[] = [];
  raw.forEach((w, i) => {
    const x = (w && typeof w === "object" ? w : {}) as { name?: unknown; runs?: unknown; gate?: unknown; approval?: unknown };
    if (typeof x.name !== "string" || !x.name) return;
    const runs = Array.isArray(x.runs) ? (x.runs as Array<{ target?: unknown; op?: unknown }>) : [];
    const targets = runs.map((r) => r?.target).filter((t): t is string => typeof t === "string");
    const ops = [...new Set(runs.map((r) => r?.op).filter((o): o is string => typeof o === "string"))];
    waves.push({
      k: i + 1,
      env: x.name,
      targets: targets.length ? targets : [x.name],
      ops: ops.length ? ops : [`migrate-${x.name}`],
      ...(typeof x.gate === "string" ? { gate: x.gate } : {}),
      // chant reads a mode it does not know as sealed, the strictest (op-waves-run's rule at base).
      ...(x.approval === "ledger" || x.approval === "pr-review" || x.approval === "sealed" ? { approval: x.approval } : x.approval !== undefined ? { approval: "sealed" as const } : {}),
    });
  });
  return { path, waves };
}

/** The checkout's `yodel-waves.json`, or undefined when it has none. */
export function readYodelWaves(checkout: string): YodelWaves | undefined {
  const p = join(checkout, WAVES_SPEC_FILE);
  if (!existsSync(p)) return undefined;
  try {
    return parseYodelWaves(readFileSync(p, "utf8"));
  } catch (e) {
    return { path: WAVES_SPEC_FILE, waves: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** The environments `ops/migrate-<env>.op.ts` names in the checkout, sorted. */
export function migrateOpEnvironments(checkout: string): string[] {
  const dir = join(checkout, "ops");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((f) => /^migrate-(.+)\.op\.ts$/.exec(f)?.[1])
      .filter((e): e is string => !!e)
      .sort();
  } catch {
    return [];
  }
}

/** SQL Yodeler's approve line (sql-yodeler src/approval-mode approveCommand), run through npx: `--sign` under sealed. */
export function yodelApproveCommand(env: string, digest: string | undefined, mode: GateApprovalSource = "ledger"): string {
  return `npx yodel approve ${env}${digest ? ` --plan ${digest}` : ""}${mode === "sealed" ? " --sign" : ""}`;
}

/**
 * The mode at base for the apply pipeline, from `yodel-waves.json` at base
 * (in the project's directory `dir` of its repository). When every wave names
 * the same approval, that is the lane's mode. When they differ (#537), the
 * lane's mode is chant's own rule and each wave is decided under its own: a
 * wave's `approval`, else chant's rule. `yodel.config.ts` is TypeScript,
 * which behold does not run.
 */
export function yodelApprovalMode(dir = ""): (show: (path: string) => Promise<string | undefined>, identityGates: number) => Promise<Omit<ApprovalRule, "base" | "signers">> {
  return async (show, identityGates) => {
    const path = `${dir}${WAVES_SPEC_FILE}`;
    const text = await show(path);
    const chant = await chantApprovalMode(show, identityGates);
    if (text === undefined) return chant;
    const spec = parseYodelWaves(text, path);
    if (spec.error || !spec.waves.length) return { ...chant, note: `${path} at base could not be read: ${spec.error ?? "no waves"}` };
    const modes = new Set(spec.waves.map((w) => w.approval ?? "ledger"));
    if (modes.size === 1) {
      const mode = [...modes][0]!;
      // ledger in the spec is the absence of a key: chant's identity.gates may still seal it.
      if (mode === "ledger") return chant;
      return { mode, source: `approval: ${mode} on every wave in ${path} at base` };
    }
    return {
      ...chant,
      source: `each wave's approval in ${path} at base; a wave that names none takes ${chant.source}`,
      waves: spec.waves.map((w) => ({ wave: w.k, name: w.env, mode: w.approval ?? chant.mode })),
    };
  };
}

/** The lane for the apply pipeline's waves: `yodel-apply-wave-<k>`, approved with `npx yodel approve <env>`. */
export function yodelApplyLane(waves: readonly YodelWave[], ledger: Pick<ProjectLedger, "prefix" | "dir"> = { prefix: "", dir: "" }): GateLaneSpec {
  const envOf = (k: number | undefined): string | undefined => (k === undefined ? undefined : waves.find((w) => w.k === k)?.env);
  return opWavesLane(YODEL_APPLY_OP, {
    approveCommand: (gate, digest, mode, at) => {
      const env = envOf(at?.wave ?? waveOfGate(gate));
      return env ? yodelApproveCommand(env, digest, mode) : `chant approve ${at?.op ?? YODEL_APPLY_OP} ${gate}${digest ? ` --plan ${digest}` : ""}${mode === "sealed" ? " --sign" : ""}`;
    },
    approvalMode: yodelApprovalMode(ledger.dir),
    headPlans: YODEL_APPLY_OP,
    ...(ledger.prefix ? { ledgerPrefix: ledger.prefix } : {}),
  });
}

/** The lane for one environment's migrations op: its one gate `approve-migrate-<env>`, drawn as wave 1 of that op. */
export function migrateOpLane(env: string, ledgerPrefix = ""): GateLaneSpec {
  const gate = `approve-migrate-${env}`;
  return opWavesLane(`migrate-${env}`, {
    waveOf: (g) => (g === gate ? 1 : undefined),
    gateOf: () => gate,
    approveCommand: (_g, digest, mode) => yodelApproveCommand(env, digest, mode),
    ...(ledgerPrefix ? { ledgerPrefix } : {}),
  });
}

/** One gate in the SQL Yodeler lane: a wave of the apply pipeline, or an environment's migrations op. */
export type YodelGate = GateEntry & { kind: "wave" | "migrate" };

/** One environment's row: its wave in `yodel-waves.json` when it has one, and its gates. */
export interface YodelEnvironment {
  env: string;
  wave?: { k: number; targets: string[]; gate?: string; approval?: GateApprovalSource };
  gates: YodelGate[];
}

export interface SqlYodelerLaneAnswer extends Omit<LifecycleAnswer, "gates" | "locks"> {
  product: "sql-yodeler";
  /** Where the environments' order came from. */
  order: { source: "yodel-waves.json" | "ops" | "ledger"; error?: string };
  /** In the order of applies: the waves first, then any environment only an op or a ledger names. */
  environments: YodelEnvironment[];
  /** Waves on the ledger that `yodel-waves.json` does not name. */
  unplaced: YodelGate[];
  /** Set when the project is a workspace member (its records under `_members/<member>/`), or chant could not place it. */
  member?: { members: string[]; prefix: string; error?: string };
}

/** One git run per distinct argument list in a read: the several specs share one fetch and one set of reads. */
export function onceGit(git: GitRun): GitRun {
  const seen = new Map<string, ReturnType<GitRun>>();
  return (args, o) => {
    const key = JSON.stringify(args);
    let p = seen.get(key);
    if (!p) {
      p = git(args, o);
      seen.set(key, p);
    }
    return p;
  };
}

/** Assemble the answer from each spec's read. Pure. */
export function sqlYodelerLane(
  apply: LifecycleAnswer,
  migrate: ReadonlyArray<{ env: string; answer: LifecycleAnswer }>,
  waves: YodelWaves | undefined,
  opEnvs: readonly string[],
): SqlYodelerLaneAnswer {
  const { gates: applyGates, locks: _l, ...head } = apply;
  const rows = new Map<string, YodelEnvironment>();
  const row = (env: string): YodelEnvironment => {
    let r = rows.get(env);
    if (!r) rows.set(env, (r = { env, gates: [] }));
    return r;
  };
  for (const w of waves?.waves ?? []) row(w.env).wave = { k: w.k, targets: w.targets, ...(w.gate ? { gate: w.gate } : {}), ...(w.approval ? { approval: w.approval } : {}) };
  for (const e of opEnvs) row(e);
  const unplaced: YodelGate[] = [];
  for (const g of applyGates) {
    const w = waves?.waves.find((x) => x.k === g.wave);
    if (w) row(w.env).gates.push({ ...g, kind: "wave" });
    else unplaced.push({ ...g, kind: "wave" });
  }
  for (const { env, answer } of migrate) for (const g of answer.gates) row(env).gates.push({ ...g, kind: "migrate" });
  const source = waves?.waves.length ? "yodel-waves.json" : opEnvs.length ? "ops" : "ledger";
  return {
    ...head,
    product: "sql-yodeler",
    order: { source, ...(waves?.error ? { error: waves.error } : {}) },
    environments: [...rows.values()],
    unplaced,
  };
}

/**
 * Read the lane for the SQL Yodeler checkout at `checkout`. The environments
 * whose migrations op the lane reads are those `ops/` and `yodel-waves.json`
 * name. Never throws for a git failure; the answer says what happened.
 */
export async function readSqlYodelerLane(checkout: string, opts: Omit<LifecycleOptions, "spec"> = {}): Promise<SqlYodelerLaneAnswer> {
  const git = onceGit(opts.git ?? realGit);
  const waves = readYodelWaves(checkout);
  const opEnvs = migrateOpEnvironments(checkout);
  const envs = [...new Set([...(waves?.waves ?? []).flatMap((w) => w.ops.map((o) => o.replace(/^migrate-/, ""))), ...opEnvs])];
  const o = { ...opts, git };
  const ledger = await projectLedger(checkout, git);
  const apply = await readLifecycle(checkout, { ...o, spec: yodelApplyLane(waves?.waves ?? [], ledger) });
  const migrate: { env: string; answer: LifecycleAnswer }[] = [];
  for (const env of envs) migrate.push({ env, answer: await readLifecycle(checkout, { ...o, spec: migrateOpLane(env, ledger.prefix) }) });
  const lane = sqlYodelerLane(apply, migrate, waves, opEnvs);
  if (!ledger.members.length && !ledger.error) return lane;
  return { ...lane, member: { members: ledger.members, prefix: ledger.prefix, ...(ledger.error ? { error: ledger.error } : {}) }, note: `${lane.note} ${memberNote(ledger)}` };
}

/** How long a read is reused by the route. */
export const SQL_YODELER_LANE_TTL_MS = 30_000;

/**
 * `GET /api/sql-yodeler/lifecycle[?fresh=1]`. `checkout()` names the SQL
 * Yodeler checkout per request, or undefined when the served directory is
 * not one (404, `code: "sql-yodeler"`).
 */
export function sqlYodelerLaneRoute(app: Hono, checkout: () => string | undefined, opts: Omit<LifecycleOptions, "spec"> = {}): void {
  let cached: { at: number; dir: string; read: Promise<SqlYodelerLaneAnswer> } | undefined;
  app.get("/api/sql-yodeler/lifecycle", async (c) => {
    const dir = checkout();
    if (!dir) return c.json({ error: "the served directory is not a SQL Yodeler project (no yodel.config.ts)", code: "sql-yodeler", remedy: "serve a directory with a yodel.config.ts" }, 404);
    const fresh = new URL(c.req.url).searchParams.get("fresh") === "1";
    if (fresh || !cached || cached.dir !== dir || Date.now() - cached.at > SQL_YODELER_LANE_TTL_MS) {
      const read = readSqlYodelerLane(dir, opts);
      cached = { at: Date.now(), dir, read };
      read.catch(() => (cached = undefined));
    }
    return c.json(await cached.read);
  });
}
