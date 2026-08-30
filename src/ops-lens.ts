/**
 * The ops lens (#284 item 1) — render a chant project's DECLARED Ops as a
 * behold graph.
 *
 * "An op is chant source; behold renders chant source." Since chant 0.50
 * (chant#1289) every `chant build` writes `dist/ops/<name>/op.json` beside the
 * generated `workflow.ts`: a portable, engine-neutral restatement of the
 * `OpConfig` with every step's `profile` and every gate's `timeout` resolved to
 * its effective value, the referenced activity retry/timeout profiles riding
 * along, and (where the lexicon registered a contract) each activity's args and
 * returns as JSON Schema. So the declared DAG is already inert JSON, and this
 * module is the same thing src/carve-lens.ts is for a peelability report: a
 * pure conversion into the `GraphIR` the existing painter and SPA draw. No new
 * frontend, no chant subprocess — behold reads a file the build already wrote.
 *
 * What the picture says:
 *  - one card per STEP, `kind` = the activity's `fn` (`awsApply`, `httpCheck`)
 *    so pinhole's keyword glyph heuristic and the inspect pane's identity block
 *    both get the real name, lexicon `op`
 *  - one boundary box per `<op> · <phase>` (`groups.byStack`), in declared
 *    order, so the graph reads as the ordered phase track it is
 *  - edges chain the steps in declared order (`viaAttr: "then"`). A `parallel`
 *    phase does not chain internally: its predecessor fans out to every step
 *    and they all converge on the successor, which is what `parallel` means
 *  - op → op `depends` becomes an edge from the depended-on Op's last step(s)
 *    to the depending Op's first step(s) (`viaAttr: "depends"`), so several Ops
 *    render as one DAG. `depends` naming an Op this project didn't emit draws
 *    nothing rather than minting a phantom card
 *  - a gate is its own card, `_status: "warn"`, carrying the step it guards —
 *    the pause is a mark in the track, not a badge hidden on a neighbour
 *
 * ## No estate cross-links, and why this doesn't guess one
 *
 * #284's inventory asked for "linking back to the estate nodes each phase
 * touches". op.json cannot support it yet. Across every Op example-writes
 * declares, the union of activity args is `env`, `stackName`, `templatePath`,
 * `target`, `output`, `path`, `script`, `deleteMode`, `mode`, `owned`, `live`,
 * `endpoint`, `url` — and the union of registered contract args adds only
 * `method`, `status`, `contains`, `retries`, `intervalMs`. Not one of them is a
 * chant IR node id. A step says which ENVIRONMENT and which STACK it acts on;
 * it never says which entity. Joining `stackName: "prod"` to the bucket the
 * stack happens to contain would be behold inventing an edge chant never
 * stated — the same mistake #234 records — so this lens draws none, surfaces
 * the scope facts it does have as attrs, and {@link opsNote} says so on the
 * statusbar. The remedy is a chant-side ask, not a heuristic here.
 */
import type { GraphIR, IRNode, IREdge } from "@intentius/chant";

// ── The op.json shape, as much of it as this lens reads ───────────────────────
//
// Deliberately structural and lenient, the way src/carve-lens.ts reads a carve
// report: a renderer that demands more than it uses breaks on the first
// additive field the producer ships. chant's own `OpIR` (its temporal lexicon's
// `op/op-ir.ts`) is the authority for the full shape.

/** One activity step — `profile` already resolved to its effective value. */
export interface OpIrActivityStep {
  kind: "activity";
  fn: string;
  args?: Record<string, unknown>;
  profile?: string;
  outcomeAttribute?: { name: string; from?: string };
}

/** A human gate — `timeout` already resolved to its effective value. */
export interface OpIrGateStep {
  kind: "gate";
  signalName: string;
  timeout?: string;
  description?: string;
}

/** Read-compare-run-write over an effect receipt (chant#1834). Its nested steps
 * stay inside the one card — an effect either fires whole or is skipped whole,
 * so drawing its internals as track members would claim an ordering the run
 * may never take. */
