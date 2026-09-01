import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import {
  parseOpIr,
  readOpIr,
  opsToIr,
  opsNote,
  stepLabel,
  stepKind,
  stepStatus,
  opCardFields,
  convergeTable,
  predicateText,
  actionText,
  ruleStatus,
  joinStepEntities,
  ESTATE_BOX,
  type OpIr,
  type OpIrConvergeRule,
} from "./ops-lens.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__", "ops-example-writes");
const CONVERGE_FIXTURES = join(HERE, "__fixtures__", "ops-converge");

/**
 * The fixtures are REAL emitted IR: this repo's own `example-writes` copied to
 * a scratch dir (so nothing in the checkout was touched), `npm install
 * --no-save @intentius/chant@0.52.1 @intentius/chant-lexicon-aws@0.52.1
 * @intentius/chant-lexicon-temporal@0.52.1`, then `chant build --lexicon
 * temporal`, which writes `dist/ops/<name>/op.json` per Op (chant#1289, chant
 * >= 0.50). Committed verbatim, one file per Op.
 *
 * Three of the four are example-writes exactly as it ships: `prod-apply`
 * (ApplyOp), `prod-reconcile` (ReconcileOp), `floci-apply` (a hand-written
 * `Op()`). None of them declares a gate or a `depends`, and the lens draws
 * both — so the scratch copy also declared a fourth Op, `prod-promote`, and
 * chant emitted its IR in the same build:
 *
 *     export default Op({
 *       name: "prod-promote", overview: "...", taskQueue: "behold-writes",
 *       depends: ["prod-apply"],
 *       phases: [
 *         phase("Plan", [activity("lifecycleDiff", { env: "prod", live: true })]),
 *         phase("Approve", [gate("approve-promote", { timeout: "24h", description: "..." })]),
 *         phase("Apply", [awsApply("template.json", { stackName: "prod" })]),
 *         phase("Verify", [httpCheck("https://behold-floci-demo.s3.amazonaws.com/")]),
 *       ],
 *     });
 *
 * The union of every step's args across all four is env / stackName /
 * templatePath / target / output / path / script / deleteMode / mode / owned /
 * live / endpoint / url — scope, never an estate entity id. Which of those
 * identify an entity is the CONTRACT's to say, and chant 0.54.0 (chant#2022)
 * says it: `httpCheck` declares `url`, so op.json resolves each httpCheck's
 * literal url into the step's `entities`. `floci-apply.op.json` was
 * regenerated verbatim from example-writes on chant 0.54.0 (the diff against
 * the 0.52.1 emit is exactly the two `entities` additions — step and contract
 * — and nothing else); `prod-promote`, the scratch-only Op, carries the same
 * two additions applied by hand to the same shape.
 */
const ops: OpIr[] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".op.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as OpIr);

const byName = new Map(ops.map((o) => [o.name, o]));

describe("the real chant-emitted op.json fixtures", () => {
  it("are the shape the lens claims they are", () => {
    expect(ops.map((o) => o.name)).toEqual(["floci-apply", "prod-apply", "prod-promote", "prod-reconcile"]);
    for (const op of ops) {
      expect(parseOpIr(op).ok).toBe(true);
      expect(op.formatVersion).toBe("1.0");
    }
  });

  it("resolve every step's profile and every gate's timeout to an effective value", () => {
    // The IR's own reason for existing beyond a literal OpConfig restatement:
    // no step is left saying "whatever chant's default is".
    const promote = byName.get("prod-promote")!;
    const apply = promote.phases.find((p) => p.name === "Apply")!.steps[0];
    expect(apply).toMatchObject({ kind: "activity", fn: "awsApply", profile: "longInfra" });
    const gate = promote.phases.find((p) => p.name === "Approve")!.steps[0];
    expect(gate).toMatchObject({ kind: "gate", signalName: "approve-promote", timeout: "24h" });
    // And the profile's actual policy rides along, so a reader never has to
    // know what "longInfra" means.
    expect(promote.activityProfiles?.longInfra).toMatchObject({
      startToCloseTimeout: "20m",
      retry: { maximumAttempts: 3 },
    });
  });

  it("carry an estate entity only where a contract declares one: the two httpCheck urls (chant#2022)", () => {
    const declared: Array<[string, string[]]> = [];
    for (const op of ops) {
      for (const phase of [...op.phases, ...(op.onFailure ?? [])]) {
        for (const step of phase.steps) {
          if (step.kind === "activity" && step.entities) declared.push([`${op.name}/${step.fn}`, step.entities]);
        }
      }
    }
    expect(declared).toEqual([
      ["floci-apply/httpCheck", ["http://localhost:4566/behold-floci-demo"]],
      ["prod-promote/httpCheck", ["https://behold-floci-demo.s3.amazonaws.com/"]],
    ]);
    // And the contract says why: `url` is the entity-identifying arg.
    expect(byName.get("floci-apply")!.activityContracts?.httpCheck).toMatchObject({ entities: ["url"] });
  });
});

