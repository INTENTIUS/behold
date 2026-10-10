/**
 * terragucci's verdicts on behold's Terraform cards (#490).
 *
 * A report names a root by its path (`envs/prod/payments`) and a change by
 * its instance address (`module.service.aws_dynamodb_table.records[0]`).
 * behold names a card `<member>/<root>/<block path>`, with the module calls
 * as path segments and no instance key (`module.service/aws_dynamodb_table.
 * records`), and every Terraform card carries its root's name in
 * `attrs.root`. So an instance maps onto its block's card many-to-one, the
 * same instance-to-block join src/choudoufu-refs.ts makes for choudoufu.
 *
 * What this produces is marks, never a status. A mark is a dated
 * observation: what a run found, when it finished, which commit and pull
 * request, and where its report is. Nothing here writes `_status`, so a card
 * a report says nothing about is not painted "fine", and a card a report
 * flags is not painted "live". The SPA draws a mark as a corner glyph and an
 * age ("drift found 06:04, 4h ago"), never as a fill.
 */
import type { RootRun, TerragucciRead, WaitingWave } from "./terragucci-reports.ts";

type Node = { id: string; attrs?: Record<string, unknown> };

/** One root of the checkout: which member it is in, behold's name for it, and terragucci's path for it. */
export interface CheckoutRoot {
  member: string;
  name: string;
  path: string;
}

export interface RunRef {
  stage: RootRun["stage"];
  finished: string;
  commit: string;
  wave?: number;
  pull_request?: string;
  pull_request_url?: string;
  commit_url?: string;
  job_url?: string;
  trace_url?: string;
  /** The run's report.html, as a key under the source. */
  report: string;
}

/** One verdict on one card. */
export interface CardMark {
  /** `drift` from a tf-drift run, `plan` from a tf-plan run, `wave` from a tf-apply wave waiting for its approval. */
  verdict: "drift" | "plan" | "wave";
  action: string;
  /** What the run found, in terragucci's words: "deleted outside Terraform", "would replace". */
  words: string;
  /** The instance addresses behind it, as the report names them. */
  addresses: string[];
  /** The attribute paths that changed (never a sensitive one). */
  attributes: string[];
  run: RunRef;
}

export interface RootVerdict {
  run: RunRef;
  status: "planned" | "failed";
  error?: string;
  /** How many changes the run found in the root (drift: drifted objects). */
  changes: number;
  approval?: RootRun["approval"];
  applied?: string;
}

/** A root of the checkout and the newest run of each stage that held it; a stage with no run is absent ("no report"), which is not "no changes". */
export interface RootMarks extends CheckoutRoot {
  plan?: RootVerdict;
  drift?: RootVerdict;
  apply?: RootVerdict;
}

export interface TerragucciMarks {
  /** Marks by card id. */
  cards: Record<string, CardMark[]>;
  roots: RootMarks[];
  /** Report roots no root of the checkout is, and changes no card is: said, never dropped. */
  unmatched: { roots: string[]; changes: { root: string; address: string }[] };
  waiting: WaitingWave[];
}

