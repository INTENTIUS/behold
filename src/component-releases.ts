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
import type { GraphIR } from "@intentius/chant";
import type { ReleaseRecord } from "@intentius/chant/lifecycle/release-ledger";
import { releaseChip, releaseStatus, type ReleaseStatus } from "./component-status.ts";
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