export interface OpIrEffectStep {
  kind: "effect";
  receipt?: { name?: string } | string;
  expectation?: string;
  description?: string;
  steps?: Array<OpIrActivityStep | OpIrGateStep>;
}

export type OpIrStep = OpIrActivityStep | OpIrGateStep | OpIrEffectStep;

export interface OpIrPhase {
  name: string;
  parallel?: boolean;
  steps: OpIrStep[];
}

/** One activity profile's retry/timeout policy, carried so a reader never has
 * to know what chant means by "fastIdempotent". */
export interface OpIrProfile {
  startToCloseTimeout?: string;
  heartbeatTimeout?: string;
  retry?: { maximumAttempts?: number; initialInterval?: string; backoffCoefficient?: number };
}

/** One emitted `dist/ops/<name>/op.json`. */
export interface OpIr {
  /** chant's own IR schema version. See {@link SUPPORTED_MAJOR}. */
  formatVersion?: string;
  name: string;
  overview?: string;
  taskQueue?: string;
  namespace?: string;
  depends?: string[];
  searchAttributes?: Record<string, string>;
  phases: OpIrPhase[];
  onFailure?: OpIrPhase[];
  activityProfiles?: Record<string, OpIrProfile>;
  activityContracts?: Record<string, { args?: unknown; returns?: unknown }>;
}

/** The one schema major this lens knows how to read (chant's `OP_IR_FORMAT_VERSION`). */
const SUPPORTED_MAJOR = 1;

/** A refusal: why the file isn't an op.json, and what to do instead. #193's
 * structured-error standard — `{error, code, remedy}`, the shape the SPA's
 * precondition card renders and the CLI prints. */
export interface OpsRefusal {
  error: string;
  code: "op-ir";
  remedy: string;
}

export type OpIrParse = { ok: true; ir: OpIr } | { ok: false; refusal: OpsRefusal };

const refuse = (error: string, remedy: string): OpIrParse => ({ ok: false, refusal: { error, code: "op-ir", remedy } });

/** The remedy every shape refusal ends with — where a real op.json comes from. */
export const HOW_TO_EMIT =
  "Build the project with a chant >= 0.50 (`chant build --lexicon temporal`), which writes " +
  "`dist/ops/<name>/op.json` beside each Op's generated workflow.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate an already-parsed JSON value as an op.json, or refuse politely.
 *
 * Shape before version, for carve-lens's reason: plenty of JSON files carry a
 * version, and "behold reads version 1" is a baffling thing to say about a file
 * that was never an op.json at all. An ABSENT `formatVersion` is accepted — the
 * field is chant's to add, and refusing over a missing one would make this lens
 * stricter than the contract it doesn't own.
 */
export function parseOpIr(value: unknown): OpIrParse {
  if (!isRecord(value)) {
    return refuse("That file isn't an op.json — its top level isn't a JSON object.", HOW_TO_EMIT);
  }
  if (typeof value.name !== "string" || !Array.isArray(value.phases)) {
    return refuse(
      "That JSON doesn't look like an op.json — it needs a string `name` and a `phases` array.",
      HOW_TO_EMIT,
    );
  }
  const bad = (value.phases as unknown[]).findIndex((p) => !isRecord(p) || typeof p.name !== "string" || !Array.isArray(p.steps));
  if (bad >= 0) {
    return refuse(
      `That JSON has a \`phases\` array, but entry ${bad} isn't a phase (needs a string \`name\` and a \`steps\` array).`,
      HOW_TO_EMIT,
    );
  }
  const version = value.formatVersion;
  if (version !== undefined) {
    const major = Number(String(version).split(".")[0]);
    if (!Number.isFinite(major) || major !== SUPPORTED_MAJOR) {
      return refuse(
        `This op.json declares format version ${String(version)}; behold reads version ${SUPPORTED_MAJOR}.`,
        "Upgrade behold, or render the Op with a behold that speaks its version.",
      );
    }
  }
  return { ok: true, ir: value as unknown as OpIr };
}

