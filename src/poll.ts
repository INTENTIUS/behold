/**
 * Live-drift poll (#4). When serving with an environment and `--poll <secs>`,
 * re-query the source-anchored overlay on an interval; when the drift changes,
 * signal the SPA (over the same SSE channel as #3) to re-pull. Poll-based because
 * `--live` is describe calls, not a cloud watch — the cadence is the drift
 * resolution. Off unless `--poll` is set.
 */
import type { GraphIR } from "@intentius/chant";

/** A stable fingerprint of the drift state: each node's id + its `_status`
 * (managed/foreign/pending). Pure — unit-tested. Changes iff a node's presence or
 * drift class changes, so re-renders fire only on real drift, not every poll. */
export function driftDigest(ir: GraphIR): string {
  return ir.nodes
    .map((n) => `${n.id}=${(n.attrs as { _status?: string })?._status ?? ""}`)
    .sort()
    .join("\n");
}

export interface DriftPollOptions {
  intervalMs: number;
  query: () => Promise<GraphIR>;
  onChange: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Self-scheduling poll. Each tick runs the query, and only schedules the next tick
 * *after* it settles — so a slow describe never stacks up (the overlap guard is
 * structural). The first successful poll sets the baseline without firing (the
 * page's initial load already reflects it); later ticks fire on a digest change.
 * Returns a stop function.
 */
export function startDriftPoll(opts: DriftPollOptions): () => void {
  let stopped = false;
  let last: string | undefined;
  let timer: ReturnType<typeof setTimeout>;

  const tick = async (): Promise<void> => {
    try {
      const digest = driftDigest(await opts.query());
      if (last !== undefined && digest !== last) opts.onChange();
      last = digest;
    } catch (err) {
      opts.onError?.(err);
    }
    if (!stopped) timer = setTimeout(tick, opts.intervalMs);
  };

  timer = setTimeout(tick, opts.intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
