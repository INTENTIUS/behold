/**
 * behold#1010: a member run card's local applies, from chant's Op run ledger.
 *
 * The member run card (#997, src/component-releases.ts `withMemberApplies`)
 * takes a choudoufu or terraform member's last apply from chant's CI run
 * index. A TerraformApplyOp run on this machine (`chant run`) is in no run
 * index: it is recorded in the Op run ledger of the member that declares the
 * Op, which is often a chant member, while the root it applied sits in the
 * choudoufu or terraform member's directory. chant#4482 names that member on
 * each run, `root_member`, and `chant ledger runs --where root_member=<member>
 * --json` lists them (the read contract's "Op runs per member"). This module
 * reads that document and puts the runs on the member's card.
 *
 * Two guards, both needed while chant's release is not cut (src/chant-release.ts):
 *
 *  - the floor, {@link LEDGER_ROOT_MEMBER_CHANT_FLOOR} (src/chant-floors.ts,
 *    chant's `LEDGER_ROOT_MEMBER_FLOOR`): below it the read is not sent, since
 *    an older chant refuses `--where root_member=...` as an unknown field;
 *  - a feature-detect on the document: a `runs` table whose `columns` lack
 *    `root_member` is read as "this chant does not say", never as "no runs".
 *
 * `root_member` null means unknown (chant#4508): the run's Init step did not
 * finish, so chant never learned which directory the root was in, or an older
 * chant wrote the row. Such a run is never taken as any member's apply, the
 * declaring member's included. It is shown as an apply of an unknown root,
 * with `labels.TerraformRoot` beside it, read with `chant ledger runs --where
 * labels.Apply=true --json`.
 */
import type { GraphIR } from "@intentius/chant";
import { MEMBER_RUNS_LEXICON } from "./component-releases.ts";

/** The attr a member card carries its local applies under, newest first. */
export const LOCAL_APPLIES = "_localApplies";
/** How many local applies a card keeps. */
export const LOCAL_APPLIES_SHOWN = 5;

/** One TerraformApplyOp run from the Op run ledger, as the card shows it. */
export interface LocalApply {
  runId: string;
  op: string;
  /** The member whose ledger holds the run: the one that declares the Op. */
  declaredBy: string | null;
  env: string | null;
  status: string;
  started: string | null;
  ended: string | null;
  gitSha: string | null;
  forge: string | null;
  /** Present only when the row's `run_url` is an absolute http(s) URL. */
  url?: string;
  /** `labels.TerraformRoot`: the root's key in the declaring member's config. */
  root: string | null;
  /** The member whose directory holds the root, or null when chant does not know it. */
  rootMember: string | null;
}

