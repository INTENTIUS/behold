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

/** One estate member the poll covers: its project dir (the attribution key every
 * event carries) and the query that reads its live overlay. */
export interface DriftPollMember {
  dir: string;
  query: () => Promise<GraphIR>;
}

export interface DriftPollOptions {
  intervalMs: number;
  /** Every estate member, primary first (#297). One entry on a single-project
   * serve — the estate case is not a different mode, just a longer list. */
  members: DriftPollMember[];
  /** Fired per member whose drift moved, with that member's dir and the
   * substrates that moved (#117) — sorted, and never empty when called. */
  onChange: (dir: string, movedLexicons: string[]) => void;
  onError?: (dir: string, err: unknown) => void;
}

/**
 * Self-scheduling poll. Each tick queries every member — sequentially, never in
 * parallel (#297): a member read can take seconds (#295), and N members
 * describing at once is exactly the stampede a single self-scheduling poll
 * exists to prevent. A slow estate stretches the tick; it never stacks it,
 * because the next tick is only scheduled *after* the whole sweep settles (the
 * overlap guard is structural).
 *
 * Baselines are per member: a member's first successful read sets its baseline
 * without firing (the page's initial load already reflects it); later ticks fire
 * on that member's digest change. One member failing reaches `onError` with its
 * dir and neither aborts the sweep nor disturbs anyone's baseline — including
 * its own, so a flaky read can't fake drift when it recovers. Returns a stop
 * function.
 */
export function startDriftPoll(opts: DriftPollOptions): () => void {
  let stopped = false;
  const last = new Map<string, Record<string, string>>();
  let timer: ReturnType<typeof setTimeout>;

  const tick = async (): Promise<void> => {
    for (const member of opts.members) {
      if (stopped) return;
      try {
        const digests = driftDigestsByLexicon(await member.query());
        const prev = last.get(member.dir);
        if (prev !== undefined) {
          const moved = changedLexicons(prev, digests);
          if (moved.length) opts.onChange(member.dir, moved);
        }
        last.set(member.dir, digests);
      } catch (err) {
        opts.onError?.(member.dir, err);
      }
    }
    if (!stopped) timer = setTimeout(tick, opts.intervalMs);
  };

  timer = setTimeout(tick, opts.intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