/** An instance address's block path, behold's way: module calls as segments, instance keys dropped. */
export function blockPath(address: string): string {
  // Instance keys first: `["a.b"]` may hold a dot, which would split wrongly.
  const bare = address.replace(/\[(?:"(?:[^"\\]|\\.)*"|[^\]])*\]/g, "");
  const tokens = bare.split(".");
  const segments: string[] = [];
  let i = 0;
  while (tokens[i] === "module" && i + 1 < tokens.length) {
    segments.push(`module.${tokens[i + 1]}`);
    i += 2;
  }
  segments.push(tokens.slice(i).join("."));
  return segments.join("/");
}

const DRIFT_WORDS: Record<string, string> = {
  delete: "deleted outside Terraform",
  create: "exists outside the state",
  update: "changed outside Terraform",
  replace: "changed outside Terraform",
};
const PLAN_WORDS: Record<string, string> = {
  create: "would create",
  update: "would update",
  replace: "would replace",
  delete: "would destroy",
  forget: "would forget",
  import: "would import",
};

const ref = (r: RootRun): RunRef => ({
  stage: r.stage,
  finished: r.finished,
  commit: r.commit,
  ...(r.wave !== undefined ? { wave: r.wave } : {}),
  ...(r.pull_request ? { pull_request: r.pull_request } : {}),
  ...(r.pull_request_url ? { pull_request_url: r.pull_request_url } : {}),
  ...(r.commit_url ? { commit_url: r.commit_url } : {}),
  ...(r.job_url ? { job_url: r.job_url } : {}),
  ...(r.trace_url ? { trace_url: r.trace_url } : {}),
  report: r.report,
});

const verdict = (r: RootRun): RootVerdict => ({
  run: ref(r),
  status: r.status,
  ...(r.error ? { error: r.error } : {}),
  changes: r.changes.filter((c) => c.action !== "no-op" && c.action !== "read").length,
  ...(r.approval ? { approval: r.approval } : {}),
  ...(r.applied ? { applied: r.applied } : {}),
});

/** Join a read onto the cards of the checkout. Pure: the nodes are not changed. */
export function joinTerragucci(read: TerragucciRead, nodes: readonly Node[], roots: readonly CheckoutRoot[]): TerragucciMarks {
  // Cards by member, root and block path. The member is the id's first
  // segment, the same name composeStacks gave it.
  const byRoot = new Map<string, Map<string, string>>();
  for (const n of nodes) {
    const root = n.attrs?.root;
    if (typeof root !== "string") continue;
    const at = n.id.indexOf(`/${root}/`);
    if (at < 0) continue;
    const member = n.id.slice(0, at);
    const key = `${member}\u0000${root}`;
    if (!byRoot.has(key)) byRoot.set(key, new Map());
    byRoot.get(key)!.set(n.id.slice(at + root.length + 2), n.id);
  }

  const cards: Record<string, CardMark[]> = {};
  const unmatchedChanges: { root: string; address: string }[] = [];
  const out: RootMarks[] = [];
  const known = new Set(roots.map((r) => r.path));
  for (const root of roots) {
    const runs = read.roots[root.path] ?? {};
    const marks: RootMarks = { ...root };
    const blocks = byRoot.get(`${root.member}\u0000${root.name}`);
    for (const [slot, run] of [["drift", runs.drift], ["plan", runs.plan], ["apply", runs.apply]] as const) {
      if (!run) continue;
      marks[slot] = verdict(run);
      // An applied wave's changes have happened; a waiting one's would, once
      // a person approves it, so they mark their cards like a plan's.
      if (slot === "apply" && run.approval !== "waiting") continue;
      const kind = slot === "apply" ? "wave" : slot;
      const words = slot === "drift" ? DRIFT_WORDS : PLAN_WORDS;
      // One mark per card and action, gathering the instances.
      const grouped = new Map<string, CardMark>();
      for (const c of run.changes) {
        const said = words[c.action];
        if (!said) continue;
        const id = blocks?.get(blockPath(c.address));
        if (!id) {
          unmatchedChanges.push({ root: root.path, address: c.address });
          continue;
        }
        const k = `${id}\u0000${c.action}`;
        const m = grouped.get(k) ?? { verdict: kind, action: c.action, words: said, addresses: [], attributes: [], run: ref(run) };
        m.addresses.push(c.address);
        for (const a of c.attributes ?? []) if (!m.attributes.includes(a.path)) m.attributes.push(a.path);
        grouped.set(k, m);
      }
      for (const [k, m] of grouped) (cards[k.slice(0, k.indexOf("\u0000"))] ??= []).push(m);
    }
    out.push(marks);
  }
  return {
    cards,
    roots: out,
    unmatched: { roots: Object.keys(read.roots).filter((p) => !known.has(p)).sort(), changes: unmatchedChanges },
    waiting: read.waiting,
  };
}
