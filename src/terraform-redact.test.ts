import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { redactSensitiveDefaults, redactSensitiveSources } from "./terraform-redact.ts";

const FILE = `variable "token" {
  type      = string
  default   = "hunter2"
  sensitive = true
}

variable "port" {
  default   = 5432
  sensitive = true
}

variable "creds" {
  sensitive = true
  default = {
    user = "admin"
    pass = "s3cret"
    note = <<-EOT
      heredoc } with "quotes"
    EOT
  }
  validation {
    condition     = length(var.creds) > 0
    error_message = "default = \\"nope\\""
  }
}

variable "region" {
  default = "us-east-1"
}

variable "plain" {
  default   = "visible"
  sensitive = false
}

resource "aws_db_instance" "main" {
  password = var.token # default = "hunter2"
}
`;

describe("sensitive variable defaults in a card's source (#920)", () => {
  const out = redactSensitiveDefaults(FILE);

  it("replaces a string, a number and a multi-line map default", () => {
    expect(out).toContain("default   = (sensitive)\n  sensitive = true");
    expect(out).not.toContain('default   = "hunter2"');
    expect(out).toContain("default   = (sensitive)\n  sensitive = true\n}\n\nvariable \"creds\"");
    expect(out).not.toContain("5432");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("admin");
    expect(out).toContain("sensitive = true\n  default = (sensitive)\n  validation {");
  });

  it("leaves everything else byte for byte", () => {
    expect(out).toContain('default = "us-east-1"');
    expect(out).toContain('default   = "visible"');
    expect(out).toContain('error_message = "default = \\"nope\\""');
    expect(out).toContain('password = var.token # default = "hunter2"');
    expect(out.length).toBeLessThan(FILE.length);
  });

  it("handles a one-line block", () => {
    expect(redactSensitiveDefaults('variable "t" { default = "hunter2", sensitive = true }')).toBe('variable "t" { default = (sensitive), sensitive = true }');
    expect(redactSensitiveDefaults('variable "t" { sensitive = true, default = "hunter2" }')).toBe('variable "t" { sensitive = true, default = (sensitive) }');
  });

  it("redacts the source on every node and keeps nodes that have none", () => {
    const ir = {
      version: 1,
      nodes: [
        { id: "a", kind: "Terraform::Variable", attrs: { source: FILE } },
        { id: "b", kind: "Terraform::Resource", attrs: { source: FILE } },
        { id: "d", kind: "Terraform::Variable", attrs: { body: { default: { pass: "s3cret" }, sensitive: true }, source: FILE } },
        { id: "e", kind: "Terraform::Variable", attrs: { body: { default: "us-east-1" }, source: FILE } },
        { id: "c", kind: "Terraform::Resource", attrs: {} },
      ],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    redactSensitiveSources(ir);
    const json = JSON.stringify(ir);
    for (const secret of ["hunter2\\\"\\n  sensitive", "5432", "s3cret"]) expect(json).not.toContain(secret);
    expect((ir.nodes[2].attrs as { body: unknown }).body).toEqual({ default: "(sensitive)", sensitive: true });
    expect((ir.nodes[3].attrs as { body: unknown }).body).toEqual({ default: "us-east-1" });
    expect(JSON.stringify(ir.nodes[0])).toBe(JSON.stringify({ id: "a", kind: "Terraform::Variable", attrs: { source: out } }));
  });
});
