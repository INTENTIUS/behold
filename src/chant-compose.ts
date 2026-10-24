/**
 * behold#969: a chant composed run, drawn the way the kiosk draws a composed choudoufu estate run.
 *
 * chant's pull-request loop (INTENTIUS/chant#4419) plans the stacks a change reaches together, marks a value the
 * run creates as known after apply in the stacks that read it, binds one digest, and takes one approval. Its
 * pr-report/v1 documents carry the pieces (chant `workspace/pr-report.schema.json`):
 *
 * - `members[].unknownInputs`: `<component>.<output>` the member's preview read before it existed. These are the
 *   `stackOutput` reads between stacks, and the only per-reader record of a read the report has today.
 * - `changeSet.entries[]`: each resource a member changes, `attributes[]` marking `unknown: true` the properties an
 *   unknown input drives. `changeSet.members[].holes[]`: a member no preview could be made of.
 * - `rounds[]`: the members planned again after an upstream applied. `covered { digest, filledInputs }` when the first
 *   approval covered the re-plan (no gate of its own), `notCovered` (a reason) when it asked for one.
 *
 * {@link composedView} turns the plan and apply stages into the two reads the kiosk's ask mode already draws from,
 * `/api/terragucci` (the answer: roots, estate scene, reads) and `/api/terragucci/progress` (the run view), so the
 * estate scene (src/terragucci-overlay.ts `estateSceneOf`) and the card rules (web/kiosk-light.js `cardLines`) are
 * reused unchanged. Nothing here reads a cloud or a forge.
 *
 * What the report does not record, and so is not drawn: a read whose value was known at plan (no `unknownInputs`
 * entry, and `plannedOutputs` does not name the reader), and the real value of an attribute after apply unless the
 * report's change set carries an `after` for it (CloudFormation entries carry property names only). Both read as the
 * kiosk's own fallbacks: no line, and "filled from <stack>".
 */

export const COVERED_WORDS = "one approval covered the re-plan";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export interface ComposedAttribute {
  path: string;
  unknown?: true;
  before?: unknown;
  after?: unknown;
}

export interface ComposedEntry {
  member: string;
  address: string;
  type?: string;
  action: string;
  attributes: ComposedAttribute[];
}

export interface ComposedMember {
  member: string;
  component: string;
  status: string;
  counts: Record<string, number>;
  unknownInputs: string[];
  /** The member's change set had a hole: nothing could be previewed. */
  hole: boolean;
  round?: number;
  held?: string;
}

export interface ComposedRound {
  round: number;
  components: string[];
  status: string;
  covered?: { digest: string; filledInputs: string[] };
  notCovered?: string;
  entries: ComposedEntry[];
}

/** The parts of one pr-report/v1 stage the composed view reads. */
export interface ComposedReport {
  stage: "plan" | "apply";
  status: string | null;
  digest: string | null;
  approval: string | null;
  gate: string | null;
  /** The pull request's number and the commit the stage ran on (the head for a plan, the merge for an apply). */
  pr: number | null;
  head: string | null;
  /** The upstream members whose outputs the plan states (`plannedOutputs`' keys). */
  planned: string[];
  /** `selection.waves` flattened: the apply order, upstreams first. */
  order: string[];
  /** `selection.waves` as the report gives them. */
  waves: string[][];
  members: ComposedMember[];
  entries: ComposedEntry[];
  rounds: ComposedRound[];
}

function entriesOf(changeSet: unknown): ComposedEntry[] {
  const list = isRecord(changeSet) && Array.isArray(changeSet.entries) ? changeSet.entries : [];
  const out: ComposedEntry[] = [];
  for (const e of list) {
    if (!isRecord(e) || typeof e.member !== "string" || typeof e.address !== "string" || typeof e.action !== "string") continue;
    const attributes: ComposedAttribute[] = [];
    for (const a of Array.isArray(e.attributes) ? e.attributes : []) {
      if (!isRecord(a) || typeof a.path !== "string") continue;
      attributes.push({ path: a.path, ...(a.unknown === true ? { unknown: true as const } : {}), ...("before" in a ? { before: a.before } : {}), ...("after" in a ? { after: a.after } : {}) });
    }
    out.push({ member: e.member, address: e.address, ...(typeof e.type === "string" ? { type: e.type } : {}), action: e.action, attributes });
  }
  return out;
}

