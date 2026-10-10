/**
 * Writes example-terragucci-reports/: a reports bucket for terragucci's own
 * example estate (terragucci/example, 15 roots), laid out exactly as
 * terragucci writes one, because terragucci's own code writes it. Every
 * report.json, index.json and estate.json here comes out of terragucci's
 * buildReport, uploadReport (against a store that writes files) and
 * buildEstate. Nothing in this script shapes a document by hand; it only
 * supplies the plans, shaped like `tofu show -json`, for the tutorial's
 * scenarios:
 *
 * - tf-drift, yesterday 06:00: nothing drifted.
 * - tf-drift, today 06:00: staging orders' jobs queue was deleted outside
 *   Terraform (the `drift` scenario), and prod payments failed to plan.
 * - tf-plan on pull request #11, 08:00: prod search keys its records table by
 *   `sku`, which replaces the table (the `replace` scenario).
 * - tf-plan on pull request #12, 09:00: dev orders keeps unclaimed jobs for
 *   seven days (the `one-root` scenario).
 * - tf-apply of the merge of #10, staging email drops its records table (the
 *   `destroy` scenario): wave 1 (dev) applied at 09:30; wave 2 (staging)
 *   has waited for an approval since 09:31.
 *
 * Run it from behold's root, with terragucci's main checked out and
 * installed somewhere (its node_modules supplies chant and the lexicon its
 * report code imports):
 *
 *   TERRAGUCCI=/path/to/terragucci \
 *     /path/to/terragucci/node_modules/.bin/tsx scripts/terragucci-example-reports.ts
 *
 * The clock is fixed, so a rerun writes the same files.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TG = process.env.TERRAGUCCI;
if (!TG) throw new Error("set TERRAGUCCI to a checkout of terragucci's main, installed");
const OUT = resolve(process.argv[2] ?? "example-terragucci-reports");
const src = (rel: string) => import(pathToFileURL(join(TG, "packages/terragucci/src", rel)).href);

const { buildReport, planFiles } = await src("report/build.ts");
const { writeReportDir, uploadReport } = await src("report/store.ts");
const { driftPlan } = await src("report/drift.ts");
const { buildEstate, renderEstateHtml } = await src("report/estate.ts");

type Json = Record<string, unknown>;

const PROJECT = "github.com/acme/shop";
const ENVS = ["dev", "staging", "prod"];
const SERVICES = ["email", "orders", "payments", "search"];
const ROOTS = ENVS.flatMap((env) => [`envs/${env}/platform`, ...SERVICES.map((s) => `envs/${env}/${s}`)]);

/** One resource change as `tofu show -json` writes it. */
function rc(address: string, actions: string[], before: Json | null, after: Json | null, extra: Json = {}): Json {
  const bare = address.replace(/\[[^\]]*\]$/, "");
  const parts = bare.split(".");
  const name = parts.pop()!;
  const type = parts.pop()!;
  const index = /\[(\d+)\]$/.exec(address)?.[1];
  return {
    address,
    ...(parts.length ? { module_address: parts.join(".") } : {}),
    mode: "managed",
    type,
    name,
    ...(index !== undefined ? { index: Number(index) } : {}),
    provider_name: "registry.opentofu.org/hashicorp/aws",
    change: { actions, before, after, after_unknown: {}, before_sensitive: before ? {} : false, after_sensitive: after ? {} : false, ...extra },
  };
}

/** What a root holds, as no-op changes: what an unchanged plan lists. */
function holdings(root: string): Json[] {
  const [, env, svc] = root.split("/");
  if (svc === "platform") return [rc("aws_s3_bucket.logs", ["no-op"], { bucket: `shop-${env}-logs` }, { bucket: `shop-${env}-logs` })];
  const n = `shop-${env}-${svc}`;
  const out = [
    rc("module.service.aws_s3_bucket.files", ["no-op"], { bucket: `${n}-files` }, { bucket: `${n}-files` }),
    rc("module.service.aws_sqs_queue.jobs", ["no-op"], { name: `${n}-jobs`, message_retention_seconds: 345600 }, { name: `${n}-jobs`, message_retention_seconds: 345600 }),
    rc("module.service.aws_dynamodb_table.records[0]", ["no-op"], { name: `${n}-records`, hash_key: "id" }, { name: `${n}-records`, hash_key: "id" }),
    rc("module.service.aws_s3_object.registration", ["no-op"], { key: "registration.json" }, { key: "registration.json" }),
  ];
  if (env === "prod" && svc === "payments") out.push(rc("module.service.aws_sqs_queue.dead_letter[0]", ["no-op"], { name: `${n}-dead-letter` }, { name: `${n}-dead-letter` }));
  return out;
}

