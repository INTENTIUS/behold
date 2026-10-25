import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import { CHANT_FLOORS, TERRAFORM_PLAN_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { planCardRows } from "./terraform-lens.ts";
import {
  PLAN_READ_ENV,
  TERRAFORM_OBSERVE_ENV,
  TERRAFORM_PLAN_READ,
  paintTerraformPlan,
  parsePlanNotes,
  planRootAnswers,
  planReadFloorRefusal,
  readTerraformPlan,
  terraformPlanArgs,
  terraformPlanNote,
  terraformPlanReadOf,
} from "./terraform-plan.ts";

// Provenance: src/__fixtures__/terraform-plan-ir.json says how it was printed.
// It is chant's own answer for src/__fixtures__/terraform-plan-root at the
// plan depth: `terraform_data.replaced` is replaced because `triggers_replace`
// moved from 1 to 2, `updated` is updated with its token (a sensitive
// variable) changed, and `downstream` reads the replaced block's new id.
const HERE = dirname(fileURLToPath(import.meta.url));
// behold#995: which read answered comes from the IR's `rootReads` (chant#4452).
// The fixture was printed before chant carried the field, so the root's report
// is put on it here, as chant's integration branch now writes it: the plan
// read answered root `app`.
const recorded = (): { stderr: string[]; ir: GraphIR } => {
  const r = JSON.parse(readFileSync(join(HERE, "__fixtures__", "terraform-plan-ir.json"), "utf8")) as { stderr: string[]; ir: GraphIR };
  (r.ir as unknown as { rootReads: unknown }).rootReads = { "terraform.roots.app": { depth: "plan" } };
  return r;
};

/** A root whose plan failed on credentials and fell back to state, as rootReads reports it. */
const withRead = (ir: GraphIR, reads: Record<string, unknown>): GraphIR => ({ ...ir, rootReads: reads }) as unknown as GraphIR;
const STATE_READ = { "terraform.roots.app": { depth: "plan", fellBackTo: "state", reason: "no-credentials" } };

describe("which read answered each root (#910, behold#995)", () => {
  it("reads rootReads off the IR: the plan, a fall back to state, and none", () => {
    const roots = planRootAnswers({
      rootReads: {
        "terraform.roots.app": { depth: "plan" },
        "terraform.roots.db": { depth: "plan", fellBackTo: "state", reason: "no-credentials" },
        "terraform.roots.net": { depth: "plan", fellBackTo: "declared", reason: "backend" },
      },
    });
    expect(roots.map((r) => [r.root, r.answered])).toEqual([
      ["app", "plan"],
      ["db", "state"],
      ["net", "none"],
    ]);
    expect(roots[1]!.note).toBe("terraform.roots.db: the plan read failed (no-credentials), so the state read answered");
  });

  it("rootReads, when present, is the only source: a note beside it is not read", () => {
    expect(planRootAnswers({ rootReads: { "other.key": { depth: "plan" } } })).toEqual([]);
    const { ir } = recorded();
    expect(terraformPlanReadOf(withRead(ir, STATE_READ), "warning: [terraform] terraform.roots.app: the plan read answered").roots[0]!.answered).toBe("state");
  });

  it("a released chant with no rootReads on the IR: chant's notes are read instead (0.124.52)", () => {
    const NOTE_STATE = "\u001b[33mwarning\u001b[0m: [terraform] terraform.roots.db: the plan read failed (no provider credentials: Error: No valid credential sources found), so the state read answered; plan attributes are absent";
    const roots = parsePlanNotes(["warning: [terraform] terraform.roots.app: the plan read answered (`terraform plan`)", NOTE_STATE, "warning: [terraform] terraform.roots.net: no read answered, declared only"].join("\n"));
    expect(roots.map((r) => [r.root, r.answered, r.reason])).toEqual([
      ["app", "plan", undefined],
      ["db", "state", "no-credentials"],
      ["net", "none", undefined],
    ]);
    const { ir } = recorded();
    delete (ir as unknown as { rootReads?: unknown }).rootReads;
    expect(terraformPlanReadOf(ir, NOTE_STATE.replace("roots.db", "roots.app")).roots).toEqual([expect.objectContaining({ root: "app", answered: "state", reason: "no-credentials" })]);
    expect(planRootAnswers(ir)).toEqual([]);
  });
});

describe("the plan facts per card (#910)", () => {
  it("carries the replace, the attribute that forces it and where that value comes from", () => {
    const { ir } = recorded();
    const read = terraformPlanReadOf(ir);
    const replaced = read.cards["app/terraform_data.replaced"]!;
    expect(replaced.source).toBe("plan");
    expect(replaced.action).toBe("replace");
    expect(replaced.reason).toBe("replace_because_cannot_update");
    expect(replaced.replacePaths).toEqual(["triggers_replace"]);
    expect(replaced.forcedFrom).toEqual([{ path: "triggers_replace", from: "var.generation" }]);
    expect(replaced.changes).toContainEqual({ path: "triggers_replace", before: "1", after: "2" });
    expect(read.cards["app/terraform_data.downstream"]!.afterUnknown).toEqual(["input", "output"]);
    // Only resource and data blocks: a variable has no row in a plan.
    expect(Object.keys(read.cards).sort()).toEqual(["app/terraform_data.downstream", "app/terraform_data.replaced", "app/terraform_data.updated"]);
  });

  it("prints them on the card: plan, forced by, from, read", () => {
    const { ir } = recorded();
    const read = terraformPlanReadOf(ir);
    expect(planCardRows(read.cards["app/terraform_data.replaced"])).toEqual([
      { label: "plan", value: "replace" },
      { label: "forced by", value: "triggers_replace 1 -> 2" },
      { label: "from", value: "var.generation" },
      { label: "read", value: "plan" },
    ]);
    expect(planCardRows(read.cards["app/terraform_data.downstream"])).toEqual([
      { label: "plan", value: "update" },
      { label: "unknown", value: "2 until apply" },
      { label: "read", value: "plan" },
    ]);
  });

  it("a planned create gets a card: create, and what stays unknown until apply (chant#4372)", () => {
    const { ir, stderr } = recorded();
    // As chant prints a block the applied state has never seen: absent, so
    // pending and with no physical id, carrying the plan's attributes.
    ir.nodes.push({
      id: "app/terraform_data.created",
      kind: "Terraform::Resource",
      lexicon: "terraform",
      attrs: {
        _status: "accent",
        planAction: "create",
        planActions: { "terraform_data.created": ["create"] },
        planAfterUnknown: ["id", "input", "output"],
      },
    } as GraphIR["nodes"][number]);
    const read = terraformPlanReadOf(ir);
    expect(read.cards["app/terraform_data.created"]).toEqual({
      source: "plan",
      action: "create",
      actions: { "terraform_data.created": ["create"] },
      afterUnknown: ["id", "input", "output"],
    });
    expect(planCardRows(read.cards["app/terraform_data.created"])).toEqual([
      { label: "plan", value: "create" },
      { label: "unknown", value: "3 until apply" },
      { label: "read", value: "plan" },
    ]);
  });

  it("keeps sensitive values as (sensitive): the token's change has no value in it", () => {
    const { ir } = recorded();
    const read = terraformPlanReadOf(ir);
    expect(read.cards["app/terraform_data.updated"]!.changes).toContainEqual({ path: "input.token", before: "(sensitive)", after: "(sensitive)" });
    expect(JSON.stringify(read)).not.toMatch(/s3cr3t/);
  });

  it("copies plan facts only, never the block's other attributes", () => {
    const { ir, stderr } = recorded();
    ir.nodes[1]!.attrs.source = 'variable "token" { default = "s3cr3t" }';
    const read = terraformPlanReadOf(ir);
    expect(JSON.stringify(read)).not.toContain("s3cr3t");
  });

  it("a root that fell back to state says so on every card and never reads as no changes", () => {
    const { ir } = recorded();
    for (const n of ir.nodes) for (const k of Object.keys(n.attrs)) if (k.startsWith("plan")) delete n.attrs[k];
    const read = terraformPlanReadOf(withRead(ir, STATE_READ));
    expect(read.roots).toEqual([expect.objectContaining({ root: "app", answered: "state" })]);
    for (const facts of Object.values(read.cards)) {
      expect(facts.source).toBe("state");
      expect(facts.action).toBeUndefined();
      const rows = planCardRows(facts);
      expect(rows).toEqual([
        { label: "plan", value: "not read" },
        { label: "read", value: "state, no provider credentials" },
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/no changes/);
    }
    expect(terraformPlanNote([{ member: "tf", roots: read.roots }])).toBe(
      "plan: tf: app plan not read, the state read answered (the plan read failed (no-credentials), so the state read answered)",
    );
  });

  it("a root nothing answered is declared only on the card", () => {
    const rows = planCardRows({ source: "none", note: "terraform.roots.net: no read answered, declared only: the plan read failed (backend-unreachable)", readReason: "backend-unreachable" });
    expect(rows).toEqual([
      { label: "plan", value: "not read" },
      { label: "read", value: "none, declared only" },
    ]);
  });

  it("only a no-op from the plan itself reads as no changes", () => {
    expect(planCardRows({ source: "plan", action: "no-op" })[0]).toEqual({ label: "plan", value: "no changes" });
  });

  it("paints `_plan` onto the estate's composed ids", () => {
    const { ir } = recorded();
    const read = terraformPlanReadOf(ir);
    const composed = { ...ir, nodes: ir.nodes.map((n) => ({ ...n, id: `tf/${n.id}` })) } as GraphIR;
    expect(paintTerraformPlan(composed, read, "tf")).toBe(3);
    expect((composed.nodes.find((n) => n.id === "tf/app/terraform_data.replaced")!.attrs._plan as { action: string }).action).toBe("replace");
  });
});

describe("the read itself (#910)", () => {
  it("asks behold's chant for the plan depth, with the lexicon's one-run override", async () => {
    const seen: Array<{ args: string[]; env: Record<string, string> }> = [];
    const res = await readTerraformPlan(join(HERE, "__fixtures__", "terraform-plan-root"), {
      chantVersion: () => TERRAFORM_PLAN_CHANT_FLOOR,
      lexiconVersion: () => TERRAFORM_PLAN_CHANT_FLOOR,
      spawnEnv: { EXTRA: "1" },
      run: async (args, _dir, env) => {
        seen.push({ args, env });
        const { ir, stderr } = recorded();
        return { code: 0, stdout: JSON.stringify(ir), stderr: stderr.join("\n") };
      },
    });
    // Without the lexicon installed the read is refused before any spawn, as the member's source read is.
    if (!res.ok) {
      expect(res.refusal.code).toBe("terraform-lexicon");
      expect(seen).toEqual([]);
      return;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args).toEqual(terraformPlanArgs());
    expect(seen[0]!.args).toEqual(["graph", ".", "--live", "--overlay", "--env", PLAN_READ_ENV, "--format", "ir", "--detail", "3"]);
    expect(seen[0]!.env).toEqual({ EXTRA: "1", [TERRAFORM_OBSERVE_ENV]: "plan" });
  });
});

describe("the floor (#691, #910)", () => {
  it("is registered, so doctor lists it", () => {
    expect(floorFor(TERRAFORM_PLAN_READ).floor).toBe(TERRAFORM_PLAN_CHANT_FLOOR);
    expect(CHANT_FLOORS.filter((f) => f.read === TERRAFORM_PLAN_READ)).toHaveLength(1);
  });

  it("refuses an older chant before anything is spawned", async () => {
    let spawned = false;
    const res = await readTerraformPlan(join(HERE, "__fixtures__", "terraform-plan-root"), {
      chantVersion: () => "0.124.45",
      lexiconVersion: () => TERRAFORM_PLAN_CHANT_FLOOR,
      run: async () => {
        spawned = true;
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(spawned).toBe(false);
    expect(res).toEqual({
      ok: false,
      refusal: {
        error: `Plan read on a Terraform root needs chant ${TERRAFORM_PLAN_CHANT_FLOOR} or newer. This project has chant 0.124.45.`,
        code: "chant-too-old",
        remedy: `Upgrade @intentius/chant to ${TERRAFORM_PLAN_CHANT_FLOOR} or newer in the project.`,
      },
    });
  });

  it("refuses an older lexicon too, since the read lives there", () => {
    expect(planReadFloorRefusal(TERRAFORM_PLAN_CHANT_FLOOR, "0.124.40")?.error).toMatch(/needs @intentius\/chant-lexicon-terraform 0\.124\.46 or newer\. behold has 0\.124\.40\./);
    expect(planReadFloorRefusal(TERRAFORM_PLAN_CHANT_FLOOR, TERRAFORM_PLAN_CHANT_FLOOR)).toBeUndefined();
  });
});
