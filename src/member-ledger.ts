/**
 * Where a served project's records sit on `chant/lifecycle` (#537).
 *
 * A project that is a member of a chant workspace (a `chant.workspace.json`
 * between it and the git root names it) writes every lifecycle store under
 * `_members/<member>/` on the branch: releases under `<env>/`, gates under
 * `_gates/`, head plans under `_wave-plans/`. A nested workspace adds a level
 * per member. Which member owns the project is chant's call,
 * `resolveMemberLedger` from `@intentius/chant/lifecycle/member-ledger`,
 * which reads the declaration in the served checkout and writes nothing.
 * Level 0 (no declaration) and the root member `.` keep the flat layout.
 */
import { clearMemberLedgerCache, MemberLedgerError, resolveMemberLedger } from "@intentius/chant/lifecycle/member-ledger";
import type { GitRun } from "./terragucci-lifecycle.ts";

export interface ProjectLedger {
  /** The owning member's names, outermost first; empty for the flat layout. */
  members: string[];
  /** The prefix on the branch: `""`, or `_members/<member>/` per level. */
  prefix: string;
  /** The project's directory in its repository, with a trailing slash (`""` at the root): where its files are at base. */
  dir: string;
  /** Why chant could not place the ledger (a declaration it cannot read). The read then falls back to the flat layout. */
  error?: string;
}

/** The ledger of the project at `checkout`, as chant places it. Never throws. */
export async function projectLedger(checkout: string, git: GitRun): Promise<ProjectLedger> {
  const p = await git(["-C", checkout, "rev-parse", "--show-prefix"]);
  const dir = p.code === 0 ? p.stdout.trim() : "";
  // chant caches a placement for the life of the process; a declaration edited while behold serves should count.
  clearMemberLedgerCache();
  try {
    const { members, prefix } = await resolveMemberLedger(checkout);
    return { members, prefix, dir };
  } catch (e) {
    const why = e instanceof MemberLedgerError ? e.message : `chant could not place this project's ledger: ${e instanceof Error ? e.message : String(e)}`;
    return { members: [], prefix: "", dir, error: `${why} behold read the flat layout instead.` };
  }
}

/** A sentence for an answer's note, when the project is a member. */
export function memberNote(l: ProjectLedger): string {
  if (l.error) return l.error;
  return l.members.length ? `This project is the workspace member ${l.members.join(" / ")}, so its records are read under ${l.prefix} on chant/lifecycle.` : "";
}