/** What one `chant ledger runs` document says. */
export type LedgerRunsAnswer =
  | { supported: true; runs: LocalApply[] }
  /** The chant printed a `runs` table without `root_member`, or refused the read. */
  | { supported: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const httpUrl = (v: unknown): string | undefined => (typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined);

/** One `runs` row as a {@link LocalApply}, or undefined when it has no id. */
function localApplyOf(row: Record<string, unknown>): LocalApply | undefined {
  const runId = strOrNull(row.id);
  if (!runId) return undefined;
  const labels = isRecord(row.labels) ? row.labels : {};
  const url = httpUrl(row.run_url);
  return {
    runId,
    op: strOrNull(row.op) ?? "",
    declaredBy: strOrNull(row.member),
    env: strOrNull(row.env),
    status: strOrNull(row.status) ?? "unknown",
    started: strOrNull(row.started),
    ended: strOrNull(row.ended),
    gitSha: strOrNull(row.git_sha),
    forge: strOrNull(row.forge),
    ...(url ? { url } : {}),
    root: strOrNull(labels.TerraformRoot),
    // null, absent and "" all read as unknown (chant#4508).
    rootMember: strOrNull(row.root_member),
  };
}

/** When a run happened, for ordering: its end, else its start. */
const whenOf = (r: LocalApply): string => r.ended ?? r.started ?? "";
const newestFirst = (a: LocalApply, b: LocalApply): number => whenOf(b).localeCompare(whenOf(a));

/**
 * Read a `chant ledger runs --json` document. Feature-detect: the read is
 * supported only when the table is `runs` and its `columns` name
 * `root_member`. Pure.
 */
export function ledgerRunsOf(doc: Record<string, unknown>): LedgerRunsAnswer {
  if (isRecord(doc.error)) return { supported: false, reason: `chant ledger runs: ${String(doc.error.code ?? "error")}: ${String(doc.error.message ?? "")}`.trim() };
  if (doc.table !== "runs" || !Array.isArray(doc.columns) || !Array.isArray(doc.rows)) return { supported: false, reason: "chant ledger runs printed no runs table" };
  if (!doc.columns.includes("root_member")) return { supported: false, reason: "this chant's ledger runs carry no root_member" };
  const runs = doc.rows
    .filter(isRecord)
    .map(localApplyOf)
    .filter((r): r is LocalApply => r !== undefined)
    .sort(newestFirst);
  return { supported: true, runs };
}

/** The runs of a `--where root_member=<member>` read that are `member`'s. A row naming another member, or none, is left out. Pure. */
export function memberLocalApplies(answer: LedgerRunsAnswer, member: string): LocalApply[] {
  return answer.supported ? answer.runs.filter((r) => r.rootMember === member) : [];
}

/** The runs of a `--where labels.Apply=true` read whose root member is unknown. Pure. */
export function unknownRootApplies(answer: LedgerRunsAnswer): LocalApply[] {
  return answer.supported ? answer.runs.filter((r) => r.rootMember === null) : [];
}

/** A run as one short card line: `aws ok 57192f6 · 2026-10-26`. */
export function localApplyLine(r: LocalApply): string {
  return [r.root ?? r.op, r.status === "ok" ? "ok" : r.status, r.gitSha ? r.gitSha.slice(0, 7) : undefined, whenOf(r) ? `· ${whenOf(r).slice(0, 10)}` : undefined].filter(Boolean).join(" ");
}

/** The `where` filters the reads take. */
export const rootMemberWhere = (member: string): string => `root_member=${member}`;
export const APPLY_RUNS_WHERE = "labels.Apply=true";

/**
 * Put each member card's local applies on it: the runs
 * `byMember` holds for the card's member, newest first, at most
 * {@link LOCAL_APPLIES_SHOWN}, as `attrs._localApplies`, and `attrs.local` the
 * newest one that passed (`local apply` on the card), or the words saying the
 * ledger names none. A member `byMember` has no entry for (the read was not
 * made, or this chant does not say) is left as it is. Returns how many cards
 * got a local apply. Pure.
 */
export function withLocalApplies(ir: GraphIR, byMember: ReadonlyMap<string, readonly LocalApply[]>): { ir: GraphIR; applied: number } {
  let applied = 0;
  const nodes = ir.nodes.map((n) => {
    if (n.lexicon !== MEMBER_RUNS_LEXICON) return n;
    const at = n.id.indexOf("/");
    const member = at >= 0 ? n.id.slice(0, at) : undefined;
    const runs = member !== undefined ? byMember.get(member) : undefined;
    if (!runs) return n;
    const sorted = [...runs].sort(newestFirst);
    const passed = sorted.find((r) => r.status === "ok");
    if (passed) applied++;
    const attrs: Record<string, unknown> = {
      ...n.attrs,
      [LOCAL_APPLIES]: sorted.slice(0, LOCAL_APPLIES_SHOWN),
      local: passed ? localApplyLine(passed) : sorted.length ? `none passed (${sorted.length} run${sorted.length === 1 ? "" : "s"})` : "none in the ledger",
    };
    return { ...n, attrs };
  });
  return { ir: { ...ir, nodes }, applied };
}

/** The note for applies whose root member is unknown: `2 local applies of an unknown root (aws, net)`, or undefined when there are none. */
export function unknownRootNote(runs: readonly LocalApply[]): string | undefined {
  if (!runs.length) return undefined;
  const roots = [...new Set(runs.map((r) => r.root ?? "no TerraformRoot label"))].sort();
  return `${runs.length} local ${runs.length === 1 ? "apply" : "applies"} of an unknown root (${roots.join(", ")})`;
}
