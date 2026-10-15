// behold#571: a Terragrunt repo's units, read from terragrunt.hcl, drawn as roots.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { addTerragruntUnits, discoverTerragruntUnits, parseTerragrunt, resolveSource, stripHclComments, terragruntNote, terragruntPicture } from "./terragrunt-units.ts";
import { checkoutRootDirs, isTerraformMember, terraformMemberScan } from "./terraform-member.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** The demo's Terragrunt repo (terragucci example-demo-terragrunt/), with the pull request's two units when `pr`. */
function repo(pr = false): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-tg-test-"));
  made.push(dir);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("root.hcl", 'remote_state {\n  backend = "s3"\n  config = { key = "terragrunt/${path_relative_to_include()}/terraform.tfstate" }\n}\n');
  put("modules/record/main.tf", 'terraform {\n  required_version = ">= 1.13"\n}\n\nvariable "value" {\n  type = string\n}\n\nresource "terraform_data" "this" {\n  input = var.value\n}\n\noutput "value" {\n  value = terraform_data.this.input\n}\n');
  const unit = (dep?: string) =>
    `include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\n# a comment with { a brace\nterraform {\n  source = "../../modules/record"\n}\n` +
    (dep ? `\ndependency "${dep}" {\n  config_path = "../${dep}"\n  mock_outputs = { value = "mock-${dep}" }\n}\n` : "") +
    `\ninputs = {\n  value = "x"\n}\n`;
  put("live/network/terragrunt.hcl", unit());
  put("live/app/terragrunt.hcl", unit("network"));
  if (pr) {
    put("live/ledger/terragrunt.hcl", unit());
    put("live/billing/terragrunt.hcl", unit("ledger"));
  }
  return dir;
}

describe("parseTerragrunt", () => {
  it("reads the module source and each dependency block, and nothing in a comment or a string", () => {
    const p = parseTerragrunt('# terraform { source = "nope" }\nterraform {\n  source = "../../modules//record?ref=v1" // trailing\n}\ndependency "net" {\n  config_path = "../network"\n  mock_outputs = { value = "}" }\n}\n');
    expect(p.source).toBe("../../modules//record?ref=v1");
    expect(p.dependencies).toEqual([{ name: "net", configPath: "../network", line: 5 }]);
  });
  it("says a source that is an expression is stated but not read", () => {
    const p = parseTerragrunt('terraform {\n  source = "${local.base}/record"\n}\n');
    expect(p.source).toBeUndefined();
    expect(p.sourceStated).toBe(true);
  });
  it("keeps line numbers through block comments", () => {
    expect(stripHclComments("a /* x\ny */ b").split("\n")).toHaveLength(2);
  });
});

describe("resolveSource", () => {
  it("follows a local path in the repo to a directory of .tf, and refuses anything else", () => {
    const dir = repo();
    expect(resolveSource(dir, "live/app", "../../modules//record", true)).toEqual({ module: "modules/record" });
    expect(resolveSource(dir, "live/app", "git::https://example.com/m.git//record", true)).toHaveProperty("why");
    expect(resolveSource(dir, "live/app", "tfr:///terraform-aws-modules/vpc/aws", true)).toHaveProperty("why");
    expect(resolveSource(dir, "live/app", "../../../../elsewhere", true)).toHaveProperty("why");
    expect(resolveSource(dir, "live/app", "../../live", true)).toEqual({ why: "its source ../../live holds no .tf file" });
    expect(resolveSource(dir, "live/app", undefined, false)).toEqual({ why: "it names no terraform source" });
  });
});

describe("a Terragrunt repo as a terraform member", () => {
  it("finds the units, their module and the unit each dependency names", () => {
    const units = discoverTerragruntUnits(repo(true));
    expect(units.map((u) => u.dir)).toEqual(["live/app", "live/billing", "live/ledger", "live/network"]);
    expect(units.every((u) => u.module === "modules/record")).toBe(true);
    expect(units.find((u) => u.dir === "live/billing")!.dependencies).toEqual([{ name: "ledger", configPath: "../ledger", unit: "live/ledger", line: 10 }]);
  });

  it("is a terraform member, keyed by unit and read from the module", () => {
    const dir = repo();
    expect(isTerraformMember(dir)).toBe(true);
    expect(terraformMemberScan(dir).scan.roots).toEqual([
      { name: "live/app", dir: "modules/record", unit: "live/app" },
      { name: "live/network", dir: "modules/record", unit: "live/network" },
    ]);
    expect(checkoutRootDirs(dir)).toEqual([
      { name: "live/app", dir: "live/app" },
      { name: "live/network", dir: "live/network" },
    ]);
  });

  it("adds a card per dependency with an edge to the unit it reads", () => {
    const picture = terragruntPicture(".", discoverTerragruntUnits(repo(true)));
    const ir = {
      version: 1,
      nodes: ["live/app", "live/billing", "live/ledger", "live/network"].map((r) => ({ id: `${r}/terraform_data.this`, kind: "Terraform::Resource", lexicon: "terraform", attrs: { address: "terraform_data.this", root: r } })),
      edges: [],
      groups: { byStack: {} },
    } as unknown as GraphIR;
    addTerragruntUnits(ir, picture);
    expect(ir.edges).toEqual([
      { from: "live/app/data.terragrunt_dependency.network", to: "live/network/terraform_data.this", kind: "ref" },
      { from: "live/billing/data.terragrunt_dependency.ledger", to: "live/ledger/terraform_data.this", kind: "ref" },
    ]);
    expect((ir.groups as { byStack: Record<string, string[]> }).byStack["live/billing"]).toEqual(["live/billing/data.terragrunt_dependency.ledger"]);
    expect(terragruntNote(picture)).toBe("4 Terragrunt units — live/app, live/billing, live/ledger, live/network; resources from modules/record");
  });

  it("draws a unit whose module isn't here, and a declared root with no unit, as one card that says so", () => {
    const picture = {
      units: [{ dir: "live/edge", source: "git::https://example.com/m.git", unresolved: "its source git::https://example.com/m.git is not in this repo", dependencies: [] }],
      declaredOnly: [{ name: "live/dns", dir: "live/dns", dependsOn: ["live/edge"] }],
    };
    const ir = addTerragruntUnits({ version: 1, nodes: [], edges: [], groups: {} } as unknown as GraphIR, picture);
    expect(ir.nodes.map((n) => n.id)).toEqual(["live/edge/module.not_read", "live/dns/module.not_read", "live/dns/data.terragrunt_dependency.live_edge"]);
    expect(String(ir.nodes[0]!.attrs.unread)).toContain("Drawn from terragrunt.hcl alone");
    expect(ir.edges).toEqual([{ from: "live/dns/data.terragrunt_dependency.live_edge", to: "live/edge/module.not_read", kind: "ref" }]);
  });
});
