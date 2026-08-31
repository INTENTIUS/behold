import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import {
  readOperatorStatus,
  declaredConvergeOps,
  operatorStrip,
  convergeGateCards,
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

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const rows = (stdout: string): OpStatusLine[] => {
  const result = readOperatorStatus(ok(stdout));
  if (!result.ok) throw new Error(`fixture didn't parse: ${result.refusal.error}`);
  return result.rows;
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

  it("carry ONE tick per loop — there is no history in this surface (chant#2029)", () => {
    // Not a stylistic assertion: `lastTick` is a single object in chant's own
    // `OpStatusLine`, and if that ever becomes an array behold must notice here
    // rather than silently rendering the first of many as if it were the only.
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

  it("carries no URL — a pending gate fact has no address (chant#2028)", () => {
    const [card] = convergeGateCards(rows(chantTestValues));
    expect(Object.keys(card)).not.toContain("url");
    expect(JSON.stringify(card)).not.toMatch(/https?:/);
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

  it("says out loud that one tick is all chant exposes", () => {
    const state = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(chantTestValues)), AT, NOW);
    const note = operatorNote(state);
    expect(note).toMatch(/last tick only/);
    expect(note).toMatch(/chant#2029/);
    expect(note).toMatch(/strip and not a timeline/);
  });

  it("distinguishes the converge gate from the run gate in the sentence", () => {
    const state = operatorRead({ ...initialOperatorState, declared }, readOperatorStatus(ok(chantTestValues)), AT, NOW);
    const note = operatorNote(state);
    expect(note).toMatch(/1 converge gate pending/);
    expect(note).toMatch(/records a fact for the next tick/);
    expect(note).toMatch(/does not release a workflow/);
    expect(note).toMatch(/chant#2028/);
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
