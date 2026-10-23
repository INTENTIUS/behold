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
const recorded = (): { stderr: string[]; ir: GraphIR } => JSON.parse(readFileSync(join(HERE, "__fixtures__", "terraform-plan-ir.json"), "utf8"));

/** chant's note for a root whose plan failed on credentials, verbatim in shape (describe-resources.ts, planAdapter). */
const STATE_NOTE =
  "\u001b[33mwarning\u001b[0m: [terraform] terraform.roots.app: the plan read failed (no provider credentials: Error: No valid credential sources found), so the state read answered; plan attributes are absent";
const NONE_NOTE = "warning: [terraform] terraform.roots.net: no read answered, declared only (the plan read could not reach the backend)";

describe("which read answered each root (#910)", () => {
  it("reads chant's three notes, ANSI and prefix included", () => {
    const roots = parsePlanNotes([recorded().stderr.join("\n"), STATE_NOTE.replace("roots.app", "roots.db"), NONE_NOTE].join("\n"));
    expect(roots.map((r) => [r.root, r.answered])).toEqual([
      ["app", "plan"],
      ["db", "state"],
      ["net", "none"],
    ]);
    expect(roots[1]!.note).toMatch(/^terraform\.roots\.db: the plan read failed \(no provider credentials/);
  });

  it("ignores the per-entity warnings", () => {
    expect(parsePlanNotes("warning: terraform: not observed — app/var.token (Terraform::Variable) — no reader")).toEqual([]);
  });
});

describe("the plan facts per card (#910)", () => {
  it("carries the replace, the attribute that forces it and where that value comes from", () => {
    const { ir, stderr } = recorded();
    const read = terraformPlanReadOf(ir, stderr.join("\n"));
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
    const { ir, stderr } = recorded();
    const read = terraformPlanReadOf(ir, stderr.join("\n"));
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

  it("keeps sensitive values as (sensitive): the token's change has no value in it", () => {
    const { ir, stderr } = recorded();
    const read = terraformPlanReadOf(ir, stderr.join("\n"));
    expect(read.cards["app/terraform_data.updated"]!.changes).toContainEqual({ path: "input.token", before: "(sensitive)", after: "(sensitive)" });
    expect(JSON.stringify(read)).not.toMatch(/s3cr3t/);
  });

  it("copies plan facts only, never the block's other attributes", () => {
    const { ir, stderr } = recorded();
    ir.nodes[1]!.attrs.source = 'variable "token" { default = "s3cr3t" }';
    const read = terraformPlanReadOf(ir, stderr.join("\n"));
    expect(JSON.stringify(read)).not.toContain("s3cr3t");
  });

  it("a root that fell back to state says so on every card and never reads as no changes", () => {
    const { ir } = recorded();
    for (const n of ir.nodes) for (const k of Object.keys(n.attrs)) if (k.startsWith("plan")) delete n.attrs[k];
    const read = terraformPlanReadOf(ir, STATE_NOTE);
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
      "plan: tf: app plan not read, the state read answered (the plan read failed (no provider credentials: Error: No valid credential sources found), so the state read answered; plan attributes are absent)",
    );
  });

  it("a root nothing answered is declared only on the card", () => {
    const rows = planCardRows({ source: "none", note: NONE_NOTE });
    expect(rows).toEqual([
      { label: "plan", value: "not read" },
      { label: "read", value: "none, declared only" },
    ]);
  });

  it("only a no-op from the plan itself reads as no changes", () => {
    expect(planCardRows({ source: "plan", action: "no-op" })[0]).toEqual({ label: "plan", value: "no changes" });
  });

  it("paints `_plan` onto the estate's composed ids", () => {
    const { ir, stderr } = recorded();
    const read = terraformPlanReadOf(ir, stderr.join("\n"));
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
