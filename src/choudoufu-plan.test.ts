import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import { paintPlanDrift } from "./choudoufu-live.ts";
import { KNOWN_AFTER_APPLY, SENSITIVE, parsePlanShow, planArgv, planDrift, readChoudoufuPlan, type PlanShowDocument } from "./choudoufu-plan.ts";

// Fixture provenance (#404). Printed by choudoufu v0.16.0 (based on OpenTofu
// v1.13.0-dev) against a scratch floci, from behold's own workbench entry
// `choudoufu-cohort-iam-ecr` — `node bin/behold.js demo choudoufu-cohort-iam-ecr
// /tmp/beh404 --port 4820`, which renders choudoufu's `iam-ecr` cohort with
// tools/estate-gen (6 resources, a sidecar-declared estate), boots the floci
// `behold-wb-choudoufu-cohort-iam-ecr` on 127.0.0.1:4653 and applies it clean.
// Nothing hand-edited. Every document is `choudoufu show -json` of a plan file
// written by `choudoufu plan -input=false -out=…` in the target, with
// AWS_ENDPOINT_URL=http://127.0.0.1:4653 and the dummy test credentials.
//
// The three, and the out-of-band change that explains each:
//
//  1. choudoufu-plan-iam-ecr-clean.json — the estate exactly as applied.
//     All 6 `resource_changes` are `no-op`; the terminal says "No changes."
//  2. choudoufu-plan-iam-ecr-drift.json — TWO attributes changed out of band,
//     one a map and one a scalar, so both of the pane's rendering paths are
//     covered by a real document:
//       aws iam tag-role --role-name tofu-iam-ecr-cohort-iam-role \
//         --tags Key=drifted,Value=out-of-band
//       aws ecr put-image-tag-mutability \
//         --repository-name tofu-iam-ecr-cohort-ecr-repository \
//         --image-tag-mutability IMMUTABLE
//     `aws_iam_role.iam-ecr` is `update` on `tags`/`tags_all` (the estate's two
//     ownership markers survive on both sides — the drift is the third key);
//     `aws_ecr_repository.app` is `update` on `image_tag_mutability`,
//     "IMMUTABLE" -> "MUTABLE". The terminal prints "Plan: 0 to add, 2 to
//     change, 0 to destroy."
//  3. choudoufu-plan-iam-ecr-create.json — the group deleted out of band
//     (`aws iam delete-group --group-name tofu-iam-ecr-cohort-iam-group`), so
//     the plan proposes `create` for `aws_iam_group.app` with `before: null`.
//     Recorded because a create is exactly what must NOT read as attribute
//     drift (#404); the estate was restored with `choudoufu apply` afterwards.
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (name: string): string => readFileSync(join(HERE, "__fixtures__", name), "utf8");
const ok = { code: 0, stderr: "" };
const doc = (name: string): PlanShowDocument => {
  const p = parsePlanShow({ ...ok, stdout: raw(name) }, "/est");
  if (!p.ok) throw new Error(p.refusal.error);
  return p.doc;
};

const CLEAN = "choudoufu-plan-iam-ecr-clean.json";
const DRIFT = "choudoufu-plan-iam-ecr-drift.json";
const CREATE = "choudoufu-plan-iam-ecr-create.json";

describe("the plan document (#404)", () => {
  it("reads a real `choudoufu show -json` — format 1.2, one entry per declared resource", () => {
    const d = doc(DRIFT);
    expect(d.format_version).toBe("1.2");
    expect(d.resource_changes).toHaveLength(6);
  });

  it("refuses what is not a plan document, and says why", () => {
    expect(parsePlanShow({ ...ok, stdout: "" }, "/est")).toMatchObject({ ok: false, refusal: { code: "choudoufu-live-check" } });
    expect(parsePlanShow({ ...ok, stdout: "not json" }, "/est")).toMatchObject({ ok: false, refusal: { error: expect.stringContaining("not JSON") } });
    expect(parsePlanShow({ ...ok, stdout: '{"resource_changes":[]}' }, "/est")).toMatchObject({ ok: false, refusal: { error: expect.stringContaining("format_version") } });
    // A missing binary is its own remedy, not a credentials problem.
    expect(parsePlanShow({ code: 127, stdout: "", stderr: "" }, "/est")).toMatchObject({ ok: false, refusal: { remedy: expect.stringContaining("PATH") } });
  });
});

