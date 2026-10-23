/**
 * The plan read on a stock Terraform root against a real binary (#910).
 *
 * src/__fixtures__/terraform-plan-root uses only the built-in `terraform_data`
 * and a `local` backend, so `init` downloads nothing and no cloud or
 * credentials are involved. Each test copies it to a temp directory, runs
 * `init` and `apply` at generation 1 there (setup a person would have done;
 * behold itself never runs either), then writes a terraform.tfvars at
 * generation 2 with a new token and serves the copy.
 *
 * `terraform` reaches chant through a shim on PATH that records every argv it
 * is given and hands it to the real binary, so the test can see the exact
 * plan command chant ran. With BEHOLD_SHIM_FAIL_PLAN=1 the shim answers
 * `plan` as a provider with no credentials does, which is the fallback case.
 *
 * Gated three ways, each skipped with its reason: the terraform lexicon and
 * @cdktn/hcl2json (behold dependencies since #909, absent only from a pruned
 * install, required in CI's `peers` job), a chant at TERRAFORM_PLAN_CHANT_FLOOR or
 * newer (INTENTIUS/chant#4358), and `terraform` on PATH.
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import { TERRAFORM_PLAN_CHANT_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import { HCL_PARSER_PKG, TERRAFORM_LEXICON_PKG, resolvedVersion } from "./terraform-member.ts";
import { readTerraformPlan, type PlanCardFacts } from "./terraform-plan.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { resetMemberIrCache } from "./member-ir.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "terraform-plan-root");
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const peers = !!resolvedVersion(TERRAFORM_LEXICON_PKG) && !!resolvedVersion(HCL_PARSER_PKG);
const chantMeets = meetsFloor(resolvedVersion("@intentius/chant"), TERRAFORM_PLAN_CHANT_FLOOR) && meetsFloor(resolvedVersion(TERRAFORM_LEXICON_PKG), TERRAFORM_PLAN_CHANT_FLOOR);
const which = spawnSync("sh", ["-c", "command -v terraform"], { encoding: "utf8" });
const TERRAFORM = which.status === 0 ? which.stdout.trim() : undefined;
const skip = (!peers && !REQUIRE_PEERS) || !chantMeets || !TERRAFORM;
const why = `needs the terraform lexicon and @cdktn/hcl2json, chant ${TERRAFORM_PLAN_CHANT_FLOOR} (INTENTIUS/chant#4358) and terraform on PATH`;

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** An applied copy of the fixture at generation 1, planned at 2, and the shim beside it. */
function estate(): { dir: string; log: string; spawnEnv: Record<string, string> } {
  const tmp = mkdtempSync(join(tmpdir(), "behold-910-"));
  made.push(tmp);
  const dir = join(tmp, "estate");
  cpSync(FIXTURE, dir, { recursive: true });
  const run = (args: string[]) => {
    const r = spawnSync(TERRAFORM!, args, { cwd: dir, encoding: "utf8", env: { ...process.env, TF_IN_AUTOMATION: "1" } });
    if (r.status !== 0) throw new Error(`terraform ${args.join(" ")}: ${r.stderr}`);
  };
  run(["init", "-input=false"]);
  run(["apply", "-auto-approve", "-input=false", "-var", "token=s3cr3t-gen1"]);
  writeFileSync(join(dir, "terraform.tfvars"), 'generation = "2"\ntoken      = "s3cr3t-gen2"\n');
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const log = join(tmp, "argv.log");
  writeFileSync(
    join(bin, "terraform"),
    [
      "#!/bin/sh",
      `echo "$*" >> ${JSON.stringify(log)}`,
      'if [ "$1" = plan ] && [ "$BEHOLD_SHIM_FAIL_PLAN" = 1 ]; then',
      '  echo "Error: No valid credential sources found" >&2',
      "  exit 1",
      "fi",
      `exec ${JSON.stringify(TERRAFORM)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "terraform"), 0o755);
  return { dir, log, spawnEnv: { PATH: `${bin}:${process.env.PATH ?? ""}` } };
}

function served(dir: string, spawnEnv: Record<string, string>) {
  resetMemberIrCache();
  const broadcaster = new Broadcaster();
  return createApp(
    { projectDir: dir, projectDirs: [dir], port: 0, terraformPlan: { spawnEnv } },
    broadcaster,
    new FrameBuffer(),
    new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }),
  );
}

describe("the plan read on a stock root, real terraform (#910)", () => {
  it.skipIf(skip)(`reads the replace, its forcing attribute and its source, with -lock=false on the plan (${why})`, { timeout: 180_000 }, async () => {
    const { dir, log, spawnEnv } = estate();
    const res = await readTerraformPlan(dir, { spawnEnv });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.read.roots).toEqual([expect.objectContaining({ root: "estate", answered: "plan" })]);
    const replaced = res.read.cards["estate/terraform_data.replaced"]!;
    expect(replaced).toMatchObject({ source: "plan", action: "replace", replacePaths: ["triggers_replace"], forcedFrom: [{ path: "triggers_replace", from: "var.generation" }] });

    // The plan command chant ran, as terraform received it.
    const plans = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("plan "));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.split(" ")).toContain("-lock=false");
    expect(plans[0]!.split(" ")).toContain("-input=false");
    // The plan file is written under the OS temp directory, never in the root.
    expect(plans[0]).not.toContain(dir);
  });

  it.skipIf(skip)(`puts it on the card and in every response, with sensitive values as (sensitive) (${why})`, { timeout: 180_000 }, async () => {
    const { dir, spawnEnv } = estate();
    const app = served(dir, spawnEnv);
    const graphRes = await app.request("/api/graph?plan=1&alike=0");
    const graphText = await graphRes.text();
    expect(graphRes.status, graphText).toBe(200);
    const graph = JSON.parse(graphText) as { ir: GraphIR; svg: string; meta: { note?: string } };
    const card = graph.ir.nodes.find((n) => n.id.endsWith("/terraform_data.replaced"))!;
    expect((card.attrs._plan as PlanCardFacts).action).toBe("replace");
    // The card's painted rows.
    expect(graph.svg).toContain("forced by");
    expect(graph.svg).toContain("triggers_replace 1 -&gt; 2");
    expect(graph.svg).toContain("var.generation");
    expect(graph.meta.note).toContain("estate read from the plan");

    const planRes = await app.request("/api/terraform/plan");
    const planText = await planRes.text();
    expect(planRes.status).toBe(200);
    const plan = JSON.parse(planText) as { members: Array<{ cards: Record<string, PlanCardFacts> }> };
    const updated = Object.entries(plan.members[0]!.cards).find(([id]) => id.endsWith("/terraform_data.updated"))![1];
    expect(updated.changes).toContainEqual({ path: "input.token", before: "(sensitive)", after: "(sensitive)" });

    for (const text of [graphText, planText]) {
      expect(text).not.toContain("s3cr3t-gen1");
      expect(text).not.toContain("s3cr3t-gen2");
      expect(text).toContain("(sensitive)");
    }
  });

  it.skipIf(skip)(`a block added after the apply is a planned create, with a card of its own (chant#4372) (${why})`, { timeout: 180_000 }, async () => {
    const { dir, spawnEnv } = estate();
    // A resource the applied state has never seen, reading another block's
    // new id, so its own id and its input are unknown until apply.
    writeFileSync(join(dir, "created.tf"), 'resource "terraform_data" "created" {\n  input = terraform_data.replaced.id\n}\n');
    const res = await readTerraformPlan(dir, { spawnEnv });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const created = res.read.cards["estate/terraform_data.created"]!;
    expect(created).toMatchObject({ source: "plan", action: "create", actions: { "terraform_data.created": ["create"] } });
    expect(created.afterUnknown).toEqual(expect.arrayContaining(["id", "input"]));

    const app = served(dir, spawnEnv);
    const graph = (await (await app.request("/api/graph?plan=1&alike=0")).json()) as { ir: GraphIR; svg: string };
    const card = graph.ir.nodes.find((n) => n.id.endsWith("/terraform_data.created"))!;
    expect((card.attrs._plan as PlanCardFacts).action).toBe("create");
    // Still not deployed: the plan's facts never give it a physical id.
    expect(card.physicalId).toBeUndefined();
    expect(graph.svg).toContain("until apply");
  });

  it.skipIf(skip)(`without provider credentials falls back to the state read and says so, never "no changes" (${why})`, { timeout: 180_000 }, async () => {
    const { dir, spawnEnv } = estate();
    const app = served(dir, { ...spawnEnv, BEHOLD_SHIM_FAIL_PLAN: "1" });
    const graph = (await (await app.request("/api/graph?plan=1&alike=0")).json()) as { ir: GraphIR; svg: string; meta: { note?: string } };
    expect(graph.meta.note).toMatch(/estate plan not read, the state read answered \(the plan read failed \(no provider credentials/);
    const cards = graph.ir.nodes.filter((n) => n.attrs._plan);
    expect(cards.length).toBe(3);
    for (const n of cards) expect(n.attrs._plan).toMatchObject({ source: "state" });
    expect(graph.svg).toContain("not read");
    expect(graph.svg).toContain("state, no provider credentials");
    expect(graph.svg).not.toContain("no changes");

    const plan = (await (await app.request("/api/terraform/plan")).json()) as { members: Array<{ roots: Array<{ answered: string }> }> };
    expect(plan.members[0]!.roots).toEqual([expect.objectContaining({ answered: "state" })]);
  });
});
