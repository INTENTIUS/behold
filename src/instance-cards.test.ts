import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { overlayFrom } from "./change-set-overlay.ts";
import { addInstanceCards, instanceKeyOf, instanceOfNode } from "./instance-cards.ts";
import { terraformCardFields } from "./terraform-lens.ts";
import { paintTerraformPlan, terraformPlanReadOf } from "./terraform-plan.ts";

// #996 (B3): a `count = 3` resource draws three cards, each with its own
// plan and drift, and its block card stays as the rollup. The block below is
// what chant's plan read prints for
//
//     resource "aws_s3_bucket" "logs" { count = 3 ... }
//
// with [0] unchanged, [1] updated in place after drift, [2] a planned create:
// one node per block, `planActions` keyed by instance address, and each change
// and drift row naming its `instance` (chant's planAttributesFor).
const PLAN_NOTE = "warning: [terraform] terraform.roots.app: the plan read answered";

function planIr(): GraphIR {
  return {
    nodes: [
      {
        id: "app/aws_s3_bucket.logs",
        kind: "Terraform::Resource",
        lexicon: "terraform",
        attrs: {
          root: "app",
          address: "aws_s3_bucket.logs",
          planAction: "create,no-op,update",
          planActions: {
            "aws_s3_bucket.logs[0]": ["no-op"],
            "aws_s3_bucket.logs[1]": ["update"],
            "aws_s3_bucket.logs[2]": ["create"],
          },
          planChanges: [{ path: "tags.team", before: "a", after: "b", instance: "aws_s3_bucket.logs[1]" }],
          planDrift: [{ path: "tags.team", before: "b", after: "a", instance: "aws_s3_bucket.logs[1]" }],
          planDriftAction: "update",
        },
      },
    ],
    edges: [],
    groups: {},
  } as unknown as GraphIR;
}

/** The source graph the card view draws, as the terraform passes leave it: the block, boxed by root. */
function sourceIr(prefix = ""): GraphIR {
  return {
    nodes: [{ id: `${prefix}app/aws_s3_bucket.logs`, kind: "aws_s3_bucket", lexicon: "terraform", attrs: { root: "app", address: "aws_s3_bucket.logs", block: "resource" } }],
    edges: [],
    groups: { byStack: { app: [`${prefix}app/aws_s3_bucket.logs`] } },
  } as unknown as GraphIR;
}

const ids3 = ["app/aws_s3_bucket.logs[0]", "app/aws_s3_bucket.logs[1]", "app/aws_s3_bucket.logs[2]"];

describe("the instance id rule (#996)", () => {
  it("is the block's node id and the key exactly as Terraform prints it", () => {
    expect(instanceKeyOf("aws_s3_bucket.logs[0]")).toBe("[0]");
    expect(instanceKeyOf('aws_s3_bucket.logs["a"]')).toBe('["a"]');
    expect(instanceKeyOf('aws_s3_bucket.logs["x]y"]')).toBe('["x]y"]');
    expect(instanceKeyOf("module.app.aws_s3_bucket.logs[1]")).toBe("[1]");
    expect(instanceKeyOf("aws_s3_bucket.logs")).toBeUndefined();
    // A module instance key stays in the block's rollup.
    expect(instanceKeyOf("module.app[0].aws_s3_bucket.logs[1]")).toBeUndefined();
  });
  it("gives the same pair whether chant mapped the entry to the block node or the instance node", () => {
    const before = instanceOfNode("web/app/aws_s3_bucket.logs", "aws_s3_bucket.logs[2]");
    const after = instanceOfNode("web/app/aws_s3_bucket.logs[2]", "aws_s3_bucket.logs[2]");
    expect(before).toEqual({ instance: "web/app/aws_s3_bucket.logs[2]", block: "web/app/aws_s3_bucket.logs", key: "[2]" });
    expect(after).toEqual(before);
  });
});

