/**
 * The dispatched-run record (#165 §6) — the CI path's equivalent of the
 * durable status read the Temporal path already has.
 *
 * `src/op-runner.ts` says it plainly for Ops: run state is in-process, "a run
 * started elsewhere is invisible here", and `chant run status` re-reading
 * durable state is the answer. For a dispatched GitHub run the durable read
 * is `gh run view <id>` — but nothing persisted the id, so restarting behold
 * mid-deploy left a live prod run with no reader at all. This module is that
 * persistence: one small JSON per project under `~/.behold/ci-runs/`, written
 * when a dispatched run is adopted by watermark, updated when the follow
 * concludes (ok / failed / lost). Nothing about the run itself lives here —
 * GitHub stays the source of truth; this is only the pointer behold needs to
 * re-adopt it.
 *
 * Under the operator's own home, not the project tree: the record is this
 * machine's watching-state, not a fact about the project — committing it
 * would be as wrong as committing a terminal's scrollback.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DispatchedRun {
  version: 1;
  /** Absolute project dir the dispatch was made for — sanity-checked on read. */
  projectDir: string;
  /** The env the pipeline was generated for, when the dispatch named one. */
  env?: string;
  /** Workflow file dispatched (e.g. `deploy.yml`). */
  workflow: string;
  /** Git ref the run built. */
  ref: string;
  /** The run id adopted by watermark — the handle `gh run view` reads. */
  runId: number;
  /** The run's page, once a poll reported one. */
  url?: string;
  /** ISO timestamp of the dispatch. */
  dispatchedAt: string;
  /** Set when the follow ended. Absent = behold may still owe this run a reader. */
  concluded?: { verdict: "ok" | "failed" | "lost"; at: string };
}

/** Filesystem-safe slug for a project dir (mirrors no existing convention — first per-project state file behold keeps). */
function slug(projectDir: string): string {
  return resolve(projectDir).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-80);
}

/** Store root: `~/.behold/ci-runs`, overridable for tests (and an operator who wants state elsewhere). */
function defaultRoot(): string {
  return process.env.BEHOLD_CI_RUN_DIR ?? join(homedir(), ".behold", "ci-runs");
}

export function dispatchedRunPath(projectDir: string, root: string = defaultRoot()): string {
  return join(root, `${slug(projectDir)}.json`);
}

/** Persist the adopted run (called from the dispatch route's `onAdopted`). Best-effort: a failed write must never fail the dispatch. */
export function saveDispatchedRun(run: Omit<DispatchedRun, "version">, root: string = defaultRoot()): void {
  try {
    const path = dispatchedRunPath(run.projectDir, root);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, ...run }, null, 2) + "\n");
  } catch {
    // the run still has its in-process reader; only the restart story degrades
  }
}

/** The persisted record for a project, or undefined (absent, unreadable, wrong shape, other project). */
export function readDispatchedRun(projectDir: string, root?: string): DispatchedRun | undefined {
  try {
    const path = dispatchedRunPath(projectDir, root);
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DispatchedRun;
    if (parsed?.version !== 1 || typeof parsed.runId !== "number") return undefined;
    if (resolve(parsed.projectDir) !== resolve(projectDir)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Record the follow's verdict on the persisted run (no-op when nothing/another run is persisted). */
export function concludeDispatchedRun(
  projectDir: string,
  runId: number,
  verdict: "ok" | "failed" | "lost",
  root?: string,
): void {
  const current = readDispatchedRun(projectDir, root);
  if (!current || current.runId !== runId) return;
  saveDispatchedRun({ ...current, concluded: { verdict, at: new Date().toISOString() } }, root);
}

/** Drop the record entirely (tests; a project the operator stopped serving). */
export function clearDispatchedRun(projectDir: string, root?: string): void {
  try {
    rmSync(dispatchedRunPath(projectDir, root), { force: true });
  } catch {
    // absent is the goal
  }
}
