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
 */

import type { GraphIR, IRNode } from "@intentius/chant";

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

/** One immutable converge-tick record — chant's `ConvergeTickRecord`. */
export interface ConvergeTickRecord {
  version: 1;
  op: string;
  env: string;
  timestamp: string;
  firedRuleIds: string[];
  outcomes: ConvergeRuleOutcome[];
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
// `namespaceTitle` mints `namespace <ns>`), and a `GroupBox` carries only a
// title, a drift `status` and an id — no mark channel. Suffixing the title would
// be the obvious move and is wrong: src/logical.ts:398 re-derives that exact
// string to re-parent helm releases, so a decorated title would silently
// unparent them. Giving a box its own mark needs a pinhole-side field; not
// invented here.

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
      lease,
      leaseHolder: r.lease?.holder ?? null,
      leaseExpiresAt: r.lease?.expiresAt ?? null,
      pendingGates: r.pendingGates.length,
    };
  });
  return { rows: out, pendingGates: out.reduce((n, r) => n + r.pendingGates, 0) };
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
    return { ...state, strip: null, gates: [], note: result.refusal.error, code: result.refusal.code, readAt: at };
  }
  return {
    ...state,
    strip: operatorStrip(result.rows, now),
    gates: convergeGateCards(result.rows),
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
export function operatorNote(state: OperatorState): string {
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