describe("a count = 3 resource draws three cards (#996)", () => {
  it("each with its own plan and drift, and the block card rolls them up", () => {
    const ir = sourceIr();
    paintTerraformPlan(ir, terraformPlanReadOf(planIr(), PLAN_NOTE));
    expect(addInstanceCards(ir)).toBe(3);

    const cards = ir.nodes.filter((n) => n.attrs.instanceOf === "app/aws_s3_bucket.logs");
    expect(cards.map((n) => n.id).sort()).toEqual(ids3);
    const plan = (id: string) => ir.nodes.find((n) => n.id === id)!.attrs._plan as { action: string; changes?: unknown[]; drift?: unknown[] };
    expect(plan(ids3[0]!)).toEqual({ source: "plan", action: "no-op", actions: { "aws_s3_bucket.logs[0]": ["no-op"] } });
    expect(plan(ids3[1]!).action).toBe("update");
    expect(plan(ids3[1]!).changes).toHaveLength(1);
    expect(plan(ids3[1]!).drift).toHaveLength(1);
    expect(plan(ids3[2]!).action).toBe("create");
    expect(plan(ids3[2]!).drift).toBeUndefined();

    // Three different card faces, one per instance.
    const face = (id: string) => terraformCardFields(ir.nodes.find((n) => n.id === id)!)!;
    expect(face(ids3[0]!)[0]).toEqual({ label: "plan", value: "no changes" });
    expect(face(ids3[1]!)).toContainEqual({ label: "drift", value: "update, 1 attribute" });
    expect(face(ids3[2]!)[0]).toEqual({ label: "plan", value: "create" });

    // The block stays, carries chant's aggregate, and says how many instances it rolls up.
    const block = ir.nodes.find((n) => n.id === "app/aws_s3_bucket.logs")!;
    expect(block.attrs._instances).toEqual(ids3);
    expect(terraformCardFields(block)).toContainEqual({ label: "instances", value: "3" });
    // Every instance sits in its block's box and points at it.
    expect((ir.groups as { byStack: Record<string, string[]> }).byStack.app).toEqual(["app/aws_s3_bucket.logs", ...ids3]);
    expect(ir.edges.filter((e) => e.to === "app/aws_s3_bucket.logs").map((e) => e.from).sort()).toEqual(ids3);
  });

  it("composes: on an estate the ids are <member>/<blockNode>[k]", () => {
    const ir = sourceIr("tf/");
    paintTerraformPlan(ir, terraformPlanReadOf(planIr(), PLAN_NOTE), "tf");
    addInstanceCards(ir);
    expect(ir.nodes.map((n) => n.id).sort()).toEqual(["tf/app/aws_s3_bucket.logs", ...ids3.map((id) => `tf/${id}`)]);
  });

  it("keeps the instance nodes chant draws (C4) and gives them their own plan, adding none twice", () => {
    const ir = sourceIr();
    for (const [i, id] of ids3.entries()) {
      ir.nodes.push({ id, kind: "aws_s3_bucket", lexicon: "terraform", instanceOf: "app/aws_s3_bucket.logs", attrs: { root: "app", address: `aws_s3_bucket.logs[${i}]`, block: "resource" } } as never);
    }
    paintTerraformPlan(ir, terraformPlanReadOf(planIr(), PLAN_NOTE));
    expect(addInstanceCards(ir)).toBe(0);
    expect(ir.nodes).toHaveLength(4);
    expect((ir.nodes.find((n) => n.id === ids3[2])!.attrs._plan as { action: string }).action).toBe("create");
  });

  it("draws no instance cards for a block without a count", () => {
    const ir = sourceIr();
    ir.nodes[0]!.attrs._plan = { source: "plan", action: "update", actions: { "aws_s3_bucket.logs": ["update"] } };
    expect(addInstanceCards(ir)).toBe(0);
    expect(ir.nodes[0]!.attrs._instances).toBeUndefined();
  });
});

describe("a count = 3 change set outlines three instance cards and the block's rollup (#996)", () => {
  const gate = { key: "tf/apply/prod", member: "tf", op: "apply", gate: "approve", env: "prod", approve: "chant op-signal" } as never;
  const entry = (i: number, action: string, node: string) => ({ member: "tf", planner: "terraform", address: `aws_s3_bucket.logs[${i}]`, type: "aws_s3_bucket", action, attributes: [], node });
  const doc = (node: (i: number) => string) => ({
    changeSet: { digest: "jcs1-sha256:00", entries: [entry(0, "no-op", node(0)), entry(1, "update", node(1)), entry(2, "create", node(2))], members: [], graph: { member: "tf", at: null } },
  });
  // Before chant C4 every entry names the block node; after, its instance node.
  const before = overlayFrom(gate, doc(() => "tf/app/aws_s3_bucket.logs"), new Date(0));
  const after = overlayFrom(gate, doc((i) => `tf/app/aws_s3_bucket.logs[${i}]`), new Date(0));

  it("matches on instance node ids, whichever node chant mapped the entries to", () => {
    expect(before.nodes).toEqual(after.nodes);
    expect(before.nodes["tf/app/aws_s3_bucket.logs[1]"]).toEqual({ bucket: "change", actions: { update: 1 }, instanceOf: "tf/app/aws_s3_bucket.logs" });
    expect(before.nodes["tf/app/aws_s3_bucket.logs[2]"]).toEqual({ bucket: "create", actions: { create: 1 }, instanceOf: "tf/app/aws_s3_bucket.logs" });
    // [0] changes nothing, so it is counted, not drawn.
    expect(before.nodes["tf/app/aws_s3_bucket.logs[0]"]).toBeUndefined();
    expect(before.nodes["tf/app/aws_s3_bucket.logs"]).toEqual({
      bucket: "change",
      actions: { update: 1, create: 1 },
      instances: ["tf/app/aws_s3_bucket.logs[1]", "tf/app/aws_s3_bucket.logs[2]"],
    });
  });
  // The marks drawn from these nodes: web/change-set-overlay.test.js.
});
