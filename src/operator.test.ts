import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import {
  readOperatorStatus,
  readOperatorLog,
  declaredConvergeOps,
  operatorStrip,
  tickComponentVerdicts,
  verdictsForEnv,
  tickFreshness,
  TICK_VERDICT_TTL_MS,
  convergeGateCards,
  operatorTimeline,
  operatorLogWindow,
  operatorLogArgs,
  mergeOperatorLogs,
  approvalLink,
  APPROVE_AT,
  OPERATOR_LOG_LIMIT,
  OPERATOR_LOG_MAX_LIMIT,
  OPERATOR_LOG_FLOOR,
  type OperatorLogEntry,
  operatorHomes,
  markOperatorHome,
  operatorHomeBoxMarks,
  OPERATOR_HOME_GLYPH,
  operatorRead,
  operatorNote,
  initialOperatorState,
  APPROVE_SEMANTICS,
  CONVERGE_GATE_LOOP,
  type OpStatusLine,
} from "./operator.ts";
import { parseOpIr, type OpIr } from "./ops-lens.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__", "operator-status");
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/**
 * ## Fixture provenance
 *
 * chant's operator ships with tests, and every value here is derived from them
 * rather than invented — `chant operator status --json` against a REAL loop
 * would need a running operator, a ticked ledger and an orphan branch, which is
 * not something this suite boots.
 *
 * **`chant-test-values.status.json`** is chant's own
 * `packages/core/src/cli/handlers/operator.test.ts` ("--json emits one row per
 * discovered ConvergeOp with last tick, lease, and pending gates", lines
 * 148-181 at chant `8f280b7e`), verbatim: the discovered op
 * `staging-converge`/`staging`, the `lastTick` record (timestamp, `firedRuleIds`,
 * the `gated` outcome naming `fountain-apply`/`rollout-gate`, the summary
 * counts), the lease `{holder: "op-a", expiresAt: "y"}`, and the resulting
 * `pendingGates` the test asserts on. `"y"` is chant's own placeholder — the
 * test only asserts the lease passes through — and it is kept, because an
 * unparseable expiry is a real branch behold has to have an answer for.
 *
 * One substitution: chant's test elides the log line as `"converge(staging):
 * ..."`. The fixture carries the line chant actually renders, from `renderLog`
 * (`lexicons/temporal/src/op/activities/converge.ts:338`) applied to that same
 * record's own summary counts — the strip prints this string verbatim, so an
 * elided one would pin nothing.
 *
 * **`two-loops.status.json`** is the same `OpStatusLine` shape with a second
 * ConvergeOp added and real ISO lease expiries, so the multi-loop strip, the
 * held/expired/free lease verdicts and a gate-free row are all pinnable. The
 * `reason` strings are chant's own gate/dial refusal wordings
 * (`converge.ts:287-386`).
 *
 * **`verdicts.status.json`** is the chant 0.53.1 record shape (chant#2027,
 * merged as chant PR #2042, commit `52ca6c82`), and every value in its
 * `lastTick` is derived from that PR's own tests in
 * `packages/core/src/lifecycle/converge-ledger.test.ts`:
 *
 *  - the record's frame (`op: "fountain-converge"`, `env`/`timestamp`, empty
 *    `firedRuleIds`/`outcomes`) is that file's `makeInput()` (lines 30-41);
 *  - `components` is exactly what its "round-trips on a record, naming the
 *    component that tripped the tick's aggregate unknown" test writes —
 *    `componentVerdicts()` applied to an `api` row (`drifted`, "live digest
 *    differs", `live: true`) and a `worker` row (`unknown`, "unreadable",
 *    `unobserved: {reason: "no-credentials"}`) — and its `summary` is that
 *    test's own `{drifted: 1, reported: 1, unobserved: 1, …}`;
 *  - `id` is a `randomUUID()`-shaped value, the mint `appendConvergeRecord` now
 *    performs. chant's tests assert the SHAPE (`/^[0-9a-f-]{36}$/`) rather than
 *    a value, since a mint has none to pin, so this fixture picks one that
 *    matches and behold pins the same shape rather than the string.
 *
 * Two substitutions, both for the reason the fixture above states: chant's
 * ledger test predates #1485's `gated` count, so `summary.gated` is carried at
 * 0 (`convergeTick` writes it on every tick), and the log line is `renderLog`
 * (`lexicons/temporal/src/op/activities/converge.ts:341`) applied to this
 * record's own counts rather than the ledger test's placeholder — the strip
 * prints it verbatim, so an inconsistent one would pin nothing.
 *
 * The two fixtures above are deliberately NOT updated to the new shape: they
 * are what a chant older than 0.53.1 emits, with no `components` and no `id`,
 * which is the absence path every reader here has to keep handling.
 *
 * **`gate-url.status.json`** is chant's own
 * `packages/core/src/cli/handlers/operator.test.ts` ("a gated outcome's approval
 * url rides onto the pending-gate row", chant PR #2043 / chant#2028 at
 * `2dd9f809`), verbatim: the gated outcome carrying
 * `url: "https://github.com/INTENTIUS/chant/pull/2028"`, and the
 * `pendingGates` row that test asserts chant emits with it. The one substitution
 * is the same one made above — chant's test elides the log line as
 * `"converge(staging): ..."`, and the fixture carries the line `renderLog`
 * actually produces for those counts, since the strip prints it verbatim.
 *
 * **`timeline.log.json`** is one `chant operator log --json` document, from
 * chant's "gate resolutions are merged into the timeline, in timestamp order
 * after the tick that gated" test (chant PR #2044 / chant#2029 at `0ec67657`):
 * its `tick()` helper's record shape, the two ticks it overrides to `t1`/`t2`,
 * the gated outcome naming `fountain-apply`/`rollout-gate` with
 * `url: "https://pr.example/1"`, and the resolution `{op: "fountain-apply",
 * gate: "rollout-gate", resolvedBy: "alex", timestamp: "2026-01-02...", url}`
 * that test hands `readGateResolutions`. Wrapped in the `{entries, malformed}`
 * envelope `runOperatorLog` prints, with the `kind`/`timestamp` entry fields
 * `collectOperatorLog` adds and in the order that test asserts
 * (`["tick", "gate-resolution", "tick"]`).
 *
 * **`staging-converge.op.json`** is a ConvergeOp's emitted IR. chant ships no
 * example that declares a ConvergeOp (the issue's own inventory says so, and
 * `lexicons/k8s/examples/operator-stack` declares converge *hosts*, not a rule
 * table), so there is no golden op.json to copy. This one is assembled from
 * `ConvergeOp`'s own `Op({...})` call
 * (`lexicons/temporal/src/composites/converge-op.ts:180-217` — the Observe
 * [`lifecycleSnapshot`, `lifecycleDiff`] / Converge [`convergeTick`] phases and
 * the `{Converge, Env, Dial}` search attributes) put through the serializer's
 * documented shape (`lexicons/temporal/src/op/op-ir.ts:94-160`: `args` always
 * present, `profile` resolved). The test below pins the search-attribute union
 * the way `ops-lens.test.ts` pins the activity-arg one, so the day chant ships
 * an example this fixture is checkable against it.
 */