/**
 * A pr-report/v1 document as a composed stage, or undefined when the run is not composed: no member reads an unknown
 * input and no round was planned. A plain fan-out report reads as before.
 */
export function composedReportOf(doc: unknown): ComposedReport | undefined {
  if (!isRecord(doc) || (doc.stage !== "plan" && doc.stage !== "apply") || !Array.isArray(doc.members)) return undefined;
  const holes = new Set<string>();
  const cs = doc.changeSet;
  if (isRecord(cs) && Array.isArray(cs.members)) {
    for (const m of cs.members) if (isRecord(m) && typeof m.member === "string" && Array.isArray(m.holes) && m.holes.length) holes.add(m.member);
  }
  const members: ComposedMember[] = [];
  for (const m of doc.members) {
    if (!isRecord(m) || typeof m.member !== "string") continue;
    members.push({
      member: m.member,
      component: typeof m.component === "string" ? m.component : m.member,
      status: typeof m.status === "string" ? m.status : "planned",
      counts: isRecord(m.counts) ? (Object.fromEntries(Object.entries(m.counts).filter(([, n]) => typeof n === "number")) as Record<string, number>) : {},
      unknownInputs: strings(m.unknownInputs),
      hole: holes.has(m.member),
      ...(typeof m.round === "number" ? { round: m.round } : {}),
      ...(typeof m.held === "string" ? { held: m.held } : {}),
    });
  }
  const rounds: ComposedRound[] = [];
  for (const r of Array.isArray(doc.rounds) ? doc.rounds : []) {
    if (!isRecord(r) || typeof r.round !== "number") continue;
    const c = r.covered;
    rounds.push({
      round: r.round,
      components: strings(r.components),
      status: typeof r.status === "string" ? r.status : "waiting",
      ...(isRecord(c) && typeof c.digest === "string" ? { covered: { digest: c.digest, filledInputs: strings(c.filledInputs) } } : {}),
      ...(typeof r.notCovered === "string" ? { notCovered: r.notCovered } : {}),
      entries: entriesOf(r.changeSet),
    });
  }
  // A composed run reads outputs between its stacks: an unknown input, a round, or upstreams whose outputs the plan
  // states (`plannedOutputs`, which an edit that moves only known values still has). A plain fan-out has none.
  const planned = isRecord(doc.plannedOutputs) ? Object.keys(doc.plannedOutputs) : [];
  if (!members.some((m) => m.unknownInputs.length) && !rounds.length && !planned.length) return undefined;
  const sel = doc.selection;
  const order = isRecord(sel) && Array.isArray(sel.waves) ? sel.waves.flatMap((w) => strings(w)) : [];
  const approval = isRecord(doc.approval) && typeof doc.approval.status === "string" ? doc.approval.status : null;
  return {
    stage: doc.stage,
    status: typeof doc.status === "string" ? doc.status : null,
    digest: typeof doc.digest === "string" ? doc.digest : null,
    approval,
    gate: typeof doc.gate === "string" ? doc.gate : null,
    planned,
    waves: isRecord(sel) && Array.isArray(sel.waves) ? sel.waves.map((w) => strings(w)) : [],
    pr: typeof doc.pr === "number" ? doc.pr : null,
    head: typeof doc.head === "string" ? doc.head : null,
    order,
    members,
    entries: entriesOf(cs),
    rounds,
  };
}

export type MemberKind = "previewed" | "hole" | "plain";