describe("opsToIr — the declared track", () => {
  const ir = opsToIr(ops);

  it("makes one node per step, in declared order, boxed per <op> · <phase>", () => {
    // floci-apply: Build → Apply → Verify, one step each.
    expect(ir.groups.byStack!["floci-apply · Build"]).toEqual(["floci-apply/Build/chantBuild"]);
    expect(ir.groups.byStack!["floci-apply · Apply"]).toEqual(["floci-apply/Apply/awsApply"]);
    expect(ir.groups.byStack!["floci-apply · Verify"]).toEqual(["floci-apply/Verify/httpCheck"]);
    // 3 + 3 + 4 + 3 steps across the four Ops.
    expect(ir.nodes).toHaveLength(13);
    expect(ir.nodes.every((n) => n.lexicon === "op")).toBe(true);
    // The card's kind is the activity's own function name, which is what
    // pinhole's glyph heuristic and the inspect pane's identity block read.
    expect(ir.nodes.find((n) => n.id === "floci-apply/Apply/awsApply")!.kind).toBe("awsApply");
  });

  it("chains the steps of one Op in declared order and nothing across Ops but depends", () => {
    const then = ir.edges.filter((e) => e.viaAttr === "then").map((e) => `${e.from} → ${e.to}`);
    expect(then).toContain("floci-apply/Build/chantBuild → floci-apply/Apply/awsApply");
    expect(then).toContain("floci-apply/Apply/awsApply → floci-apply/Verify/httpCheck");
    // Every `then` edge stays inside its own Op.
    for (const e of ir.edges.filter((x) => x.viaAttr === "then")) {
      expect(e.from.split("/")[0]).toBe(e.to.split("/")[0]);
    }
  });

  it("draws op → op depends from the depended-on Op's last step to the depender's first", () => {
    const depends = ir.edges.filter((e) => e.viaAttr === "depends");
    expect(depends).toEqual([
      { from: "prod-apply/Apply/nativeApply", to: "prod-promote/Plan/lifecycleDiff", kind: "ref", viaAttr: "depends" },
    ]);
  });

  it("drops a depends naming an Op this project didn't emit, rather than minting a card", () => {
    const orphan = opsToIr([{ ...byName.get("prod-promote")!, depends: ["never-built"] }]);
    expect(orphan.edges.filter((e) => e.viaAttr === "depends")).toEqual([]);
    expect(orphan.nodes.some((n) => n.id.startsWith("never-built"))).toBe(false);
  });

  it("draws the gate as its own card, marked, naming the step it guards", () => {
    const gate = ir.nodes.find((n) => n.id === "prod-promote/Approve/gate:approve-promote")!;
    expect(gate.kind).toBe("Gate");
    // The drift palette's own vocabulary — nothing here has run, so `warn` is
    // the one mark: this is where the Op stops for a human.
    expect(gate.attrs._status).toBe("warn");
    expect(gate.attrs.gate).toBe("approve-promote");
    expect(gate.attrs.timeout).toBe("24h");
    expect(gate.attrs.guards).toBe("awsApply");
    // Every other step is unrun and unmarked.
    expect(ir.nodes.filter((n) => n.attrs._status === "warn")).toHaveLength(1);
    expect(ir.nodes.filter((n) => n.attrs._status === "good")).toHaveLength(0);
  });

  it("puts the resolved profile policy and args on the activity card", () => {
    const apply = ir.nodes.find((n) => n.id === "prod-apply/Apply/nativeApply")!;
    expect(apply.attrs.profile).toBe("longInfra");
    expect(apply.attrs.policy).toBe("20m start-to-close, 60s heartbeat, 3 attempts, from 30s");
    expect(apply.attrs.args).toBe("target=cloudformation, env=prod, output=template.json, deleteMode=never");
    // chant's outcomeAttribute — the search attribute a run stamps from a
    // step's return value.
    const plan = ir.nodes.find((n) => n.id === "prod-apply/Plan/lifecycleDiff")!;
    expect(plan.attrs.outcome).toBe("Drift ← drifted");
    expect(plan.attrs.contract).toContain("declared");
  });

  it("draws no cross-link on its own — every edge runs between two steps until an estate is joined (#284)", () => {
    // `opsToIr` is the declaration alone. The httpCheck steps carry their
    // entities on the card; the edge into the estate is `joinStepEntities`'s,
    // and it needs an estate to join to.
    expect(ir.nodes.every((n) => n.lexicon === "op")).toBe(true);
    const ids = new Set(ir.nodes.map((n) => n.id));
    expect(ir.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    const check = ir.nodes.find((n) => n.id === "floci-apply/Verify/httpCheck")!;
    expect(check.attrs.entities).toBe("http://localhost:4566/behold-floci-demo");
    expect(check.attrs._entities).toEqual(["http://localhost:4566/behold-floci-demo"]);
  });
});

describe("opsToIr — shapes the real fixtures can't reach", () => {
  /** A `parallel` phase, an `onFailure` compensation track, an `effect` step and
   * a repeated step: all legal op.json that example-writes happens not to
   * declare. Hand-built against chant's own `OpIR` interface. */
  const synthetic: OpIr = {
    formatVersion: "1.0",
    name: "wide",
    phases: [
      { name: "Build", parallel: false, steps: [{ kind: "activity", fn: "chantBuild", args: {}, profile: "fastIdempotent" }] },
      {
        name: "Fan",
        parallel: true,
        steps: [
          { kind: "activity", fn: "httpCheck", args: { url: "http://a" }, profile: "fastIdempotent" },
          { kind: "activity", fn: "httpCheck", args: { url: "http://b" }, profile: "fastIdempotent" },
        ],
      },
      {
        name: "Seed",
        parallel: false,
        steps: [
          {
            kind: "effect",
            receipt: { name: "dbSeeded" },
            expectation: "sha256:abc",
            steps: [{ kind: "activity", fn: "shellCmd", args: { script: "seed" } }],
          },
        ],
      },
    ],
    onFailure: [{ name: "Rollback", parallel: false, steps: [{ kind: "activity", fn: "rollbackStack", args: { env: "prod" } }] }],
  };
  const ir = opsToIr([synthetic]);

  it("suffixes a repeated step rather than letting one card stand for both", () => {
    expect(ir.nodes.map((n) => n.id)).toContain("wide/Fan/httpCheck");
    expect(ir.nodes.map((n) => n.id)).toContain("wide/Fan/httpCheck#2");
  });

  it("fans out and back around a parallel phase instead of chaining through it", () => {
    const then = ir.edges.filter((e) => e.viaAttr === "then").map((e) => `${e.from} → ${e.to}`);
    expect(then).toEqual([
      "wide/Build/chantBuild → wide/Fan/httpCheck",
      "wide/Build/chantBuild → wide/Fan/httpCheck#2",
      "wide/Fan/httpCheck → wide/Seed/effect:dbSeeded",
      "wide/Fan/httpCheck#2 → wide/Seed/effect:dbSeeded",
    ]);
  });

  it("keeps onFailure as its own unattached track", () => {
    expect(ir.groups.byStack!["wide · onFailure: Rollback"]).toEqual(["wide/Rollback/rollbackStack"]);
    const rollback = ir.nodes.find((n) => n.id === "wide/Rollback/rollbackStack")!;
    expect(rollback.attrs.when).toBe("onFailure");
    // No edge crosses between the main track and the compensation track.
    expect(ir.edges.some((e) => e.from.includes("Rollback") || e.to.includes("Rollback"))).toBe(false);
  });

  it("keeps an effect's nested steps inside its one card", () => {
    const effect = ir.nodes.find((n) => n.id === "wide/Seed/effect:dbSeeded")!;
    expect(effect.kind).toBe("Effect");
    expect(effect.attrs._status).toBe("accent");
    expect(effect.attrs.effect).toBe("dbSeeded");
    expect(effect.attrs.runs).toBe("shellCmd");
    expect(ir.nodes.some((n) => n.id.includes("shellCmd"))).toBe(false);
  });
});

describe("step naming and paint", () => {
  it("prefixes a gate and an effect so neither reads as another activity", () => {
    expect(stepLabel({ kind: "activity", fn: "awsApply" })).toBe("awsApply");
    expect(stepLabel({ kind: "gate", signalName: "approve" })).toBe("gate:approve");
    expect(stepLabel({ kind: "effect", receipt: "seeded" })).toBe("effect:seeded");
    expect(stepKind({ kind: "gate", signalName: "approve" })).toBe("Gate");
    expect(stepKind({ kind: "activity", fn: "awsApply" })).toBe("awsApply");
  });

  it("marks only what is not a plain activity — nothing here has run", () => {
    expect(stepStatus({ kind: "activity", fn: "awsApply" })).toBe("neutral");
    expect(stepStatus({ kind: "gate", signalName: "approve" })).toBe("warn");
    expect(stepStatus({ kind: "effect", receipt: "seeded" })).toBe("accent");
  });
});

describe("opCardFields — the two fields a step card shows", () => {
  const ir = opsToIr(ops);
  const at = (id: string) => ir.nodes.find((n) => n.id === id)!;

  it("leads an activity with its phase, not the alphabetically-first attr", () => {
    expect(opCardFields(at("prod-apply/Apply/nativeApply"))).toEqual([
      { label: "phase", value: "Apply" },
      { label: "profile", value: "longInfra" },
    ]);
  });

  it("leads a gate with the signal it waits on", () => {
    expect(opCardFields(at("prod-promote/Approve/gate:approve-promote"))).toEqual([
      { label: "gate", value: "approve-promote" },
      { label: "timeout", value: "24h" },
    ]);
  });

  it("declines a node from another lexicon", () => {
    expect(opCardFields({ attrs: { score: 88 } })).toBeUndefined();
  });
});

describe("opsNote", () => {
  it("counts what was drawn and says what could not be joined", () => {
    const ir = opsToIr(ops);
    const note = opsNote(ops, ir);
    expect(note).toContain("4 declared Ops · 13 steps · 1 gate");
    expect(note).toContain("No estate cross-links");
    expect(note).toContain("Read-only");
  });
});

describe("parseOpIr / readOpIr — refusals (#193)", () => {
  it("refuses a non-object, and a JSON file that was never an op.json", () => {
    for (const value of [42, "hello", [1, 2]]) {
      const p = parseOpIr(value);
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.refusal.code).toBe("op-ir");
    }
    const p = parseOpIr({ hello: "world" });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.refusal.error).toContain("string `name` and a `phases` array");
      expect(p.refusal.remedy).toContain("chant build --lexicon temporal");
    }
  });

  it("names the phase that isn't one", () => {
    const p = parseOpIr({ name: "x", phases: [{ name: "ok", steps: [] }, { name: "bad" }] });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.refusal.error).toContain("entry 1");
  });

  it("accepts an absent formatVersion but refuses a major it can't read", () => {
    expect(parseOpIr({ name: "x", phases: [] }).ok).toBe(true);
    const p = parseOpIr({ name: "x", phases: [], formatVersion: "2.0" });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.refusal.error).toContain("behold reads version 1");
  });

  it("refuses an unreadable file and invalid JSON without throwing", () => {
    const missing = readOpIr("/nope/op.json", () => {
      throw new Error("ENOENT");
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusal.error).toContain("ENOENT");
    const bad = readOpIr("/x/op.json", () => "{not json");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.refusal.error).toContain("isn't valid JSON");
  });

  it("reads a real fixture off disk", () => {
    const p = readOpIr(join(FIXTURES, "prod-promote.op.json"), (f) => readFileSync(f, "utf8"));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.ir.depends).toEqual(["prod-apply"]);
  });
});

