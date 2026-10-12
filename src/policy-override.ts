/**
 * #519: a policy denial is an override card, never an approve button.
 *
 * Since chant#3760 and chant#3831 a run whose plan the policy denies records
 * a pending fact on `_gates/policy-override.jsonl` on `chant/lifecycle`, gate
 * the subject (a terragucci root, a SQL Yodeler migrations Op), with the
 * denied plan (`plan`) and the rules that denied it (`rules`). Its
 * `planDigest` is the override digest. `chant workspace status` lists it as
 * an ordinary gate, but `chant approve policy-override` without `--rule` and
 * `--reason` always fails, so behold draws it as an override: the subject,
 * the rules, the plan digest, and the command a person runs with a reason.
 *
 * An override a run applied under is spent: chant appends a line to
 * `_gates/policy-override/applied.jsonl` (chant's `OVERRIDE_APPLIED`), and
 * such a gate reads as spent, never as waiting.
 *
 * behold only reads these files (`git show`), never writes them. The field
 * names follow chant's `override-gate` module (`OverridePendingRecord`,
 * `AppliedOverrideRecord`); behold pins chant 0.121 until #518, which has no
 * `@intentius/chant/override-gate` export, so the two small readers here stay
 * until it does.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { terragucciConfig } from "./terragucci-repo.ts";

/** chant's `OVERRIDE_OP`. */
export const OVERRIDE_OP = "policy-override";
/** chant's `OVERRIDE_LEDGER`. */
export const OVERRIDE_LEDGER = `_gates/${OVERRIDE_OP}.jsonl`;
/** chant's `OVERRIDE_APPLIED`. */
export const OVERRIDE_APPLIED = `_gates/${OVERRIDE_OP}/applied.jsonl`;
/** SQL Yodeler's config file (sql-yodeler src/config/load.ts `CONFIG_FILE`). */
export const YODEL_CONFIG = "yodel.config.ts";

export type OverrideProduct = "terragucci" | "sql-yodeler" | null;

/** What the card says about one denial. */
export interface PolicyOverride {
  /** The gate's subject: a root, an Op, an Op's revert. */
  subject: string;
  /** The rule ids that denied the plan, sorted. Empty when the ledger could not be read. */
  rules: string[];
  /** The plan digest the policy denied, or null when the ledger could not be read. */
  plan: string | null;
  /** The override digest the denial records (the gate's planDigest). */
  digest: string | null;
  /** `waiting` for a person's override; `overridden` when one counts and no run has applied it; `spent` once a run applied under it. */
  state: "waiting" | "overridden" | "spent";
  /** When the run applied under it, for a spent override. */
  spentAt: string | null;
  product: OverrideProduct;
  /** The command a person runs, with a reason, to override the denial. */
  command: string;
  /** Where the rules and plan were read, or null when they weren't. */
  source: string | null;
}

interface PendingLine {
  gate: string;
  timestamp: string;
  planDigest?: string;
  plan?: string;
  rules?: string[];
}

interface AppliedLine {
  gate: string;
  planDigest: string;
  timestamp: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (isRecord(r)) out.push(r);
    } catch {
      continue;
    }
  }
  return out;
}

/** chant's `sortedRules`: trimmed, each once, sorted. */
export function sortedRules(rules: readonly string[]): string[] {
  return [...new Set(rules.map((r) => r.trim()).filter(Boolean))].sort();
}

/** The newest denial recorded for `subject` on the override ledger, or undefined. */
export function newestDenial(ledger: string, subject: string): PendingLine | undefined {
  let best: PendingLine | undefined;
  for (const r of jsonLines(ledger)) {
    if (r.kind !== "pending" || r.op !== OVERRIDE_OP || r.gate !== subject || typeof r.timestamp !== "string") continue;
    if (best && Date.parse(r.timestamp) < Date.parse(best.timestamp)) continue;
    best = {
      gate: subject,
      timestamp: r.timestamp,
      ...(typeof r.planDigest === "string" ? { planDigest: r.planDigest } : {}),
      ...(typeof r.plan === "string" ? { plan: r.plan } : {}),
      rules: Array.isArray(r.rules) ? sortedRules(r.rules.filter((x): x is string => typeof x === "string")) : [],
    };
  }
  return best;
}

/** The applied lines for `subject` in `_gates/policy-override/applied.jsonl`. */
export function appliedFor(applied: string, subject: string): AppliedLine[] {
  return jsonLines(applied)
    .filter((r) => r.kind === "applied" && r.op === OVERRIDE_OP && r.gate === subject && typeof r.planDigest === "string" && typeof r.timestamp === "string")
    .map((r) => ({ gate: subject, planDigest: r.planDigest as string, timestamp: r.timestamp as string }));
}

const bareDigest = (d: string): string => d.replace(/^[a-z0-9-]+:/i, "");
const sameDigest = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && bareDigest(a) === bareDigest(b);

