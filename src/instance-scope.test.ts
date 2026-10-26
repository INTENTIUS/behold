import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { overlayFrom } from "./change-set-overlay.ts";
import { choudoufuCardAliases } from "./drift-overlay.ts";
import { addInstanceCards, instanceBlockIdOf, instanceScopeOf, ownInstanceKeyOf, scopedInstanceNodeId, scopedInstancePath } from "./instance-cards.ts";
import { paintTerraformPlan, terraformPlanReadOf } from "./terraform-plan.ts";

// behold#1011: instance nodes under an expanded module call. chant#4486 (the
// planned graph) and chant#4488 (the live graph) put the module key on its
// call segment, `app/module.web[0]/aws_s3_bucket.logs[1]`, under the block
// node `app/module.web/aws_s3_bucket.logs`, with `instanceScope`
// `module.web[0]` and `instanceKey` absent when only the call is expanded.

const BLOCK = "app/module.web/aws_s3_bucket.logs";

/** A block under `module "web" { count = 2 }`, as the terraform passes leave it. */
function sourceIr(prefix = ""): GraphIR {
  return {
    nodes: [{ id: `${prefix}${BLOCK}`, kind: "aws_s3_bucket", lexicon: "terraform", attrs: { root: "app", address: "module.web.aws_s3_bucket.logs", block: "resource" } }],
    edges: [],
    groups: { byStack: { app: [`${prefix}${BLOCK}`] } },
  } as unknown as GraphIR;
}

/** chant's instance node, fields on the node as graph-ir.ts writes them. */
function chantInstance(id: string, instanceOf: string, scope: string, key?: string) {
  return { id, kind: "aws_s3_bucket", lexicon: "terraform", instanceOf, instanceScope: scope, ...(key ? { instanceKey: key } : {}), attrs: {} } as never;
}

/** chant's plan read of that block: one node, `planActions` keyed by module-keyed instance address. */
function planIr(actions: Record<string, string[]>): GraphIR {
  return {
    rootReads: { "terraform.roots.app": { depth: "plan" } },
    nodes: [{ id: BLOCK, kind: "Terraform::Resource", lexicon: "terraform", attrs: { root: "app", address: "module.web.aws_s3_bucket.logs", planAction: "create,update", planActions: actions } }],
    edges: [],
    groups: {},
  } as unknown as GraphIR;
}

describe("the module-keyed id rule (chant#4486)", () => {
  it("puts the module key on its call segment and the block's own key at the end", () => {
    expect(scopedInstancePath("module.web[0].aws_s3_bucket.logs[1]")).toEqual({
      block: "module.web/aws_s3_bucket.logs",
      instance: "module.web[0]/aws_s3_bucket.logs[1]",
      key: "[1]",
      scope: "module.web[0]",
    });
    expect(scopedInstancePath('module.a["x.y"].module.b[2].data.aws_ami.base')).toEqual({
      block: "module.a/module.b/data.aws_ami.base",
      instance: 'module.a["x.y"]/module.b[2]/data.aws_ami.base',
      scope: 'module.a["x.y"].module.b[2]',
    });
    // No expanded call on the way: the plain `<block>[key]` rule covers it.
    expect(scopedInstancePath("module.web.aws_s3_bucket.logs[1]")).toBeUndefined();
    expect(scopedInstancePath("aws_s3_bucket.logs[1]")).toBeUndefined();
  });

  it("swaps the block suffix of the node id, keeping a member prefix", () => {
    expect(scopedInstanceNodeId(`tf/${BLOCK}`, "module.web[1].aws_s3_bucket.logs")).toBe("tf/app/module.web[1]/aws_s3_bucket.logs");
    expect(scopedInstanceNodeId(BLOCK, "module.other[0].aws_s3_bucket.logs")).toBeUndefined();
  });

  it("reads instanceScope and an absent instanceKey, and finds the block by the id rule", () => {
    const keyed = { id: "tf/app/module.web[0]/aws_s3_bucket.logs[1]", instanceOf: BLOCK, instanceScope: "module.web[0]", instanceKey: "[1]", attrs: {} } as never;
    const keyless = { id: "tf/app/module.web[0]/aws_s3_bucket.logs", instanceOf: BLOCK, instanceScope: "module.web[0]", attrs: {} } as never;
    expect(instanceScopeOf(keyed)).toBe("module.web[0]");
    expect(ownInstanceKeyOf(keyed)).toBe("[1]");
    expect(ownInstanceKeyOf(keyless)).toBeUndefined();
    // Composition prefixed the id and not instanceOf; the rule still finds the composed block.
    expect(instanceBlockIdOf(keyed)).toBe(`tf/${BLOCK}`);
    expect(instanceBlockIdOf(keyless)).toBe(`tf/${BLOCK}`);
    // No scope: the trailing key goes, as before.
    expect(instanceBlockIdOf({ id: "app/aws_s3_bucket.logs[2]", attrs: {} } as never)).toBe("app/aws_s3_bucket.logs");
    // The module call's own instance node is the plain rule.
    expect(instanceBlockIdOf({ id: "app/module.web[0]", attrs: {} } as never)).toBe("app/module.web");
  });
});

