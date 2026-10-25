/**
 * A component's last release, on its card (#899).
 *
 * chant records a release per component and environment on `chant/lifecycle`
 * (`<env>/releases.jsonl`, a workspace member's under `_members/<member>/`):
 * the digest, the commit, who, when, and the run. Since chant#4274 a component
 * that only deploys infrastructure gets one too, its digest that of its deploy
 * inputs (`digestKind: "deploy-input"`). src/lifecycle-releases.ts reads the
 * ledger for one checkout; this reads it for each chant member and gives each
 * component card its newest release, in the environment being viewed or, with
 * none, the newest in any. The card and the pane take it as they take the
 * release a live status read finds (src/component-status.ts): the `release`
 * chip and the `_release` attr web/release.js draws.
 */
import type { GraphIR, IRNode } from "@intentius/chant";
import type { ReleaseRecord } from "@intentius/chant/lifecycle/release-ledger";
import { releaseChip, releaseStatus, type ReleaseStatus } from "./component-status.ts";
import type { CiRunEntry } from "./ci-run-index.ts";
import { readReleases, RELEASES_READ_TTL_MS, type ReleaseCell, type ReleasesAnswer } from "./lifecycle-releases.ts";

/** The newest release of `component` in `env`, or in any environment when `env` is not given. */
export function lastRelease(answer: Pick<ReleasesAnswer, "cells">, component: string, env?: string): ReleaseStatus | undefined {
  const newest = answer.cells
    .filter((c) => c.component === component && (!env || c.env === env))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  return newest ? releaseStatus(recordOf(newest)) : undefined;
}

/** The ledger record a cell was read from, as much of it as the pane shows. */
function recordOf(c: ReleaseCell): ReleaseRecord {
  return {
    version: 1,
    component: c.component,
    env: c.env,
    digest: c.digest,
    gitSha: c.gitSha,
    runId: c.runId,
    timestamp: c.timestamp,
    actor: c.actor,
    ...(c.approver ? { approver: c.approver } : {}),
    ...(c.runOrigin ? { runOrigin: c.runOrigin } : {}),
  } as ReleaseRecord;
}

/** One read per member directory per {@link RELEASES_READ_TTL_MS}, as the releases route keeps it. */
const reads = new Map<string, { at: number; read: Promise<ReleasesAnswer> }>();
function cachedRead(dir: string): Promise<ReleasesAnswer> {
  const hit = reads.get(dir);
  if (hit && Date.now() - hit.at < RELEASES_READ_TTL_MS) return hit.read;
  const read = readReleases(dir);
  reads.set(dir, { at: Date.now(), read });
  read.catch(() => reads.delete(dir));
  return read;
}

/**
 * Each component card's last release. `ir` holds the components, an estate's
 * prefixed `<member>/<component>`; `members` names each member's directory
 * (one unnamed entry for a single project). A card that already carries a
 * release, from a live status read, keeps it.
 */
export async function withReleases(
  ir: GraphIR,
  members: Array<{ name?: string; dir: string }>,
  env: string | undefined,
  read: (dir: string) => Promise<Pick<ReleasesAnswer, "cells" | "found">> = cachedRead,
): Promise<{ ir: GraphIR; released: number }> {
  const answers = new Map<string | undefined, Pick<ReleasesAnswer, "cells" | "found">>();
  await Promise.all(members.map(async (m) => answers.set(m.name, await read(m.dir).catch(() => ({ cells: [], found: false })))));
  const named = members.some((m) => m.name);
  let released = 0;
  const nodes = ir.nodes.map((n) => {
    if (n.attrs._release) {
      released++;
      return n;
    }
    const at = n.id.indexOf("/");
    const member = named && at >= 0 ? n.id.slice(0, at) : undefined;
    const answer = answers.get(member);
    const r = answer?.found ? lastRelease(answer, member ? n.id.slice(at + 1) : n.id, env) : undefined;
    if (!r) return n;
    released++;
    return { ...n, attrs: { ...n.attrs, release: releaseChip(r), _release: r } };
  });
  return { ir: { ...ir, nodes }, released };
}

/** The attr a component card carries a CI run under that ended after its last release and did not pass. */
export const RUN_SINCE = "_runSince";

/** What a card says about a run since its release. */
export interface RunSince {
  job: string;
  status: string;
  runId: string;
  commit: string;
  ended: string;
  /** The member the run was for; absent for a run of the whole workspace. */
  member?: string;
}

/** How the card says a run's status: `apply failed 57192f6`, short enough for a card line. */
const SINCE_WORD: Record<string, string> = { fail: "failed", waiting: "waiting" };

/**
 * The run index beside each component's release: the newest run that ended
 * after the release, for the component's member or the whole workspace, when
 * it did not pass. A release only ever records a success, so this is where a
 * failure after it shows. Pure.
 */