const chantTestValues = read("chant-test-values.status.json");
const twoLoops = read("two-loops.status.json");
const verdictsFixture = read("verdicts.status.json");
const gateUrl = read("gate-url.status.json");
const timelineLog = read("timeline.log.json");

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const rows = (stdout: string): OpStatusLine[] => {
  const result = readOperatorStatus(ok(stdout));
  if (!result.ok) throw new Error(`fixture didn't parse: ${result.refusal.error}`);
  return result.rows;
};
const logEntries = (stdout: string): OperatorLogEntry[] => {
  const result = readOperatorLog(ok(stdout));
  if (!result.ok) throw new Error(`fixture didn't parse: ${result.refusal.error}`);
  return result.entries;
};

describe("the chant-derived operator status fixtures", () => {
  it("are the shape src/operator.ts claims chant emits", () => {
    const parsed = rows(chantTestValues);
    expect(parsed).toHaveLength(1);
    const [row] = parsed;
    expect(row.op).toBe("staging-converge");
    expect(row.env).toBe("staging");
    // chant's own test asserts exactly this pendingGates value.
    expect(row.pendingGates).toEqual([{ rule: "drift-apply", op: "fountain-apply", gate: "rollout-gate" }]);
    expect(row.lease).toEqual({ holder: "op-a", expiresAt: "y" });
    expect(row.lastTick?.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(row.lastTick?.summary.gated).toBe(1);
  });

  // The #324-time pin was "a tick is `{timestamp, log, summary, outcomes}` and
  // nothing behold can colour a node with". chant 0.53.1 (#2027) made that
  // false, so the pin is now the join it enables: the field path the record
  // arrives on, and the key it joins by.
  it("carry the tick's per-component verdicts and its id at `[].lastTick` (chant#2027)", () => {
    // The path, stated: `statusFor` spreads `ownRecords.at(-1)` onto the row
    // untouched, so a field added to `ConvergeTickRecord` arrives here verbatim.
    const [row] = rows(verdictsFixture);
    expect(row.lastTick?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.lastTick?.components).toEqual([
      { component: "api", reconciliation: "drifted", detail: "live digest differs", live: true },
      { component: "worker", reconciliation: "unknown", detail: "unreadable", unobserved: { reason: "no-credentials" } },
    ]);
    // The join key, pinned as a key and not as prose: a verdict names a
    // COMPONENT, and that is the same string `chant components status --live
    // --json` puts in `ComponentStatusRow.component` — which is what
    // src/component-status.ts joins onto a component-DAG node id. If chant ever
    // re-keys these by entity id instead, this is where behold finds out.
    expect(row.lastTick?.components?.map((c) => c.component)).toEqual(["api", "worker"]);
    // …and the count says "1 unobserved" while the verdicts say which one, the
    // whole point of chant#2027.
    expect(row.lastTick?.summary.unobserved).toBe(1);
    expect(row.lastTick?.components?.filter((c) => c.unobserved).map((c) => c.component)).toEqual(["worker"]);
  });

  it("keep reading a pre-0.53.1 tick, which carries neither field", () => {
    for (const row of [...rows(chantTestValues), ...rows(twoLoops)]) {
      expect(row.lastTick?.id).toBeUndefined();
      expect(row.lastTick?.components).toBeUndefined();
    }
  });

  it("carry ONE tick per loop — the history is a different read (chant#2029)", () => {
    // Not a stylistic assertion: `lastTick` is a single object in chant's own
    // `OpStatusLine`, and if that ever becomes an array behold must notice here
    // rather than silently rendering the first of many as if it were the only.
    // chant#2029 shipping `operator log` did NOT change this — `statusFor` still
    // keeps `records.at(-1)` — so the pin stays exactly where it was.
    for (const row of [...rows(chantTestValues), ...rows(twoLoops)]) {
      expect(Array.isArray(row.lastTick)).toBe(false);
    }
  });

  it("pin the ConvergeOp search-attribute union an op.json carries", () => {
    const parsed = parseOpIr(JSON.parse(read("staging-converge.op.json")));
    expect(parsed.ok).toBe(true);
    const ir = (parsed as { ok: true; ir: OpIr }).ir;
    expect(Object.keys(ir.searchAttributes ?? {}).sort()).toEqual(["Converge", "Dial", "Env"]);
  });
});

describe("readOperatorStatus", () => {
  it("reads the row array chant prints", () => {
    expect(rows(twoLoops).map((r) => r.op)).toEqual(["staging-converge", "prod-observe"]);
  });

  it("refuses a project with no ConvergeOp — exit 0 with an empty stdout is NOT an empty strip", () => {
    // chant prints its "No ConvergeOp declarations found" warning to stderr and
    // still exits 0 with nothing on stdout (cli/handlers/operator.ts:158-161).
    const result = readOperatorStatus({
      code: 0,
      stdout: "",
      stderr: "warning: No ConvergeOp declarations found\n",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("no-operator");
    expect(result.refusal.error).toMatch(/declares no operating loop/);
    expect(result.refusal.remedy).toMatch(/ConvergeOp/);
  });

  it("refuses a chant too old to have the command, and says which", () => {
    const result = readOperatorStatus({
      code: 1,
      stdout: "",
      stderr: 'error: Unknown command: operator\nhint: Run "chant --help" to see available commands\n',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("no-operator-cli");
    expect(result.refusal.remedy).toMatch(/chant 0\.52/);
  });

  it("refuses a malformed answer rather than rendering half a strip", () => {
    for (const stdout of ["not json at all", '{"op":"x"}', '[{"op":"x","env":"staging"}]']) {
      const result = readOperatorStatus(ok(stdout));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.code).toBe("operator-status");
    }
  });

  it("refuses one bad row outright — a strip missing a loop undercounts them", () => {
    const parsed = JSON.parse(twoLoops);
    delete parsed[1].pendingGates;
    const result = readOperatorStatus(ok(JSON.stringify(parsed)));
    expect(result.ok).toBe(false);
  });

  it("surfaces any other failure verbatim instead of guessing at it", () => {
    const result = readOperatorStatus({ code: 1, stdout: "", stderr: "error: could not read chant/lifecycle\n" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("operator-status");
    expect(result.refusal.error).toMatch(/could not read chant\/lifecycle/);
  });

  it("drops an undated tick rather than putting an undated line on the strip", () => {
    const parsed = JSON.parse(chantTestValues);
    delete parsed[0].lastTick.timestamp;
    const result = readOperatorStatus(ok(JSON.stringify(parsed)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].lastTick).toBeUndefined();
    // …and the gates it recorded still show: the row is not thrown away.
    expect(result.rows[0].pendingGates).toHaveLength(1);
  });

  it("strips ANSI before deciding what a failure was", () => {
    const result = readOperatorStatus({ code: 1, stdout: "", stderr: "[31merror: Unknown command: operator[0m" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("no-operator-cli");
  });
});

describe("declaredConvergeOps", () => {
  it("uses chant's own predicate — searchAttributes.Converge === 'true'", () => {
    const ir = JSON.parse(read("staging-converge.op.json")) as OpIr;
    expect(declaredConvergeOps([ir])).toEqual([{ name: "staging-converge", env: "staging", dial: "apply" }]);
  });

  it("finds none in an ordinary Op", () => {
    expect(declaredConvergeOps([{ name: "prod-apply" }, { name: "x", searchAttributes: { Env: "prod" } }])).toEqual([]);
  });
});

describe("operatorStrip", () => {
  const NOW = Date.parse("2026-01-01T00:05:00.000Z");

  it("puts the last tick's own log line on the strip, verbatim and dated", () => {
    const strip = operatorStrip(rows(twoLoops), NOW);
    expect(strip.rows[0].log).toBe(
      "converge(staging): drifted=1 remediated=0 reported=0 skipped-budget=0 skipped-flap=0 gated=1 unobserved=0 adopted=0",
    );
    expect(strip.rows[0].at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reads a lapsed lease as expired, a live one as held, and none as free", () => {
    const strip = operatorStrip(rows(twoLoops), NOW);
    // staging's lease expired at 00:00:30, four and a half minutes ago.
    expect(strip.rows[0]).toMatchObject({ lease: "expired", leaseHolder: "op-a" });
    // prod's row carries no lease at all.
    expect(strip.rows[1]).toMatchObject({ lease: "free", leaseHolder: null });
    const early = operatorStrip(rows(twoLoops), Date.parse("2026-01-01T00:00:10.000Z"));
    expect(early.rows[0].lease).toBe("held");
  });

  it("calls an unparseable expiry held, never expired", () => {
    // chant's own test uses `expiresAt: "y"`. behold knows a holder wrote a
    // lease and does not know when it lapses; "expired" would invite a reader to
    // assume the loop is free when it may not be.
    const strip = operatorStrip(rows(chantTestValues), NOW);
    expect(strip.rows[0].lease).toBe("held");
  });

  it("counts pending gates per loop and across them", () => {
    const strip = operatorStrip(rows(twoLoops), NOW);
    expect(strip.rows.map((r) => r.pendingGates)).toEqual([1, 0]);
    expect(strip.pendingGates).toBe(1);
  });

  it("says a never-ticked loop has no line rather than inventing one", () => {
    const strip = operatorStrip([{ op: "fresh", env: "dev", pendingGates: [] }], NOW);
    expect(strip.rows[0]).toMatchObject({ log: null, at: null, lease: "free" });
  });

  it("carries the tick's id so a tick is something to point at (chant#2027)", () => {
    const strip = operatorStrip(rows(verdictsFixture), NOW);
    expect(strip.rows[0].tickId).toBe("9f1c7a52-3b64-4d0e-8a71-2e5c6d90b4af");
  });

  it("carries a null tick id on a pre-0.53.1 tick — never a minted one", () => {
    // behold must not synthesize an identity chant didn't write: two ticks in
    // the same ISO second are exactly what the field exists to separate, and a
    // behold-side id would separate nothing while looking like it did.
    expect(operatorStrip(rows(twoLoops), NOW).rows.map((r) => r.tickId)).toEqual([null, null]);
    expect(operatorStrip([{ op: "fresh", env: "dev", pendingGates: [] }], NOW).rows[0].tickId).toBeNull();
  });
});

// ── The tick's per-component verdicts (chant#2027) ───────────────────────────

describe("tickComponentVerdicts", () => {
  it("projects the last tick's verdicts, keyed by component name", () => {
    expect(tickComponentVerdicts(rows(verdictsFixture))).toEqual([
      {
        op: "fountain-converge",
        env: "staging",
        at: "2026-01-01T00:00:00.000Z",
        tickId: "9f1c7a52-3b64-4d0e-8a71-2e5c6d90b4af",
        verdicts: [
          { component: "api", reconciliation: "drifted", detail: "live digest differs", live: true },
          { component: "worker", reconciliation: "unknown", detail: "unreadable", unobserved: { reason: "no-credentials" } },
        ],
      },
    ]);
  });

  it("contributes NOTHING for a tick with no components field — absent is not 'no components'", () => {
    // Every chant before 0.53.1. An entry with an empty list would let a
    // consumer read "this chant doesn't say" as "this tick saw nothing".
    expect(tickComponentVerdicts(rows(chantTestValues))).toEqual([]);
    expect(tickComponentVerdicts(rows(twoLoops))).toEqual([]);
  });

  it("contributes an EMPTY entry for a tick whose components is an empty array", () => {
    // A different fact: chant said it observed no components. It paints nothing
    // either way, but it is chant's statement rather than chant's silence.
    const parsed = JSON.parse(verdictsFixture);
    parsed[0].lastTick.components = [];
    const [tick] = tickComponentVerdicts(rows(JSON.stringify(parsed)));
    expect(tick.verdicts).toEqual([]);
    expect(tick.at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("contributes nothing for a loop that has never ticked", () => {
    expect(tickComponentVerdicts([{ op: "fresh", env: "dev", pendingGates: [] }])).toEqual([]);
  });

  it("drops a verdict behold can't read, and keeps the rest of the tick", () => {
    // One unreadable ROW refuses the whole strip (a strip missing a loop
    // undercounts them); one unreadable VERDICT costs a single node its colour,
    // which is exactly what a pre-0.53.1 chant costs every node.
    const parsed = JSON.parse(verdictsFixture);
    parsed[0].lastTick.components = [
      { reconciliation: "drifted", detail: "no component name" },
      { component: "api", reconciliation: "not-a-verdict", detail: "outside chant's union" },
      { component: "worker", reconciliation: "reconciled", detail: "fine" },
    ];
    const [tick] = tickComponentVerdicts(rows(JSON.stringify(parsed)));
    expect(tick.verdicts).toEqual([{ component: "worker", reconciliation: "reconciled", detail: "fine" }]);
  });

  it("takes the tick id as null when this chant recorded none", () => {
    const parsed = JSON.parse(verdictsFixture);
    delete parsed[0].lastTick.id;
    expect(tickComponentVerdicts(rows(JSON.stringify(parsed)))[0].tickId).toBeNull();
  });
});

describe("verdictsForEnv", () => {
  const tick = (env: string, at: string, component: string) => ({
    op: `${env}-converge`,
    env,
    at,
    tickId: null,
    verdicts: [{ component, reconciliation: "drifted" as const, detail: "d" }],
  });

  it("matches on the tick's own env — a staging verdict never paints a prod DAG", () => {
    const all = [tick("staging", "2026-01-01T00:00:00.000Z", "api"), tick("prod", "2026-01-01T00:01:00.000Z", "api")];
    expect(verdictsForEnv(all, "staging")?.op).toBe("staging-converge");
    expect(verdictsForEnv(all, "dev")).toBeNull();
  });

  it("takes the newest tick when two loops converge the same env", () => {
    const all = [tick("staging", "2026-01-01T00:00:00.000Z", "api"), tick("staging", "2026-01-01T00:04:00.000Z", "worker")];
    expect(verdictsForEnv(all, "staging")?.at).toBe("2026-01-01T00:04:00.000Z");
  });

  it("never lets an undatable tick displace one behold can date", () => {
    const all = [tick("staging", "2026-01-01T00:00:00.000Z", "api"), tick("staging", "not-a-date", "worker")];
    expect(verdictsForEnv(all, "staging")?.at).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("tickFreshness", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  const T = Date.parse(AT);

  it("dates a tick inside the window fresh", () => {
    expect(tickFreshness(AT, T + 60_000)).toEqual({ ageMs: 60_000, fresh: true });
    expect(tickFreshness(AT, T + TICK_VERDICT_TTL_MS)).toEqual({ ageMs: TICK_VERDICT_TTL_MS, fresh: true });
  });

  it("calls a tick past the window stale, while still reporting its age", () => {
    const past = tickFreshness(AT, T + TICK_VERDICT_TTL_MS + 1);
    expect(past.fresh).toBe(false);
    expect(past.ageMs).toBe(TICK_VERDICT_TTL_MS + 1);
  });

  it("refuses to call an undatable or future-dated tick fresh", () => {
    // The strip's lease verdict makes the same call in the other direction: when
    // behold can't date a fact, it declines to claim the fact is current.
    expect(tickFreshness("not-a-date", T)).toEqual({ ageMs: null, fresh: false });
    expect(tickFreshness(null, T)).toEqual({ ageMs: null, fresh: false });
    expect(tickFreshness(AT, T - 1000)).toEqual({ ageMs: null, fresh: false });
  });

  it("is fifteen of chant's own default operator rounds", () => {
    expect(TICK_VERDICT_TTL_MS).toBe(15 * 60_000);
  });
});

describe("convergeGateCards", () => {
  it("names its loop, its rule, and the op+gate chant approve takes", () => {
    const [card] = convergeGateCards(rows(chantTestValues));
    expect(card).toEqual({
      loop: CONVERGE_GATE_LOOP,
      rule: "drift-apply",
      op: "fountain-apply",
      gate: "rollout-gate",
      convergeOp: "staging-converge",
      env: "staging",
      since: "2026-01-01T00:00:00.000Z",
      semantics: APPROVE_SEMANTICS,
      approve: {
        method: "POST",
        path: "/api/operator/approve/fountain-apply/rollout-gate",
        command: "chant approve fountain-apply rollout-gate",
      },
    });
  });

  it("states that approving records a fact and does not unblock the dispatch", () => {
    // chant's gate-ledger doc: "it is not itself the unblock". A card that said
    // otherwise would make the button lie about what the click did.
    expect(APPROVE_SEMANTICS).toMatch(/records a fact/);
    expect(APPROVE_SEMANTICS).toMatch(/does not unblock/);
    expect(APPROVE_SEMANTICS).toMatch(/next tick/);
  });

  // chant#2028 shipped the address the pending fact never had, so this pin
  // flipped: it used to assert no card could carry a URL. It asserts BOTH ways
  // now, because the field is optional by design — a local tick with no PR
  // behind it genuinely has no address — and the absent case must keep rendering
  // exactly as it did before, with no placeholder standing in for a review
  // surface chant never claimed.
  it("carries the gate's address when the fact has one (chant#2028)", () => {
    const [card] = convergeGateCards(rows(gateUrl));
    expect(card.url).toBe("https://github.com/INTENTIUS/chant/pull/2028");
  });

  it("…and no url key at all when it doesn't — never a placeholder link", () => {
    const [card] = convergeGateCards(rows(chantTestValues));
    expect(Object.keys(card)).not.toContain("url");
    expect(JSON.stringify(card)).not.toMatch(/https?:/);
  });

  it("refuses an address it would not link — a ledger is not a trusted href", () => {
    // chant's own `isApprovalUrl` refuses this at `chant approve --url`, but the
    // PENDING half's url comes from CI env vars and either ledger can be
    // hand-edited. A card that can't link it renders as one with no address.
    const parsed = JSON.parse(gateUrl);
    for (const bad of ["javascript:alert(1)", "org/repo/pull/1", "file:///etc/passwd"]) {
      parsed[0].pendingGates[0].url = bad;
      const [card] = convergeGateCards(rows(JSON.stringify(parsed)));
      expect(card.url).toBeUndefined();
      expect(approvalLink(bad)).toBeUndefined();
    }
  });

  it("offers the address under chant's own words", () => {
    // `chant operator status`'s human render prints `approve at: <url>` beneath
    // the pending gate. A reader who has seen one has read the other.
    expect(APPROVE_AT).toBe("approve at:");
  });

  it("renders no resolved gate — a resolved one leaves pendingGates entirely", () => {
    // chant computes pendingGates by cross-reading readGateResolutions against
    // the gated tick's timestamp; `resolvedBy`/`timestamp` never reach the JSON.
    // Synthesizing a resolution from "the gate stopped being listed" would
    // attribute an approval to nobody.
    const parsed = JSON.parse(chantTestValues);
    parsed[0].pendingGates = [];
    expect(convergeGateCards(rows(JSON.stringify(parsed)))).toEqual([]);
  });

  it("drops a gate with no op — chant approve takes <op> <gate> positionally", () => {
    expect(convergeGateCards([{ op: "c", env: "e", pendingGates: [{ rule: "r", gate: "g" }] }])).toEqual([]);
  });
});

// ── The timeline: `chant operator log --json` (chant#2029) ───────────────────

describe("readOperatorLog", () => {
  it("reads the merged tick/resolution timeline chant prints", () => {
    const entries = logEntries(timelineLog);
    // chant's own test asserts exactly this order: the resolution lands after
    // the tick that made its gate pending, and before the next tick.
    expect(entries.map((e) => e.kind)).toEqual(["tick", "gate-resolution", "tick"]);
    expect(entries.map((e) => e.timestamp)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
  });

  it("carries the malformed count rather than rendering a silently short timeline", () => {
    // chant skips an unreadable ledger line and counts it instead of throwing,
    // so a corrupted ledger answers with a SHORTER history. Without the count on
    // screen a reader takes that gap for a quiet loop.
    const parsed = JSON.parse(timelineLog);
    parsed.malformed = { converge: 3, gates: 1 };
    const result = readOperatorLog(ok(JSON.stringify(parsed)));
    expect(result.ok && result.malformed).toEqual({ converge: 3, gates: 1 });
  });

  it("refuses a chant with no `operator log`, naming the version that has one", () => {
    // Both shapes an older chant answers with: the unknown compound command,
    // and — since `--limit` landed with the subcommand — chant#1127's hard error
    // on an unrecognized flag.
    for (const stderr of ["error: Unknown command: operator log\n", "error: Unknown flag: --limit\n"]) {
      const result = readOperatorLog({ code: 1, stdout: "", stderr });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe("no-operator-log-cli");
      expect(result.refusal.remedy).toContain(OPERATOR_LOG_FLOOR);
    }
  });

  it("refuses an empty stdout as `no operator`, not as an empty history", () => {
    // Same trap the status reader has: chant warns on stderr and still exits 0
    // with nothing on stdout when it discovers no ConvergeOp.
    const result = readOperatorLog({ code: 0, stdout: "", stderr: "No ConvergeOp declarations found\n" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("no-operator");
  });

  it("refuses the whole timeline on one entry it can't read", () => {
    // A dropped entry is an invisible gap — worse than chant's own malformed
    // count, which at least says a line was lost.
    for (const broken of [
      { kind: "tick", timestamp: "2026-01-01T00:00:00.000Z", record: { op: "x" } },
      { kind: "gate-resolution", timestamp: "2026-01-01T00:00:00.000Z", record: { op: "x", gate: "g" } },
      { kind: "remediation", timestamp: "2026-01-01T00:00:00.000Z", record: {} },
    ]) {
      const parsed = JSON.parse(timelineLog);
      parsed.entries.push(broken);
      const result = readOperatorLog(ok(JSON.stringify(parsed)));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe("operator-log");
    }
  });

  it("refuses an answer that isn't the {entries, malformed} document", () => {
    for (const stdout of ["[]", '{"ticks": []}', "not json"]) {
      expect(readOperatorLog(ok(stdout)).ok).toBe(false);
    }
  });
});

describe("operatorTimeline", () => {
  it("keeps chant's order and chant's words", () => {
    const timeline = operatorTimeline(logEntries(timelineLog));
    expect(timeline.map((r) => r.at)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
    const [first] = timeline;
    expect(first).toEqual({
      kind: "tick",
      at: "2026-01-01T00:00:00.000Z",
      op: "staging-converge",
      env: "staging",
      id: "t1",
      // chant's own log line, verbatim — the strip's rule, on every row.
      log: "converge(staging): drifted=0",
      gated: [{ rule: "drift-apply", op: "fountain-apply", gate: "rollout-gate", url: "https://pr.example/1" }],
    });
  });

  it("names who resolved a gate, and where — the one place behold says so", () => {
    // The status read can't: it computes pendingGates by cross-reading the gate
    // ledger and a resolved gate simply leaves the array, so `resolvedBy` never
    // reaches that JSON. Here it is a record, not an inference.
    const [, resolution] = operatorTimeline(logEntries(timelineLog));
    expect(resolution).toEqual({
      kind: "gate-resolution",
      at: "2026-01-02T00:00:00.000Z",
      op: "fountain-apply",
      gate: "rollout-gate",
      resolvedBy: "alex",
      note: null,
      url: "https://pr.example/1",
    });
  });

  it("nulls an address it would not link, on either half", () => {
    const parsed = JSON.parse(timelineLog);
    parsed.entries[0].record.outcomes[0].url = "javascript:alert(1)";
    parsed.entries[1].record.url = "not a url";
    const [tick, resolution] = operatorTimeline(logEntries(JSON.stringify(parsed)));
    expect(tick.kind === "tick" && tick.gated[0].url).toBeNull();
    expect(resolution.kind === "gate-resolution" && resolution.url).toBeNull();
  });

  it("prints an id only when the record has one — chant#2027 is younger than the ledger", () => {
    const parsed = JSON.parse(timelineLog);
    delete parsed.entries[0].record.id;
    const [tick] = operatorTimeline(logEntries(JSON.stringify(parsed)));
    expect(tick.kind === "tick" && tick.id).toBeNull();
  });
});

describe("the window behold asks for", () => {
  it("is bounded by default — never the whole ledger", () => {
    expect(operatorLogWindow({})).toEqual({ limit: OPERATOR_LOG_LIMIT });
    // The ledger grows one line per tick forever; a 60s round writes ~1,440 a
    // day. `--limit` is on every invocation behold makes.
    expect(operatorLogArgs({ limit: OPERATOR_LOG_LIMIT })).toEqual([
      "operator",
      "log",
      "--json",
      "--limit",
      String(OPERATOR_LOG_LIMIT),
    ]);
  });

  it("passes --since through when the caller asks for one", () => {
    expect(operatorLogArgs({ limit: 10, since: "2026-01-02T00:00:00.000Z" })).toEqual([
      "operator",
      "log",
      "--json",
      "--limit",
      "10",
      "--since",
      "2026-01-02T00:00:00.000Z",
    ]);
  });

  it("clamps a limit past the ceiling rather than refusing it", () => {
    // Asking for more history than behold will fetch is reasonable; the answer
    // reports the window it used, so the clamp is visible rather than silent.
    expect(operatorLogWindow({ limit: "5000" })).toEqual({ limit: OPERATOR_LOG_MAX_LIMIT });
  });

  it("refuses what chant would refuse, before anything is spawned", () => {
    for (const limit of ["0", "-3", "1.5", "lots"]) {
      expect(operatorLogWindow({ limit })).toHaveProperty("error");
    }
    expect(operatorLogWindow({ since: "last tuesday" })).toHaveProperty("error");
  });
});

describe("mergeOperatorLogs", () => {
  const entries = logEntries(timelineLog);
  const one = { entries, malformed: { converge: 1, gates: 0 } };

  it("keeps the newest n across every member's ledger, still oldest-first", () => {
    // A multi-estate (#31) has a ConvergeOp per member project, each with its
    // own chant and its own ledger, so the window has to mean the same thing
    // whether one project answered or four.
    const other: OperatorLogEntry[] = [
      { kind: "tick", timestamp: "2026-01-02T12:00:00.000Z", record: { ...entries[0].record, id: "o1" } as never },
    ];
    const merged = mergeOperatorLogs([one, { entries: other, malformed: { converge: 0, gates: 2 } }], 3);
    expect(merged.entries.map((e) => e.timestamp)).toEqual([
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T12:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
    // …and every member's unreadable lines are counted, not the first one's.
    expect(merged.malformed).toEqual({ converge: 1, gates: 2 });
  });

  it("leaves a single member's answer in chant's own order, untouched", () => {
    expect(mergeOperatorLogs([one], 50).entries).toBe(entries);
  });

  it("keeps chant's tie rule: a resolution reads after the tick that gated", () => {
    const tick = entries[0];
    const resolution = { ...entries[1], timestamp: tick.timestamp };
    const merged = mergeOperatorLogs(
      [
        { entries: [resolution as OperatorLogEntry], malformed: { converge: 0, gates: 0 } },
        { entries: [tick], malformed: { converge: 0, gates: 0 } },
      ],
      10,
    );
    expect(merged.entries.map((e) => e.kind)).toEqual(["tick", "gate-resolution"]);
  });
});

// ── The free rider: OperatorStack's namespace ────────────────────────────────

/** An OperatorStack's rendered members, as chant's k8s lexicon emits them —
 * kinds from `lexicons/k8s/src/generated/index.ts`, labels from
 * `lexicons/k8s/src/composites/operator-stack.ts` (`app.kubernetes.io/managed-by:
 * chant`, and `component: converge-tick` on the CronJob). */
function operatorEstate(): GraphIR {
  const common = { "app.kubernetes.io/name": "chant-operator", "app.kubernetes.io/managed-by": "chant" };
  return {
    nodes: [
      {
        id: "ns",
        kind: "K8s::Core::Namespace",
        lexicon: "k8s",
        attrs: { metadata: { name: "chant-operator", labels: { ...common, "app.kubernetes.io/component": "namespace" } } },
      },
      {
        id: "cron",
        kind: "K8s::Batch::CronJob",
        lexicon: "k8s",
        attrs: {
          metadata: {
            name: "staging-converge",
            namespace: "chant-operator",
            labels: { ...common, "app.kubernetes.io/component": "converge-tick", "app.kubernetes.io/instance": "staging-converge" },
          },
          spec: { schedule: "*/10 * * * *", concurrencyPolicy: "Forbid" },
        },
      },
      {
        id: "sa",
        kind: "K8s::Core::ServiceAccount",
        lexicon: "k8s",
        attrs: { metadata: { name: "staging-converge-sa", namespace: "chant-operator", labels: common } },
      },
      // An ordinary app CronJob in another namespace: not the loop.
      {
        id: "backup",
        kind: "K8s::Batch::CronJob",
        lexicon: "k8s",
        attrs: { metadata: { name: "nightly-backup", namespace: "apps", labels: { "app.kubernetes.io/component": "backup" } } },
      },
    ],
    edges: [],
    groups: {},
  } as unknown as GraphIR;
}

describe("markOperatorHome", () => {
  it("finds the loop's home from chant's own labels, not from a name convention", () => {
    expect(operatorHomes(operatorEstate())).toEqual([
      {
        namespace: "chant-operator",
        node: "ns",
        stack: "chant-operator",
        ticks: [{ node: "cron", op: "staging-converge", schedule: "*/10 * * * *" }],
      },
    ]);
  });

  it("marks the Namespace as the home and each CronJob as a tick", () => {
    const marked = markOperatorHome(operatorEstate());
    const by = new Map(marked.nodes.map((n) => [n.id, n.attrs?._operator]));
    expect(by.get("ns")).toEqual({
      role: "home",
      namespace: "chant-operator",
      stack: "chant-operator",
      ticks: ["staging-converge"],
    });
    expect(by.get("cron")).toEqual({
      role: "tick",
      namespace: "chant-operator",
      stack: "chant-operator",
      op: "staging-converge",
      schedule: "*/10 * * * *",
    });
    // The RBAC trio and an unrelated CronJob are left alone.
    expect(by.get("sa")).toBeUndefined();
    expect(by.get("backup")).toBeUndefined();
  });

  it("is strictly additive — an estate with no OperatorStack is returned untouched", () => {
    const plain = { nodes: [{ id: "a", kind: "K8s::Batch::CronJob", lexicon: "k8s", attrs: {} }], edges: [], groups: {} } as unknown as GraphIR;
    expect(markOperatorHome(plain)).toBe(plain);
  });

  it("marks the ticks even when the Namespace is declared in a project not being served", () => {
    const ir = operatorEstate();
    const withoutNs = { ...ir, nodes: ir.nodes.filter((n) => n.id !== "ns") } as GraphIR;
    const [home] = operatorHomes(withoutNs);
    expect(home.node).toBeUndefined();
    expect(home.ticks).toHaveLength(1);
  });

  it("refuses to claim a stack name two OperatorStacks disagree on", () => {
    const ir = operatorEstate();
    const tick = (id: string, op: string, stack: string) => {
      const n = JSON.parse(JSON.stringify(ir.nodes[1])) as (typeof ir.nodes)[number];
      n.id = id;
      (n.attrs!.metadata as Record<string, unknown>).name = op;
      ((n.attrs!.metadata as Record<string, unknown>).labels as Record<string, string>)["app.kubernetes.io/name"] = stack;
      return n;
    };
    // The third tick agrees with the first. The name must stay gone: a
    // contradiction already happened, and re-adopting the majority answer would
    // put a name on the box that one of these stacks does not answer to.
    const nodes = [...ir.nodes, tick("cron2", "prod-converge", "other-operator"), tick("cron3", "dev-converge", "chant-operator")];
    const [home] = operatorHomes({ ...ir, nodes } as GraphIR);
    expect(home.stack).toBeUndefined();
    expect(home.ticks.map((t) => t.op)).toEqual(["dev-converge", "prod-converge", "staging-converge"]);
  });
});

// ── The free rider's other half: the logical lens's namespace box ───────────
// (#234, pinhole#119, behold#331). Same detector (`operatorHomes`), a
// different destination — a `GroupBox` addressed by the projection's own
// `namespaceBoxes` key, never by title.
describe("operatorHomeBoxMarks", () => {
  it("marks the operator's namespace box, by its structural key", () => {
    const namespaceBoxes = { "chant-operator": "namespace chant-operator", apps: "namespace apps" };
    expect(operatorHomeBoxMarks(operatorEstate(), namespaceBoxes)).toEqual({
      "namespace chant-operator": OPERATOR_HOME_GLYPH,
    });
  });

  it("a non-operator namespace's box is absent from the result, not marked with anything", () => {
    const namespaceBoxes = { "chant-operator": "namespace chant-operator", apps: "namespace apps" };
    const marks = operatorHomeBoxMarks(operatorEstate(), namespaceBoxes);
    expect(marks["namespace apps"]).toBeUndefined();
    expect(Object.keys(marks)).toEqual(["namespace chant-operator"]);
  });

  it("a project with no operator marks nothing — byte-identical to before this field existed", () => {
    const plain = { nodes: [{ id: "a", kind: "K8s::Batch::CronJob", lexicon: "k8s", attrs: {} }], edges: [], groups: {} } as unknown as GraphIR;
    expect(operatorHomeBoxMarks(plain, { default: "namespace default" })).toEqual({});
  });

  it("a home whose namespace the projection never boxed marks nothing — no box to invent one on", () => {
    expect(operatorHomeBoxMarks(operatorEstate(), {})).toEqual({});
  });
});

// ── The held state and the statusbar sentence ────────────────────────────────

describe("operatorRead / operatorNote", () => {
  const declared = [{ name: "staging-converge", env: "staging", dial: "apply" }];
  const AT = "2026-01-01T00:05:00.000Z";
  const NOW = Date.parse(AT);

  it("says there is no strip when no loop is declared", () => {
    expect(operatorNote(initialOperatorState)).toMatch(/declares no ConvergeOp/);
  });

  it("says a declared loop hasn't been read yet before the first ask", () => {
    expect(operatorNote({ ...initialOperatorState, declared })).toMatch(/not read yet/);
  });

  it("keeps the declaration when a read refuses, and states why", () => {
    const state = operatorRead(
      { ...initialOperatorState, declared },
      readOperatorStatus({ code: 1, stdout: "", stderr: "error: Unknown command: operator" }),
      AT,
    );
    expect(state.declared).toEqual(declared);
    expect(state.strip).toBeNull();
    expect(state.code).toBe("no-operator-cli");
    expect(operatorNote(state)).toMatch(/status unavailable/);
  });

  it("says out loud that one tick is all the STATUS read exposes, and where the rest is", () => {
    const state = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(chantTestValues)), AT, NOW);
    const note = operatorNote(state);
    expect(note).toMatch(/last tick per loop/);
    // The history exists now (chant#2029), so the sentence points at it rather
    // than stopping at "this is not a timeline".
    expect(note).toMatch(/chant#2029/);
    expect(note).toMatch(/its own read/);
  });

  it("holds the tick's verdicts on the state, time-independently (chant#2027)", () => {
    // Time-independent on purpose: src/op-runner.ts compares the whole state to
    // decide whether to broadcast, so a freshness flag computed here would make
    // the clock itself look like news and turn the poll into a repaint loop.
    const state = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(verdictsFixture)), AT, NOW);
    expect(state.verdicts).toEqual(tickComponentVerdicts(rows(verdictsFixture)));
    expect(JSON.stringify(state.verdicts)).not.toMatch(/fresh|ageMs/);
  });

  it("drops the verdicts when a read refuses — a refusal leaves no current claim", () => {
    const read = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(verdictsFixture)), AT, NOW);
    const refused = operatorRead(read, readOperatorStatus({ code: 1, stdout: "", stderr: "error: nope" }), AT, NOW);
    expect(refused.verdicts).toEqual([]);
  });

  it("holds no verdicts from a pre-0.53.1 chant, so the join is a no-op there", () => {
    const state = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(twoLoops)), AT, NOW);
    expect(state.verdicts).toEqual([]);
  });

  it("says how many component verdicts the tick carried, and that they sit under the live read", () => {
    const state = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(verdictsFixture)), AT, NOW);
    const note = operatorNote(state, NOW);
    expect(note).toMatch(/2 component verdicts from that tick/);
    expect(note).toMatch(/joined onto the component DAG by component name/);
    expect(note).toMatch(/under the live read \(never over it\)/);
  });

  it("says a stale tick's verdicts are named but not painted", () => {
    const state = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(verdictsFixture)), AT, NOW);
    const note = operatorNote(state, NOW + TICK_VERDICT_TTL_MS + 1);
    expect(note).toMatch(/all older than 15m/);
    expect(note).toMatch(/named on the node, not painted/);
  });

  it("says nothing about verdicts when the tick carried none", () => {
    const state = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(chantTestValues)), AT, NOW);
    expect(operatorNote(state, NOW)).not.toMatch(/component verdict/);
  });

  it("distinguishes the converge gate from the run gate in the sentence", () => {
    const state = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(chantTestValues)), AT, NOW);
    const note = operatorNote(state);
    expect(note).toMatch(/1 converge gate pending/);
    expect(note).toMatch(/records a fact for the next tick/);
    expect(note).toMatch(/does not release a workflow/);
  });

  it("counts the gates that name where approval happens, and stays quiet when none do", () => {
    // chant#2028's address is optional by design — a local tick with no PR
    // behind it genuinely has none — so a blanket claim either way would be
    // wrong on some estate. The count is the honest summary.
    const addressed = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(gateUrl)), AT, NOW);
    expect(operatorNote(addressed)).toMatch(/1 names where approval happens \(chant#2028\)/);
    const none = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(chantTestValues)), AT, NOW);
    expect(operatorNote(none)).not.toMatch(/chant#2028/);
    expect(operatorNote(none)).toMatch(/1 converge gate pending/);
  });

  it("names an expired lease so a reader knows the next round reclaims it", () => {
    const two = [{ name: "staging-converge", env: "staging" }, { name: "prod-observe", env: "prod" }];
    const state = operatorRead({ ...initialOperatorState, declared: two }, readOperatorStatus(ok(twoLoops)), AT, NOW);
    expect(operatorNote(state)).toMatch(/1 lease expired/);
  });

  it("says a loop has never ticked rather than staying silent about it", () => {
    const state = operatorRead(
      { ...initialOperatorState, declared },
      { ok: true, rows: [{ op: "staging-converge", env: "staging", pendingGates: [] }] },
      AT,
      NOW,
    );
    expect(operatorNote(state)).toMatch(/no tick recorded yet/);
  });
});