describe("planned: chant's module-keyed instance nodes get their own plan (behold#1011)", () => {
  const ids = ["app/module.web[0]/aws_s3_bucket.logs", "app/module.web[1]/aws_s3_bucket.logs"];

  it("keeps the nodes chant drew, gives each its slice of the plan, and the block rolls them up", () => {
    const ir = sourceIr();
    ir.nodes.push(chantInstance(ids[0]!, BLOCK, "module.web[0]"), chantInstance(ids[1]!, BLOCK, "module.web[1]"));
    paintTerraformPlan(ir, terraformPlanReadOf(planIr({ "module.web[0].aws_s3_bucket.logs": ["update"], "module.web[1].aws_s3_bucket.logs": ["create"] })));
    expect(addInstanceCards(ir)).toBe(0);
    const plan = (id: string) => ir.nodes.find((n) => n.id === id)!.attrs._plan as { action: string };
    expect(plan(ids[0]!).action).toBe("update");
    expect(plan(ids[1]!).action).toBe("create");
    const block = ir.nodes.find((n) => n.id === BLOCK)!;
    expect(block.attrs._instances).toEqual(ids);
    expect(ir.edges.filter((e) => e.to === BLOCK).map((e) => e.from).sort()).toEqual(ids);
    expect((ir.groups as { byStack: Record<string, string[]> }).byStack.app).toEqual([BLOCK, ...ids]);
  });

  it("draws the cards from the plan when chant drew none (a chant before #4486), on the same ids", () => {
    const ir = sourceIr();
    paintTerraformPlan(ir, terraformPlanReadOf(planIr({ "module.web[0].aws_s3_bucket.logs": ["update"], "module.web[1].aws_s3_bucket.logs": ["create"] })));
    expect(addInstanceCards(ir)).toBe(2);
    const card = ir.nodes.find((n) => n.id === ids[1])!;
    expect(card.attrs.instanceScope).toBe("module.web[1]");
    expect(card.attrs.instanceKey).toBeUndefined();
    expect(card.attrs.instanceOf).toBe(BLOCK);
    expect((card.attrs._plan as { action: string }).action).toBe("create");
  });

  it("carries the block's own key when the block is counted too", () => {
    const ir = sourceIr();
    paintTerraformPlan(ir, terraformPlanReadOf(planIr({ "module.web[0].aws_s3_bucket.logs[1]": ["create"] })));
    expect(addInstanceCards(ir)).toBe(1);
    const card = ir.nodes.find((n) => n.id === "app/module.web[0]/aws_s3_bucket.logs[1]")!;
    expect(card.attrs).toMatchObject({ instanceScope: "module.web[0]", instanceKey: "[1]", address: "module.web[0].aws_s3_bucket.logs[1]" });
  });
});

describe("live: chant#4488's live instance nodes hang under their block (behold#1011)", () => {
  it("lists live module-keyed instances on a composed block, with or without an instanceKey", () => {
    const ir = sourceIr("tf/");
    // A live read keeps chant's verdict on the node; behold only places it.
    const keyless = { ...(chantInstance("tf/app/module.web[0]/aws_s3_bucket.logs", BLOCK, "module.web[0]") as object), attrs: { _status: "good" } };
    const keyed = chantInstance('tf/app/module.web["b"]/aws_s3_bucket.logs[0]', BLOCK, 'module.web["b"]', "[0]");
    ir.nodes.push(keyless as never, keyed);
    expect(addInstanceCards(ir)).toBe(0);
    const block = ir.nodes.find((n) => n.id === `tf/${BLOCK}`)!;
    expect(block.attrs._instances).toEqual(['tf/app/module.web["b"]/aws_s3_bucket.logs[0]', "tf/app/module.web[0]/aws_s3_bucket.logs"]);
    expect(ir.nodes.find((n) => n.id === "tf/app/module.web[0]/aws_s3_bucket.logs")!.attrs._status).toBe("good");
  });
});

describe("change sets and drift land on module-keyed instance cards (behold#1011)", () => {
  const gate = { key: "tf/apply/prod", member: "tf", op: "apply", gate: "approve", env: "prod", approve: "chant op-signal" } as never;
  const doc = (entry: Record<string, unknown>) => ({
    changeSet: { digest: "jcs1-sha256:00", entries: [{ member: "tf", planner: "terraform", address: "module.web[1].aws_s3_bucket.logs", type: "aws_s3_bucket", action: "create", attributes: [], ...entry }], members: [], graph: { member: "tf", at: null } },
  });

  it("outlines the instance and its block, whether chant named the instance node or only the block", () => {
    const after = overlayFrom(gate, doc({ node: "tf/app/module.web[1]/aws_s3_bucket.logs", instanceOf: `tf/${BLOCK}` }), new Date(0));
    const before = overlayFrom(gate, doc({ node: `tf/${BLOCK}` }), new Date(0));
    expect(after.nodes).toEqual(before.nodes);
    expect(after.nodes["tf/app/module.web[1]/aws_s3_bucket.logs"]).toEqual({ bucket: "create", actions: { create: 1 }, instanceOf: `tf/${BLOCK}` });
    expect(after.nodes[`tf/${BLOCK}`]!.instances).toEqual(["tf/app/module.web[1]/aws_s3_bucket.logs"]);
  });

  it("maps a choudoufu member's module-keyed instance node to its block path", () => {
    const aliases = choudoufuCardAliases("cd", { nodes: [{ id: BLOCK, attrs: { root: "app" } }, chantInstance("app/module.web[0]/aws_s3_bucket.logs[1]", BLOCK, "module.web[0]", "[1]")] as never });
    expect(aliases.blocks.get("cd/app/module.web[0]/aws_s3_bucket.logs[1]")).toBe("module.web/aws_s3_bucket.logs");
  });
});
