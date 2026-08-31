/**
 * The operator strip (#234 join 3) and the converge gate card (#234 join 1) —
 * what behold can honestly say about a chant project's *operating loop*.
 *
 * chant 0.52 ships a native durable-tick operator (chant#1485, epic #1487): a
 * `ConvergeOp` is an Op whose `searchAttributes.Converge === "true"`, ticked by
 * `chant operator` (or a cron, a systemd timer, an `OperatorStack` CronJob),
 * each tick writing one immutable record to the converge ledger. One CLI reads
 * that back — `chant operator status --json` — and this module is the parse and
 * the two models it feeds.
 *
 * ## A strip, not a lane, and why
 *
 * `readConvergeLedger(env)` (chant's `lifecycle/converge-ledger.ts`) returns
 * EVERY tick record, oldest first. Its one CLI caller keeps `ownRecords.at(-1)`
 * and throws the rest away (`cli/handlers/operator.ts:125`), so
 * `operator status --json` answers with exactly one tick per ConvergeOp. There
 * is no `chant operator log`, no `--history`. The history exists — append-only,
 * on the project's own `chant/lifecycle` orphan branch — but reaching it would
 * pin behold to that branch's name, its path convention and an encoding nobody
 * promised. Filed as chant#2029.
 *
 * So this renders a STRIP: one line, honestly dated, per ConvergeOp. Not a
 * timeline. {@link operatorNote} says so on the statusbar, and nothing here ever
 * produces more than one tick's worth of anything — a two-element array of ticks
 * is not a shape this module can build.
 *
 * ## The converge gate is not the run gate
 *
 * behold now draws two gate cards and they are different things:
 *
 *  - The **Temporal run gate** (`src/run-playhead.ts`) — a `gateState` query on
 *    a durable workflow, resolved by `chant run signal <op> <gate>`, which
 *    actually releases the waiting workflow. That is #284 item 2's card.
 *  - The **converge gate** (this module) — a `ConvergeRuleOutcome` with
 *    `action: "gated"`, resolved by `chant approve <op> <gate>`, which writes a
 *    fact to the gate ledger and **does not unblock anything**. chant's own
 *    `lifecycle/gate-ledger.ts` doc is explicit: it "does not (v1) retroactively
 *    make a gated op's local dispatch succeed — the local executor still refuses
 *    any op containing a gate outright", and `chant approve` prints that
 *    verbatim on success.
 *
 * Both cards therefore name their loop out loud ({@link CONVERGE_GATE_LOOP}),
 * and the converge card states the recorded-fact semantics in the card body
 * rather than hiding it in a tooltip. An Approve button that implied an unblock
 * would be the picture lying about what the click did.
 *
 * ## What the status read does NOT carry
 *
 *  - **No URL.** chant#1485 argued gate-as-fact partly for "a URL, a review
 *    surface, and CODEOWNERS as the authorization model". What shipped puts an
 *    optional PR link in the *resolution* record's free-text `note`, after the
 *    fact. The PENDING gate — the one a human acts on — has no address at all.
 *    Filed as chant#2028. behold renders no link and no placeholder for one.
 *  - **No resolution.** `pendingGates` is computed by cross-reading
 *    `readGateResolutions` against the gated tick's timestamp
 *    (`latestResolutionSince`), and a RESOLVED gate is simply absent from the
 *    array. `resolvedBy`/`timestamp` never reach the JSON. So behold shows no
 *    resolved-by line — there is nothing to show, and synthesizing one from
 *    "the gate stopped being listed" would attribute an approval to nobody.
 *
 * ## What it started carrying in chant 0.53.1 (chant#2027)
 *
 * The tick record grew two optional fields, and `statusFor` hands the whole
 * record through untouched (`cli/handlers/operator.ts`: `lastTick =
 * ownRecords.at(-1)`, spread onto the row as-is), so both arrive verbatim at
 * `chant operator status --json`'s `[].lastTick`:
 *
 *  - `[].lastTick.components[]` — the per-component verdicts the tick already
 *    derived, `{component, reconciliation, detail, live?, unobserved?}`, keyed
 *    by COMPONENT NAME. That is the same key `chant components status --live
 *    --json` emits and the same one src/component-status.ts's
 *    `joinComponentStatus` already joins onto component-DAG node ids, so the
 *    verdicts join to behold's IR without inventing a mapping — see
 *    {@link tickComponentVerdicts} and `joinTickVerdicts`.
 *  - `[].lastTick.id` — a stable tick id, so a tick is something a reader can
 *    point at rather than an `(op, env, timestamp)` triple.
 *
 * Both are optional on the record, and a `version: 1` ledger written before
 * 0.53.1 has neither. Absent is not "no components" and not "no id": every
 * path here reads absence as "this chant didn't say", never as a claim.
 */

import type { GraphIR, IRNode, ComponentStatusRow } from "@intentius/chant";
import type { GlyphSpec } from "@intentius/pinhole";

// ── chant's shapes, mirrored ─────────────────────────────────────────────────
//
// `OpStatusLine` is a local interface in chant's `cli/handlers/operator.ts` and
// is not exported at all; `ConvergeTickRecord` and `GateResolutionRecord` live
// under `lifecycle/` and aren't on `@intentius/chant`'s public index either.
// Mirrored here field-for-field on src/run-playhead.ts's precedent for
// `StepRecord`: don't reach past a package's declared public export surface for
// an internal type. Verified against chant `8f280b7e`.

/** One rule's outcome within a tick — chant's `ConvergeRuleOutcome`. */
export interface ConvergeRuleOutcome {
  ruleId: string;
  action: "ran" | "reported" | "skipped-budget" | "skipped-flap" | "gated";
  /** The dispatched Op name, for `action: "ran"` or `"gated"`. */
  op?: string;
  /** The gate's signal name, for `action: "gated"`. */
  gateName?: string;
  reason?: string;
}

