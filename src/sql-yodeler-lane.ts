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
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** The apply pipeline's op (sql-yodeler src/waves/record.ts WAVES_PIPELINE). */
export const YODEL_APPLY_OP = "yodel-apply";

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
      ...(x.approval === "ledger" || x.approval === "pr-review" || x.approval === "sealed" ? { approval: x.approval } : {}),
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
 * The mode at base for the apply pipeline: `yodel-waves.json` at base, when
 * every wave there names the same approval; with waves that differ, chant's
 * own rule, and a note naming each wave's. `yodel.config.ts` is TypeScript,
 * which behold does not run.
 */
export async function yodelApprovalMode(show: (path: string) => Promise<string | undefined>, identityGates: number): Promise<Omit<ApprovalRule, "base" | "signers">> {
  const text = await show(WAVES_SPEC_FILE);
  const chant = await chantApprovalMode(show, identityGates);
  if (text === undefined) return chant;
  const spec = parseYodelWaves(text);
  if (spec.error || !spec.waves.length) return { ...chant, note: `${WAVES_SPEC_FILE} at base could not be read: ${spec.error ?? "no waves"}` };
  const modes = new Set(spec.waves.map((w) => w.approval ?? "ledger"));
  if (modes.size === 1) {
    const mode = [...modes][0]!;
    // ledger in the spec is the absence of a key: chant's identity.gates may still seal it.
    if (mode === "ledger") return chant;
    return { mode, source: `approval: ${mode} on every wave in ${WAVES_SPEC_FILE} at base` };
  }
  return { ...chant, note: `the waves in ${WAVES_SPEC_FILE} at base differ in approval (${spec.waves.map((w) => `${w.env}: ${w.approval ?? "ledger"}`).join(", ")}); each wave's line is decided under ${chant.mode}` };
}

/** The lane for the apply pipeline's waves: `yodel-apply-wave-<k>`, approved with `npx yodel approve <env>`. */
export function yodelApplyLane(waves: readonly YodelWave[]): GateLaneSpec {
  const envOf = (k: number | undefined): string | undefined => (k === undefined ? undefined : waves.find((w) => w.k === k)?.env);
  return opWavesLane(YODEL_APPLY_OP, {
    approveCommand: (gate, digest, mode, at) => {
      const env = envOf(at?.wave ?? waveOfGate(gate));
      return env ? yodelApproveCommand(env, digest, mode) : `chant approve ${at?.op ?? YODEL_APPLY_OP} ${gate}${digest ? ` --plan ${digest}` : ""}${mode === "sealed" ? " --sign" : ""}`;
    },
    approvalMode: yodelApprovalMode,
  });
}

/** The lane for one environment's migrations op: its one gate `approve-migrate-<env>`, drawn as wave 1 of that op. */
export function migrateOpLane(env: string): GateLaneSpec {
  const gate = `approve-migrate-${env}`;
  return opWavesLane(`migrate-${env}`, {
    waveOf: (g) => (g === gate ? 1 : undefined),
    gateOf: () => gate,
    approveCommand: (_g, digest, mode) => yodelApproveCommand(env, digest, mode),
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
  const apply = await readLifecycle(checkout, { ...o, spec: yodelApplyLane(waves?.waves ?? []) });
  const migrate: { env: string; answer: LifecycleAnswer }[] = [];
  for (const env of envs) migrate.push({ env, answer: await readLifecycle(checkout, { ...o, spec: migrateOpLane(env) }) });
  return sqlYodelerLane(apply, migrate, waves, opEnvs);
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
