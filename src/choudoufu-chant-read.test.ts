import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import { paintPlanDrift } from "./choudoufu-live.ts";
import {
  choudoufuChantArgs,
  choudoufuChantUnavailable,
  livePlanDocumentFile,
  planDriftFromIr,
  readChoudoufuThroughChant,
  rootAnswerOf,
  type ChoudoufuChantDeps,
} from "./choudoufu-chant-read.ts";

// Fixture provenance (#924). Recorded on 2026-10-23 from behold's workbench
// entry `choudoufu-cohort-iam-ecr` (6 resources, a sidecar-declared estate,
// the floci `behold-wb-choudoufu-cohort-iam-ecr` on 127.0.0.1:4653), served
// into a target named `beh924`, so the reader project's one root is `beh924`.
// choudoufu v0.16.0, and chant 0.124.46 packed from chant's
// epic/908-ask-your-agent at f68ed3d0e (#4371 the plan depth on a live root,
// #4379 nothing written in the root, #4383 the document handed back). Each
// case is one read in the member's generated `chdf` reader project:
//
//     CHANT_TERRAFORM_OBSERVE=plan CHANT_TERRAFORM_LIVE_PLAN_DIR=<tmp> \
//       chant graph . --live --overlay --env behold-plan --format ir --detail 3
//
// `.ir.json` is its stdout, `.stderr.txt` its `terraform.roots` notes, and
// `.live-plan.json` the document it handed back. Nothing hand-edited. The
// three are the cases #404 recorded through behold's own plan read:
//
//  1. clean: the estate as applied. Every block `no-op`.
//  2. drift: two attributes changed out of band, one a map and one a scalar:
//       aws iam tag-role --role-name tofu-iam-ecr-cohort-iam-role \
//         --tags Key=drifted,Value=out-of-band
//       aws ecr put-image-tag-mutability \
//         --repository-name tofu-iam-ecr-cohort-ecr-repository \
//         --image-tag-mutability IMMUTABLE
//  3. create: on top of 2, the group deleted out of band
//     (`aws iam delete-group --group-name tofu-iam-ecr-cohort-iam-group`), so
//     the plan proposes `create` for `aws_iam_group.app`, which is not
//     attribute drift (#404).
//
// The target was hashed file by file before and after each read; it was
// unchanged.
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = (name: string): string => readFileSync(join(HERE, "__fixtures__", name), "utf8");
const ROOT = "beh924";
type Case = "clean" | "drift" | "create";
const ir = (c: Case): GraphIR => JSON.parse(raw(`choudoufu-chant-iam-ecr-${c}.ir.json`)) as GraphIR;

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A served member on disk, named as the recording's root. */
function member(): string {
  const parent = mkdtempSync(join(tmpdir(), "behold-924-"));
  made.push(parent);
  const dir = join(parent, ROOT);
  mkdirSync(join(dir, ".tofu-records"), { recursive: true });
  writeFileSync(join(dir, "estate.chdf.hcl"), 'estate = "iam-ecr-cohort"\n');
  writeFileSync(join(dir, "iam-ecr.tf"), 'resource "aws_iam_group" "app" {\n  name = "x"\n}\n');
  return dir;
}

/**
 * behold#995: which reads answered is the IR's `rootReads` (chant#4452). The
 * recordings were printed before chant carried the field, so the root's
 * report is put on the recorded IR here, as chant now writes it: `live+plan`
 * when both reads answered, and the given report otherwise.
 */
const BOTH = { depth: "live+plan" };
const withRootRead = (text: string, rootRead: Record<string, unknown> | null): string => {
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (rootRead) doc.rootReads = { [`terraform.roots.${ROOT}`]: rootRead };
  return JSON.stringify(doc);
};

/** chant, answered from a recording: the document handed to the directory the
 * variable names, the IR on stdout (with its root's report), the notes on stderr. */
function recorded(c: Case, seen: Array<{ args: string[]; project: string; env: Record<string, string> }> = [], over: Partial<{ code: number; stderr: string; hand: boolean; rootRead: Record<string, unknown> | null }> = {}): ChoudoufuChantDeps {
  return {
    chantVersion: () => "0.124.46",
    lexiconVersion: () => "0.124.46",
    readerAbsent: () => undefined,
    run: async (args, project, env) => {
      seen.push({ args, project, env });
      if (over.hand !== false) writeFileSync(join(env.CHANT_TERRAFORM_LIVE_PLAN_DIR!, livePlanDocumentFile(ROOT)), raw(`choudoufu-chant-iam-ecr-${c}.live-plan.json`));
      const rootRead = over.rootRead === undefined ? BOTH : over.rootRead;
      return { code: over.code ?? 0, stdout: withRootRead(raw(`choudoufu-chant-iam-ecr-${c}.ir.json`), rootRead), stderr: over.stderr ?? raw(`choudoufu-chant-iam-ecr-${c}.stderr.txt`) };
    },
  };
}