/**
 * One component's verdict as a tick observed it — chant's
 * `ConvergeComponentVerdict` (chant#2027, shipped 0.53.1), field for field.
 *
 * A deliberate subset of `ComponentStatusRow`: chant's `componentVerdicts`
 * projects a status row down to these five and drops `recorded`, `build` and
 * `componentBom`, because a tick record is one line of JSON appended forever.
 * `reconciliation` is typed off chant's own row rather than restated, so the
 * union stays the one src/component-status.ts paints from — the #234 inventory's
 * point that the tick's symptom vocabulary IS `ComponentStatusRow`'s.
 */
export interface ConvergeComponentVerdict {
  component: string;
  reconciliation: ComponentStatusRow["reconciliation"];
  /** chant's own detail behind the verdict, already capped to one line by its
   * `sanitizeLedgerText`. */
  detail: string;
  /** "Observed live". Absent means "did not look" or "could not look" — see `unobserved`. */
  live?: boolean;
  /** Why live state could not be read (chant#1089) — the row that tripped the
   * tick's aggregate `unknown`. */
  unobserved?: { reason: string; detail?: string };
}

/** One immutable converge-tick record — chant's `ConvergeTickRecord`. */
export interface ConvergeTickRecord {
  version: 1;
  /** A stable tick id (chant#2027, minted in `appendConvergeRecord`). Absent on
   * a record written by a chant older than 0.53.1. */
  id?: string;
  op: string;
  env: string;
  timestamp: string;
  firedRuleIds: string[];
  outcomes: ConvergeRuleOutcome[];
  /** The per-component verdicts behind `summary`'s counts (chant#2027). Absent
   * on a record written by a chant older than 0.53.1 — which is not the same
   * statement as "this tick observed no components". */
  components?: ConvergeComponentVerdict[];
  summary: {
    drifted: number;
    remediated: number;
    reported: number;
    skippedBudget: number;
    skippedFlap: number;
    unobserved: number;
    adopted: number;
    /** Absent on a record written before chant#1485 — read as 0, never undefined. */
    gated?: number;
  };
  /** The one human-readable log line the tick produced. */
  log: string;
}

/** One still-unresolved gate, as `operator status --json` emits it. `op` is the
 * DISPATCHED op the gate belongs to (a converge rule's `run()` target), not the
 * ConvergeOp — chant's gate ledger is keyed by op name for exactly that reason. */
export interface OperatorPendingGate {
  rule: string;
  op?: string;
  gate: string;
}

/** One row of `chant operator status --json` — chant's `OpStatusLine`. */
export interface OpStatusLine {
  op: string;
  env: string;
  lastTick?: ConvergeTickRecord;
  pendingGates: OperatorPendingGate[];
  lease?: { holder: string; expiresAt: string };
}

// ── Refusals ─────────────────────────────────────────────────────────────────

/** #193's structured-error standard, the shape src/ops-lens.ts's `OpsRefusal`
 * already uses and the SPA's precondition card renders. */
export interface OperatorRefusal {
  error: string;
  /**
   * - `no-operator` — the project declares no ConvergeOp. Not a failure: most
   *   estates don't run an operating loop.
   * - `no-operator-cli` — this chant predates `chant operator` (< 0.52).
   * - `operator-status` — the command ran and behold could not read the answer,
   *   or it failed for a reason behold won't guess at.
   */
  code: "no-operator" | "no-operator-cli" | "operator-status";
  remedy: string;
}

export type OperatorStatusResult =
  | { ok: true; rows: OpStatusLine[] }
  | { ok: false; refusal: OperatorRefusal };

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, "");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where an operating loop comes from, for every refusal that ends in "there
 * isn't one". */
export const HOW_TO_DECLARE =
  "An operating loop is a ConvergeOp: declare one in a `*.op.ts` " +
  "(`ConvergeOp({ name, env, dial, rules })` from @intentius/chant-lexicon-temporal), " +
  "build the project, and tick it with `chant operator` (or a cron / CronJob invoking it).";

// ── Reading `chant operator status --json` ───────────────────────────────────

/**
 * One row's worth of validation. Structural and lenient in the same way
 * src/ops-lens.ts reads an op.json: demand only what the strip actually paints
 * (`op`, `env`, a `pendingGates` array), and let every additive field chant
 * ships later ride along untouched.
 */
function readRow(value: unknown): OpStatusLine | null {
  if (!isRecord(value)) return null;
  if (typeof value.op !== "string" || typeof value.env !== "string") return null;
  if (!Array.isArray(value.pendingGates)) return null;
  const gates: OperatorPendingGate[] = [];
  for (const g of value.pendingGates) {
    if (!isRecord(g) || typeof g.rule !== "string" || typeof g.gate !== "string") return null;
    gates.push({ rule: g.rule, gate: g.gate, ...(typeof g.op === "string" ? { op: g.op } : {}) });
  }
  const tick = isRecord(value.lastTick) ? value.lastTick : undefined;
  // A tick without a timestamp or a log line can't be put on the strip at all —
  // the strip IS "this line, at this instant". Drop the tick rather than render
  // an undated one; the row still carries its lease and its gates.
  const usable = tick && typeof tick.timestamp === "string" && typeof tick.log === "string";
  const lease = isRecord(value.lease) ? value.lease : undefined;
  return {
    op: value.op,
    env: value.env,
    ...(usable ? { lastTick: tick as unknown as ConvergeTickRecord } : {}),
    pendingGates: gates,
    ...(lease && typeof lease.holder === "string" && typeof lease.expiresAt === "string"
      ? { lease: { holder: lease.holder, expiresAt: lease.expiresAt } }
      : {}),
  };
}

