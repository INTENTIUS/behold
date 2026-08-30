import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOpIr,
  readOpIr,
  opsToIr,
  opsNote,
  stepLabel,
  stepKind,
  stepStatus,
  opCardFields,
  type OpIr,
} from "./ops-lens.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__", "ops-example-writes");

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
 * Note what NO fixture carries, because it is the point of the cross-link test
 * below: an estate entity id. The union of every step's args across all four is
 * env / stackName / templatePath / target / output / path / script / deleteMode
 * / mode / owned / live / endpoint / url — scope, never identity.
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

  it("carry no estate entity id on any step — the reason this lens draws no cross-links", () => {
    const argKeys = new Set<string>();
    for (const op of ops) {
      for (const phase of [...op.phases, ...(op.onFailure ?? [])]) {
        for (const step of phase.steps) {
          if (step.kind === "activity") for (const k of Object.keys(step.args ?? {})) argKeys.add(k);
        }
      }
    }
    expect([...argKeys].sort()).toEqual([
      "deleteMode",
      "endpoint",
      "env",
      "live",
      "mode",
      "output",
      "owned",
      "path",
      "script",
      "stackName",
      "target",
      "templatePath",
      "url",
    ]);
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

  it("joins nothing to the estate — no node id, no edge out of the op lexicon (#284)", () => {
    // The cross-link #284 asks for is unbuildable on this input: every node is
    // an op step, every edge runs between two of them. If chant ever names an
    // entity in an op.json, this is the test that has to change.
    expect(ir.nodes.every((n) => n.lexicon === "op")).toBe(true);
    const ids = new Set(ir.nodes.map((n) => n.id));
    expect(ir.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
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