const plan = (changes: Json[], extra: Json = {}): Json => ({ format_version: "1.2", terraform_version: "1.13.1", resource_changes: changes, output_changes: {}, errored: false, ...extra });

/** A root's plan with `changed` in place of its no-op of the same address. */
function changedPlan(root: string, changed: Json[]): Json {
  const by = new Map(changed.map((c) => [c.address, c]));
  return plan(holdings(root).map((c) => by.get(c.address as string) ?? c));
}

const COMMITS = {
  old: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d",
  main: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f",
  pr11: "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  pr12: "c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1",
  merge10: "d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
};
const JOBS = "https://github.com/acme/shop/actions/runs";

interface Run {
  stage: "tf-plan" | "tf-drift" | "tf-apply";
  commit: string;
  started: string;
  finished: string;
  wave?: number;
  job: number;
  pull_request?: string;
  roots: { path: string; plan?: Json; error?: string; applied?: boolean }[];
  waves?: Json[];
}

const driftRoot = (path: string, drift: Json[] = []): Run["roots"][number] => ({ path, plan: driftPlan(plan([], { resource_drift: drift })) as Json });

const runs: Run[] = [
  {
    stage: "tf-drift",
    commit: COMMITS.old,
    started: "2026-10-07T06:00:00.000Z",
    finished: "2026-10-07T06:04:00.000Z",
    job: 9001,
    roots: ROOTS.map((p) => driftRoot(p)),
  },
  {
    stage: "tf-drift",
    commit: COMMITS.main,
    started: "2026-10-08T06:00:00.000Z",
    finished: "2026-10-08T06:04:12.000Z",
    job: 9102,
    roots: ROOTS.map((p) =>
      p === "envs/staging/orders"
        ? driftRoot(p, [rc("module.service.aws_sqs_queue.jobs", ["delete"], { name: "shop-staging-orders-jobs", message_retention_seconds: 345600 }, null)])
        : p === "envs/prod/payments"
          ? { path: p, error: "plan failed:\nError: reading SQS Queue (shop-prod-payments-dead-letter): AccessDenied: not authorized to perform sqs:GetQueueAttributes" }
          : driftRoot(p),
    ),
  },
  {
    stage: "tf-plan",
    commit: COMMITS.pr11,
    started: "2026-10-08T07:58:00.000Z",
    finished: "2026-10-08T08:00:30.000Z",
    job: 9110,
    pull_request: "11",
    roots: [
      {
        path: "envs/prod/search",
        plan: changedPlan("envs/prod/search", [
          rc(
            "module.service.aws_dynamodb_table.records[0]",
            ["delete", "create"],
            { name: "shop-prod-search-records", hash_key: "id" },
            { name: "shop-prod-search-records", hash_key: "sku" },
            { replace_paths: [["hash_key"]] },
          ),
        ]),
      },
    ],
  },
  {
    stage: "tf-plan",
    commit: COMMITS.pr12,
    started: "2026-10-08T08:58:00.000Z",
    finished: "2026-10-08T09:00:20.000Z",
    job: 9120,
    pull_request: "12",
    roots: [
      {
        path: "envs/dev/orders",
        plan: changedPlan("envs/dev/orders", [
          rc("module.service.aws_sqs_queue.jobs", ["update"], { name: "shop-dev-orders-jobs", message_retention_seconds: 345600 }, { name: "shop-dev-orders-jobs", message_retention_seconds: 604800 }),
        ]),
      },
    ],
  },
  {
    stage: "tf-apply",
    commit: COMMITS.merge10,
    wave: 1,
    started: "2026-10-08T09:25:00.000Z",
    finished: "2026-10-08T09:30:00.000Z",
    job: 9130,
    roots: ROOTS.filter((p) => p.startsWith("envs/dev/")).map((p) => ({ path: p, plan: plan(holdings(p)), applied: true })),
    waves: [{ number: 1, roots: ROOTS.filter((p) => p.startsWith("envs/dev/")), approval: "not-required", state: "applied" }],
  },
  {
    stage: "tf-apply",
    commit: COMMITS.merge10,
    wave: 2,
    started: "2026-10-08T09:30:30.000Z",
    finished: "2026-10-08T09:31:00.000Z",
    job: 9131,
    roots: ROOTS.filter((p) => p.startsWith("envs/staging/")).map((p) =>
      p === "envs/staging/email"
        ? { path: p, plan: changedPlan(p, [rc("module.service.aws_dynamodb_table.records[0]", ["delete"], { name: "shop-staging-email-records", hash_key: "id" }, null)]) }
        : { path: p, plan: plan(holdings(p)) },
    ),
    waves: [
      {
        number: 2,
        roots: ROOTS.filter((p) => p.startsWith("envs/staging/")),
        approval: "waiting",
        gate: { branch: "chant/lifecycle", path: "_gates/tf-apply.jsonl" },
        waitingSince: "2026-10-08T09:31:00.000Z",
        state: "waiting",
      },
    ],
  },
];

