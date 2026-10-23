import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { attachLintFindings, lintReportOf, terraformLintNote } from "./terraform-lint.ts";

// #919: what `chant graph` writes on meta.lint under `graph.lint: "report"`,
// shaped like #912's terralith-4-stock findings.
function ir(): GraphIR {
  return {
    nodes: [
      { id: "estate/aws_db_instance.orders", kind: "Terraform::Resource", lexicon: "terraform", attrs: {} },
      { id: "estate/aws_vpc_security_group_ingress_rule.bastion_ssh", kind: "Terraform::Resource", lexicon: "terraform", attrs: {} },
      { id: "estate/terraform", kind: "Terraform::Terraform", lexicon: "terraform", attrs: {} },
    ],
    edges: [],
    groups: {},
    meta: {
      lint: {
        errors: 4,
        warnings: 1,
        findings: [
          { ruleId: "TF030", severity: "error", message: "[estate/aws_vpc_security_group_ingress_rule.bastion_ssh] ssh from 0.0.0.0/0", entity: "estate/aws_vpc_security_group_ingress_rule.bastion_ssh" },
          { ruleId: "TF033", severity: "error", message: "[estate/aws_db_instance.orders] unencrypted", entity: "estate/aws_db_instance.orders" },
          { ruleId: "TF022", severity: "error", message: "[estate/aws_db_instance.orders] password literal", entity: "estate/aws_db_instance.orders" },
          { ruleId: "TF999", severity: "error", message: "a finding about no block" },
          { ruleId: "TF001", severity: "warning", message: "[estate/terraform] no remote backend", entity: "estate/terraform" },
        ],
      },
    },
  } as unknown as GraphIR;
}

const lintOf = (g: GraphIR, id: string): unknown => (g.nodes.find((n) => n.id === id)!.attrs as Record<string, unknown>)._lint;

describe("a bare Terraform estate's lint findings (#919)", () => {
  it("puts each error on the card it names, and no warning on any card", () => {
    const g = ir();
    attachLintFindings(g);
    expect(lintOf(g, "estate/aws_db_instance.orders")).toEqual([
      { ruleId: "TF033", message: "[estate/aws_db_instance.orders] unencrypted" },
      { ruleId: "TF022", message: "[estate/aws_db_instance.orders] password literal" },
    ]);
    expect(lintOf(g, "estate/aws_vpc_security_group_ingress_rule.bastion_ssh")).toHaveLength(1);
    expect(lintOf(g, "estate/terraform")).toBeUndefined();
  });

  it("is idempotent: a second pass rebuilds the list rather than appending", () => {
    const g = ir();
    attachLintFindings(g);
    attachLintFindings(g);
    expect(lintOf(g, "estate/aws_db_instance.orders")).toHaveLength(2);
  });

  it("names every error on the note, and counts the one that names no block", () => {
    const g = ir();
    attachLintFindings(g);
    expect(terraformLintNote(g)).toEqual({
      note: "4 lint errors, drawn anyway — TF033 aws_db_instance.orders, TF022 aws_db_instance.orders, TF030 aws_vpc_security_group_ingress_rule.bastion_ssh, 1 on no drawn block",
      noteShort: "4 lint errors",
    });
  });

  it("still names them from the cards once composition has dropped meta", () => {
    const g = ir();
    attachLintFindings(g);
    delete (g as { meta?: unknown }).meta;
    expect(terraformLintNote(g).note).toBe("3 lint errors, drawn anyway — TF033 aws_db_instance.orders, TF022 aws_db_instance.orders, TF030 aws_vpc_security_group_ingress_rule.bastion_ssh");
  });

  it("says nothing when lint found no error, or was not asked", () => {
    const clean = { nodes: [], edges: [], groups: {}, meta: { lint: { errors: 0, warnings: 2, findings: [] } } } as unknown as GraphIR;
    expect(terraformLintNote(clean)).toEqual({});
    const unasked = { nodes: [], edges: [], groups: {} } as unknown as GraphIR;
    expect(lintReportOf(unasked)).toBeUndefined();
    expect(terraformLintNote(unasked)).toEqual({});
  });
});