/** The product whose repo governs `dir`, from its config file in `dir` or above it, up to the git root. */
export function overrideProduct(dir: string): OverrideProduct {
  if (terragucciConfig(dir)) return "terragucci";
  let at = resolve(dir);
  for (;;) {
    if (existsSync(join(at, YODEL_CONFIG))) return "sql-yodeler";
    if (existsSync(join(at, ".git"))) return null;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

const quoteRules = (rules: readonly string[]): string => (rules.length ? rules : ["<id>"]).map((r) => `--rule ${r}`).join(" ");

/**
 * The command that overrides a denial. The product's own when the product is
 * known (it records the denial and the override together, and signs where its
 * approval mode says so), else chant's, bound to the digest with `--plan`.
 */
export function overrideCommand(o: { subject: string; rules: readonly string[]; digest: string | null; env: string | null; signed: boolean; product: OverrideProduct }): string {
  const rules = quoteRules(sortedRules(o.rules));
  if (o.product === "terragucci") return `npx terragucci override ${o.subject} ${rules} --reason "<why>"${o.signed ? " --sign" : ""}`;
  if (o.product === "sql-yodeler") {
    // SQL Yodeler's subject is the migrations Op, or `<op>/revert-<id>`
    // (sql-yodeler src/versioned/policy.ts overrideSubject); its command
    // takes the environment and the revert id instead.
    const revert = /\/revert-(.+)$/.exec(o.subject)?.[1];
    return `npx yodel override ${o.env ?? "<env>"} ${rules} --reason "<why>"${revert ? ` --revert ${revert}` : ""}`;
  }
  return `chant approve ${OVERRIDE_OP} ${o.subject} ${rules} --reason "<why>"${o.digest ? ` --plan ${o.digest}` : ""}${o.signed ? " --sign" : ""}`;
}

/** What status says about a policy-override gate. `approved` means an override counts for its digest. */
export interface OverrideGate {
  gate: string;
  planDigest: string | null;
  env: string | null;
  signed: boolean;
  recordedAt: string | null;
  approved: boolean;
}

/** The override card's facts for one policy-override gate, from the ledger texts (empty when unread). */
export function policyOverride(
  g: OverrideGate,
  texts: { ledger: string; applied: string; source: string | null },
  product: OverrideProduct,
): PolicyOverride {
  const denial = newestDenial(texts.ledger, g.gate);
  // The denial status read is the one it judged; a newer one on the ledger
  // only adds its rules when it names the same digest.
  const matches = denial && (!g.planDigest || sameDigest(denial.planDigest, g.planDigest));
  const rules = matches ? (denial!.rules ?? []) : [];
  const plan = matches ? (denial!.plan ?? null) : null;
  const digest = g.planDigest ?? denial?.planDigest ?? null;
  const since = g.recordedAt ? Date.parse(g.recordedAt) : 0;
  const spent = digest ? appliedFor(texts.applied, g.gate).filter((a) => sameDigest(a.planDigest, digest) && Date.parse(a.timestamp) >= since).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] : undefined;
  return {
    subject: g.gate,
    rules,
    plan,
    digest,
    state: spent ? "spent" : g.approved ? "overridden" : "waiting",
    spentAt: spent?.timestamp ?? null,
    product,
    command: overrideCommand({ subject: g.gate, rules, digest, env: g.env, signed: g.signed, product }),
    source: matches && texts.source ? texts.source : null,
  };
}

/** Reads a file on `chant/lifecycle` in the repo at `dir`, or "" when it is not there. */
export type LifecycleFileReader = (dir: string, path: string) => Promise<{ text: string; ref: string | null }>;

function gitShow(dir: string, spec: string): Promise<string | null> {
  return new Promise((done) => {
    const p = spawn("git", ["show", spec], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.setEncoding("utf-8");
    p.stdout.on("data", (d: string) => (out += d));
    p.on("error", () => done(null));
    p.on("close", (code) => done(code === 0 ? out : null));
  });
}

/** `git show` of the local `chant/lifecycle`, then the remote-tracking one. Read only. */
export const gitLifecycleReader: LifecycleFileReader = async (dir, path) => {
  for (const ref of ["chant/lifecycle", "origin/chant/lifecycle"]) {
    const text = await gitShow(dir, `${ref}:${path}`);
    if (text !== null) return { text, ref };
  }
  return { text: "", ref: null };
};

/** The override card's facts for a policy-override gate in the member at `dir`. */
export async function readPolicyOverride(
  dir: string,
  g: OverrideGate,
  read: LifecycleFileReader = gitLifecycleReader,
): Promise<PolicyOverride> {
  const [ledger, applied] = await Promise.all([read(dir, OVERRIDE_LEDGER), read(dir, OVERRIDE_APPLIED)]);
  return policyOverride(g, { ledger: ledger.text, applied: applied.text, source: ledger.ref ? `${ledger.ref}:${OVERRIDE_LEDGER}` : null }, overrideProduct(dir));
}
