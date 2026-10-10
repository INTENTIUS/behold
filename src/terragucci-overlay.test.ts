import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blockPath, joinTerragucci, type CheckoutRoot } from "./terragucci-overlay.ts";
import { readTerragucci } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";

// #490. Provenance: the IR is /api/graph?detail=2 over a copy of terragucci's
// example (origin/main cb2381d2) served as `tg-example`, through
// @intentius/chant-lexicon-terraform 0.102.0, trimmed to id, kind and the
// attrs the join reads.
const HERE = import.meta.dirname;
const NODES = (JSON.parse(readFileSync(join(HERE, "__fixtures__", "terragucci-example-ir.json"), "utf8")) as { nodes: { id: string; attrs: Record<string, unknown> }[] }).nodes;
const BUCKET = join(HERE, "..", "example-terragucci-reports");
const ROOTS: CheckoutRoot[] = ["dev", "staging", "prod"].flatMap((e) =>
  ["platform", "email", "orders", "payments", "search"].map((s) => ({ member: "tg-example", name: `envs-${e}-${s}`, path: `envs/${e}/${s}` })),
);

describe("blockPath (#490)", () => {
  it.each([
    ["aws_s3_bucket.logs", "aws_s3_bucket.logs"],
    ["module.service.aws_sqs_queue.jobs", "module.service/aws_sqs_queue.jobs"],
    ["module.service.aws_dynamodb_table.records[0]", "module.service/aws_dynamodb_table.records"],
    ['module.svc["a.b"].module.inner.aws_iam_role.r["x"]', "module.svc/module.inner/aws_iam_role.r"],
    ["data.terraform_remote_state.platform", "data.terraform_remote_state.platform"],
    ["module.service.data.aws_iam_policy_document.p", "module.service/data.aws_iam_policy_document.p"],
  ])("%s is the card %s", (address, path) => {
    expect(blockPath(address)).toBe(path);
  });
});

describe("joinTerragucci over terragucci's example (#490)", () => {
  it("marks the cards the newest runs flag, dated, and nothing else", async () => {
    const read = await readTerragucci(terragucciSource(BUCKET), { roots: ROOTS.map((r) => r.path) });
    const m = joinTerragucci(read, NODES, ROOTS);
    expect(m.unmatched).toEqual({ roots: [], changes: [] });
    expect(Object.keys(m.cards).sort()).toEqual([
      "tg-example/envs-dev-orders/module.service/aws_sqs_queue.jobs",
      "tg-example/envs-prod-search/module.service/aws_dynamodb_table.records",
      "tg-example/envs-staging-email/module.service/aws_dynamodb_table.records",
      "tg-example/envs-staging-orders/module.service/aws_sqs_queue.jobs",
    ]);
    expect(m.cards["tg-example/envs-staging-orders/module.service/aws_sqs_queue.jobs"]).toEqual([
      {
        verdict: "drift",
        action: "delete",
        words: "deleted outside Terraform",
        addresses: ["module.service.aws_sqs_queue.jobs"],
        attributes: [],
        run: expect.objectContaining({ stage: "tf-drift", finished: "2026-10-08T06:04:12.000Z", job_url: "https://github.com/acme/shop/actions/runs/9102", report: expect.stringMatching(/tf-drift\/report\.html$/) }),
      },
    ]);
    expect(m.cards["tg-example/envs-prod-search/module.service/aws_dynamodb_table.records"]![0]).toMatchObject({ verdict: "plan", words: "would replace", addresses: ["module.service.aws_dynamodb_table.records[0]"], attributes: ["hash_key"], run: { pull_request: "11" } });
    // A waiting wave's change marks its card; an applied wave's does not.
    expect(m.cards["tg-example/envs-staging-email/module.service/aws_dynamodb_table.records"]![0]).toMatchObject({ verdict: "wave", words: "would destroy", run: { wave: 2 } });
  });

  it("never writes a status: the marks ride beside the graph, not in it", async () => {
    const read = await readTerragucci(terragucciSource(BUCKET), { roots: ROOTS.map((r) => r.path) });
    const before = JSON.stringify(NODES);
    joinTerragucci(read, NODES, ROOTS);
    expect(JSON.stringify(NODES)).toBe(before);
    expect(NODES.some((n) => "_status" in n.attrs)).toBe(false);
  });

  it("keeps 'no report' apart from 'no changes', and says what it could not place", async () => {
    const read = await readTerragucci(terragucciSource(BUCKET), { roots: ROOTS.map((r) => r.path) });
    const m = joinTerragucci(read, NODES, [...ROOTS, { member: "tg-example", name: "envs-qa-orders", path: "envs/qa/orders" }]);
    const qa = m.roots.find((r) => r.path === "envs/qa/orders")!;
    expect(qa.drift).toBeUndefined();
    const devEmail = m.roots.find((r) => r.path === "envs/dev/email")!;
    expect(devEmail.drift).toMatchObject({ status: "planned", changes: 0 });
    expect(devEmail.plan).toBeUndefined();
    // A report root the checkout does not declare is named, not dropped.
    const fewer = joinTerragucci(read, NODES, ROOTS.filter((r) => r.path !== "envs/prod/search"));
    expect(fewer.unmatched.roots).toEqual(["envs/prod/search"]);
  });
});
