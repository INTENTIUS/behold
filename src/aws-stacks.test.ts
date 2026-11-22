import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyReferenceCatalog, referenceCatalogOf } from "./reference-catalog.ts";
import { attachDeployedStacks, deployedStacksOf, unreadStacks, UNREAD_STACK_KIND } from "./aws-stacks.ts";
import { AWS_STACK_MEMBER_CHANT_FLOOR, CHANT_FLOORS, floorFor } from "./chant-floors.ts";
import { stackChecks, hasAwsCredentials } from "./doctor-stacks.ts";
import { composeMembers } from "./estate.ts";
import { memberIrFromGraphDocument } from "./workspace.ts";

// The document is shaped as `chant workspace graph` writes it for a workspace with a Terraform member and a
// cloudformation member that names two deployed stacks (INTENTIUS/chant#5455): `meta.awsMember.stacks` on the
// member, one stack read and one not, and a derived identity edge from the stack's function to the Terraform role.
const doc = (): Record<string, unknown> => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "aws-stacks", "workspace-graph.json"), "utf8")) as Record<string, unknown>;

describe("deployed CloudFormation stacks (behold#1245)", () => {
  it("has a floor in CHANT_FLOORS, and doctor prints it", () => {
    expect(CHANT_FLOORS).toContain(floorFor("deployed CloudFormation stacks"));
    expect(floorFor("deployed CloudFormation stacks").floor).toBe(AWS_STACK_MEMBER_CHANT_FLOOR);
  });

  it("reads each stack's answer from meta.awsMember.stacks as chant wrote it", () => {
    const ir = memberIrFromGraphDocument(doc(), "legacy");
    const stacks = deployedStacksOf(ir)!;
    expect(stacks.map((s) => [s.name, s.read])).toEqual([["orders", true], ["billing", false]]);
    expect(stacks[0]!.resources).toHaveLength(2);
    expect(stacks[1]!.reason).toMatch(/ExpiredToken/);
  });

  it("puts the stack, its status and each physical id on the cards of a read stack", () => {
    const ir = memberIrFromGraphDocument(doc(), "legacy");
    const fn = ir.nodes.find((n) => n.id === "orders/DeployFn")!;
    expect(fn.attrs._stack).toEqual({ name: "orders", region: "us-east-1", status: "UPDATE_COMPLETE", physicalId: "orders-DeployFn-1A2B3C", resourceStatus: "UPDATE_COMPLETE" });
  });

  it("draws a stack chant could not read as one neutral card with chant's reason, and no colour of its own", () => {
    const ir = memberIrFromGraphDocument(doc(), "legacy");
    const card = ir.nodes.find((n) => n.kind === UNREAD_STACK_KIND)!;
    expect(card.id).toBe("unread-stack/billing");
    expect(card.attrs._status).toBe("neutral");
    expect(String(card.attrs._unobserved)).toMatch(/cloudformation:DescribeStacks/);
    expect(unreadStacks(ir)).toEqual([{ name: "billing", reason: card.attrs._unobserved }]);
  });

  it("is idempotent and leaves an IR with no stacks untouched", () => {
    const ir = memberIrFromGraphDocument(doc(), "legacy");
    const before = JSON.stringify(ir.nodes);
    attachDeployedStacks(ir, "legacy");
    expect(JSON.stringify(ir.nodes)).toBe(before);
    const plain = memberIrFromGraphDocument(doc(), "platform");
    const nodes = JSON.stringify(plain.nodes);
    attachDeployedStacks(plain, "platform");
    expect(JSON.stringify(plain.nodes)).toBe(nodes);
    expect(plain.nodes.some((n) => n.kind === UNREAD_STACK_KIND)).toBe(false);
  });

  it("draws the Terraform member and the stack member together, with chant's identity edge between them", () => {
    const d = doc();
    const estate = composeMembers([
      { name: "platform", ir: memberIrFromGraphDocument(d, "platform") },
      { name: "legacy", ir: memberIrFromGraphDocument(d, "legacy") },
    ]);
    applyReferenceCatalog(estate, referenceCatalogOf(d)!);
    const ids = estate.nodes.map((n) => n.id);
    expect(ids).toContain("platform/aws_iam_role.deploy");
    expect(ids).toContain("legacy/orders/DeployFn");
    expect(ids).toContain("legacy/unread-stack/billing");
    const identity = estate.edges.find((e) => e.from === "legacy/orders/DeployFn" && e.to === "platform/aws_iam_role.deploy")!;
    expect(identity).toMatchObject({ origin: "derived", rule: "aws:AWS::Lambda::Function:Role" });
  });
});

describe("doctor's stacks line (behold#1245)", () => {
  const dir = mkdtempSync(join(tmpdir(), "behold-stacks-"));
  const member = (decl: unknown) => {
    writeFileSync(join(dir, "cloudformation-stacks.json"), typeof decl === "string" ? decl : JSON.stringify(decl));
    return [{ name: "legacy", dir: "legacy", abs: dir }];
  };
  const keys = { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" };
  const opts = (env: NodeJS.ProcessEnv, chantVersion: string | undefined = AWS_STACK_MEMBER_CHANT_FLOOR) => ({ root: dir, chantVersion, env, home: dir });

  it("passes with a region and credentials", () => {
    const [c] = stackChecks(member({ stacks: ["orders"], region: "us-east-1" }), opts(keys));
    expect(c).toMatchObject({ name: "stacks", status: "pass" });
  });

  it("says a missing region and missing credentials, each with the step that fixes it", () => {
    const [c] = stackChecks(member({ stacks: ["orders"] }), opts({}));
    expect(c!.status).toBe("warn");
    expect(c!.detail).toMatch(/no region/);
    expect(c!.detail).toMatch(/no AWS credentials/);
    expect(c!.fix).toMatch(/AWS_REGION/);
    expect(c!.fix).toMatch(/AWS_PROFILE/);
  });

  it("takes the region from the environment when the file names none", () => {
    const [c] = stackChecks(member({ stacks: ["orders"] }), opts({ ...keys, AWS_REGION: "eu-west-1" }));
    expect(c!.status).toBe("pass");
  });

  it("refuses a chant below the floor and says the member draws its template files only", () => {
    const [c] = stackChecks(member({ stacks: ["orders"], region: "us-east-1" }), opts(keys, "0.124.110"));
    expect(c!.status).toBe("warn");
    expect(c!.detail).toMatch(new RegExp(`needs chant ${AWS_STACK_MEMBER_CHANT_FLOOR.replaceAll(".", "\\.")}`));
    expect(c!.fix).toMatch(/template files only/);
  });

  it("fails a stacks file that is not the shape chant reads, and says nothing for a member without one", () => {
    expect(stackChecks(member("{ nope"), opts(keys))[0]!.status).toBe("fail");
    expect(stackChecks(member({ stacks: [] }), opts(keys))[0]!.status).toBe("fail");
    expect(stackChecks([{ name: "other", dir: "other", abs: join(dir, "absent") }], opts(keys))).toEqual([]);
  });

  it("finds credentials by profile, web identity token or container role", () => {
    expect(hasAwsCredentials({ AWS_PROFILE: "prod" }, dir)).toBe(true);
    expect(hasAwsCredentials({ AWS_WEB_IDENTITY_TOKEN_FILE: "/t" }, dir)).toBe(true);
    expect(hasAwsCredentials({}, dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