/**
 * Read one `chant operator status --json` invocation.
 *
 * Three refusals, three different things to say, and never a silent empty
 * strip. In particular: chant prints its "No ConvergeOp declarations found"
 * warning to stderr and still exits 0 with NOTHING on stdout, so exit 0 alone is
 * not evidence of an answer — an empty stdout is `no-operator`, stated, not an
 * operator with zero ticks.
 */
export function readOperatorStatus(run: { code: number; stdout: string; stderr: string }): OperatorStatusResult {
  const err = strip(run.stderr);
  const out = strip(run.stdout).trim();

  if (run.code !== 0) {
    const message = err.trim() || out || `chant operator status exited ${run.code}`;
    const first = message.split("\n")[0].replace(/^error:\s*/i, "");
    // chant's own `Unknown command: <name>` (its `cli/main.ts`), which is what a
    // chant older than 0.52 answers `operator status` with.
    if (/Unknown command|Unknown operator subcommand/i.test(message)) {
      return {
        ok: false,
        refusal: {
          error: `This chant has no \`operator status\` — ${first}`,
          code: "no-operator-cli",
          remedy: "The operating loop's status surface landed in chant 0.52 (chant#1485). Upgrade chant to read it.",
        },
      };
    }
    return {
      ok: false,
      refusal: {
        error: `chant operator status failed: ${first}`,
        code: "operator-status",
        remedy: "Run `chant operator status --json` in the project to see the whole error.",
      },
    };
  }

  // Exit 0, no JSON: chant discovered no ConvergeOp and warned on stderr.
  if (!out) {
    return {
      ok: false,
      refusal: {
        error: "This project declares no operating loop — chant found no ConvergeOp.",
        code: "no-operator",
        remedy: HOW_TO_DECLARE,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    return {
      ok: false,
      refusal: {
        error: `chant operator status --json didn't print JSON: ${e instanceof Error ? e.message : String(e)}`,
        code: "operator-status",
        remedy: "Run `chant operator status --json` in the project and check what it printed.",
      },
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      refusal: {
        error: "chant operator status --json answered with something that isn't an array of ConvergeOp rows.",
        code: "operator-status",
        remedy: "behold reads one row per ConvergeOp: `{op, env, lastTick?, pendingGates[], lease?}`.",
      },
    };
  }
  const rows: OpStatusLine[] = [];
  for (const value of parsed) {
    const row = readRow(value);
    // One unreadable row refuses the whole strip, for src/server.ts's reason on
    // an unreadable op.json: a strip missing a ConvergeOp is a picture that lies
    // about how many loops are running.
    if (!row) {
      return {
        ok: false,
        refusal: {
          error: "chant operator status --json answered with a row behold couldn't read (needs `op`, `env`, `pendingGates[]`).",
          code: "operator-status",
          remedy: "Check `chant operator status --json` in the project — and file the shape change if chant's is the newer one.",
        },
      };
    }
    rows.push(row);
  }
  return { ok: true, rows };
}

// ── Does this project run an operating loop at all? ──────────────────────────

/** One declared ConvergeOp, as read from an emitted `op.json` alone. */
export interface DeclaredConvergeOp {
  name: string;
  env?: string;
  /** `observe` | `reconcile` | `apply` — the authority dial the loop free-runs at. */
  dial?: string;
}

/**
 * Which of the project's emitted Ops are ConvergeOps.
 *
 * chant's own discovery predicate, verbatim: `searchAttributes.Converge ===
 * "true"` (`packages/core/src/op/operator.ts`'s `isConvergeOp`). `ConvergeOp`
 * always sets `Converge`, `Env` and `Dial`, and the op.json serializer passes
 * `searchAttributes` through — so behold can tell whether a project declares an
 * operating loop from a file the ops lens already parses, with no subprocess and
 * no guess. That is what gates the strip: it appears when a loop is DECLARED,
 * never merely because a status read happened to answer.
 */
export function declaredConvergeOps(
  ops: ReadonlyArray<{ name: string; searchAttributes?: Record<string, string> }>,
): DeclaredConvergeOp[] {
  return ops
    .filter((o) => o.searchAttributes?.Converge === "true")
    .map((o) => ({
      name: o.name,
      ...(o.searchAttributes?.Env ? { env: o.searchAttributes.Env } : {}),
      ...(o.searchAttributes?.Dial ? { dial: o.searchAttributes.Dial } : {}),
    }));
}

// ── The free rider: the operating loop's home in the estate graph ────────────
//
// `OperatorStack` (chant 0.50, chant#1940, commit 31f7d5f3) declares the loop as
// an ordinary k8s estate — one Namespace, one CronJob per hosted ConvergeOp,
// and a least-privilege ServiceAccount/Role/RoleBinding each. So a project that
// runs its operator this way ALREADY appears in behold's estate graph, with no
// behold change at all — as an anonymous namespace holding some CronJobs. What
// it lacks is its identity: nothing in the picture says this namespace is where
// the loop lives.
//
// chant writes that identity itself. Every OperatorStack member carries
// `app.kubernetes.io/managed-by: chant` plus a component label, and the CronJob's
// is `converge-tick` (its `metadata.name` IS the hosted ConvergeOp's name, and
// `metadata.namespace` is the loop's home). Those are declared labels in chant's
// own composite, not a naming convention behold guessed at, which is the whole
// difference between this mark and the estate cross-link the ops lens still
// refuses to draw.
//
// Only the Namespace and the CronJobs are marked. The RBAC trio is genuinely
// part of the stack, but marking it would put three more badges per host on the
// picture without saying anything the namespace's own mark doesn't already say.
//
// Scope, stated: this marks the ENTITY graph, where a `Namespace` is a card
// (`/api/graph`, `/api/overlay`). The logical lens turns a namespace into a
// *box* instead (src/logical-k8s.ts's `K8S_PLUMBING_KINDS` drops the card and
// `namespaceBoxKey` mints `namespace <ns>`), and until pinhole 0.3.7 a
// `GroupBox` carried only a title, a drift `status` and an id — no mark
// channel, which was pinhole#119. Suffixing the title used to be doubly wrong:
// src/logical.ts re-derived that exact string to re-parent helm releases, so a
// decorated title would have silently unparented them. #328 removed that half
// — the re-parenting carries the box's container KEY now. pinhole#119 shipped
// in 0.3.7 (`GroupBox.mark`), so the box gets the same glyph identity below —
// {@link OPERATOR_HOME_GLYPH} — addressed by that same key
// (`LogicalProjection.namespaceBoxes`), never by title. See
// {@link operatorHomeBoxMarks}.

/** k8s's own well-known labels, as OperatorStack sets them. */
const MANAGED_BY = "app.kubernetes.io/managed-by";
const COMPONENT = "app.kubernetes.io/component";
const NAME_LABEL = "app.kubernetes.io/name";
const CHANT = "chant";
/** `OperatorStack`'s label for the CronJob that runs one converge tick. */
const CONVERGE_TICK = "converge-tick";
/** chant's k8s lexicon kinds (its `generated/index.ts`): `K8s::Batch::CronJob`,
 * `K8s::Core::Namespace`. Matched in full — a bare `"CronJob"` would also match
 * a different lexicon's resource of the same short name. */
const CRONJOB_KIND = "K8s::Batch::CronJob";
const NAMESPACE_KIND = "K8s::Core::Namespace";

const rec = (v: unknown): Record<string, unknown> | undefined => (isRecord(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const labelsOf = (n: IRNode): Record<string, unknown> => rec(rec(n.attrs?.metadata)?.labels) ?? {};

/** One CronJob that ticks a ConvergeOp. */
export interface OperatorTickJob {
  /** The graph node id of the CronJob card. */
  node: string;
  /** The hosted ConvergeOp's name — `OperatorStack` uses it as the CronJob name. */
  op: string;
  /** The cron expression driving the beat, when the IR carries the spec. */
  schedule?: string;
}

/** One namespace that is an operating loop's home. */
export interface OperatorHome {
  namespace: string;
  /** The Namespace card's node id — absent when the estate declares the CronJobs
   * in one project and the Namespace in another that isn't being served. */
  node?: string;
  /** The `OperatorStack`'s own name (`app.kubernetes.io/name`), when consistent
   * across the ticks found here. */
  stack?: string;
  ticks: OperatorTickJob[];
}

/**
 * Every operating-loop home in a graph, found from chant's own labels.
 *
 * Joins on attribute values (label values, `metadata.namespace`/`name`) and
 * never on node ids — the same rule src/k8s-edges.ts follows, which is what lets
 * this run over a composed multi-project estate whose ids are stack-prefixed.
 */
export function operatorHomes(ir: GraphIR): OperatorHome[] {
  const byNamespace = new Map<string, OperatorHome>();
  /** Namespaces where two ticks named different OperatorStacks. Tracked rather
   * than inferred from `home.stack` being absent, so a third tick agreeing with
   * the first can't resurrect a name the second already contradicted. */
  const conflicted = new Set<string>();
  for (const n of ir.nodes) {
    if (n.kind !== CRONJOB_KIND) continue;
    const labels = labelsOf(n);
    if (labels[MANAGED_BY] !== CHANT || labels[COMPONENT] !== CONVERGE_TICK) continue;
    const meta = rec(n.attrs?.metadata);
    const ns = str(meta?.namespace);
    const op = str(meta?.name);
    if (!ns || !op) continue;
    const home = byNamespace.get(ns) ?? { namespace: ns, ticks: [] };
    const stack = str(labels[NAME_LABEL]);
    // Two OperatorStacks sharing one namespace is legal and would make `stack` a
    // lie, so it is kept only while every tick agrees on it.
    if (stack && !conflicted.has(ns)) {
      if (home.stack === undefined) home.stack = stack;
      else if (home.stack !== stack) {
        conflicted.add(ns);
        delete home.stack;
      }
    }
    const schedule = str(rec(n.attrs?.spec)?.schedule);
    home.ticks.push({ node: n.id, op, ...(schedule ? { schedule } : {}) });
    byNamespace.set(ns, home);
  }
  if (!byNamespace.size) return [];
  for (const n of ir.nodes) {
    if (n.kind !== NAMESPACE_KIND) continue;
    const name = str(rec(n.attrs?.metadata)?.name);
    const home = name ? byNamespace.get(name) : undefined;
    if (home && !home.node) home.node = n.id;
  }
  for (const home of byNamespace.values()) home.ticks.sort((a, b) => a.op.localeCompare(b.op));
  return [...byNamespace.values()].sort((a, b) => a.namespace.localeCompare(b.namespace));
}

/** What a marked card carries. An object rather than a pair of scalars, for
 * src/component-status.ts's reason on `_liveStatus`: a flat `_operatorRole` /
 * `_operatorOp` pair would land in the card's own field list. */
export interface OperatorMark {
  role: "home" | "tick";
  namespace: string;
  stack?: string;
  /** The ConvergeOp this CronJob ticks (`role: "tick"`). */
  op?: string;
  schedule?: string;
  /** The ConvergeOps hosted here (`role: "home"`). */
  ticks?: string[];
}

/**
 * Give the operating loop's namespace (and its tick CronJobs) their identity.
 *
 * Strictly additive paint, the same contract `paintPlayhead` keeps: with no
 * OperatorStack in the graph the input IR is returned untouched, so every estate
 * that doesn't run its operator in-cluster renders exactly as it did before.
 */
export function markOperatorHome(ir: GraphIR): GraphIR {
  const homes = operatorHomes(ir);
  if (!homes.length) return ir;
  const marks = new Map<string, OperatorMark>();
  for (const home of homes) {
    if (home.node) {
      marks.set(home.node, {
        role: "home",
        namespace: home.namespace,
        ...(home.stack ? { stack: home.stack } : {}),
        ticks: home.ticks.map((t) => t.op),
      });
    }
    for (const tick of home.ticks) {
      marks.set(tick.node, {
        role: "tick",
        namespace: home.namespace,
        ...(home.stack ? { stack: home.stack } : {}),
        op: tick.op,
        ...(tick.schedule ? { schedule: tick.schedule } : {}),
      });
    }
  }
  return {
    ...ir,
    nodes: ir.nodes.map((n) => {
      const mark = marks.get(n.id);
      return mark ? { ...n, attrs: { ...n.attrs, _operator: mark } } : n;
    }),
  };
}

// ── The logical lens's namespace box (pinhole#119) ───────────────────────────

/**
 * The operator home's glyph identity, in pinhole's node mark vocabulary
 * (pinhole#95): monochrome geometry, stroked with the box's title colour
 * (pinhole#119's `GroupBox.mark` contract), a two-arc cycle — the same
 * "operating loop" reading web/app.js's `OPERATOR_MARK_LABEL` paints as "⟳" on
 * the entity graph's own home card. Authored fresh rather than a
 * `GENERIC_GLYPHS` key: nothing in that fixed vocabulary (compute, storage,
 * queue, …) names a converge loop, and the whole point is picking ONE
 * identity so the operator's home reads the same in both views.
 */
export const OPERATOR_HOME_GLYPH: GlyphSpec = {
  body: '<path d="M16.5 6.63A7 7 0 1 1 6.64 7.5"/><path d="M16.5 6.63 14.3 5.9M16.5 6.63 15.9 8.1"/>',
};

/**
 * Which namespace `GroupBox` (the logical lens's, pinhole#119) is the
 * operating loop's home — box KEY → {@link OPERATOR_HOME_GLYPH}, ready to
 * splice onto `layoutArchitecture`'s boxes before `renderSvg` paints them.
 *
 * Same detector as {@link markOperatorHome} — `operatorHomes(ir)`, chant's own
 * `app.kubernetes.io/*` labels — run again here rather than read off the
 * entity mark {@link markOperatorHome} leaves on the IR: the logical
 * projection drops the Namespace node as a card entirely (it becomes the box),
 * so there is no `_operator`-marked node left to read once `projectTopology`
 * has run. `ir` is the same pre-projection entity graph `projectTopology` was
 * given; `namespaceBoxes` is that call's own return
 * (`LogicalProjection.namespaceBoxes`, behold#328/#331) — the box's KEY, never
 * its title, exactly as `placeHelmReleases` addresses it.
 *
 * A home with no box in `namespaceBoxes` (the projection drew no box for that
 * namespace — nothing in it survived the headline filter, and it was never
 * separately declared) marks nothing rather than inventing one; the entity
 * graph still names the loop's home in that case.
 */
export function operatorHomeBoxMarks(ir: GraphIR, namespaceBoxes: Readonly<Record<string, string>>): Record<string, GlyphSpec> {
  const out: Record<string, GlyphSpec> = {};
  for (const home of operatorHomes(ir)) {
    const box = namespaceBoxes[home.namespace];
    if (box) out[box] = OPERATOR_HOME_GLYPH;
  }
  return out;
}

// ── The strip ────────────────────────────────────────────────────────────────

/** How a lease reads. `expired` is its own state, not a shade of `free`: a lease
 * past its TTL means the holder stopped renewing — the next operator round
 * reclaims it — which is a different statement from "nobody has ever held it". */
export type LeaseState = "held" | "expired" | "free";

/** One ConvergeOp's line on the strip. Exactly one tick, by construction. */
export interface OperatorStripRow {
  op: string;
  env: string;
  /** The last tick's own log line, verbatim from chant. Null when no tick has
   * ever been recorded for this ConvergeOp. */
  log: string | null;
  /** That tick's ISO timestamp. Null for the same reason. */
  at: string | null;
  /** That tick's own id (chant#2027) — what makes a tick a thing a reader can
   * point at rather than an `(op, env, timestamp)` triple. Null when no tick has
   * been recorded, AND when the tick predates chant 0.53.1 and carries none: the
   * strip must not mint an identity chant didn't write. Carried whole here; the
   * renderer truncates it (web/operator.js's `shortTickId`). */
  tickId: string | null;
  lease: LeaseState;
  leaseHolder: string | null;
  leaseExpiresAt: string | null;
  /** How many gates this tick recorded that nothing has resolved since. */
  pendingGates: number;
}

export interface OperatorStrip {
  rows: OperatorStripRow[];
  /** Total pending gates across every loop — what the strip's own badge says. */
  pendingGates: number;
}

/**
 * Fold the status rows into the strip.
 *
 * `now` is injected rather than read here so a test pins the lease verdict
 * instead of racing the clock — the same convention chant's own ledger writers
 * use (library code never calls `Date.now()` internally).
 */
export function operatorStrip(rows: readonly OpStatusLine[], now: number = Date.now()): OperatorStrip {
  const out: OperatorStripRow[] = rows.map((r) => {
    const expiresAt = r.lease ? Date.parse(r.lease.expiresAt) : NaN;
    // An unparseable expiry is `held`, not `expired`: behold knows a holder
    // wrote a lease and does not know when it lapses, and calling that "expired"
    // would invite a reader to assume the loop is free when it may not be.
    const lease: LeaseState = !r.lease ? "free" : Number.isFinite(expiresAt) && expiresAt <= now ? "expired" : "held";
    return {
      op: r.op,
      env: r.env,
      log: r.lastTick?.log ?? null,
      at: r.lastTick?.timestamp ?? null,
      tickId: typeof r.lastTick?.id === "string" && r.lastTick.id ? r.lastTick.id : null,
      lease,
      leaseHolder: r.lease?.holder ?? null,
      leaseExpiresAt: r.lease?.expiresAt ?? null,
      pendingGates: r.pendingGates.length,
    };
  });
  return { rows: out, pendingGates: out.reduce((n, r) => n + r.pendingGates, 0) };
}

// ── The tick's per-component verdicts (chant#2027) ───────────────────────────
//
// ## The join key, verified rather than guessed
//
// chant#2022's lesson was that a field which doesn't join is a field you render
// where it arrived and file an issue about — you do not invent the mapping. So
// this one was checked before anything was built:
//
//   `ConvergeComponentVerdict.component` is `ComponentStatusRow.component`,
//   copied straight through by chant's `componentVerdicts(rows)` from the very
//   `statusRows` its `convergeTick` already had
//   (`lexicons/temporal/src/op/activities/converge.ts`: `components:
//   componentVerdicts(statusRows)`, where `statusRows = observeStatusRows(env)`).
//
// And `ComponentStatusRow.component` is EXACTLY the key
// src/component-status.ts's `joinComponentStatus` already joins onto
// component-DAG node ids (`node.id === row.component`, M1.0/#56). Same
// namespace, same producer, same key. The tick's verdicts therefore reach
// behold's IR through the join that already exists — nothing new to map, and
// no issue to file.
//
// ## Why they can only ever feed the LAST tier
//
// A verdict is what the operator saw at `lastTick.timestamp`, which is a moment
// in the past — possibly a long one, since a loop that stopped ticking leaves
// its final record on the branch forever. The live component-status read is
// what chant sees NOW. So the tick is never allowed to outrank it: it paints
// only where the live join painted nothing, and only its `reconciliation`, the
// last-resort tier under stack / rollup / `live` (see
// `componentStatusColor`'s doc). The tick's own `live` boolean rides onto the
// node for the panel to state, and is deliberately NOT painted from — tier-3
// evidence from an old moment competing with tier-3 evidence from this one is
// the exact confusion the tiering exists to prevent.

/** chant's own operator cadence — `DEFAULT_OPERATOR_INTERVAL_MS`
 * (`packages/core/src/op/operator.ts`), mirrored because it is not on
 * `@intentius/chant`'s public export surface, same rule the types above follow.
 * Verified against chant `52ca6c82` (0.53.1). */
export const OPERATOR_INTERVAL_MS = 60_000;

/**
 * How old a tick's verdicts may be and still be painted.
 *
 * Fifteen of chant's own default rounds. A loop running at that cadence has
 * written fifteen records inside this window, so a newest record older than it
 * does not mean "nothing changed" — it means nobody is ticking, and the verdict
 * is history. History is still shown (the panel names the tick and how old it
 * is); it is not shown as a colour, because a colour on the graph reads as the
 * current state of the estate and there is no way to caveat a fill.
 */
export const TICK_VERDICT_TTL_MS = 15 * OPERATOR_INTERVAL_MS;

/** How old a tick is, and whether that is still paintable. */
export interface TickFreshness {
  /** Milliseconds between the tick and `now`. Null when the timestamp doesn't
   * parse, or when the tick is dated in the future (a clock behold can't
   * reconcile is not an age it will report). */
  ageMs: number | null;
  fresh: boolean;
}

/**
 * Read a tick's age against {@link TICK_VERDICT_TTL_MS}.
 *
 * `now` is injected for `operatorStrip`'s reason: a test pins the verdict
 * instead of racing the clock. An undatable or future-dated timestamp is NOT
 * fresh — the strip's lease verdict makes the same call in the other direction
 * (an unparseable expiry stays `held`) and for the same reason: when behold
 * can't date a fact, it declines to claim the fact is current.
 */
export function tickFreshness(at: string | null | undefined, now: number = Date.now()): TickFreshness {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return { ageMs: null, fresh: false };
  const age = now - t;
  if (age < 0) return { ageMs: null, fresh: false };
  return { ageMs: age, fresh: age <= TICK_VERDICT_TTL_MS };
}

/**
 * One ConvergeOp's last tick, reduced to what a graph join needs.
 *
 * Deliberately carries no freshness: this is the time-INDEPENDENT half, so it
 * can sit on the broadcast `OperatorState` without changing on every poll (which
 * would make src/op-runner.ts's compare-and-broadcast a repaint loop). Freshness
 * is computed at join time from `at`, by {@link tickFreshness}.
 */
export interface TickComponentVerdicts {
  /** The ConvergeOp that recorded the tick. */
  op: string;
  /** The environment it converges — the verdicts are about THAT env's components. */
  env: string;
  /** The tick's ISO timestamp: how fresh every verdict below is, exactly. */
  at: string;
  /** The tick's id, when this chant wrote one (chant#2027). */
  tickId: string | null;
  verdicts: ConvergeComponentVerdict[];
}

/** chant's `reconciliation` union — the one src/component-status.ts paints, and
 * the one the #234 inventory established the tick's symptom vocabulary IS. */
const RECONCILIATIONS = new Set(["reconciled", "unrecorded", "stale", "drifted", "unknown"]);

/** Structural read of one `lastTick.components[]` entry, `readRow`'s discipline
 * applied one level down: demand only what a paint needs (`component`, a
 * `reconciliation` from chant's own union), let anything additive ride along
 * untouched. */
function readVerdict(value: unknown): ConvergeComponentVerdict | null {
  if (!isRecord(value)) return null;
  if (typeof value.component !== "string" || !value.component) return null;
  if (typeof value.reconciliation !== "string" || !RECONCILIATIONS.has(value.reconciliation)) return null;
  const unobserved = isRecord(value.unobserved) && typeof value.unobserved.reason === "string" ? value.unobserved : undefined;
  return {
    component: value.component,
    reconciliation: value.reconciliation as ConvergeComponentVerdict["reconciliation"],
    detail: typeof value.detail === "string" ? value.detail : "",
    ...(typeof value.live === "boolean" ? { live: value.live } : {}),
    ...(unobserved
      ? {
          unobserved: {
            reason: unobserved.reason as string,
            ...(typeof unobserved.detail === "string" ? { detail: unobserved.detail } : {}),
          },
        }
      : {}),
  };
}

/**
 * The per-component verdicts each status row's last tick carries.
 *
 * A row whose tick has no `components` (every chant before 0.53.1) contributes
 * nothing — no entry at all, rather than an entry with an empty list, so a
 * consumer can't mistake "this chant doesn't say" for "this tick saw no
 * components". A tick whose `components` IS an empty array does produce an
 * entry with no verdicts: that is chant saying it observed nothing, which is a
 * different fact and paints nothing either way.
 *
 * An individual entry behold can't read is dropped rather than refusing the
 * whole strip — unlike an unreadable status ROW, which refuses (a strip missing
 * a loop undercounts the loops running). A dropped verdict costs one node its
 * colour, which is exactly what a pre-0.53.1 chant costs every node, so it
 * degrades to a shape behold already renders honestly.
 */
export function tickComponentVerdicts(rows: readonly OpStatusLine[]): TickComponentVerdicts[] {
  const out: TickComponentVerdicts[] = [];
  for (const row of rows) {
    const tick = row.lastTick;
    if (!tick || !Array.isArray(tick.components)) continue;
    const verdicts: ConvergeComponentVerdict[] = [];
    for (const value of tick.components) {
      const verdict = readVerdict(value);
      if (verdict) verdicts.push(verdict);
    }
    out.push({
      op: row.op,
      env: tick.env || row.env,
      at: tick.timestamp,
      tickId: typeof tick.id === "string" && tick.id ? tick.id : null,
      verdicts,
    });
  }
  return out;
}

/**
 * The verdicts that speak for `env`, or null.
 *
 * Matched on the tick's OWN env, never on which loop happens to be first: a
 * staging loop's verdicts painted onto a prod component DAG would be a picture
 * lying about which cloud it is describing. Two ConvergeOps converging the same
 * env is legal (chant discovers ops, not one-per-env), so the NEWEST tick wins
 * — the same `at(-1)` rule chant's own `statusFor` applies within one ledger.
 */
export function verdictsForEnv(all: readonly TickComponentVerdicts[], env: string): TickComponentVerdicts | null {
  // An undatable tick sorts oldest rather than throwing the comparison: it can
  // still be the only candidate (and paints nothing, `tickFreshness` refusing to
  // call it fresh), but it never displaces one behold can actually date.
  const when = (t: TickComponentVerdicts): number => {
    const ms = Date.parse(t.at);
    return Number.isFinite(ms) ? ms : -Infinity;
  };
  let best: TickComponentVerdicts | null = null;
  for (const t of all) {
    if (t.env !== env) continue;
    if (!best || when(t) > when(best)) best = t;
  }
  return best;
}

// ── The converge gate card ───────────────────────────────────────────────────

/** Which loop a gate card belongs to. Stated on every card because behold draws
 * two kinds and they resolve through different commands with different effects.
 * The run playhead's card is the other one. */
export const CONVERGE_GATE_LOOP = "converge";

/**
 * The one sentence the converge card must never soften.
 *
 * chant's `lifecycle/gate-ledger.ts`: `chant approve` "does **not** (v1)
 * retroactively make a gated op's local dispatch succeed — the local executor
 * still refuses any op containing a gate outright, unconditionally, gate
 * resolution or not... it is not itself the unblock."
 */
export const APPROVE_SEMANTICS =
  "Approving records a fact in the gate ledger; it does not unblock the dispatch. The next tick reads it.";

/** The past-tense half, for the moment after the click. */
export const APPROVED_SEMANTICS = "recorded; the next tick acts on it";

/** A pending converge gate, as the card renders it. */
export interface ConvergeGateCard {
  /** Always {@link CONVERGE_GATE_LOOP} — this is not the Temporal run gate. */
  loop: typeof CONVERGE_GATE_LOOP;
  /** The converge rule whose dispatch hit the gate. */
  rule: string;
  /** The DISPATCHED op the gate belongs to — `chant approve`'s first argument. */
  op: string;
  /** The gate's signal name — `chant approve`'s second argument. */
  gate: string;
  /** The ConvergeOp that recorded it, and its environment. */
  convergeOp: string;
  env: string;
  /** The gated tick's timestamp — when this became pending. Null when the row
   * carried gates but no readable tick. */
  since: string | null;
  /** What approving actually does. On the card, not in a tooltip. */
  semantics: typeof APPROVE_SEMANTICS;
  /** The delegated write the button performs. Stated, not implied. */
  approve: { method: "POST"; path: string; command: string };
}

/**
 * Every pending converge gate across every loop, as cards.
 *
 * A gate whose `op` is missing is dropped: `chant approve` takes `<op> <gate>`
 * positionally, so a card without an op would render a button that cannot be
 * pressed correctly. chant only ever emits a pending gate WITH an op (its
 * `statusFor` skips an outcome missing either field), so this is a guard against
 * a hand-edited ledger, not an expected shape.
 */
export function convergeGateCards(rows: readonly OpStatusLine[]): ConvergeGateCard[] {
  const out: ConvergeGateCard[] = [];
  for (const row of rows) {
    for (const g of row.pendingGates) {
      if (!g.op) continue;
      out.push({
        loop: CONVERGE_GATE_LOOP,
        rule: g.rule,
        op: g.op,
        gate: g.gate,
        convergeOp: row.op,
        env: row.env,
        since: row.lastTick?.timestamp ?? null,
        semantics: APPROVE_SEMANTICS,
        approve: {
          method: "POST",
          path: `/api/operator/approve/${encodeURIComponent(g.op)}/${encodeURIComponent(g.gate)}`,
          command: `chant approve ${g.op} ${g.gate}`,
        },
      });
    }
  }
  return out;
}

// ── The model the server holds and broadcasts ────────────────────────────────

/**
 * What behold knows about the operating loop right now.
 *
 * `declared` comes from the emitted op.json (free, structural); everything else
 * comes from the last `chant operator status --json` read. The two are separate
 * on purpose: a project that DECLARES a loop but whose status read refused still
 * shows the strip, saying why it is empty, instead of vanishing as if no loop
 * existed.
 */
export interface OperatorState {
  /** The ConvergeOps the built project declares. Empty → no strip at all. */
  declared: DeclaredConvergeOp[];
  /** The last read's strip, or null when nothing has been read yet. */
  strip: OperatorStrip | null;
  /** The pending converge gates from that same read. */
  gates: ConvergeGateCard[];
  /** The per-component verdicts each loop's last tick carried (chant#2027), one
   * entry per ticked loop whose chant is new enough to say. Empty on every
   * older chant, which is why the graph join is strictly additive. Held
   * time-independently so `op-runner`'s compare-and-broadcast doesn't see the
   * clock move and repaint. */
  verdicts: TickComponentVerdicts[];
  /** Why there is no strip, when there isn't one to be had — a refusal's own
   * `error` text. Null when the last read succeeded. */
  note: string | null;
  /** The refusal's code, so the SPA can tell "no loop declared" from "couldn't
   * ask" without parsing prose. */
  code: OperatorRefusal["code"] | null;
  /** When behold last asked. Null before the first read. */
  readAt: string | null;
}

export const initialOperatorState: OperatorState = {
  declared: [],
  strip: null,
  gates: [],
  verdicts: [],
  note: null,
  code: null,
  readAt: null,
};

/** Fold one status read into the state. Pure — the caller owns the broadcast. */
export function operatorRead(
  state: OperatorState,
  result: OperatorStatusResult,
  at: string,
  now: number = Date.now(),
): OperatorState {
  if (!result.ok) {
    // The verdicts go with the strip: they are what the LAST read said, and a
    // read that refused leaves behold with no current claim about any component.
    return { ...state, strip: null, gates: [], verdicts: [], note: result.refusal.error, code: result.refusal.code, readAt: at };
  }
  return {
    ...state,
    strip: operatorStrip(result.rows, now),
    gates: convergeGateCards(result.rows),
    verdicts: tickComponentVerdicts(result.rows),
    note: null,
    code: null,
    readAt: at,
  };
}

// ── The statusbar sentence ───────────────────────────────────────────────────

/**
 * What the operator strip adds to the ops lens's own note.
 *
 * Every branch says what behold KNOWS, and the one-tick limit is stated every
 * time there is a tick to state it about — a reader must never take the strip
 * for a shortened timeline.
 */
export function operatorNote(state: OperatorState, now: number = Date.now()): string {
  if (!state.declared.length) {
    return "No operating loop: this project declares no ConvergeOp, so there is no operator strip.";
  }
  const loops = `${state.declared.length} ConvergeOp${state.declared.length === 1 ? "" : "s"}`;
  if (!state.strip) {
    return state.note
      ? `Operating loop: ${loops} declared — status unavailable: ${state.note}`
      : `Operating loop: ${loops} declared — not read yet.`;
  }
  const bits: string[] = [];
  const ticked = state.strip.rows.filter((r) => r.at).length;
  bits.push(
    ticked
      ? `last tick only — chant's status surface exposes one tick per loop, not the history (chant#2029), so this is a strip and not a timeline`
      : `no tick recorded yet on any loop`,
  );
  // The per-component verdicts (chant#2027), and — the half that matters — how
  // old they are. A reader must never take a painted component for a live read.
  const named = state.verdicts.reduce((n, t) => n + t.verdicts.length, 0);
  if (named) {
    const stale = state.verdicts.filter((t) => t.verdicts.length && !tickFreshness(t.at, now).fresh);
    const painted = named - stale.reduce((n, t) => n + t.verdicts.length, 0);
    bits.push(
      painted
        ? `${painted} component verdict${painted === 1 ? "" : "s"} from that tick — joined onto the component DAG by component name, ` +
            `under the live read (never over it) and only while the tick is younger than ${Math.round(TICK_VERDICT_TTL_MS / 60_000)}m`
        : `${named} component verdict${named === 1 ? "" : "s"} from that tick, all older than ${Math.round(TICK_VERDICT_TTL_MS / 60_000)}m — ` +
            `named on the node, not painted: a colour would read as the estate's state now`,
    );
  }
  const held = state.strip.rows.filter((r) => r.lease === "held").length;
  if (held) bits.push(`${held} lease${held === 1 ? "" : "s"} held`);
  const expired = state.strip.rows.filter((r) => r.lease === "expired").length;
  if (expired) bits.push(`${expired} lease${expired === 1 ? "" : "s"} expired — the next round reclaims it`);
  if (state.strip.pendingGates) {
    bits.push(
      `${state.strip.pendingGates} converge gate${state.strip.pendingGates === 1 ? "" : "s"} pending — ` +
        `approving one records a fact for the next tick, it does not release a workflow (that is the run gate, a different card), ` +
        `and a gate fact carries no URL yet (chant#2028)`,
    );
  }
  return `Operating loop: ${loops} — ${bits.join("; ")}.`;
}
