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
  return digestOf(ir.nodes);
}

function digestOf(nodes: GraphIR["nodes"]): string {
  return nodes
    .map((n) => `${n.id}=${(n.attrs as { _status?: string })?._status ?? ""}`)
    .sort()
    .join("\n");
}

/** The lexicon bucket for a node that declares none. Its own key rather than a
 * merge into some real substrate, so an unattributed node can never make `aws`
 * look like it moved. */
export const UNKNOWN_LEXICON = "";

/**
 * {@link driftDigest}, but kept per substrate instead of reduced to one string
 * (#117).
 *
 * The estate-wide digest answers *did anything move* and never *what moved*, so
 * a drifted k8s Service and a drifted security group were the same event — which
 * is how auto-sync could route k8s drift to the AWS apply. Every IR node already
 * carries `lexicon`; this stops throwing it away. No new read: the information
 * is in the overlay behold already pulls every tick.
 *
 * Nodes only, never edges — so the cross-substrate anchor edges #103 adds cannot
 * make one substrate appear to move because it is now connected to another that
 * did. Pure — unit-tested.
 */
export function driftDigestsByLexicon(ir: GraphIR): Record<string, string> {
  const byLexicon = new Map<string, GraphIR["nodes"]>();
  for (const n of ir.nodes) {
    const key = n.lexicon ?? UNKNOWN_LEXICON;
    const bucket = byLexicon.get(key);
    if (bucket) bucket.push(n);
    else byLexicon.set(key, [n]);
  }
  const out: Record<string, string> = {};
  for (const [lexicon, nodes] of byLexicon) out[lexicon] = digestOf(nodes);
  return out;
}

/**
 * Which substrates moved between two ticks — sorted, so a caller's log and
 * routing are deterministic.
 *
 * A substrate counts as moved when its digest changed, when it is newly present
 * (its first node appeared), or when it vanished entirely (every node gone,
 * which is drift of the most consequential kind). Pure — unit-tested.
 */
export function changedLexicons(prev: Record<string, string>, next: Record<string, string>): string[] {
  const moved = new Set<string>();
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (prev[key] !== next[key]) moved.add(key);
  }
  return [...moved].sort();
}

export interface DriftPollOptions {
  intervalMs: number;
  query: () => Promise<GraphIR>;
  /** Fired when the drift moved, with the substrates that moved (#117) — sorted,
   * and never empty when called. */
  onChange: (movedLexicons: string[]) => void;
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
  let last: Record<string, string> | undefined;
  let timer: ReturnType<typeof setTimeout>;

  const tick = async (): Promise<void> => {
    try {
      const digests = driftDigestsByLexicon(await opts.query());
      if (last !== undefined) {
        const moved = changedLexicons(last, digests);
        if (moved.length) opts.onChange(moved);
      }
      last = digests;
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
