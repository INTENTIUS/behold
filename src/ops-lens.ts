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
 *  - a ConvergeOp's rule table is one card per RULE, each carrying its `why`
 *    verbatim — see below
 *
 * ## The converge rule table (#234 join 4)
 *
 * A `ConvergeOp` (chant's temporal lexicon, `composites/converge-op.ts`) is an
 * ordinary Op whose Converge phase holds a single `convergeTick` activity, and
 * the composite bakes the whole rule table into that step's args. `op.json`
 * passes activity args through verbatim (`OpIRActivityStep.args`), so the table
 * arrives here as data, in the file this lens already reads — no new chant
 * surface, no subprocess.
 *
 * Each `ConvergeRule` is `{id, when, then, why, flapThreshold?}`, and chant
 * refuses at BUILD time a rule whose `id` or `why` is blank (`when()` throws,
 * and `ConvergeOp` re-checks). So "every rule carries its why" is a guarantee,
 * not a hope, and this lens can put the rationale on the card unconditionally:
 * that is the accessible-ops promise — "git blame answers why did it do that" —
 * with a UI. The text is shown VERBATIM. behold never paraphrases it.
 *
 * `when` is chant's JSON predicate language, not a closure: field comparisons
 * and truthiness checks over one `ConvergeSymptom`, composed with `all-of` /
 * `any-of`. {@link predicateText} renders it as the condition it states —
 * `status = "drifted" and deleteCount > 0` — reading the operator names chant
 * ships rather than inventing a query DSL behold would then have to defend.
 *
 * ## The one legitimate cross-link
 *
 * `then` is `{kind: "run", op}` or `{kind: "report", reason}`, and `RunAction.op`
 * names a DECLARED Op by name — chant's own TMP014 post-synth check refuses a
 * `run()` naming an Op the project doesn't declare. That makes rule → op the
 * first join in this lens that chant actually states, so a `run` rule draws an
 * edge to that Op's first step (`viaAttr: "run"`).
 *
 * It is still drawn only when the named Op is in the set being rendered. behold
 * composes op.json across every served project (#31, `discoverOpIrs`) and keeps
 * the first of a colliding name, so a converge Op can perfectly well be rendered
 * beside a set that doesn't hold its dispatch target — an unbuilt sibling, a
 * project this behold isn't serving. Then the rule says so on its own card
 * (`dangling`, painted `warn`) and no edge is drawn. Same rule `depends` already
 * follows: a reference behold can't resolve is stated, never guessed.
 *
 * ## Estate cross-links (chant#2022, chant ≥ 0.54.0)
 *
 * #284's inventory asked for "linking back to the estate nodes each phase
 * touches", and until 0.53.1 op.json could not support it: a step's args named
 * an ENVIRONMENT and a STACK, never an entity, and joining `stackName: "prod"`
 * to whatever the stack contained would have been behold inventing an edge
 * chant never stated. 0.54.0 answers the ask at the contract: an activity's
 * `ActivityContract.entities` names which of its args identify what the step
 * touches, and op.json resolves those args' literal string values into the
 * step's `entities` (`httpCheck` declares `url`; more contracts follow as the
 * lexicons declare them).
 *
 * `joinStepEntities` turns those into edges by exact match only: an entity
 * value that IS an estate node id, or that equals a string leaf of some node's
 * declared attrs (the same leaves src/value-match.ts joins on). Nothing is
 * parsed — a URL is not decomposed into a bucket name — so a value no node
 * carries verbatim stays on the card as an unresolved reference, stated, and
 * the note counts how many resolved. A resolved node is copied into the lens
 * in its own `estate` box so the dashed edge (pinhole draws a `viaAttr` edge
 * dashed) lands on the real card with its real glyph.
 */
import type { GraphIR, IRNode, IREdge } from "@intentius/chant";
import { stringLeaves } from "./value-match.ts";

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
  /** What this step touches in the estate (chant#2022): the literal string
   * values of the args its contract declares entity-identifying. Absent on a
   * pre-0.54 op.json, on an activity with no contract, or when the arg is a
   * step-output ref that resolves only at run time. */
  entities?: string[];
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

// ── A ConvergeOp's rule table, as it rides in `convergeTick`'s args ──────────
//
// chant's `ConvergeRule` / `SymptomPredicate` / `RuleAction`
// (`packages/core/src/op/converge-rule.ts`) mirrored structurally, on the same
// terms as the step shapes above: read leniently, and never re-derive a fact
// chant already states. `field` is `keyof ConvergeSymptom` upstream; here it is
// a string, because behold renders whatever field the rule names rather than
// keeping a copy of chant's symptom shape in step with it.

/** `field <op> value` — chant's `FieldComparisonPredicate`. */
export interface OpIrFieldComparison {
  kind: "field-comparison";
  field: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  value: string | number | boolean;
}

/** `field is truthy|falsy` — chant's `FieldTruthinessPredicate`, no value. */
export interface OpIrFieldTruthiness {
  kind: "field-truthiness";
  field: string;
  op: "truthy" | "falsy";
}

export interface OpIrAllOf {
  kind: "all-of";
  predicates: OpIrPredicate[];
}

export interface OpIrAnyOf {
  kind: "any-of";
  predicates: OpIrPredicate[];
}

/** A rule's `when` — chant's whole evaluable subset. There is deliberately no
 * escape hatch to an arbitrary expression upstream, so there is none here. */
export type OpIrPredicate = OpIrFieldComparison | OpIrFieldTruthiness | OpIrAllOf | OpIrAnyOf;

/** A rule's `then` — dispatch a declared Op, or report and stop. */
export type OpIrRuleAction = { kind: "run"; op: string } | { kind: "report"; reason: string };

/** One row of a ConvergeOp's rule table. `id` and `why` are required upstream —
 * chant refuses a blank one at build — so this lens treats both as present. */
export interface OpIrConvergeRule {
  id: string;
  when: OpIrPredicate;
  then: OpIrRuleAction;
  why: string;
  flapThreshold?: number;
}

/** A ConvergeOp's `convergeTick` args, as much of them as this lens reads. */
export interface ConvergeTable {
  /** The `convergeTick` step's own node id — what the rule cards hang off. */
  tickStepId: string;
  /** The phase the tick sits in, so the rule cards can name it. */
  phase: string;
  rules: OpIrConvergeRule[];
  /** How far the loop is allowed to go: `observe` | `reconcile` | `apply`. */
  dial?: string;
  /** How many dispatches one tick may make. */
  budget?: number;
  env?: string;
}

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

/**
 * One step as the lens places it — the node id its card carries, and where the
 * step sits in the Op.
 *
 * Exported so the run playhead (#284 item 2, src/run-playhead.ts) joins a run's
 * StepRecords to the very ids this lens draws instead of recomputing the id
 * rule and drifting from it. `phase` is flattened to its name (the run records
 * carry a phase NAME, not the phase object) and `parallel` rides along, because
 * a parallel phase's steps settle in no guaranteed order.
 */
export interface PlacedStep {
  id: string;
  step: OpIrStep;
  phase: string;
  parallel: boolean;
  when: "phases" | "onFailure";
}

/** {@link placeSteps}, flattened for readers outside this module. */
export function opPlacedSteps(op: OpIr): PlacedStep[] {
  return placeSteps(op).map((p) => ({
    id: p.id,
    step: p.step,
    phase: p.phase.name,
    parallel: Boolean(p.phase.parallel),
    when: p.when,
  }));
}

// ── The converge rule table ───────────────────────────────────────────────────

const RULE_BOX = (opName: string): string => `${opName} · rule table`;

/** A rule's own node id. `id` is chant's stable, unique-per-table identifier
 * (flap counters key on it, and `ConvergeOp` refuses duplicates at build), so it
 * needs no de-duplication pass the way a repeated step label does. */
const ruleId = (opName: string, rule: OpIrConvergeRule): string => `${opName}/rules/${rule.id}`;

const isPredicate = (v: unknown): v is OpIrPredicate => isRecord(v) && typeof v.kind === "string";

/** Is this value a rule chant would have emitted? `id`/`why`/`then` are all
 * required upstream and refused blank at build, so anything missing one is not a
 * rule table this lens should be drawing cards from. */
function isConvergeRule(v: unknown): v is OpIrConvergeRule {
  if (!isRecord(v)) return false;
  if (typeof v.id !== "string" || !v.id) return false;
  if (typeof v.why !== "string" || !v.why) return false;
  if (!isPredicate(v.when)) return false;
  const then = v.then;
  if (!isRecord(then)) return false;
  return (then.kind === "run" && typeof then.op === "string") || (then.kind === "report" && typeof then.reason === "string");
}

/**
 * The rule table one Op declares, or undefined for an Op that isn't a
 * ConvergeOp — which is every Op in a project that declares none, so this is
 * also what makes the whole feature cost nothing on such a project.
 *
 * Found by the `convergeTick` activity `fn`, which is how chant's own TMP014
 * check reads a rule table back off an Op: there is no dedicated `OpConfig`
 * field for it, the table travels as that step's args. `searchAttributes.Converge`
 * is the composite's marker but not a requirement here — a hand-written Op that
 * calls `convergeTick` runs the same activity against the same table, and
 * refusing to draw its rules because a search attribute is missing would hide a
 * real rule table behind a label.
 */
export function convergeTable(op: OpIr): ConvergeTable | undefined {
  for (const placed of placeSteps(op)) {
    const { step } = placed;
    if (step.kind !== "activity" || step.fn !== "convergeTick") continue;
    const rules = step.args?.rules;
    if (!Array.isArray(rules)) return undefined;
    const kept = rules.filter(isConvergeRule);
    if (!kept.length) return undefined;
    return {
      tickStepId: placed.id,
      phase: placed.phase.name,
      rules: kept,
      ...(typeof step.args?.dial === "string" ? { dial: step.args.dial } : {}),
      ...(typeof step.args?.budget === "number" ? { budget: step.args.budget } : {}),
      ...(typeof step.args?.env === "string" ? { env: step.args.env } : {}),
    };
  }
  return undefined;
}

/** How a comparison operator reads in the condition line. chant's own operator
 * names (`eq`, `gte`) are builder function names, not a rendering — the symbols
 * are what the predicate SAYS. */
const COMPARISON_TEXT: Readonly<Record<OpIrFieldComparison["op"], string>> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * One predicate as the condition it states — `status = "drifted" and
 * deleteCount > 0`.
 *
 * Rendered from the JSON, never re-parsed from the authoring source: the source
 * is TypeScript this lens never sees, and the JSON is the thing the tick will
 * actually evaluate. A string value keeps its quotes (a value, not a field
 * name); a number or boolean doesn't. A composite nested inside another is
 * parenthesised, because `a and b or c` states an order chant's tree does not.
 *
 * An EMPTY `all-of` / `any-of` is rendered as what `evaluatePredicate` does with
 * it — every() over nothing is true, some() over nothing is false — rather than
 * as a blank condition. Anything outside chant's four kinds says so plainly:
 * this lens does not guess at a predicate language it doesn't know.
 */
export function predicateText(predicate: OpIrPredicate): string {
  switch (predicate.kind) {
    case "field-comparison": {
      const op = COMPARISON_TEXT[predicate.op];
      if (!op) return `(unreadable comparison on ${predicate.field})`;
      const value = typeof predicate.value === "string" ? JSON.stringify(predicate.value) : String(predicate.value);
      return `${predicate.field} ${op} ${value}`;
    }
    case "field-truthiness":
      return `${predicate.field} is ${predicate.op}`;
    case "all-of":
    case "any-of": {
      const joiner = predicate.kind === "all-of" ? " and " : " or ";
      const parts = (predicate.predicates ?? []).filter(isPredicate);
      if (!parts.length) return predicate.kind === "all-of" ? "(always)" : "(never)";
      return parts
        .map((p) => (p.kind === "all-of" || p.kind === "any-of" ? `(${predicateText(p)})` : predicateText(p)))
        .join(joiner);
    }
    default:
      return "(predicate outside the kinds behold reads)";
  }
}

/** One action as the line the card shows. `report`'s reason is chant's own
 * text and rides verbatim, the same way `why` does. */
export function actionText(action: OpIrRuleAction): string {
  return action.kind === "run" ? `run(${action.op})` : `report: ${action.reason}`;
}

/**
 * How a rule paints.
 *
 * Nothing here has run — this is the declared table, not a tick — so no rule is
 * `good`. `accent` on a dispatching rule is the effect step's semantics exactly:
 * it MAY fire, and on a quiet tick fires not at all. A reporting rule never
 * mutates anything, so it stays `neutral`. `warn` is reserved for the rule whose
 * `then` names an Op that isn't here to draw an edge to — a dangling reference
 * is the one thing on this card a reader has to act on.
 */
export function ruleStatus(rule: OpIrConvergeRule, declared: ReadonlySet<string>): "neutral" | "warn" | "accent" {
  if (rule.then.kind !== "run") return "neutral";
  return declared.has(rule.then.op) ? "accent" : "warn";
}

function ruleNode(op: OpIr, table: ConvergeTable, rule: OpIrConvergeRule, declared: ReadonlySet<string>): IRNode {
  const dispatches = rule.then.kind === "run" && declared.has(rule.then.op) ? rule.then.op : undefined;
  const dangling = rule.then.kind === "run" && !declared.has(rule.then.op) ? rule.then.op : undefined;
  return {
    id: ruleId(op.name, rule),
    // The card's kind, as an activity's is its `fn`: a converge rule is what
    // this is, and the whole table reads as one kind of thing in the track.
    kind: "ConvergeRule",
    lexicon: "op",
    attrs: {
      _status: ruleStatus(rule, declared),
      _step: "rule",
      rule: rule.id,
      op: op.name,
      phase: table.phase,
      // The condition, the action, and the rationale — the three columns a rule
      // table has. `why` is chant's required field, verbatim: the accessible-ops
      // promise is that the answer to "why did it do that" is already written
      // down, so behold's job is to show it, not to summarise it.
      when: predicateText(rule.when),
      then: actionText(rule.then),
      why: rule.why,
      ...(dispatches ? { dispatches } : {}),
      // A `then` naming an Op that isn't in this set: stated, not guessed at.
      // chant's TMP014 refuses a run() naming an Op the PROJECT doesn't declare,
      // so this is behold's own composition boundary showing through, and saying
      // which one it is beats an edge into nowhere.
      ...(dangling
        ? { dangling: `${dangling} — not among the Ops rendered here, so no edge is drawn` }
        : {}),
      // `flapThreshold` absent means chant's own default applies. Named the way
      // a gate's unset timeout is, rather than restating a number chant owns.
      flap: rule.flapThreshold !== undefined ? `${rule.flapThreshold} consecutive ticks` : "(chant default)",
      ...(table.dial ? { dial: table.dial } : {}),
    },
  };
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
      // (env, stack, template path); which of them identify an ENTITY is the
      // contract's to say, and 0.54's op.json says it in `entities` below.
      ...(args ? { args } : {}),
      // chant#2022: what the step touches, verbatim. `entities` prints on the
      // card; `_entities` is what `joinStepEntities` resolves.
      ...(step.entities?.length ? { entities: step.entities.join(", "), _entities: step.entities } : {}),
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
  /** Every Op name in THIS set — what a converge rule's `run` resolves against.
   * Known up front so a rule card can paint a dangling reference correctly on
   * the first pass, whatever order the Ops arrived in. */
  const declared = new Set(ops.map((o) => o.name));
  /** Rule card -> the Op its `then` dispatches, resolved with `depends` below,
   * once every Op's first step is known. */
  const dispatches: Array<{ from: string; op: string }> = [];

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

    // A ConvergeOp's rule table (#234 join 4). One card per rule, in declared
    // order, in its own box beside the track — the rules are what the tick
    // evaluates, not steps the run walks through, and boxing them with the
    // phase would claim an ordering the tick doesn't have. An Op declaring no
    // rule table adds nothing: no node, no edge, no box.
    const table = convergeTable(op);
    if (!table) continue;
    for (const rule of table.rules) {
      const node = ruleNode(op, table, rule, declared);
      nodes.push(node);
      (byStack[RULE_BOX(op.name)] ??= []).push(node.id);
      // The table hangs off the step that carries it, so a reader follows the
      // Op's own track into its rules rather than finding them floating.
      edges.push({ from: table.tickStepId, to: node.id, kind: "ref", viaAttr: "rule" });
      if (rule.then.kind === "run") dispatches.push({ from: node.id, op: rule.then.op });
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

  // rule → op `then: run(<op>)` — the ops view's one legitimate cross-link, and
  // the only edge in this lens that leaves the Op it was declared in for a
  // reason chant states rather than one behold inferred. Drawn to the dispatched
  // Op's FIRST step, because that is what `chant run <op>` starts. Dropped when
  // the Op isn't in this set; the rule card already says so (`dangling`).
  for (const { from, op } of dispatches) {
    const target = endpoints.get(op);
    if (!target) continue;
    for (const to of target.first) edges.push({ from, to, kind: "ref", viaAttr: "run" });
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
  const declared =
    step === "gate"
      ? [
          { label: "gate", value: String(node.attrs.gate ?? "") },
          { label: "timeout", value: String(node.attrs.timeout ?? "") },
        ]
      : step === "effect"
        ? [
            { label: "effect", value: String(node.attrs.effect ?? "") },
            ...(phase ? [{ label: "phase", value: phase }] : []),
          ]
        : step === "activity"
          ? [
              ...(phase ? [{ label: "phase", value: phase }] : []),
              ...(typeof node.attrs.profile === "string" ? [{ label: "profile", value: node.attrs.profile }] : []),
            ]
          : // A converge rule card leads with the two columns that make it a
            // rule — the condition and what it does about it. `why` is the long
            // one and belongs in the inspect pane, where it reads in full
            // rather than being cut to fit a card.
            step === "rule"
            ? [
                { label: "when", value: String(node.attrs.when ?? "") },
                { label: "then", value: String(node.attrs.then ?? "") },
              ]
            : undefined;
  if (!declared) return undefined;
  // The playhead (#284 item 2, src/run-playhead.ts) leads when there IS run
  // state: once a step has settled, what it did outranks what it was declared
  // as. Nothing paints `run` on an unrun track, so this is purely additive.
  const run = typeof node.attrs.run === "string" ? node.attrs.run : undefined;
  return run ? [{ label: "run", value: run }, ...declared.slice(0, 1)] : declared;
}

/**
 * The one-line summary the server puts on `meta.note` — the statusbar's honesty
 * about what this graph is, including the cross-link chant can't support yet.
 */
export function opsNote(ops: OpIr[], ir: GraphIR): string {
  const gates = ir.nodes.filter((n) => n.attrs._step === "gate").length;
  const rules = ir.nodes.filter((n) => n.attrs._step === "rule");
  // Estate nodes a step's entities resolved to (chant#2022) sit in the lens
  // but are not steps either.
  const estate = ir.nodes.filter((n) => n.lexicon !== "op").length;
  // Rule cards are not steps — count them apart, so a project that declares a
  // ConvergeOp doesn't report its rule table as extra track.
  const steps = ir.nodes.length - rules.length - estate;
  const dangling = rules.filter((n) => n.attrs.dangling !== undefined).length;
  const counts = [
    `${ops.length} declared Op${ops.length === 1 ? "" : "s"}`,
    `${steps} step${steps === 1 ? "" : "s"}`,
    ...(gates ? [`${gates} gate${gates === 1 ? "" : "s"}`] : []),
    ...(rules.length ? [`${rules.length} converge rule${rules.length === 1 ? "" : "s"}`] : []),
    ...entityCountClause(ir),
  ].join(" · ");
  // The rule table's own sentence, present only for a project that declares one
  // — an estate with no ConvergeOp reads exactly the note it read before.
  const ruleNote = rules.length
    ? ` Each converge rule carries the why chant requires of it, verbatim, and a rule whose then is run(<op>) is drawn as an edge to that Op's first step.` +
      (dangling
        ? ` ${dangling} rule${dangling === 1 ? " names an Op" : "s name Ops"} not in this set — stated on the card, not drawn.`
        : "")
    : "";
  return (
    `${counts}, from each Op's emitted dist/ops/<name>/op.json.${ruleNote} ` +
    `No estate cross-links: op.json names an Op's env and stack but never an estate entity id, ` +
    `so nothing here is joined to the graph's nodes (chant ask). ` +
    `Read-only: this renders the declared Op — nothing is started, signalled, or applied.`
  );
}

// ── Estate cross-links (chant#2022) ──────────────────────────────────────────

export const ESTATE_BOX = "estate";

/** What a step's entity references resolved to — the `_entityLinks` attr the
 * inspect pane reads. Every declared value lands in exactly one list. */
export interface EntityLinks {
  resolved: Array<{ value: string; node: string; via: "id" | "attr" }>;
  unresolved: string[];
}

/**
 * Join each step's `_entities` onto `estate`'s nodes, in place, and return how
 * many references there were and how many resolved.
 *
 * The rule is exact match and nothing looser: a value that is a node id, or
 * that equals one of a node's declared string leaves. A value several nodes
 * carry joins to all of them — that is what the value says. A value nothing
 * carries is kept on the step as unresolved, never guessed at. With no estate
 * (`undefined` — the read was unavailable) every reference is unresolved and
 * the lens is exactly what it was.
 */
export function joinStepEntities(ir: GraphIR, estate: GraphIR | undefined): { refs: number; resolved: number } {
  const steps = ir.nodes.filter((n) => Array.isArray(n.attrs._entities));
  if (steps.length === 0) return { refs: 0, resolved: 0 };

  const byId = new Map<string, IRNode>();
  const byLeaf = new Map<string, IRNode[]>();
  for (const n of estate?.nodes ?? []) {
    byId.set(n.id, n);
    for (const leaf of stringLeaves(n.attrs)) {
      const list = byLeaf.get(leaf.value);
      if (list) {
        if (!list.includes(n)) list.push(n);
      } else byLeaf.set(leaf.value, [n]);
    }
  }

  const present = new Set(ir.nodes.map((n) => n.id));
  let refs = 0;
  let resolvedCount = 0;
  for (const step of steps) {
    const links: EntityLinks = { resolved: [], unresolved: [] };
    for (const value of step.attrs._entities as string[]) {
      refs++;
      const targets: Array<{ node: IRNode; via: "id" | "attr" }> = [];
      const idHit = byId.get(value);
      if (idHit) targets.push({ node: idHit, via: "id" });
      for (const n of byLeaf.get(value) ?? []) if (n !== idHit) targets.push({ node: n, via: "attr" });
      if (targets.length === 0) {
        links.unresolved.push(value);
        continue;
      }
      resolvedCount++;
      for (const { node, via } of targets) {
        links.resolved.push({ value, node: node.id, via });
        if (!present.has(node.id)) {
          present.add(node.id);
          // The estate card itself, copied whole so it renders with its own
          // glyph and attrs — plus who touches it, for the pane.
          ir.nodes.push({ ...node, attrs: { ...node.attrs, _touchedBy: [step.id] } });
          (ir.groups.byStack ??= {})[ESTATE_BOX] = [...(ir.groups.byStack[ESTATE_BOX] ?? []), node.id];
        } else {
          const held = ir.nodes.find((n) => n.id === node.id)!;
          const touched = (held.attrs._touchedBy as string[] | undefined) ?? [];
          if (!touched.includes(step.id)) held.attrs._touchedBy = [...touched, step.id];
        }
        ir.edges.push({ from: step.id, to: node.id, kind: "ref", viaAttr: "entities" });
      }
    }
    step.attrs._entityLinks = links;
  }
  return { refs, resolved: resolvedCount };
}

/** The note's clause for entity references, or nothing when no step declares any. */
function entityCountClause(ir: GraphIR): string[] {
  let refs = 0;
  let resolved = 0;
  for (const n of ir.nodes) {
    const links = n.attrs._entityLinks as EntityLinks | undefined;
    if (links) {
      refs += links.resolved.length + links.unresolved.length;
      resolved += links.resolved.length;
    } else if (Array.isArray(n.attrs._entities)) {
      refs += (n.attrs._entities as string[]).length;
    }
  }
  if (refs === 0) return [];
  return [`${refs} entity ref${refs === 1 ? "" : "s"}, ${resolved} linked`];
}
