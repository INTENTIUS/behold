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
import type { ReportAttribute, RootRun, TerragucciRead, WaitingWave } from "./terragucci-reports.ts";

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
  /** behold#571: each changed attribute's before and after (or `unknown`), by instance address, for the kiosk's popover. */
  values: AttributeValue[];
  run: RunRef;
}

/** behold#571: one attribute of one instance, as a report states it. */
export type AttributeValue = ReportAttribute & { address: string };

/** behold#571: what an applied wave wrote for a card's attributes: the state the root holds now, as of that run. */
export interface AppliedValues {
  values: AttributeValue[];
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

/** A change no card of the checkout is. behold#796: with its action and its mark's kind, so the kiosk's root popover lists a planned create the checkout does not declare yet. */
export interface UnmatchedChange {
  root: string;
  address: string;
  action: string;
  verdict: CardMark["verdict"];
}

/**
 * behold#940: a composed choudoufu run's resources, per estate, as its reports state them. An estate keeps no state
 * file and the checkout's graph is as of the base, so the kiosk's ask mode draws these in place of the graph's cards.
 */
export interface EstateResource {
  address: string;
  action: string;
  /** `applied` once a newer apply report lists it, else `planned`. */
  state: "planned" | "applied";
  /** The plan's attributes (an unknown one is marked), by instance address. */
  values: AttributeValue[];
}

export interface EstateRootScene extends CheckoutRoot {
  resources: EstateResource[];
}

export interface EstateScene {
  roots: EstateRootScene[];
}

export interface TerragucciMarks {
  /** Marks by card id. */
  cards: Record<string, CardMark[]>;
  roots: RootMarks[];
  /** Report roots no root of the checkout is, and changes no card is: said, never dropped. */
  unmatched: { roots: string[]; changes: UnmatchedChange[] };
  waiting: WaitingWave[];
  /** behold#571: by card id, the attributes the root's newest applied wave wrote. */
  applied: Record<string, AppliedValues>;
  /** behold#940: with a composed choudoufu run (report minor 48, `compose.estate`): its resources by estate. Absent otherwise. */
  estateScene?: EstateScene;
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
  const applied: Record<string, AppliedValues> = {};
  const unmatchedChanges: UnmatchedChange[] = [];
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
      if (slot === "apply" && run.approval !== "waiting") {
        // behold#571: what it wrote is what the state holds now, for the kiosk's popover.
        // The push back to the base is a no-op apply with no approval, so it has no `applied` mark of its own.
        const wrote = !run.changes.length && runs.wrote ? runs.wrote : run;
        if (wrote.applied) {
          for (const c of wrote.changes) {
            const id = blocks?.get(blockPath(c.address));
            if (!id || !c.attributes?.length) continue;
            const a = (applied[id] ??= { values: [], run: ref(run) });
            for (const v of c.attributes) a.values.push({ ...v, address: c.address });
          }
        }
        continue;
      }
      const kind = slot === "apply" ? "wave" : slot;
      const words = slot === "drift" ? DRIFT_WORDS : PLAN_WORDS;
      // One mark per card and action, gathering the instances.
      const grouped = new Map<string, CardMark>();
      for (const c of run.changes) {
        const said = words[c.action];
        if (!said) continue;
        const id = blocks?.get(blockPath(c.address));
        if (!id) {
          unmatchedChanges.push({ root: root.path, address: c.address, action: c.action, verdict: kind });
          continue;
        }
        const k = `${id}\u0000${c.action}`;
        const m = grouped.get(k) ?? { verdict: kind, action: c.action, words: said, addresses: [], attributes: [], values: [], run: ref(run) };
        m.addresses.push(c.address);
        for (const a of c.attributes ?? []) {
          if (!m.attributes.includes(a.path)) m.attributes.push(a.path);
          m.values.push({ ...a, address: c.address });
        }
        grouped.set(k, m);
      }
      for (const [k, m] of grouped) (cards[k.slice(0, k.indexOf("\u0000"))] ??= []).push(m);
    }
    out.push(marks);
  }
  const estateScene = read.pull_request?.compose?.estate === true ? estateSceneOf(read, roots, applied) : undefined;
  return {
    cards,
    roots: out,
    unmatched: { roots: Object.keys(read.roots).filter((p) => !known.has(p)).sort(), changes: unmatchedChanges },
    waiting: read.waiting,
    applied,
    ...(estateScene ? { estateScene } : {}),
  };
}

/** The card id a scene's resource has: the id a graph card of it would have. */
export const estateCardId = (root: CheckoutRoot, address: string): string => `${root.member}/${root.name}/${address}`;

/**
 * behold#940: each estate's resources from its newest reports. The plan lists what the change does; an apply report
 * newer than it (one a person approved, not a waiting one) marks what applied and says the values the apply wrote,
 * which join `applied` under the same card id. An apply that changed nothing (the push back to the base) is not
 * newer than what it undoes: the run before it speaks.
 */
function estateSceneOf(read: TerragucciRead, roots: readonly CheckoutRoot[], applied: Record<string, AppliedValues>): EstateScene {
  const listed = (c: { action: string }) => c.action !== "no-op" && c.action !== "read";
  const out: EstateRootScene[] = [];
  // Every estate the run names is drawn: one the checkout does not list as a root joins under the checkout's first member.
  const named = [...(read.pull_request?.compose?.roots ?? []), ...Object.keys(read.roots)];
  const extra = [...new Set(named)].filter((p) => !roots.some((r) => r.path === p) && read.roots[p]);
  const member = roots[0]?.member ?? "estate";
  const all: CheckoutRoot[] = [...roots, ...extra.map((p) => ({ member, name: p.split("/").filter(Boolean).pop() ?? p, path: p }))];
  for (const root of all) {
    const runs = read.roots[root.path];
    if (!runs) continue;
    const waiting = runs.apply?.approval === "waiting" ? runs.apply : undefined;
    const plan = runs.plan ?? waiting;
    const settled = runs.apply && !waiting ? (!runs.apply.changes.length && runs.wrote ? runs.wrote : runs.apply) : undefined;
    const done = settled && settled.applied && settled.changes.some(listed) && (!plan || settled.finished >= plan.finished) ? settled : undefined;
    const byAddress = new Map<string, EstateResource>();
    for (const c of plan?.changes ?? []) {
      if (!listed(c)) continue;
      byAddress.set(c.address, { address: c.address, action: c.action, state: "planned", values: (c.attributes ?? []).map((a) => ({ ...a, address: c.address })) });
    }
    for (const c of done?.changes ?? []) {
      if (!listed(c)) continue;
      const had = byAddress.get(c.address);
      const values = (c.attributes ?? []).map((a) => ({ ...a, address: c.address }));
      byAddress.set(c.address, { address: c.address, action: c.action, state: "applied", values: had ? had.values : values });
      if (values.length) {
        const id = estateCardId(root, c.address);
        (applied[id] ??= { values: [], run: ref(done!) }).values.push(...values);
      }
    }
    if (byAddress.size) out.push({ ...root, resources: [...byAddress.values()] });
  }
  return { roots: out };
}