/** Read + parse one op.json, refusing politely on anything unreadable. */
export function readOpIr(path: string, readFile: (p: string) => string): OpIrParse {
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    return refuse(`Couldn't read ${path}: ${err instanceof Error ? err.message : String(err)}`, HOW_TO_EMIT);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return refuse(`${path} isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`, HOW_TO_EMIT);
  }
  return parseOpIr(json);
}

// ── Step naming ───────────────────────────────────────────────────────────────

/** The receipt an effect step writes, however the IR spells it. */
function receiptName(step: OpIrEffectStep): string {
  const r = step.receipt;
  if (typeof r === "string") return r;
  return (r && typeof r.name === "string" && r.name) || "effect";
}

/**
 * A step's own name within its phase — the last segment of the node id, and the
 * word the inspect pane's identity block shows. An activity is its `fn`; a gate
 * and an effect are prefixed, because `approve-promote` on its own reads as
 * another activity in the track.
 */
export function stepLabel(step: OpIrStep): string {
  if (step.kind === "gate") return `gate:${step.signalName}`;
  if (step.kind === "effect") return `effect:${receiptName(step)}`;
  return step.fn;
}

/**
 * The card's `kind` — pinhole's glyph heuristic and the inspect pane both read
 * it. An activity's `fn` is the real type name here (`awsApply`, `httpCheck`),
 * exactly as a Terraform type is on a carve card.
 */
export function stepKind(step: OpIrStep): string {
  if (step.kind === "gate") return "Gate";
  if (step.kind === "effect") return "Effect";
  return step.fn;
}

/**
 * How a step paints.
 *
 * Nothing here has run — this is the DECLARED Op, not a run — so no step is
 * `good`. `warn` on a gate is the mark #284 asks for: the one place the Op
 * stops for a human. `accent` on an effect says "may not fire at all": an
 * effect step whose receipt already matches is skipped whole.
 */
export function stepStatus(step: OpIrStep): "neutral" | "warn" | "accent" {
  return step.kind === "gate" ? "warn" : step.kind === "effect" ? "accent" : "neutral";
}

/** A step's args as one readable line — `env=prod, live=true`. Non-scalars
 * (a nested bag, a `step-output-ref` placeholder) are JSON, not flattened:
 * losing the structure would make an arg unreadable rather than short. */
function argsLine(args: Record<string, unknown> | undefined): string | undefined {
  const entries = Object.entries(args ?? {});
  if (!entries.length) return undefined;
  return entries
    .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(", ");
}

/** A profile's policy in one line — what "fastIdempotent" actually means, which
 * is the whole reason chant carries `activityProfiles` in the IR. */
function profileLine(p: OpIrProfile | undefined): string | undefined {
  if (!p) return undefined;
  const parts: string[] = [];
  if (p.startToCloseTimeout) parts.push(`${p.startToCloseTimeout} start-to-close`);
  if (p.heartbeatTimeout) parts.push(`${p.heartbeatTimeout} heartbeat`);
  if (p.retry?.maximumAttempts) parts.push(`${p.retry.maximumAttempts} attempts`);
  if (p.retry?.initialInterval) parts.push(`from ${p.retry.initialInterval}`);
  return parts.length ? parts.join(", ") : undefined;
}

// ── The conversion ────────────────────────────────────────────────────────────

/** A phase list flattened to placed steps, keeping the declared order and which
 * box each step belongs to. */
interface Placed {
  id: string;
  step: OpIrStep;
  phase: OpIrPhase;
  /** `phases` or `onFailure` — the two lists an Op declares. */
  when: "phases" | "onFailure";
  box: string;
}

/** Flatten one Op's two phase lists into placed steps with unique node ids.
 * A phase repeating the same step (two `httpCheck`s in one Verify) gets a `#n`
 * suffix rather than one card standing for both. */
function placeSteps(op: OpIr): Placed[] {
  const out: Placed[] = [];
  const lists: Array<[OpIrPhase[], Placed["when"]]> = [
    [op.phases ?? [], "phases"],
    [op.onFailure ?? [], "onFailure"],
  ];
  const used = new Set<string>();
  for (const [phases, when] of lists) {
    for (const phase of phases) {
      const box = when === "onFailure" ? `${op.name} · onFailure: ${phase.name}` : `${op.name} · ${phase.name}`;
      for (const step of phase.steps ?? []) {
        let id = `${op.name}/${phase.name}/${stepLabel(step)}`;
        for (let n = 2; used.has(id); n += 1) id = `${op.name}/${phase.name}/${stepLabel(step)}#${n}`;
        used.add(id);
        out.push({ id, step, phase, when, box });
      }
    }
  }
  return out;
}