export interface ComposedViewOptions {
  /** When each stage finished, to order the apply after the plan. The kiosk compares them as ISO strings. */
  planAt?: string;
  applyAt?: string;
  /**
   * Component -> the components it depends on (the components graph's `dependsOn`), for the edge between two stacks the
   * report records no read for: edge reads nothing the plan could not state, but it still runs after app. A report names
   * only the reads it marked unknown.
   */
  dependsOn?: Record<string, readonly string[]>;
  /**
   * The outputs the applied stacks hold now, by member then output name. A pr-report/v1 states no value for what an
   * apply created (CloudFormation change-set entries carry property names only), so the real subnet id comes from the
   * stack that published it. Used only for a stack the apply report says applied.
   */
  outputs?: Record<string, Record<string, string>>;
}

/** What the kiosk's two terragucci reads are told, plus the chant facts behind them. */
export interface ComposedView {
  answer: Record<string, unknown>;
  progress: Record<string, unknown> | null;
  /** Each member: a previewed one (entries, inputs marked unknown), a hole (nothing previewed), or neither. */
  members: { member: string; kind: MemberKind; unknownInputs: string[] }[];
  /** The rounds after the first: which members were planned again, and whether the first approval covered them. */
  rounds: { round: number; members: string[]; covered: boolean; words: string; digest?: string; filledInputs?: string[]; reason?: string }[];
}

const EPOCH = "1970-01-01T00:00:00.000Z";