export function withRunsSince(ir: GraphIR, entries: readonly CiRunEntry[]): { ir: GraphIR; marked: number } {
  let marked = 0;
  const nodes = ir.nodes.map((n) => {
    const rel = n.attrs._release as { timestamp?: string } | undefined;
    if (!rel?.timestamp) return n;
    const at = n.id.indexOf("/");
    const member = at >= 0 ? n.id.slice(0, at) : undefined;
    const since = entries
      .filter((e) => e.ended > rel.timestamp! && (!e.member || e.member === member))
      .sort((a, b) => b.ended.localeCompare(a.ended))[0];
    if (!since || since.status === "ok") return n;
    marked++;
    const run: RunSince = { job: since.job, status: since.status, runId: since.runId, commit: since.commit, ended: since.ended, ...(since.member ? { member: since.member } : {}) };
    return { ...n, attrs: { ...n.attrs, since: `${since.job} ${SINCE_WORD[since.status] ?? since.status} ${since.commit.slice(0, 7)}`, [RUN_SINCE]: run } };
  });
  return { ir: marked ? { ...ir, nodes } : ir, marked };
}

/**
 * #997: the card a member gets in an estate's components picture when chant
 * records no component release for it: a `choudoufu` or `terraform` member
 * (and, once behold reads one, a `pulumi` member). chant's release ledger is
 * written per component (`components release`, the auto-release, a promote),
 * and a TerraformApplyOp writes none, so for these members the only record of
 * an apply chant keeps is its run index: each `chant ci run` job's entry,
 * keyed by the member whose directory it ran in. One card per member stands
 * for its whole root, so every resource of the member is drawn under it.
 */
export const MEMBER_RUNS_LEXICON = "member-runs";
/** The card's kind. */
export const MEMBER_RUNS_KIND = "MemberRuns";
/** The attr a member card carries its newest apply that passed under. */
export const LAST_APPLY = "_lastApply";

/** A member's newest apply that passed, as the run index recorded it. */
export interface LastApply {
  runId: string;
  commit: string;
  ended: string;
  key: string;
  forge: string;
  /** Present only when the index entry's run origin carries an absolute http(s) URL. */
  url?: string;
}

/** The one card standing for a member of `kind` in its own box. Its id is the kind, composed below the member as `<member>/<kind>`. */
export function memberRunsCard(kind: string): IRNode {
  return { id: kind, kind: MEMBER_RUNS_KIND, lexicon: MEMBER_RUNS_LEXICON, attrs: { engine: kind } } as IRNode;
}

const httpUrl = (v: unknown): string | undefined => (typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined);

/**
 * Each member card's last apply and the run since it that did not pass, from
 * the run index. The last apply is the newest `apply` entry for the card's
 * member that passed; a run of the whole workspace (no `member`) is not taken
 * as one, since the index cannot say the member was in it. The run since is
 * the newest entry, the member's or the whole workspace's, that ended after
 * it, when that entry did not pass (as {@link withRunsSince} does for a
 * release). With no apply recorded, the member's newest run is shown when it
 * did not pass. A card the index names no run of says so in words: `indexed`
 * false means behold was given no run index to read at all. Pure.
 */
export function withMemberApplies(ir: GraphIR, entries: readonly CiRunEntry[], indexed: boolean): { ir: GraphIR; applied: number } {
  let applied = 0;
  const newest = (es: readonly CiRunEntry[]): CiRunEntry | undefined => [...es].sort((a, b) => b.ended.localeCompare(a.ended))[0];
  const nodes = ir.nodes.map((n) => {
    if (n.lexicon !== MEMBER_RUNS_LEXICON) return n;
    const at = n.id.indexOf("/");
    const member = at >= 0 ? n.id.slice(0, at) : undefined;
    const mine = entries.filter((e) => member !== undefined && e.member === member);
    const last = newest(mine.filter((e) => e.job === "apply" && e.status === "ok"));
    const after = last ? newest(entries.filter((e) => e.ended > last.ended && (!e.member || e.member === member))) : newest(mine);
    const since = after && after.status !== "ok" ? after : undefined;
    const attrs: Record<string, unknown> = { ...n.attrs };
    if (last) {
      applied++;
      const url = httpUrl(last.runOrigin?.url);
      const apply: LastApply = { runId: last.runId, commit: last.commit, ended: last.ended, key: last.key, forge: last.runOrigin?.forge ?? "unknown", ...(url ? { url } : {}) };
      attrs.apply = `${last.commit.slice(0, 7)} · ${last.ended.slice(0, 10)}`;
      attrs[LAST_APPLY] = apply;
    } else if (!since) {
      attrs.runs = indexed ? (mine.length ? "no apply recorded" : "no runs recorded") : "no run index read";
    } else {
      attrs.apply = "none recorded";
    }
    if (since) {
      const run: RunSince = { job: since.job, status: since.status, runId: since.runId, commit: since.commit, ended: since.ended, ...(since.member ? { member: since.member } : {}) };
      attrs.since = `${since.job} ${SINCE_WORD[since.status] ?? since.status} ${since.commit.slice(0, 7)}`;
      attrs[RUN_SINCE] = run;
    }
    return { ...n, attrs };
  });
  return { ir: { ...ir, nodes }, applied };
}