function nodeFor(op: OpIr, placed: Placed, guards: string | undefined): IRNode {
  const { step, phase, when } = placed;
  const common = {
    op: op.name,
    phase: phase.name,
    ...(phase.parallel ? { parallel: true } : {}),
    ...(when === "onFailure" ? { when: "onFailure" } : {}),
  };
  if (step.kind === "gate") {
    return {
      id: placed.id,
      kind: stepKind(step),
      lexicon: "op",
      attrs: {
        _status: stepStatus(step),
        _step: "gate",
        gate: step.signalName,
        timeout: step.timeout ?? "(chant default)",
        ...common,
        ...(step.description ? { description: step.description } : {}),
        // "gates drawn as their own marks on the step they guard" (#284): the
        // gate names what it holds back, so the pause reads from the gate card
        // without hunting for the next one in the track.
        ...(guards ? { guards } : {}),
      },
    };
  }
  if (step.kind === "effect") {
    return {
      id: placed.id,
      kind: stepKind(step),
      lexicon: "op",
      attrs: {
        _status: stepStatus(step),
        _step: "effect",
        effect: receiptName(step),
        ...common,
        ...(step.expectation !== undefined ? { expectation: String(step.expectation) } : {}),
        ...(step.description ? { description: step.description } : {}),
        // The nested steps, named but not drawn — see OpIrEffectStep's doc.
        ...(step.steps?.length ? { runs: step.steps.map(stepLabel).join(" → ") } : {}),
      },
    };
  }
  const profile = step.profile;
  const policy = profileLine(profile ? op.activityProfiles?.[profile] : undefined);
  const args = argsLine(step.args);
  return {
    id: placed.id,
    kind: stepKind(step),
    lexicon: "op",
    attrs: {
      _status: stepStatus(step),
      _step: "activity",
      fn: step.fn,
      ...common,
      ...(profile ? { profile } : {}),
      ...(policy ? { policy } : {}),
      // The resolved args, verbatim from the IR. They carry the Op's SCOPE
      // (env, stack, template path) and never an estate entity id — see the
      // module doc on why no edge is drawn from them.
      ...(args ? { args } : {}),
      ...(step.outcomeAttribute
        ? { outcome: step.outcomeAttribute.from ? `${step.outcomeAttribute.name} ← ${step.outcomeAttribute.from}` : step.outcomeAttribute.name }
        : {}),
      ...(op.activityContracts?.[step.fn] ? { contract: "declared (args/returns JSON Schema in op.json)" } : {}),
    },
  };
}

/**
 * The steps that start and end one phase list's track, for chaining. A
 * `parallel` phase has every step at both ends of itself; a sequential phase
 * has one at each.
 */
function chainPhases(placed: Placed[], when: Placed["when"]): Array<{ heads: string[]; tails: string[] }> {
  const byPhase: Array<{ phase: OpIrPhase; ids: string[] }> = [];
  for (const p of placed) {
    if (p.when !== when) continue;
    const last = byPhase[byPhase.length - 1];
    if (last && last.phase === p.phase) last.ids.push(p.id);
    else byPhase.push({ phase: p.phase, ids: [p.id] });
  }
  return byPhase.map(({ phase, ids }) =>
    phase.parallel ? { heads: ids, tails: ids } : { heads: ids.slice(0, 1), tails: ids.slice(-1) },
  );
}

/**
 * Convert one or many emitted op.json files into a graph IR.
 *
 * Pure — the file reading lives in src/ops.ts (discovery) and the route. Ops
 * are converted in the order given; the caller sorts (src/ops.ts discovers by
 * name), so the box order is stable across requests.
 */