// ── The converge rule table (#234 join 4) ─────────────────────────────────────

/**
 * Also REAL emitted IR, from a second scratch build. chant ships no example
 * declaring a `ConvergeOp` — `ConvergeOp(` appears only in the composite, its
 * own test and the operator internals — so there is no sanctioned golden
 * op.json to fixture against, and behold authored its own project.
 *
 * The composite IS published, so this is a real chant build rather than a
 * hand-written approximation: this repo's `example-writes` copied to a scratch
 * dir, `npm install @intentius/chant@0.52.2 @intentius/chant-lexicon-aws@0.52.2
 * @intentius/chant-lexicon-temporal@0.52.2`, one added `ops/converge.op.ts`
 * declaring `ConvergeOp({name: "prod-converge", env: "prod", dial: "apply",
 * budget: 2, rules: [...]})` with its rules built through chant's own
 * `when()`/`eq`/`gt`/`lt`/`allOf`/`anyOf`/`truthy`/`run`/`report`, exactly as
 * `converge-op.test.ts` builds them, then `chant build --lexicon temporal`.
 *
 * That the build PASSED is itself part of the provenance: chant's TMP014
 * post-synth check refuses a rule with a blank `why`, a predicate outside the
 * evaluable subset, or a `run()` naming an Op the project doesn't declare — so
 * this is a table chant considers well-formed, not merely one that parses.
 *
 * The seven rules cover every predicate form chant has (field comparison with
 * eq/gt/lt, truthiness, all-of, any-of), both actions, and `flapThreshold`
 * present and absent. `prod-apply` and `floci-apply` are the two Ops the run
 * rules dispatch, emitted by the same build, so the cross-link is drawn against
 * real targets.
 */