describe("planDrift — what counts as attribute drift (#404)", () => {
  it("names the changed attributes of an updated resource, with before and after", () => {
    const drift = planDrift(doc(DRIFT));
    expect([...drift.keys()].sort()).toEqual(["aws_ecr_repository.app", "aws_iam_role.iam-ecr"]);

    // The scalar: the account holds IMMUTABLE, the configuration says MUTABLE.
    // `oldValue`/`newValue` are the keys the pane's `diff` rows already read,
    // and it prints them `before → after`.
    const ecr = drift.get("aws_ecr_repository.app")!;
    expect(ecr.actions).toEqual(["update"]);
    expect(ecr.changes).toEqual([{ path: "image_tag_mutability", oldValue: "IMMUTABLE", newValue: "MUTABLE" }]);

    // The map: the out-of-band `drifted` key is the whole change — both
    // ownership markers are identical on either side, which is exactly why
    // the ownership half never noticed and the card stayed green.
    const role = drift.get("aws_iam_role.iam-ecr")!;
    expect(role.changes.map((c) => c.path)).toEqual(["tags", "tags_all"]);
    const tags = role.changes.find((c) => c.path === "tags")!;
    expect(tags.oldValue).toEqual({ drifted: "out-of-band", "tofu-address": "aws_iam_role.iam-ecr", "tofu-estate": "iam-ecr-cohort" });
    expect(tags.newValue).toEqual({ "tofu-address": "aws_iam_role.iam-ecr", "tofu-estate": "iam-ecr-cohort" });
  });

  it("reports nothing for a clean estate — a no-op plan is not drift", () => {
    const d = doc(CLEAN);
    expect(d.resource_changes!.every((r) => r.change.actions.every((a) => a === "no-op"))).toBe(true);
    expect(planDrift(d).size).toBe(0);
  });

  it("does NOT count a planned create — an absent resource has no attribute that drifted", () => {
    const d = doc(CREATE);
    const create = d.resource_changes!.find((r) => r.address === "aws_iam_group.app")!;
    expect(create.change.actions).toEqual(["create"]);
    expect(create.change.before).toBeNull();
    // The document HAS a change; `planDrift` still reports none, because the
    // ownership overlay is what answers "this is not there" (#404).
    expect(planDrift(d).size).toBe(0);
  });

  it("does not count a planned delete either — a removal is not a value that moved", () => {
    const drift = planDrift({
      format_version: "1.2",
      resource_changes: [{ address: "aws_iam_user.gone", change: { actions: ["delete"], before: { name: "gone" }, after: null } }],
    });
    expect(drift.size).toBe(0);
  });

  it("counts a replace, where both sides exist and the values really differ", () => {
    const drift = planDrift({
      format_version: "1.2",
      resource_changes: [{ address: "aws_iam_user.a", change: { actions: ["delete", "create"], before: { path: "/old/" }, after: { path: "/new/" } } }],
    });
    expect(drift.get("aws_iam_user.a")!.changes).toEqual([{ path: "path", oldValue: "/old/", newValue: "/new/" }]);
  });

  it("redacts a value the provider marked sensitive, and still names the attribute", () => {
    const drift = planDrift({
      format_version: "1.2",
      resource_changes: [
        {
          address: "aws_db_instance.a",
          change: { actions: ["update"], before: { password: "hunter2" }, after: { password: "correct-horse" }, before_sensitive: { password: true }, after_sensitive: { password: true } },
        },
      ],
    });
    // The NAME is the useful part and is safe; the values are not behold's to
    // print into a pane because a plan happened to read them.
    expect(drift.get("aws_db_instance.a")!.changes).toEqual([{ path: "password", oldValue: SENSITIVE, newValue: SENSITIVE }]);
  });

  it("says `(known after apply)` where the plan cannot know the value yet", () => {
    const drift = planDrift({
      format_version: "1.2",
      resource_changes: [{ address: "aws_iam_role.a", change: { actions: ["update"], before: { arn: "arn:old" }, after: {}, after_unknown: { arn: true } } }],
    });
    expect(drift.get("aws_iam_role.a")!.changes).toEqual([{ path: "arn", oldValue: "arn:old", newValue: KNOWN_AFTER_APPLY }]);
  });

  it("compares deeply — an identical nested value is not a change", () => {
    const drift = planDrift({
      format_version: "1.2",
      resource_changes: [{ address: "a.b", change: { actions: ["update"], before: { tags: { a: "1" }, list: [1, 2] }, after: { tags: { a: "1" }, list: [1, 3] } } }],
    });
    expect(drift.get("a.b")!.changes.map((c) => c.path)).toEqual(["list"]);
  });
});

