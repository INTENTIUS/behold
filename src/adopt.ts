/**
 * Adopt eligibility + PR-link extraction (#8). Adopt is the cloud→code gesture:
 * a *foreign* node (provisioned, not declared) is pulled back into typed source
 * by triggering the project's ReconcileOp, which opens a PR. behold never writes
 * source — a human merges the PR.
 *
 * Two rules live here so the server is the source of truth (the SPA gates purely
 * on data it returns): which substrates can be adopted, and how to pull the PR
 * URL out of the Op's now-line output.
 */

/** Lexicons chant can live-import (regenerate typed source from the cloud). Adopt
 * is offered only for these — other substrates have no cloud→code path. */
export const LIVE_IMPORT_LEXICONS = ["aws", "azure", "gcp", "k8s"] as const;

const LIVE = new Set<string>(LIVE_IMPORT_LEXICONS);

/** A node is adoptable when overlay marks it foreign (provisioned, undeclared)
 * and its lexicon has a live-import path. Pure — unit-tested. */
export function isAdoptable(node: { lexicon?: string; attrs?: Record<string, unknown> }): boolean {
  return node.attrs?._status === "foreign" && !!node.lexicon && LIVE.has(node.lexicon);
}

/** Pull a GitHub/GitLab PR (or MR) URL out of an Op output line, if present. The
 * ReconcileOp surfaces the opened PR as an outcome (`[outcome] PR=…`, chant #841);
 * behold turns it into a link. Pure — unit-tested. */
export function extractPrUrl(line: string): string | undefined {
  const m = line.match(/https?:\/\/[^\s"'<>]+?\/(?:pull|pulls|merge_requests)\/\d+/);
  return m ? m[0] : undefined;
}
