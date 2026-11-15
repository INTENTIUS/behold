import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGraph } from "./read-graph.ts";
import { HCL_PARSER_PKG, resolvedVersion, TERRAFORM_LEXICON_PKG } from "./terraform-member.ts";
import { servedWorkspace } from "./workspace.ts";

// behold#1057: `readGraph` keeps no state of its own and reads no served
// workspace, so one process can read two directories and get each one's own
// graph back. Through the real chant and the terraform lexicon, as the
// snapshot test beside it does.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const ESTATE = join(REPO, "example-terraform-estate");
const REQUIRE_PEERS = process.env.BEHOLD_REQUIRE_PEERS === "1";
const gate = !(resolvedVersion(TERRAFORM_LEXICON_PKG) && resolvedVersion(HCL_PARSER_PKG)) && !REQUIRE_PEERS;

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A one-root Terraform folder declaring one resource of `type` named `name`. */
function folder(name: string, type: string): string {
  const parent = mkdtempSync(join(tmpdir(), "behold-1057-"));
  made.push(parent);
  const dir = join(parent, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "main.tf"), `provider "aws" {\n  region = "us-east-1"\n}\n\nresource "${type}" "${name}" {\n}\n`);
  return dir;
}

describe("readGraph in one process (#1057)", () => {
  it.skipIf(gate)("two folders read at once each answer their own graph", { timeout: 180_000 }, async () => {
    const alpha = folder("alpha", "aws_s3_bucket");
    const beta = folder("beta", "aws_sqs_queue");
    const [a, b] = await Promise.all([readGraph(alpha), readGraph(beta)]);
    // A bare folder is a one-member estate of one root, both named for the folder: `<member>/<root>/<address>`.
    expect(a.members.map((m) => [m.name, m.kind])).toEqual([["alpha", "terraform"]]);
    expect(b.members.map((m) => [m.name, m.kind])).toEqual([["beta", "terraform"]]);
    expect(a.ir.nodes.map((n) => n.id)).toEqual(["alpha/alpha/aws_s3_bucket.alpha"]);
    expect(b.ir.nodes.map((n) => n.id)).toEqual(["beta/beta/aws_sqs_queue.beta"]);
    expect(a.meta).toMatchObject({ estate: 1, note: expect.stringContaining("1 root — alpha") });
    expect(b.meta).toMatchObject({ estate: 1, note: expect.stringContaining("1 root — beta") });
  });

  it.skipIf(gate)("a declared workspace and a loose folder, one after the other, keep their own members", { timeout: 240_000 }, async () => {
    const declared = await readGraph(ESTATE);
    const loose = await readGraph(folder("gamma", "aws_sns_topic"));
    const again = await readGraph(ESTATE);
    // The declaration names the members, and the ids are composed under those names.
    expect(declared.members.map((m) => m.name)).toEqual(["prod", "platform"]);
    expect(declared.ir.nodes.every((n) => n.id.startsWith("prod/") || n.id.startsWith("platform/"))).toBe(true);
    expect(loose.members.map((m) => m.name)).toEqual(["gamma"]);
    expect(loose.ir.nodes.map((n) => n.id)).toEqual(["gamma/gamma/aws_sns_topic.gamma"]);
    // Reading the folder changed nothing about the next read of the workspace.
    expect(again.ir).toEqual(declared.ir);
    // And nothing was served: the workspace was an argument, not a process global.
    expect(servedWorkspace()).toBeUndefined();
  });

  it.skipIf(gate)("scripts/read-graph.ts prints a folder's node count with no server started", { timeout: 120_000 }, () => {
    const run = spawnSync(join(REPO, "node_modules", ".bin", "tsx"), [join(REPO, "scripts", "read-graph.ts"), folder("delta", "aws_s3_bucket")], { cwd: REPO, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe("1 node\n");
  });
});
