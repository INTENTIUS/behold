import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS, jobImage, jobTools, orderTools, toolName, toolsOfImage, toolsOfLog } from "./tool-mark.js";

// behold#571: the tool each job runs, from its image, its log and the repo.
const run = JSON.parse(readFileSync(new URL("../src/__fixtures__/terragucci-demo/runs/448.json", import.meta.url), "utf8"));
const job = (lines) => ({ name: "apply-wave-1", steps: [{ name: "Set up job", log: lines }] });

describe("tool detection", () => {
  it("reads an image's name and tag", () => {
    expect(toolsOfImage("ghcr.io/intentius/terragucci-tofu:0.4.11-tofu1.13.1")).toEqual(["opentofu"]);
    expect(toolsOfImage("ghcr.io/intentius/terragucci-terraform:0.4.11")).toEqual(["terraform"]);
    expect(toolsOfImage("ghcr.io/intentius/terragucci-terragrunt:0.4.11-tofu1.13.1")).toEqual(["terragrunt", "opentofu"]);
    expect(toolsOfImage("ghcr.io/intentius/terragucci-choudoufu:0.28.0")).toEqual(["choudoufu"]);
    expect(toolsOfImage("ghcr.io/cloudposse/atmos:1.150.0")).toEqual(["atmos"]);
    expect(toolsOfImage("ghcr.io/acme/cdktn:0.21")).toEqual(["cdk-terrain"]);
    expect(toolsOfImage("ghcr.io/intentius/chant:0.124")).toEqual(["chant"]);
    expect(toolsOfImage("ghcr.io/intentius/sql-yodeler:0.9")).toEqual(["sql-yodeler"]);
    expect(toolsOfImage("docker.io/library/merchant:1")).toEqual([]);
    expect(toolsOfImage("node:20")).toEqual([]);
    expect(toolsOfImage(null)).toEqual([]);
  });

  it("finds the image in a real run's log", () => {
    const j = run.jobs.find((x) => x.steps.some((s) => s.log.length));
    expect(jobImage(j)).toBe("ghcr.io/intentius/terragucci-tofu:0.4.11-tofu1.13.1");
    expect(jobTools(j)).toEqual(["opentofu"]);
  });

  it("reads the commands a log runs", () => {
    expect(toolsOfLog(job(["[command]/usr/local/bin/atmos terraform plan vpc -s dev"]))).toEqual(["atmos"]);
    expect(toolsOfLog(job(["$ terragrunt run --all plan", "tofu plan -out=plan"]))).toEqual(["terragrunt", "opentofu"]);
    expect(toolsOfLog(job(["terraform init", "tofu init"]))).toEqual(["opentofu"]);
    expect(toolsOfLog(job(["echo terraforming"]))).toEqual([]);
    expect(toolsOfLog(job(["$ npx yodel apply prod"]))).toEqual(["sql-yodeler"]);
  });

  it("joins the image's engine with an orchestrator the log shows", () => {
    expect(jobTools(job(["image=ghcr.io/intentius/terragucci-tofu:1", "atmos terraform apply vpc -s dev", "terraform apply"]))).toEqual(["atmos", "opentofu"]);
  });

  it("gives a job whose log runs `yodel apply` the hat", () => {
    const j = job(["image=node:20", "> npx yodel apply prod --plan jcs1-sha256:abc"]);
    expect(jobTools(j)).toEqual(["sql-yodeler"]);
    expect(TOOLS[jobTools(j)[0]].icon.image).toBe("vendors/sql-yodeler-160.png");
  });

  it("gives the wave that applies a root carrying SQL Yodeler the hat beside its engine, on a successful run too (terragucci#1080)", () => {
    // A successful run's log has the apply summary only.
    const ok = job(["image=ghcr.io/intentius/terragucci-demo-tofu:local", "Apply complete! Resources: 1 added, 0 changed, 0 destroyed."]);
    expect(jobTools(ok, [], ["sql-yodeler"])).toEqual(["opentofu", "sql-yodeler"]);
    expect(jobTools({ name: "apply-wave-2" }, ["opentofu"], ["sql-yodeler"])).toEqual(["opentofu", "sql-yodeler"]);
    // A failed run's log shows the wave command.
    expect(toolsOfLog(job(["+ chant run wave --spec yodel-waves.json --wave 1"]))).toEqual(["sql-yodeler"]);
  });

  it("takes the repo's tools for a job whose log isn't read, and none for a log that names none", () => {
    expect(jobTools({ name: "apply-wave-1", status: "queued" }, ["opentofu", "terragrunt"])).toEqual(["terragrunt", "opentofu"]);
    expect(jobTools({ name: "plan-note", steps: [{ name: "x", log: [] }] }, ["opentofu"])).toEqual(["opentofu"]);
    expect(jobTools(job(["posting a comment"]), ["opentofu"])).toEqual([]);
  });

  it("knows nothing for an unknown tool", () => {
    expect(jobTools({ name: "x" })).toEqual([]);
    expect(orderTools(["pulumi", "opentofu"])).toEqual(["opentofu"]);
    expect(toolName("pulumi")).toBeNull();
  });
});

describe("the marks", () => {
  it("name every tool as its owner writes it", () => {
    expect(Object.values(TOOLS).map((t) => t.name)).toEqual(["Terragrunt", "CDK Terrain", "Atmos", "chant", "OpenTofu", "Terraform", "choudoufu", "SQL Yodeler"]);
  });

  it("draw Terraform by its name alone, and the rest with their own inline logo", () => {
    expect(TOOLS.terraform.icon).toBeNull();
    for (const [id, t] of Object.entries(TOOLS)) {
      if (id === "terraform") continue;
      expect(t.icon).toBeTruthy();
      // Inline geometry, or the PNG behold ships; never an external URL.
      expect(JSON.stringify(t.icon)).not.toMatch(/https?:/);
    }
    expect(TOOLS.choudoufu.icon.image).toBe("vendors/choudoufu.svg");
  });
});