/** The stages as the kiosk's estate reads. `plan` is the preview (one approval), `apply` the run after it, when there is one. */
export function composedView(plan: ComposedReport | undefined, apply: ComposedReport | undefined, opts: ComposedViewOptions = {}): ComposedView | null {
  const base = plan ?? apply;
  if (!base) return null;
  const memberRows = (plan ?? base).members;
  const memberOfComponent = new Map<string, string>();
  for (const m of memberRows) memberOfComponent.set(m.component, m.member);
  const nameOf = (c: string): string => memberOfComponent.get(c) ?? c;
  const names = memberRows.map((m) => m.member);
  // Upstreams first, as the report's waves order them; a member no wave lists keeps the report's order.
  const ordered = [...new Set([...(plan?.order ?? apply?.order ?? []).map(nameOf), ...names])].filter((n) => names.includes(n));

  const roots = ordered.map((n) => ({ member: "chant", name: n, path: n }));
  const kindOf = (m: ComposedMember): MemberKind => (m.hole ? "hole" : m.unknownInputs.length ? "previewed" : "plain");

  // The reads between stacks: each unknown input names the stack it reads from and the output.
  const planEntries = (plan ?? base).entries;
  const reads: Record<string, unknown>[] = [];
  const upstreams: Record<string, string[]> = {};
  const inputsOf = (m: ComposedMember): string[] => {
    const later = apply?.members.find((x) => x.member === m.member);
    return [...new Set([...m.unknownInputs, ...(later?.unknownInputs ?? [])])];
  };
  for (const m of memberRows) {
    const byUpstream = new Map<string, string[]>();
    for (const ref of inputsOf(m)) {
      const dot = ref.indexOf(".");
      const up = nameOf(dot < 0 ? ref : ref.slice(0, dot));
      if (up === m.member) continue;
      const out = dot < 0 ? "" : ref.slice(dot + 1);
      byUpstream.set(up, [...(byUpstream.get(up) ?? []), ...(out ? [out] : [])]);
    }
    // The properties the preview marked unknown on this member's resources are the reads the cards show.
    const props = planEntries.filter((e) => e.member === m.member).flatMap((e) => e.attributes.filter((a) => a.unknown).map((a) => a.path));
    for (const [up, outs] of byUpstream) {
      reads.push({ root: m.member, upstream: up, data: "stackOutput", outputs: "planned", unknown: [...new Set([...outs, ...props])], composed: true });
      (upstreams[m.member] ??= []).push(up);
    }
  }

  for (const m of memberRows) {
    for (const dep of opts.dependsOn?.[m.component] ?? opts.dependsOn?.[m.member] ?? []) {
      const up = nameOf(dep);
      if (up !== m.member && names.includes(up) && !(upstreams[m.member] ?? []).includes(up)) (upstreams[m.member] ??= []).push(up);
    }
  }

  // No graph to ask, and the report names only the reads it marked unknown: an upstream whose outputs the plan states is
  // read by the next wave's stacks, which is what the demo's chain is. A graph's `dependsOn` above says so when known.
  if (!opts.dependsOn) {
    const waves = (plan ?? apply)!.waves.map((w) => w.map(nameOf));
    waves.forEach((w, i) => {
      for (const up of w) {
        if (!(plan ?? apply)!.planned.some((p) => nameOf(p) === up)) continue;
        for (const reader of waves[i + 1] ?? []) if (!(upstreams[reader] ??= []).includes(up)) upstreams[reader]!.push(up);
      }
    });
  }
  const appliedMembers = new Set((apply?.members ?? []).filter((m) => m.status === "applied").map((m) => m.member));
  // Values an apply states: the properties of the final plan of each member that carry an `after`.
  const finalEntries = (member: string): ComposedEntry[] => {
    const round = [...(apply?.rounds ?? [])].reverse().find((r) => r.entries.some((e) => e.member === member));
    return round ? round.entries.filter((e) => e.member === member) : (apply?.entries ?? []).filter((e) => e.member === member);
  };

  const applied: Record<string, { values: Record<string, unknown>[]; run: Record<string, unknown> }> = {};
  const scene: { member: string; name: string; path: string; resources: Record<string, unknown>[] }[] = [];
  for (const root of roots) {
    const done = appliedMembers.has(root.path);
    const previewed = planEntries.filter((e) => e.member === root.path);
    const resources = previewed
      .filter((e) => e.action !== "no-op" && e.action !== "read")
      .map((e) => ({
        address: e.address,
        action: e.action,
        state: done ? "applied" : "planned",
        values: e.attributes.map((a) => ({ address: e.address, ...a })),
      }));
    if (done) {
      for (const e of finalEntries(root.path)) {
        const values = e.attributes.filter((a) => !a.unknown && "after" in a).map((a) => ({ address: e.address, ...a }));
        if (values.length) (applied[`${root.member}/${root.name}/${e.address}`] ??= { values: [], run: { stage: "tf-apply", finished: opts.applyAt ?? EPOCH, commit: apply?.head ?? "", report: "" } }).values.push(...values);
      }
    }
    if (resources.length) scene.push({ ...root, resources });
  }
  // The real values: an output of an applied stack that a reader's unknown input names. The resource it came from gets
  // its id (the output `SubnetBId` is `subnetB`'s), and the reader's attribute the preview marked unknown gets the value.
  const run = { stage: "tf-apply", finished: opts.applyAt ?? EPOCH, commit: apply?.head ?? "", report: "" };
  const say = (member: string, address: string, path: string, after: string) => {
    const slot = (applied[`chant/${member}/${address}`] ??= { values: [], run });
    if (!slot.values.some((v) => v.path === path)) slot.values.push({ address, path, after });
  };
  for (const m of memberRows) {
    const found: { up: string; out: string; value: string }[] = [];
    for (const ref of inputsOf(m)) {
      const dot = ref.indexOf(".");
      if (dot < 0) continue;
      const up = nameOf(ref.slice(0, dot));
      const out = ref.slice(dot + 1);
      const value = appliedMembers.has(up) ? opts.outputs?.[up]?.[out] : undefined;
      if (typeof value === "string" && value) found.push({ up, out, value });
    }
    for (const f of found) {
      const stem = f.out.replace(/Id$/, "").toLowerCase();
      const made = planEntries.find((e) => e.member === f.up && e.action === "create" && e.address.toLowerCase() === stem);
      if (made) say(f.up, made.address, "id", f.value);
    }
    // One value is unambiguous: every attribute the preview marked unknown on this stack's resources reads it.
    if (found.length === 1 && appliedMembers.has(m.member)) for (const e of planEntries.filter((x) => x.member === m.member)) for (const a of e.attributes) if (a.unknown) say(m.member, e.address, a.path, found[0]!.value);
  }

  const pullRequest = {
    run: { commit: (plan ?? base).head ?? "", finished: opts.planAt ?? EPOCH, pull_request: (plan ?? base).pr === null ? "" : String((plan ?? base).pr), report: "" },
    reads,
    roots: ordered,
    waves: [
      {
        number: 1,
        roots: ordered,
        state: "planned",
        set_digest: base.digest,
        waits: true,
        composed: { plan_digest: base.digest, members: ordered.map((r) => ({ root: r, module: r })), held_by_unknown: memberRows.filter((m) => m.unknownInputs.length || m.hole).map((m) => m.member) },
      },
    ],
    compose: { roots: [...ordered].sort(), max: ordered.length, wave: 1, estate: true },
    upstreams,
  };
  const kinds = memberRows.map((m) => ({ member: m.member, kind: kindOf(m), unknownInputs: m.unknownInputs }));
  const answer: Record<string, unknown> = {
    cards: {},
    roots,
    unmatched: { roots: [], changes: [] },
    waiting: [],
    applied,
    estateScene: { roots: scene },
    pull_request: pullRequest,
  };

  const rounds = (apply?.rounds ?? []).map((r) => {
    const members = r.components.map(nameOf);
    return r.covered
      ? { round: r.round, members, covered: true, words: COVERED_WORDS, digest: r.covered.digest, filledInputs: r.covered.filledInputs }
      : { round: r.round, members, covered: false, words: "the re-plan needed an approval of its own", ...(r.notCovered ? { reason: r.notCovered } : {}) };
  });
  const coveredBy = new Map<string, { digest: string; filledInputs: string[] }>();
  for (const r of rounds) if (r.covered && r.digest) for (const m of r.members) coveredBy.set(m, { digest: r.digest, filledInputs: r.filledInputs ?? [] });

  answer.chant = { members: kinds, rounds };
  let progress: Record<string, unknown> | null = null;
  if (apply) {
    const waveState = apply.status === "applied" || apply.status === "wave-applied" ? "applied" : apply.status === "failed" ? "failed" : apply.status === "waiting" ? "waiting" : apply.status === "refused" ? "refused" : "planned";
    const members = apply.members.map((m) => ({
      root: m.member,
      module: m.member,
      apply: m.status === "applied" ? "applied" : m.status === "failed" ? "failed" : "not-started",
      ...(coveredBy.has(m.member) ? { covered: coveredBy.get(m.member) } : {}),
    }));
    const changed = apply.members.filter((m) => Object.values(m.counts).some((n) => n > 0) || m.status === "applied").map((m) => m.member);
    progress = {
      run: { commit: apply.head ?? "", key: "", present: true, updated: opts.applyAt ?? "9999-12-31T00:00:00.000Z" },
      states: [
        {
          number: 1,
          state: waveState,
          gate: apply.gate ?? "pr-apply",
          roots: ordered,
          reads: [],
          approval: apply.approval ?? undefined,
          digest: apply.digest,
          changed,
          composed: { roots: ordered, digest: apply.digest, unknown: memberRows.filter((m) => m.unknownInputs.length).map((m) => m.member), members },
        },
      ],
      reads: ordered.map((root) => ({ root, wave: 1, reads: upstreams[root] ?? [], composed: { wave: 1, module: root, own_wave: 1 } })),
      waves: [],
      cards: {},
      unmatched: [],
      watching: false,
    };
  }

  return {
    answer,
    progress,
    members: kinds,
    rounds,
  };
}