/** An object store that writes files under OUT, which is all uploadReport asks of one. */
const store = {
  location: "s3://acme-terragucci-reports",
  async put(key: string, body: string | Uint8Array): Promise<{ etag?: string }> {
    const file = join(OUT, key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
    return {};
  },
  async read(key: string): Promise<{ body?: string; etag?: string }> {
    try {
      return { body: readFileSync(join(OUT, key), "utf8") };
    } catch {
      return {};
    }
  },
  async get(key: string): Promise<string | undefined> {
    return (await this.read(key)).body;
  },
  async presign(key: string): Promise<{ url: string; expires: Date }> {
    return { url: key, expires: new Date(0) };
  },
};

rmSync(OUT, { recursive: true, force: true });
const work = join(OUT, ".work");
for (const r of runs) {
  const report = buildReport({
    run: {
      project: PROJECT,
      commit: r.commit,
      base: "main",
      stage: r.stage,
      ...(r.wave !== undefined ? { wave: r.wave } : {}),
      binary: "tofu",
      runtime: "forge",
      started: r.started,
      finished: r.finished,
      job_url: `${JOBS}/${r.job}`,
      terragucci: "0.4.4",
      commit_url: `https://github.com/acme/shop/commit/${r.commit}`,
      ...(r.pull_request ? { pull_request: r.pull_request, pull_request_url: `https://github.com/acme/shop/pull/${r.pull_request}` } : {}),
    },
    roots: r.roots.map((x) => ({ ...x, planner: "tofu", files: planFiles(x.path), job_url: `${JOBS}/${r.job}` })),
    ...(r.waves ? { waves: r.waves } : {}),
    tips: [],
  });
  const dir = join(work, `${r.stage}-${r.finished}`);
  writeReportDir(dir, report, new Map(r.roots.filter((x) => x.plan).map((x) => [x.path, { text: `(plan text for ${x.path})\n`, json: JSON.stringify(x.plan) }])));
  await uploadReport(store, dir, report, "", async () => {});
}
rmSync(work, { recursive: true, force: true });

// What `terragucci estate` writes at the top of the prefix, from the project's index.
const index = JSON.parse(readFileSync(join(OUT, PROJECT, "index.json"), "utf8"));
const page = buildEstate([{ project: PROJECT, reports: index.reports, base: `${PROJECT}/` }], new Date("2026-10-08T10:00:00.000Z"));
writeFileSync(join(OUT, "estate.json"), JSON.stringify(page, null, 2) + "\n");
writeFileSync(join(OUT, "estate.html"), renderEstateHtml(page));
process.stdout.write(`wrote ${OUT}\n`);