/** Every file under `dir` with its size and mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = `${statSync(p).size}:${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

describe("the three recorded IAM/ECR cases, read through chant (#924)", () => {
  it("clean: nothing would change", async () => {
    const r = await readChoudoufuThroughChant(member(), recorded("clean"));
    expect(r.answered).toBe("live+plan");
    expect(r.drift.size).toBe(0);
    expect(r.plan.estate).toBe("iam-ecr-cohort");
    expect(r.plan.bound).toHaveLength(6);
  });

  it("drift: the map and the scalar changed out of band, live value before, declared value after", async () => {
    const r = await readChoudoufuThroughChant(member(), recorded("drift"));
    expect([...r.drift.keys()].sort()).toEqual(["aws_ecr_repository.app", "aws_iam_role.iam-ecr"]);
    expect(r.drift.get("aws_ecr_repository.app")).toEqual({
      address: "aws_ecr_repository.app",
      actions: ["update"],
      changes: [{ path: "image_tag_mutability", oldValue: "IMMUTABLE", newValue: "MUTABLE" }],
    });
    // The out-of-band tag, on both twins. The estate's two ownership markers
    // are on both sides, so they are not a change.
    expect(r.drift.get("aws_iam_role.iam-ecr")).toEqual({
      address: "aws_iam_role.iam-ecr",
      actions: ["update"],
      changes: [
        { path: "tags.drifted", oldValue: "out-of-band", newValue: null },
        { path: "tags_all.drifted", oldValue: "out-of-band", newValue: null },
      ],
    });
  });

  it("create: a deleted resource's planned create is not attribute drift, and the drift beside it still reads", async () => {
    const r = await readChoudoufuThroughChant(member(), recorded("create"));
    expect(r.drift.has("aws_iam_group.app")).toBe(false);
    expect([...r.drift.keys()].sort()).toEqual(["aws_ecr_repository.app", "aws_iam_role.iam-ecr"]);
    // Ownership says why: live-plan omits the group as ABSENT, which the
    // overlay paints pending, from the document chant handed back.
    expect(r.plan.omissions?.find((o) => o.addr === "aws_iam_group.app")?.reason).toBe("ABSENT");
  });

  it("the card names the attributes, once each, and only on a bound card", () => {
    const drift = planDriftFromIr(ir("drift"), ROOT);
    const graph = {
      nodes: [
        { id: "m/aws_iam_role.iam-ecr", kind: "aws_iam_role", lexicon: "choudoufu", attrs: { _status: "good" } },
        { id: "m/aws_ecr_repository.app", kind: "aws_ecr_repository", lexicon: "choudoufu", attrs: { _status: "warn" } },
      ],
      edges: [],
    } as unknown as GraphIR;
    expect(paintPlanDrift(graph, drift, "m")).toBe(1);
    expect(graph.nodes[0]!.attrs._planDrift).toEqual({ actions: ["update"], attributes: ["tags", "tags_all"] });
    expect(graph.nodes[1]!.attrs._planDrift).toBeUndefined();
  });
});

describe("the read (#924)", () => {
  it("is one chant read at the plan depth, handing its live-plan document to a directory behold made and removes", async () => {
    const seen: Array<{ args: string[]; project: string; env: Record<string, string> }> = [];
    await readChoudoufuThroughChant(member(), recorded("drift", seen));
    expect(seen).toHaveLength(1);
    const [read] = seen;
    expect(read!.args).toEqual(choudoufuChantArgs());
    expect(read!.env.CHANT_TERRAFORM_OBSERVE).toBe("plan");
    expect(read!.env.CHANT_TERRAFORM_LIVE_PLAN_DIR).toContain("behold-choudoufu-live-plan-");
    expect(existsSync(read!.env.CHANT_TERRAFORM_LIVE_PLAN_DIR!)).toBe(false);
    // The reader project is the member's `chdf` one: choudoufu, one root.
    const config = readFileSync(join(read!.project, "chant.config.ts"), "utf8");
    expect(config).toContain('binary: "choudoufu"');
    expect(config).toContain(`"${ROOT}": { dir: "estate" }`);
  });

  it("leaves the served folder unchanged", async () => {
    const dir = member();
    const before = snapshot(dir);
    await readChoudoufuThroughChant(dir, recorded("drift"));
    expect(snapshot(dir)).toEqual(before);
  });

  it("a failed plan read is live-plan alone: ownership from the document, no drift, and why", async () => {
    const stderr =
      "warning: [terraform] terraform.roots.beh924: the plan read failed (no provider credentials: choudoufu plan failed), so `live-plan -json` alone answered; plan attributes are absent\n";
    const r = await readChoudoufuThroughChant(member(), recorded("drift", [], { stderr, rootRead: { depth: "live+plan", fellBackTo: "live", reason: "no-credentials" } }));
    expect(r.answered).toBe("live");
    expect(r.drift.size).toBe(0);
    expect(r.note).toMatch(/the live\+plan read failed \(no-credentials\)/);
    expect(r.plan.bound).toHaveLength(6);
  });

  it("no live-plan document means no live-plan answered: the member is not observed, and chant's note says why", async () => {
    const stderr = "warning: [terraform] terraform.roots.beh924: no read answered (`live-plan -json` failed, so the plan read was not tried)\n";
    await expect(readChoudoufuThroughChant(member(), recorded("drift", [], { stderr, hand: false, rootRead: null }))).rejects.toThrow(/handed back no live-plan document/);
  });

  it("reads which reads answered off the IR's rootReads, never chant's note (behold#995)", () => {
    expect(rootAnswerOf({ rootReads: { [`terraform.roots.${ROOT}`]: BOTH } }, ROOT).answered).toBe("live+plan");
    expect(rootAnswerOf({ rootReads: { [`terraform.roots.${ROOT}`]: { depth: "live+plan", fellBackTo: "live", reason: "plan-failed" } } }, ROOT).answered).toBe("live");
    // A note that says the plan answered is not read: with no rootReads, live-plan alone answered.
    expect(rootAnswerOf(JSON.parse(raw("choudoufu-chant-iam-ecr-drift.ir.json")), ROOT).answered).toBe("live");
    expect(rootAnswerOf(undefined, ROOT).answered).toBe("live");
  });

  it("a replace counts, a delete and a no-op do not, and each instance of a counted block reads alone", () => {
    const drift = planDriftFromIr(
      {
        nodes: [
          {
            id: "r/aws_eip.pool",
            kind: "Terraform::Resource",
            lexicon: "terraform",
            attrs: {
              planAction: "no-op,replace",
              planActions: { "aws_eip.pool[0]": ["no-op"], "aws_eip.pool[1]": ["delete", "create"] },
              planChanges: [{ path: "domain", before: "standard", after: "vpc", instance: "aws_eip.pool[1]" }],
            },
          },
          { id: "r/aws_s3_bucket.gone", kind: "Terraform::Resource", lexicon: "terraform", attrs: { planAction: "delete", planActions: { "aws_s3_bucket.gone": ["delete"] }, planChanges: [{ path: "bucket", before: "b", after: null }] } },
          { id: "r/module.net/aws_vpc.main", kind: "Terraform::Resource", lexicon: "terraform", attrs: { planAction: "update", planActions: { "module.net.aws_vpc.main": ["update"] }, planChanges: [{ path: "cidr_block", before: "a", after: "b", instance: "module.net.aws_vpc.main" }] } },
        ],
      },
      "r",
    );
    expect([...drift.keys()].sort()).toEqual(["aws_eip.pool[1]", "module.net.aws_vpc.main"]);
    expect(drift.get("aws_eip.pool[1]")!.changes).toEqual([{ path: "domain", oldValue: "standard", newValue: "vpc" }]);
  });
});

describe("the floor (#924)", () => {
  it("reads through chant only at or above 0.124.46, and says which piece is short", async () => {
    const at = { readerAbsent: () => undefined, chantVersion: () => "0.124.46", lexiconVersion: () => "0.124.46" };
    expect(await choudoufuChantUnavailable(at)).toBeUndefined();
    expect(await choudoufuChantUnavailable({ ...at, chantVersion: () => "0.124.45" })).toMatch(/needs chant 0\.124\.46 or newer; behold has 0\.124\.45/);
    expect(await choudoufuChantUnavailable({ ...at, lexiconVersion: () => "0.124.38" })).toMatch(/chant-lexicon-terraform 0\.124\.46 or newer; behold has 0\.124\.38/);
    expect(await choudoufuChantUnavailable({ ...at, readerAbsent: () => "the terraform lexicon is not installed" })).toMatch(/not installed/);
    expect(await choudoufuChantUnavailable(null)).toMatch(/no chant/);
  });
});