export function opsToIr(ops: OpIr[]): GraphIR {
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const byStack: Record<string, string[]> = {};
  /** Op name -> its main track's first/last steps, for the `depends` pass. */
  const endpoints = new Map<string, { first: string[]; last: string[] }>();

  for (const op of ops) {
    const placed = placeSteps(op);
    for (let i = 0; i < placed.length; i += 1) {
      const p = placed[i];
      // The step a gate holds back: the next one in the same phase list. A gate
      // that ends its Op guards nothing, and says nothing rather than pointing
      // at the next Op's first step, which it does not gate.
      const next = placed[i + 1];
      const guards = p.step.kind === "gate" && next && next.when === p.when ? stepLabel(next.step) : undefined;
      nodes.push(nodeFor(op, p, guards));
      (byStack[p.box] ??= []).push(p.id);
    }

    for (const when of ["phases", "onFailure"] as const) {
      const track = chainPhases(placed, when);
      for (let i = 0; i + 1 < track.length; i += 1) {
        for (const from of track[i].tails) {
          for (const to of track[i + 1].heads) edges.push({ from, to, kind: "ref", viaAttr: "then" });
        }
      }
      // onFailure is a compensation track, not a continuation — it is
      // deliberately left unattached to the main one.
      if (when === "phases" && track.length) {
        endpoints.set(op.name, { first: track[0].heads, last: track[track.length - 1].tails });
      }
    }
  }

  // op → op `depends` — the only edge an OpConfig states explicitly. Drawn last
  // so every Op's endpoints are known, and dropped when the depended-on Op
  // isn't in this set rather than minting a phantom card (carve-lens's rule).
  for (const op of ops) {
    const mine = endpoints.get(op.name);
    if (!mine) continue;
    for (const dep of op.depends ?? []) {
      const theirs = endpoints.get(dep);
      if (!theirs) continue;
      for (const from of theirs.last) {
        for (const to of mine.first) edges.push({ from, to, kind: "ref", viaAttr: "depends" });
      }
    }
  }

  return { nodes, edges, groups: { byStack } };
}

/** The two fields an Op step's card shows (pinhole presentation pack, registered
 * in src/render.ts) — pinned, because pinhole's default template otherwise picks
 * the first two short scalar attrs in ALPHABETICAL order, which on an activity
 * is `args` then `fn` and buries the phase the track is read by. */
export function opCardFields(node: { attrs: Record<string, unknown> }): Array<{ label: string; value: string }> | undefined {
  const step = node.attrs._step;
  const phase = typeof node.attrs.phase === "string" ? node.attrs.phase : undefined;
  if (step === "gate") {
    return [
      { label: "gate", value: String(node.attrs.gate ?? "") },
      { label: "timeout", value: String(node.attrs.timeout ?? "") },
    ];
  }
  if (step === "effect") {
    return [
      { label: "effect", value: String(node.attrs.effect ?? "") },
      ...(phase ? [{ label: "phase", value: phase }] : []),
    ];
  }
  if (step !== "activity") return undefined;
  return [
    ...(phase ? [{ label: "phase", value: phase }] : []),
    ...(typeof node.attrs.profile === "string" ? [{ label: "profile", value: node.attrs.profile }] : []),
  ];
}

/**
 * The one-line summary the server puts on `meta.note` — the statusbar's honesty
 * about what this graph is, including the cross-link chant can't support yet.
 */
export function opsNote(ops: OpIr[], ir: GraphIR): string {
  const gates = ir.nodes.filter((n) => n.attrs._step === "gate").length;
  const counts = [
    `${ops.length} declared Op${ops.length === 1 ? "" : "s"}`,
    `${ir.nodes.length} step${ir.nodes.length === 1 ? "" : "s"}`,
    ...(gates ? [`${gates} gate${gates === 1 ? "" : "s"}`] : []),
  ].join(" · ");
  return (
    `${counts}, from each Op's emitted dist/ops/<name>/op.json. ` +
    `No estate cross-links: op.json names an Op's env and stack but never an estate entity id, ` +
    `so nothing here is joined to the graph's nodes (chant ask). ` +
    `Read-only: this renders the declared Op — nothing is started, signalled, or applied.`
  );
}