describe("readChoudoufuPlan — the two spawns (#404)", () => {
  const captured = (name: string) => ({ ...ok, stdout: raw(name) });

  it("runs `plan -input=false -out=<tmp>` then `show -json <tmp>`, both in the member's directory", async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const drift = await readChoudoufuPlan("/est/mono", async (args, cwd) => {
      calls.push({ args, cwd });
      return args[0] === "plan" ? { ...ok, stdout: "" } : captured(DRIFT);
    });
    expect(calls.map((c) => c.cwd)).toEqual(["/est/mono", "/est/mono"]);
    expect(calls[0].args.slice(0, 2)).toEqual(["plan", "-input=false"]);
    expect(calls[1].args.slice(0, 2)).toEqual(["show", "-json"]);
    // The plan file is the SAME path on both spawns, and it is behold's own
    // scratch — never a path inside the served member, which would be a write
    // into someone's source (AGENTS.md, "Invariant").
    const out = calls[0].args[2].replace(/^-out=/, "");
    expect(calls[1].args[2]).toBe(out);
    expect(out.startsWith("/est/mono")).toBe(false);
    expect(drift.size).toBe(2);
  });

  it("pins the argv it documents", () => {
    expect(planArgv("/tmp/x/plan.tfplan")).toEqual({
      plan: ["plan", "-input=false", "-out=/tmp/x/plan.tfplan"],
      show: ["show", "-json", "/tmp/x/plan.tfplan"],
    });
  });

  it("throws when the plan spawn fails, with choudoufu's own line", async () => {
    await expect(
      readChoudoufuPlan("/est/mono", async (args) => (args[0] === "plan" ? { code: 1, stdout: "", stderr: "Error: no valid credential sources" } : captured(DRIFT))),
    ).rejects.toThrow(/no valid credential sources/);
  });

  it("removes its scratch directory even when the read throws", async () => {
    const outs: string[] = [];
    await expect(
      readChoudoufuPlan("/est/mono", async (args) => {
        if (args[0] === "plan") outs.push(args[2].replace(/^-out=/, ""));
        return { code: 1, stdout: "", stderr: "Error: boom" };
      }),
    ).rejects.toThrow();
    const { existsSync } = await import("node:fs");
    expect(outs).toHaveLength(1);
    expect(existsSync(dirname(outs[0]))).toBe(false);
  });
});

describe("paintPlanDrift — the second signal on the card (#404)", () => {
  const ir = (): GraphIR =>
    ({
      nodes: [
        { id: "mono/aws_iam_role.iam-ecr", kind: "aws_iam_role", lexicon: "choudoufu", ownership: "owned", attrs: { _status: "good" } },
        { id: "mono/aws_iam_group.app", kind: "aws_iam_group", lexicon: "choudoufu", attrs: { _status: "warn" } },
        { id: "mono/aws_iam_user.app", kind: "aws_iam_user", lexicon: "choudoufu", attrs: { _status: "good" } },
        { id: "mono/x", kind: "AWS::S3::Bucket", lexicon: "cfn", attrs: { _status: "good" } },
      ],
      edges: [],
      groups: {},
    }) as unknown as GraphIR;

  const drift = () => planDrift(doc(DRIFT));

  it("marks a bound card and leaves its ownership colour alone", () => {
    const g = ir();
    // The fixture's addresses, under this test's member name.
    const d = new Map([["aws_iam_role.iam-ecr", drift().get("aws_iam_role.iam-ecr")!]]);
    expect(paintPlanDrift(g, d, "mono")).toBe(1);
    const node = g.nodes.find((n) => n.id === "mono/aws_iam_role.iam-ecr")!;
    // The whole point of #404's second bullet: bound stays bound.
    expect(node.attrs._status).toBe("good");
    expect(node.attrs._planDrift).toEqual({ actions: ["update"], attributes: ["tags", "tags_all"] });
  });

  it("never marks a card that is not bound — an unowned object's plan entry is an ownership fact", () => {
    const g = ir();
    const d = new Map([["aws_iam_group.app", { actions: ["update"], changes: [{ path: "path" }] }]]);
    expect(paintPlanDrift(g, d, "mono")).toBe(0);
    expect(g.nodes.find((n) => n.id === "mono/aws_iam_group.app")!.attrs._planDrift).toBeUndefined();
  });

  it("touches no other lexicon's cards, and marks nothing on an empty change set", () => {
    const g = ir();
    expect(paintPlanDrift(g, new Map())).toBe(0);
    expect(paintPlanDrift(g, new Map([["x", { actions: ["update"], changes: [{ path: "a" }] }]]), "mono")).toBe(0);
    expect(g.nodes.every((n) => n.attrs._planDrift === undefined)).toBe(true);
  });

  it("joins on the raw address when the estate serves one unnamed member", () => {
    const g = ir();
    g.nodes[0].id = "aws_iam_role.iam-ecr";
    expect(paintPlanDrift(g, new Map([["aws_iam_role.iam-ecr", drift().get("aws_iam_role.iam-ecr")!]]))).toBe(1);
  });
});