const convergeOps: OpIr[] = readdirSync(CONVERGE_FIXTURES)
  .filter((f) => f.endsWith(".op.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(CONVERGE_FIXTURES, f), "utf8")) as OpIr);

const converge = convergeOps.find((o) => o.name === "prod-converge")!;

describe("the real chant-emitted ConvergeOp fixture", () => {
  it("is an ordinary Op whose Converge phase carries one convergeTick step", () => {
    expect(convergeOps.map((o) => o.name)).toEqual(["floci-apply", "prod-apply", "prod-converge"]);
    expect(parseOpIr(converge).ok).toBe(true);
    expect(converge.formatVersion).toBe("1.0");
    expect(converge.phases.map((p) => p.name)).toEqual(["Observe", "Converge"]);
    expect(converge.searchAttributes).toEqual({ Converge: "true", Env: "prod", Dial: "apply" });
    expect(converge.phases[1].steps[0]).toMatchObject({ kind: "activity", fn: "convergeTick", profile: "longInfra" });
  });

  it("pins convergeTick's arg-key union, so an upstream shape change fails loudly", () => {
    // The same guard as the estate-entity-id test above, aimed at the other
    // shape this lens now depends on: `rules` is the table, the rest is the
    // dial and budget the rules run under.
    const tick = converge.phases[1].steps[0] as { args?: Record<string, unknown> };
    expect(Object.keys(tick.args ?? {}).sort()).toEqual(["budget", "dial", "env", "opName", "preflightDrift", "rules"]);
  });

  it("pins the rule-object key union, and the predicate and action kinds", () => {
    // `ConvergeRule` is {id, when, then, why, flapThreshold?}, with `id` and
    // `why` required and refused blank at build. If chant ever adds, renames or
    // drops a field, this says so before a card quietly loses it.
    const table = convergeTable(converge)!;
    const keys = new Set<string>();
    for (const rule of table.rules) for (const k of Object.keys(rule)) keys.add(k);
    expect([...keys].sort()).toEqual(["flapThreshold", "id", "then", "when", "why"]);

    const predicateKinds = new Set<string>();
    const walk = (p: { kind: string; predicates?: unknown[] }): void => {
      predicateKinds.add(p.kind);
      for (const child of p.predicates ?? []) walk(child as { kind: string; predicates?: unknown[] });
    };
    for (const rule of table.rules) walk(rule.when as unknown as { kind: string; predicates?: unknown[] });
    expect([...predicateKinds].sort()).toEqual(["all-of", "any-of", "field-comparison", "field-truthiness"]);
    expect([...new Set(table.rules.map((r) => r.then.kind))].sort()).toEqual(["report", "run"]);
  });

  it("reads the table off the step, with the dial and budget beside it", () => {
    const table = convergeTable(converge)!;
    expect(table.tickStepId).toBe("prod-converge/Converge/convergeTick");
    expect(table.phase).toBe("Converge");
    expect(table.dial).toBe("apply");
    expect(table.budget).toBe(2);
    expect(table.env).toBe("prod");
    expect(table.rules.map((r) => r.id)).toEqual([
      "unknown-never-remediates",
      "adopt-is-reported",
      "deletes-stop-the-loop",
      "small-drift-local-apply",
      "drift-apply",
      "stale-record-report",
      "unobserved-is-visible",
    ]);
    // chant makes `why` required and refuses a blank one at build — which is
    // exactly what lets a card show it unconditionally.
    expect(table.rules.every((r) => r.why.trim().length > 0)).toBe(true);
  });

  it("finds no table on an Op that declares none — the zero-cost case", () => {
    for (const op of ops) expect(convergeTable(op)).toBeUndefined();
    for (const op of convergeOps.filter((o) => o.name !== "prod-converge")) expect(convergeTable(op)).toBeUndefined();
  });
});

describe("predicateText — the JSON predicate as the condition it states", () => {
  it("renders a field comparison with the value's own type", () => {
    expect(predicateText({ kind: "field-comparison", field: "status", op: "eq", value: "drifted" })).toBe('status = "drifted"');
    expect(predicateText({ kind: "field-comparison", field: "status", op: "neq", value: "reconciled" })).toBe('status != "reconciled"');
    expect(predicateText({ kind: "field-comparison", field: "deleteCount", op: "gt", value: 0 })).toBe("deleteCount > 0");
    expect(predicateText({ kind: "field-comparison", field: "totalCount", op: "gte", value: 3 })).toBe("totalCount >= 3");
    expect(predicateText({ kind: "field-comparison", field: "totalCount", op: "lt", value: 3 })).toBe("totalCount < 3");
    expect(predicateText({ kind: "field-comparison", field: "totalCount", op: "lte", value: 3 })).toBe("totalCount <= 3");
    expect(predicateText({ kind: "field-comparison", field: "live", op: "eq", value: true })).toBe("live = true");
  });

  it("renders truthiness with chant's own operator word", () => {
    expect(predicateText({ kind: "field-truthiness", field: "unobservedCount", op: "truthy" })).toBe("unobservedCount is truthy");
    expect(predicateText({ kind: "field-truthiness", field: "adoptCount", op: "falsy" })).toBe("adoptCount is falsy");
  });

  it("joins all-of with and, any-of with or, and parenthesises a nested composite", () => {
    const nested = predicateText({
      kind: "all-of",
      predicates: [
        { kind: "field-comparison", field: "status", op: "eq", value: "drifted" },
        {
          kind: "any-of",
          predicates: [
            { kind: "field-comparison", field: "createCount", op: "gt", value: 0 },
            { kind: "field-comparison", field: "updateCount", op: "gt", value: 0 },
          ],
        },
      ],
    });
    expect(nested).toBe('status = "drifted" and (createCount > 0 or updateCount > 0)');
  });

  it("states what an empty composite actually evaluates to, rather than nothing", () => {
    // chant's evaluatePredicate: every() over nothing is true, some() is false.
    expect(predicateText({ kind: "all-of", predicates: [] })).toBe("(always)");
    expect(predicateText({ kind: "any-of", predicates: [] })).toBe("(never)");
  });

  it("says so rather than guessing when the predicate is outside chant's kinds", () => {
    expect(predicateText({ kind: "regex-match" } as never)).toBe("(predicate outside the kinds behold reads)");
    expect(predicateText({ kind: "field-comparison", field: "x", op: "matches", value: "y" } as never)).toBe("(unreadable comparison on x)");
  });
});

describe("actionText and ruleStatus", () => {
  const declared = new Set(["prod-apply"]);
  const ruleWith = (then: OpIrConvergeRule["then"]): OpIrConvergeRule => ({
    id: "r",
    when: { kind: "field-truthiness", field: "totalCount", op: "truthy" },
    then,
    why: "because",
  });

  it("names the dispatched Op, and carries a report's reason verbatim", () => {
    expect(actionText({ kind: "run", op: "prod-apply" })).toBe("run(prod-apply)");
    expect(actionText({ kind: "report", reason: "Adopt is reported, never claimed." })).toBe("report: Adopt is reported, never claimed.");
  });

  it("paints a dispatching rule accent, a reporting rule neutral, a dangling one warn", () => {
    // Nothing here has ticked, so no rule is `good`. `accent` is the effect
    // step's semantics — may fire, may not.
    expect(ruleStatus(ruleWith({ kind: "run", op: "prod-apply" }), declared)).toBe("accent");
    expect(ruleStatus(ruleWith({ kind: "report", reason: "x" }), declared)).toBe("neutral");
    expect(ruleStatus(ruleWith({ kind: "run", op: "elsewhere" }), declared)).toBe("warn");
  });
});

describe("opsToIr — the rule table drawn", () => {
  const ir = opsToIr(convergeOps);
  const at = (id: string) => ir.nodes.find((n) => n.id === id)!;
  const ruleNodes = ir.nodes.filter((n) => n.attrs._step === "rule");

  it("makes one card per rule, in declared order, in the Op's own rule box", () => {
    expect(ruleNodes).toHaveLength(7);
    expect(ir.groups.byStack!["prod-converge · rule table"]).toEqual([
      "prod-converge/rules/unknown-never-remediates",
      "prod-converge/rules/adopt-is-reported",
      "prod-converge/rules/deletes-stop-the-loop",
      "prod-converge/rules/small-drift-local-apply",
      "prod-converge/rules/drift-apply",
      "prod-converge/rules/stale-record-report",
      "prod-converge/rules/unobserved-is-visible",
    ]);
    expect(ruleNodes.every((n) => n.kind === "ConvergeRule" && n.lexicon === "op")).toBe(true);
  });

  it("hangs the table off the convergeTick step that carries it", () => {
    const hung = ir.edges.filter((e) => e.viaAttr === "rule");
    expect(hung).toHaveLength(7);
    expect(hung.every((e) => e.from === "prod-converge/Converge/convergeTick")).toBe(true);
    expect(new Set(hung.map((e) => e.to))).toEqual(new Set(ruleNodes.map((n) => n.id)));
  });

  it("renders the when predicate readably and the why verbatim", () => {
    const deletes = at("prod-converge/rules/deletes-stop-the-loop");
    expect(deletes.attrs.when).toBe('status = "drifted" and deleteCount > 0');
    expect(deletes.attrs.then).toBe("report: Drift whose remediation would delete a resource stops for a human.");
    // Verbatim, character for character — behold never paraphrases the why.
    expect(deletes.attrs.why).toBe(convergeTable(converge)!.rules.find((r) => r.id === "deletes-stop-the-loop")!.why);
    expect(deletes.attrs.why).toBe(
      "A re-apply that removes live resources is not convergence, it is a rollback — the loop refuses to make that call unattended.",
    );
    expect(deletes.attrs.flap).toBe("1 consecutive ticks");
    expect(deletes.attrs._status).toBe("neutral");

    const stale = at("prod-converge/rules/stale-record-report");
    expect(stale.attrs.when).toBe('status = "stale" or status = "unrecorded"');
    // No flapThreshold declared — chant's default applies, and behold names it
    // rather than restating a number chant owns.
    expect(stale.attrs.flap).toBe("(chant default)");

    expect(at("prod-converge/rules/unobserved-is-visible").attrs.when).toBe("unobservedCount is truthy");
    expect(at("prod-converge/rules/adopt-is-reported").attrs.when).toBe("adoptCount > 0");
    expect(at("prod-converge/rules/small-drift-local-apply").attrs.when).toBe('status = "drifted" and totalCount < 3');
  });

  it("draws then: run(<op>) as an edge to that Op's first step", () => {
    const run = ir.edges.filter((e) => e.viaAttr === "run");
    expect(run).toEqual([
      { from: "prod-converge/rules/small-drift-local-apply", to: "floci-apply/Build/chantBuild", kind: "ref", viaAttr: "run" },
      { from: "prod-converge/rules/drift-apply", to: "prod-apply/Build/chantBuild", kind: "ref", viaAttr: "run" },
    ]);
    const drift = at("prod-converge/rules/drift-apply");
    expect(drift.attrs.then).toBe("run(prod-apply)");
    expect(drift.attrs.dispatches).toBe("prod-apply");
    expect(drift.attrs.dangling).toBeUndefined();
    // A rule that may dispatch reads as "may fire", the same as an effect step.
    expect(drift.attrs._status).toBe("accent");
    // The first edge in this lens that leaves the Op it was declared in for a
    // reason chant states rather than one behold inferred.
    expect(run.every((e) => e.from.split("/")[0] !== e.to.split("/")[0])).toBe(true);
  });

  it("puts the dial on every rule card, since it bounds what any of them may do", () => {
    expect(ruleNodes.every((n) => n.attrs.dial === "apply")).toBe(true);
    expect(ruleNodes.every((n) => n.attrs.op === "prod-converge" && n.attrs.phase === "Converge")).toBe(true);
  });

  it("counts the table apart from the track, and says what the rules join to", () => {
    const note = opsNote(convergeOps, ir);
    // 3 + 3 + 3 steps — the seven rule cards are not steps.
    expect(note).toContain("3 declared Ops · 9 steps · 7 converge rules");
    expect(note).toContain("carries the why chant requires of it, verbatim");
    expect(note).toContain("run(<op>) is drawn as an edge to that Op's first step");
    expect(note).not.toContain("not in this set");
  });

  it("leads a rule card with its condition and its action", () => {
    expect(opCardFields(at("prod-converge/rules/drift-apply"))).toEqual([
      { label: "when", value: 'status = "drifted"' },
      { label: "then", value: "run(prod-apply)" },
    ]);
  });
});

describe("opsToIr — a then naming an Op that isn't here", () => {
  // Rendering the ConvergeOp ALONE is a real case, not a contrived one: behold
  // composes op.json across every served project (#31) and keeps the first of a
  // colliding name, so a converge Op can be drawn beside a set that doesn't
  // hold its dispatch target. chant's TMP014 guarantees the target is declared
  // in the Op's own PROJECT; it guarantees nothing about behold's rendered set.
  const ir = opsToIr([converge]);
  const at = (id: string) => ir.nodes.find((n) => n.id === id)!;

  it("states the dangling reference on the card and draws no edge", () => {
    expect(ir.edges.filter((e) => e.viaAttr === "run")).toEqual([]);
    const drift = at("prod-converge/rules/drift-apply");
    expect(drift.attrs.then).toBe("run(prod-apply)");
    expect(drift.attrs.dispatches).toBeUndefined();
    expect(drift.attrs.dangling).toBe("prod-apply — not among the Ops rendered here, so no edge is drawn");
    expect(drift.attrs._status).toBe("warn");
  });

  it("mints no phantom card for the Op it couldn't resolve", () => {
    expect(ir.nodes.every((n) => n.id.startsWith("prod-converge/"))).toBe(true);
    const ids = new Set(ir.nodes.map((n) => n.id));
    expect(ir.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it("says on the statusbar how many rules dangle", () => {
    expect(opsNote([converge], ir)).toContain("2 rules name Ops not in this set — stated on the card, not drawn.");
  });
});

describe("opsToIr — an estate with no ConvergeOp costs nothing", () => {
  it("renders the example-writes estate exactly as it did before", () => {
    const ir = opsToIr(ops);
    expect(ir.nodes.filter((n) => n.attrs._step === "rule")).toHaveLength(0);
    expect(ir.edges.filter((e) => e.viaAttr === "rule" || e.viaAttr === "run")).toHaveLength(0);
    expect(Object.keys(ir.groups.byStack!).some((b) => b.endsWith("· rule table"))).toBe(false);
    expect(opsNote(ops, ir)).not.toContain("converge rule");
  });

  it("draws nothing from a convergeTick whose rules aren't a table chant would emit", () => {
    // Every rule field is required upstream and refused blank at build, so a
    // rule missing one didn't come from chant. Dropping it beats drawing a card
    // whose why is empty, which is the one thing this join promises.
    const bogus: OpIr = {
      name: "half-built",
      phases: [
        {
          name: "Converge",
          steps: [
            {
              kind: "activity",
              fn: "convergeTick",
              args: {
                rules: [{ id: "no-why", when: { kind: "field-truthiness", field: "totalCount", op: "truthy" }, then: { kind: "report", reason: "x" } }],
              },
            },
          ],
        },
      ],
    };
    expect(convergeTable(bogus)).toBeUndefined();
    expect(opsToIr([bogus]).nodes.filter((n) => n.attrs._step === "rule")).toHaveLength(0);
    // And a convergeTick with no rules arg at all is simply an activity step.
    const noArgs: OpIr = { name: "bare", phases: [{ name: "Converge", steps: [{ kind: "activity", fn: "convergeTick" }] }] };
    expect(convergeTable(noArgs)).toBeUndefined();
    expect(opsToIr([noArgs]).nodes).toHaveLength(1);
  });
});


describe("joinStepEntities — the estate cross-link (chant#2022)", () => {
  const FLOCI_URL = "http://localhost:4566/behold-floci-demo";
  const PROD_URL = "https://behold-floci-demo.s3.amazonaws.com/";
  const estate: GraphIR = {
    nodes: [
      // An id match: the value IS a node id.
      { id: PROD_URL, kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { bucketName: "behold-floci-demo" } },
      // An attribute match: the value equals a string leaf, nested.
      // (Not under `annotations`/`labels` — src/value-match.ts skips k8s metadata noise.)
      { id: "healthProbe", kind: "K8s::Core::Service", lexicon: "k8s", attrs: { spec: { probe: { endpoint: FLOCI_URL } } } },
      { id: "bystander", kind: "AWS::EC2::VPC", lexicon: "aws", attrs: { cidr: "10.0.0.0/16" } },
    ],
    edges: [],
    groups: {},
  };
  const fresh = () => opsToIr(ops);

  it("resolves by exact node id and by exact string leaf, copies the card into an `estate` box, and draws the dashed edge", () => {
    const lens = fresh();
    expect(joinStepEntities(lens, estate)).toEqual({ refs: 2, resolved: 2 });
    const bucket = lens.nodes.find((n) => n.id === PROD_URL)!;
    const probe = lens.nodes.find((n) => n.id === "healthProbe")!;
    expect(bucket.lexicon).toBe("aws");
    expect(bucket.attrs._touchedBy).toEqual(["prod-promote/Verify/httpCheck"]);
    expect(probe.attrs._touchedBy).toEqual(["floci-apply/Verify/httpCheck"]);
    expect(lens.nodes.find((n) => n.id === "bystander")).toBeUndefined();
    expect(lens.groups.byStack?.[ESTATE_BOX]).toEqual(expect.arrayContaining([PROD_URL, "healthProbe"]));
    // `viaAttr` is what pinhole renders dashed with a tooltip.
    expect(lens.edges).toEqual(
      expect.arrayContaining([
        { from: "prod-promote/Verify/httpCheck", to: PROD_URL, kind: "ref", viaAttr: "entities" },
        { from: "floci-apply/Verify/httpCheck", to: "healthProbe", kind: "ref", viaAttr: "entities" },
      ]),
    );
    const links = lens.nodes.find((n) => n.id === "prod-promote/Verify/httpCheck")!.attrs._entityLinks as { resolved: unknown[]; unresolved: string[] };
    expect(links).toEqual({ resolved: [{ value: PROD_URL, node: PROD_URL, via: "id" }], unresolved: [] });
  });

  it("a value no node carries stays on the step as unresolved — nothing is parsed or guessed", () => {
    const lens = fresh();
    const only = { ...estate, nodes: estate.nodes.filter((n) => n.id === "bystander") };
    expect(joinStepEntities(lens, only)).toEqual({ refs: 2, resolved: 0 });
    expect(lens.nodes.every((n) => n.lexicon === "op")).toBe(true);
    expect(lens.edges.some((e) => e.viaAttr === "entities")).toBe(false);
    const links = lens.nodes.find((n) => n.id === "floci-apply/Verify/httpCheck")!.attrs._entityLinks as { unresolved: string[] };
    expect(links.unresolved).toEqual([FLOCI_URL]);
  });

  it("no estate at all: every reference is unresolved and the lens is untouched", () => {
    const lens = fresh();
    const before = JSON.stringify({ nodes: lens.nodes.map((n) => n.id), edges: lens.edges });
    expect(joinStepEntities(lens, undefined)).toEqual({ refs: 2, resolved: 0 });
    expect(JSON.stringify({ nodes: lens.nodes.map((n) => n.id), edges: lens.edges })).toBe(before);
  });

  it("a value several nodes carry joins to all of them, and a node touched twice is copied once", () => {
    const lens = fresh();
    const twice: GraphIR = {
      nodes: [
        { id: "a", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { url: PROD_URL } },
        { id: "b", kind: "AWS::CloudFront::Distribution", lexicon: "aws", attrs: { origin: PROD_URL, probe: FLOCI_URL } },
      ],
      edges: [],
      groups: {},
    };
    expect(joinStepEntities(lens, twice)).toEqual({ refs: 2, resolved: 2 });
    expect(lens.nodes.filter((n) => n.id === "b")).toHaveLength(1);
    expect((lens.nodes.find((n) => n.id === "b")!.attrs._touchedBy as string[]).sort()).toEqual(["floci-apply/Verify/httpCheck", "prod-promote/Verify/httpCheck"]);
    expect(lens.edges.filter((e) => e.viaAttr === "entities")).toHaveLength(3);
  });

  it("the note counts the references and how many linked", () => {
    const lens = fresh();
    joinStepEntities(lens, estate);
    expect(opsNote(ops, lens)).toContain("2 entity refs, 2 linked");
    const bare = fresh();
    expect(opsNote(ops, bare)).toContain("2 entity refs, 0 linked");
  });
});
