import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTerragucci, terragucciValidator, TerragucciReadError, MAX_RUNS_PER_STAGE } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";

// #490: the bundled bucket was written by terragucci's own code for its own
// example estate (example-terragucci-reports/README.md says how).
const REPO = join(import.meta.dirname, "..");
const BUCKET = join(REPO, "example-terragucci-reports");
const SCHEMAS = join(import.meta.dirname, "__fixtures__", "terragucci-schemas");
const ROOTS = ["dev", "staging", "prod"].flatMap((e) => ["platform", "email", "orders", "payments", "search"].map((s) => `envs/${e}/${s}`));

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-tg-reports-"));
  made.push(d);
  return d;
};
/** A copy of the bucket to break. */
const copy = (): string => {
  const d = join(scratch(), "bucket");
  cpSync(BUCKET, d, { recursive: true });
  return d;
};
/** A directory with @intentius/terragucci installed, carrying the schemas 0.4.4 ships. */
function withTerragucci(): string {
  const d = scratch();
  const pkg = join(d, "node_modules", "@intentius", "terragucci");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/terragucci", version: "0.4.4", exports: { "./report.schema.json": "./dist/report.schema.json" } }));
  for (const f of ["report.schema.json", "report-index.schema.json", "estate.schema.json"]) cpSync(join(SCHEMAS, f), join(pkg, "dist", f));
  return d;
}
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TerragucciReadError) return e.refusal;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("readTerragucci over terragucci's example bucket (#490)", () => {
  it("takes each root's newest drift, plan and apply run, and terragucci's own waiting wave and counts", async () => {
    const r = await readTerragucci(terragucciSource(BUCKET), { roots: ROOTS, validator: terragucciValidator([withTerragucci()]) });
    expect(r.project).toBe("github.com/acme/shop");
    expect(r.validation).toEqual({ by: "schema", terragucci: "0.4.4" });

    // The newer of the two drift checks wins, for every root.
    const drift = r.roots["envs/staging/orders"]!.drift!;
    expect(drift.finished).toBe("2026-10-08T06:04:12.000Z");
    expect(drift.changes).toEqual([{ address: "module.service.aws_sqs_queue.jobs", action: "delete", type: "aws_sqs_queue", module: "module.service", attributes: [] }]);
    expect(r.roots["envs/prod/payments"]!.drift).toMatchObject({ status: "failed", error: expect.stringContaining("AccessDenied") });
    expect(r.roots["envs/dev/email"]!.drift!.changes).toEqual([]);

    // A plan holds only the roots its pull request changed.
    expect(r.roots["envs/dev/orders"]!.plan).toMatchObject({ pull_request: "12", changes: [{ action: "update", attributes: [{ path: "message_retention_seconds" }] }] });
    expect(r.roots["envs/prod/search"]!.plan).toMatchObject({ pull_request: "11", changes: [{ address: "module.service.aws_dynamodb_table.records[0]", action: "replace" }] });
    expect(r.roots["envs/prod/email"]!.plan).toBeUndefined();

    expect(r.roots["envs/staging/email"]!.apply).toMatchObject({ wave: 2, approval: "waiting" });
    expect(r.roots["envs/dev/email"]!.apply).toMatchObject({ wave: 1, approval: "not-required" });

    expect(r.waiting).toHaveLength(1);
    expect(r.waiting[0]).toMatchObject({
      wave: 2,
      from: "estate",
      since: "2026-10-08T09:31:00.000Z",
      destroys: ["envs/staging/email: module.service.aws_dynamodb_table.records[0] (delete)"],
    });
    expect(r.waiting[0]!.command).toBe(`npx terragucci approve wave-2 --plan ${r.waiting[0]!.set_digest}`);
    expect(r.estate).toEqual({ generated: "2026-10-08T10:00:00.000Z", html: "estate.html", drifted: 1, failed: 1, waiting: 1, status: "ok" });
    // One GET per run read. The older drift check is never opened: the newer
    // one holds every root. Both plans and both waves are, since prod's roots
    // have neither and the read looks a little further for them.
    expect(r.reports).toBe(5);
  });

  it("checks structurally when terragucci is not installed, and says so", async () => {
    const r = await readTerragucci(terragucciSource(BUCKET), { roots: ROOTS, validator: terragucciValidator([scratch()]) });
    expect(r.validation).toEqual({ by: "structural" });
  });

  it("reads a project directory too, and finds the waiting wave from the index without an estate.json", async () => {
    const r = await readTerragucci(terragucciSource(join(BUCKET, "github.com/acme/shop")), { roots: ROOTS });
    expect(r.estate).toBeUndefined();
    expect(r.waiting.map((w) => [w.wave, w.from])).toEqual([[2, "index"]]);
    expect(r.roots["envs/staging/orders"]!.drift!.report).toBe("2026/10/5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f/tf-drift/report.html");
  });

  it("reads through the operator's aws CLI for an s3:// source, one cp per object", async () => {
    const asked: string[] = [];
    const aws = async (args: string[]) => {
      asked.push(args[2]!);
      const key = args[2]!.replace("s3://acme-reports/shop/", "");
      try {
        return { code: 0, stdout: readFileSync(join(BUCKET, key), "utf8"), stderr: "" };
      } catch {
        return { code: 1, stdout: "", stderr: "An error occurred (404) when calling the HeadObject operation: Not Found" };
      }
    };
    const r = await readTerragucci(terragucciSource("s3://acme-reports/shop", { aws }), { roots: ROOTS });
    expect(r.source).toBe("s3://acme-reports/shop");
    expect(asked[0]).toBe("s3://acme-reports/shop/index.json");
    expect(asked).toContain("s3://acme-reports/shop/estate.json");
    expect(asked.every((a) => /\/(index|report|estate)\.json$/.test(a))).toBe(true);
  });

  it("refuses with the aws CLI's words when the bucket can't be read", async () => {
    const aws = async () => ({ code: 1, stdout: "", stderr: "An error occurred (AccessDenied) when calling the GetObject operation: Access Denied" });
    const r = await refusal(readTerragucci(terragucciSource("s3://acme-reports", { aws })));
    expect(r.code).toBe("terragucci-report");
    expect(r.error).toContain("AccessDenied");
    expect(r.remedy).toContain("GetObject");
  });

  it("refuses a directory with no index.json", async () => {
    const r = await refusal(readTerragucci(terragucciSource(scratch())));
    expect(r.error).toContain("has no index.json");
  });

  it("refuses an index written to another schema, by name", async () => {
    const d = copy();
    writeFileSync(join(d, "index.json"), JSON.stringify({ schema: "terragucci.report-index/v2", reports: [] }));
    const r = await refusal(readTerragucci(terragucciSource(d)));
    expect(r.error).toContain('its schema is "terragucci.report-index/v2", not terragucci.report-index/v1');
  });

  it("refuses a report the schema rejects, naming the schema and the field", async () => {
    const d = copy();
    const key = join(d, "github.com/acme/shop/2026/10/c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1/tf-plan/report.json");
    const doc = JSON.parse(readFileSync(key, "utf8"));
    doc.roots[0].status = "exploded";
    writeFileSync(key, JSON.stringify(doc));
    const schema = await refusal(readTerragucci(terragucciSource(d), { roots: ROOTS, validator: terragucciValidator([withTerragucci()]) }));
    expect(schema.error).toContain("report.schema.json rejects it: /roots/0/status");
    const plain = await refusal(readTerragucci(terragucciSource(d), { roots: ROOTS, validator: terragucciValidator([scratch()]) }));
    expect(plain.error).toContain("root 0 lacks path, status or changes");
    expect(plain.remedy).toContain("Install @intentius/terragucci");
  });

  it("asks which project when the index holds several and none is the checkout's", async () => {
    const d = copy();
    const index = JSON.parse(readFileSync(join(d, "index.json"), "utf8"));
    index.reports.push({ ...index.reports[0], project: "github.com/acme/other", path: "github.com/acme/other/x" });
    writeFileSync(join(d, "index.json"), JSON.stringify(index));
    const r = await refusal(readTerragucci(terragucciSource(d)));
    expect(r.remedy).toBe("Name one with --terragucci-project: github.com/acme/other, github.com/acme/shop.");
    const picked = await readTerragucci(terragucciSource(d), { checkoutProject: "github.com/acme/shop", roots: ROOTS });
    expect(picked.project).toBe("github.com/acme/shop");
  });

  it("stops looking for a root's newest plan after a bounded number of runs", async () => {
    const d = copy();
    const index = JSON.parse(readFileSync(join(d, "index.json"), "utf8"));
    const plan = index.reports.find((r: { stage: string }) => r.stage === "tf-plan");
    for (let i = 0; i < 40; i++) index.reports.push({ ...plan, finished: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`, path: `${plan.path}-old-${i}` });
    writeFileSync(join(d, "index.json"), JSON.stringify(index));
    const reads: string[] = [];
    const src = terragucciSource(d);
    const counting = { ...src, read: (k: string) => (reads.push(k), src.read(k)) };
    await readTerragucci(counting, { roots: ROOTS });
    expect(reads.filter((k) => k.includes("tf-plan")).length).toBe(MAX_RUNS_PER_STAGE);
  });
});

describe("an s3:// source in a job, with credentials in the environment (#491)", () => {
  it("signs its own GETs and needs no aws CLI", async () => {
    const asked: string[] = [];
    const fetchFn = async (url: string, init: { headers: Record<string, string> }) => {
      asked.push(url);
      expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
      const key = url.replace("http://floci:4566/acme-reports/shop/", "");
      try {
        return { ok: true, status: 200, text: async () => readFileSync(join(BUCKET, key), "utf8") };
      } catch {
        return { ok: false, status: 404, text: async () => "" };
      }
    };
    const env = { AWS_ACCESS_KEY_ID: "AKIATEST", AWS_SECRET_ACCESS_KEY: "s", AWS_ENDPOINT_URL: "http://floci:4566" };
    const r = await readTerragucci(terragucciSource("s3://acme-reports/shop", { env, fetch: fetchFn as never }), { roots: ROOTS });
    expect(r.project).toBe("github.com/acme/shop");
    expect(asked[0]).toBe("http://floci:4566/acme-reports/shop/index.json");
  });
});
