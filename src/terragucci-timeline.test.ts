import { describe, it, expect, vi, afterAll } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GraphIR } from "@intentius/chant";

// #506: the timeline lane from terragucci's audit record. Two records:
// - src/__fixtures__/terragucci-audit.jsonl, one entry of every kind in
//   terragucci.audit/v1 (and one of a second project), shaped field for field
//   on terragucci's report/audit.ts at b0b7e144;
// - example-terragucci-reports/audit.jsonl, what `terragucci audit` writes for
//   that bucket's two apply waves and the pending approval of wave 2.
// Both validate against the vendored audit.schema.json (asserted below).
// The estate read is mocked for the export, as in export-terragucci.test.ts:
// it needs chant's terraform lexicon, which CI does not have.
vi.mock("./estate.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./estate.ts")>()),
  composeEstate: vi.fn(),
}));
import { composeEstate } from "./estate.ts";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { runExport, captureKeys, VIEWS_REPORTS_BASE } from "./export.ts";
import { TerragucciReadError } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";
import {
  AUDIT_KINDS,
  auditValidator,
  compileAuditSchema,
  parseAudit,
  readTimeline,
  reportKey,
  structuralAudit,
  timelineAnswer,
  timelineEntries,
  type AuditEntry,
} from "./terragucci-timeline.ts";

const HERE = import.meta.dirname;
const BUCKET = join(HERE, "..", "example-terragucci-reports");
const KINDS = join(HERE, "__fixtures__", "terragucci-audit.jsonl");
const SCHEMA = join(HERE, "__fixtures__", "terragucci-schemas", "audit.schema.json");
const IR = (): GraphIR => ({ ...(JSON.parse(readFileSync(join(HERE, "__fixtures__", "terragucci-example-ir.json"), "utf8")) as GraphIR), edges: [], groups: {} });
const NETWORK = "github.com/acme/network";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-tg-timeline-"));
  made.push(d);
  return d;
};
/** A source directory holding `audit.jsonl` with `text`. */
const sourceWith = (text: string): string => {
  const d = scratch();
  writeFileSync(join(d, "audit.jsonl"), text);
  return d;
};
const schemaValidator = () => compileAuditSchema(JSON.parse(readFileSync(SCHEMA, "utf8")) as object, "0.4.7");
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TerragucciReadError) return e.refusal;
    throw e;
  }
  throw new Error("expected a refusal");
};

describe("the fixtures are terragucci.audit/v1", () => {
  it("every line of both records passes the schema terragucci ships", () => {
    const v = schemaValidator();
    for (const f of [KINDS, join(BUCKET, "audit.jsonl")]) {
      for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) expect(v.check(JSON.parse(line))).toBeUndefined();
    }
  });

  it("the kinds fixture holds every kind", () => {
    const kinds = new Set(parseAudit(readFileSync(KINDS, "utf8"), "x", schemaValidator()).map((e) => e.kind));
    expect([...kinds].sort()).toEqual([...AUDIT_KINDS].sort());
  });
});

describe("readTimeline (#506)", () => {
  it("reads every kind, newest first, each with its time, its run and its roots", async () => {
    const r = await readTimeline(terragucciSource(sourceWith(readFileSync(KINDS, "utf8"))), { project: NETWORK, validator: schemaValidator(), now: new Date("2026-10-10T00:00:00Z") });
    expect(r.present).toBe(true);
    expect(r.validation).toEqual({ by: "schema", terragucci: "0.4.7" });
    expect(r.projects).toEqual(["github.com/acme/network", "gitlab.example.com/platform/data"]);
    expect(r.lines).toBe(14);
    expect(r.entries).toHaveLength(13);
    const ats = r.entries.map((e) => e.at);
    expect(ats).toEqual([...ats].sort().reverse());
    const by = Object.fromEntries(r.entries.map((e) => [e.kind, e]));
    expect(Object.keys(by).sort()).toEqual([...AUDIT_KINDS].sort());

    // A report entry: its wave, its run's commit and job, its report as a key under the source.
    expect(by.apply).toMatchObject({
      at: "2026-10-08T09:20:03.000Z",
      who: "dana",
      wave: 2,
      result: "applied",
      roots: ["envs/prod/vpc", "envs/prod/dns"],
      run: { commit: "1111111111111111111111111111111111111111", job_url: `https://ci.example/${NETWORK}/runs/2`, report: `${NETWORK}/2026/10/1111111111111111111111111111111111111111/tf-apply-wave-2/report.html` },
    });
    // An approval names no root: it takes its gate's and digest's, and the report of that wave.
    expect(by.approval).toMatchObject({ who: "dana", wave: 2, roots: ["envs/prod/vpc", "envs/prod/dns"], run: { report: by.apply!.run.report } });
    expect(by["approval-requested"]!.run).toMatchObject({ run_id: "301", report: by.apply!.run.report });
    // A revocation of a gate the record has a refusal of takes that refusal's roots.
    expect(by["approval-revoked"]).toMatchObject({ who: "lee", roots: ["envs/prod/edge"] });
    expect(by.refused).toMatchObject({ result: "changed-after-approval", wave: 3, roots: ["envs/prod/edge"] });
    // A kind whose `what` is a root concerns that root, and no wave's report.
    expect(by.override).toMatchObject({ what: "envs/prod/vpc", roots: ["envs/prod/vpc"] });
    expect(by.override!.run.report).toBeUndefined();
    expect(by["override-requested"]!.roots).toEqual(["envs/prod/vpc"]);
    expect(by["override-revoked"]!.roots).toEqual(["envs/prod/dns"]);
    expect(by.unlock!.roots).toEqual(["envs/prod/vpc"]);
    expect(by["state-export"]!.roots).toEqual(["envs/prod/dns"]);
    // Roots listed as objects.
    expect(by.migration!.roots).toEqual(["envs/prod/dns"]);
    expect(by["ephemeral-apply"]).toMatchObject({ roots: ["envs/dev/vpc"], run: { pull_request: "14", run_id: "304" } });
    expect(by["ephemeral-destroy"]!.roots).toEqual(["envs/dev/vpc"]);
    // The entry's own fields ride along.
    expect(by.override!.detail).toMatchObject({ reason: "bastion subnet, reviewed in #88" });
    expect(by.override!.evidence).toMatchObject({ source: "ledger", path: "_gates/policy-override.jsonl" });
  });

  it("answers an absent audit.jsonl as an absent record, not as no events", async () => {
    const r = await readTimeline(terragucciSource(scratch()), { validator: schemaValidator() });
    expect(r).toMatchObject({ present: false, entries: [], lines: 0 });
    const a = timelineAnswer(r);
    expect(a.record).toEqual({ key: "audit.jsonl", present: false });
    expect(a.absent).toMatch(/has no audit\.jsonl: .*terragucci audit/);
    expect(a.entries).toEqual([]);
  });

  it("refuses a malformed line with code terragucci-report, naming the line", async () => {
    const good = readFileSync(KINDS, "utf8").split("\n")[0]!;
    const notJson = await refusal(readTimeline(terragucciSource(sourceWith(`${good}\n{not json\n`)), { validator: schemaValidator() }));
    expect(notJson).toMatchObject({ code: "terragucci-report", error: expect.stringContaining("line 2, is not JSON") });

    const noWho = JSON.parse(good) as Record<string, unknown>;
    delete noWho.who;
    const bySchema = await refusal(readTimeline(terragucciSource(sourceWith(`${good}\n${JSON.stringify(noWho)}\n`)), { validator: schemaValidator() }));
    expect(bySchema.code).toBe("terragucci-report");
    expect(bySchema.error).toContain("line 2");
    expect(bySchema.error).toContain("audit.schema.json rejects it");
    expect(bySchema.remedy).toContain("0.4.7");

    const v2 = await refusal(readTimeline(terragucciSource(sourceWith(JSON.stringify({ ...JSON.parse(good), schema: "terragucci.audit/v2" }))), { validator: auditValidator([]) }));
    expect(v2.error).toContain('its schema is "terragucci.audit/v2", not terragucci.audit/v1');
  });

  it("checks structurally without the package, and with its schema when it resolves", async () => {
    expect(auditValidator([scratch()]).validation).toEqual({ by: "structural" });
    const d = scratch();
    const pkg = join(d, "node_modules", "@intentius", "terragucci");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/terragucci", version: "0.4.7", exports: { "./report.schema.json": "./dist/report.schema.json" } }));
    writeFileSync(join(pkg, "dist", "report.schema.json"), "{}");
    // An older terragucci, without the audit schema: still structural.
    expect(auditValidator([d]).validation).toEqual({ by: "structural" });
    cpSync(SCHEMA, join(pkg, "dist", "audit.schema.json"));
    expect(auditValidator([d]).validation).toEqual({ by: "schema", terragucci: "0.4.7" });
    expect(structuralAudit({ ...JSON.parse(readFileSync(KINDS, "utf8").split("\n")[0]!), at: "yesterday" })).toContain("is not a time");
  });

  it("picks the only project, the named one, or the checkout's, and refuses to guess among several", async () => {
    const kinds = sourceWith(readFileSync(KINDS, "utf8"));
    const v = schemaValidator();
    expect((await readTimeline(terragucciSource(BUCKET), { validator: v })).project).toBe("github.com/acme/shop");
    expect((await readTimeline(terragucciSource(kinds), { validator: v, checkoutProject: NETWORK })).project).toBe(NETWORK);
    const other = await readTimeline(terragucciSource(kinds), { validator: v, project: "gitlab.example.com/platform/data" });
    expect(other.entries.map((e) => e.kind)).toEqual(["apply"]);
    expect(other.entries[0]).toMatchObject({ result: "failed", roots: ["warehouse"] });
    const r = await refusal(readTimeline(terragucciSource(kinds), { validator: v }));
    expect(r).toMatchObject({ code: "terragucci-report", remedy: expect.stringContaining("--terragucci-project") });
  });

  it("a report key under the source, whatever the bucket's prefix", () => {
    const e = { project: "github.com/acme/shop", evidence: { source: "report", key: "reports/github.com/acme/shop/2026/10/abc/tf-apply-wave-1/report.json" } } as AuditEntry;
    expect(reportKey(e)).toBe("github.com/acme/shop/2026/10/abc/tf-apply-wave-1/report.html");
    expect(reportKey({ ...e, evidence: { source: "report", key: "github.com/acme/shop/x/report.json" } })).toBe("github.com/acme/shop/x/report.html");
    expect(reportKey({ ...e, evidence: { source: "report", key: "elsewhere/x/report.json" } })).toBeUndefined();
    expect(reportKey({ ...e, evidence: { source: "ledger", key: "github.com/acme/shop/x/report.json" } })).toBeUndefined();
  });

  it("two entries at one instant keep the record's order, newest last written first", () => {
    const base = JSON.parse(readFileSync(KINDS, "utf8").split("\n")[0]!) as AuditEntry;
    const out = timelineEntries([{ ...base, id: "a" }, { ...base, id: "b" }], NETWORK);
    expect(out.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

function served(source: string) {
  const dir = scratch();
  writeFileSync(join(dir, "terragucci.yml"), "binary: tofu\n");
  mkdirSync(join(dir, ".git"));
  const broadcaster = new Broadcaster();
  return createApp({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source } }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
}

describe("GET /api/terragucci/timeline (#506)", () => {
  it("answers the project's entries, newest first, each linking its report through the file route", async () => {
    const app = served(BUCKET);
    const res = await app.request("/api/terragucci/timeline");
    expect(res.status).toBe(200);
    const j = (await res.json()) as ReturnType<typeof timelineAnswer>;
    expect(j).toMatchObject({ project: "github.com/acme/shop", record: { key: "audit.jsonl", present: true }, files: "/api/terragucci/file?key=", total: 3, limit: 200 });
    expect(j.absent).toBeUndefined();
    expect(j.entries.map((e) => [e.kind, e.what, e.result])).toEqual([
      ["apply", "wave-2", "waiting"],
      ["approval-requested", "wave-2", "waiting"],
      ["apply", "wave-1", "applied"],
    ]);
    // The report key opens through the file route.
    const file = await app.request(`/api/terragucci/file?key=${encodeURIComponent(j.entries[0]!.run.report!)}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toContain("<html");
  });

  it("filters to a root and bounds the answer", async () => {
    const app = served(BUCKET);
    const dev = (await (await app.request("/api/terragucci/timeline?root=envs/dev/orders")).json()) as ReturnType<typeof timelineAnswer>;
    expect(dev).toMatchObject({ root: "envs/dev/orders", total: 1 });
    expect(dev.entries.map((e) => e.what)).toEqual(["wave-1"]);
    const one = (await (await app.request("/api/terragucci/timeline?limit=1")).json()) as ReturnType<typeof timelineAnswer>;
    expect(one).toMatchObject({ total: 3, limit: 1 });
    expect(one.entries).toHaveLength(1);
    for (const bad of ["0", "-1", "1.5", "x", "1001"]) expect((await app.request(`/api/terragucci/timeline?limit=${bad}`)).status).toBe(400);
  });

  it("says the source has no audit record, with a 200", async () => {
    const res = await served(scratch()).request("/api/terragucci/timeline");
    expect(res.status).toBe(200);
    const j = (await res.json()) as ReturnType<typeof timelineAnswer>;
    expect(j.record.present).toBe(false);
    expect(j.absent).toContain("has no audit.jsonl");
  });

  it("refuses a malformed record with 422 terragucci-report", async () => {
    const res = await served(sourceWith("{nope\n")).request("/api/terragucci/timeline");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("terragucci-report");
  });

  it("adds no write route", () => {
    const app = served(BUCKET);
    expect(app.routes.filter((r) => r.path.startsWith("/api/terragucci") && r.method !== "GET").map((r) => r.path)).toEqual([]);
    expect(app.routes.some((r) => r.method === "GET" && r.path === "/api/terragucci/timeline")).toBe(true);
  });
});

describe("export carries the timeline (#506)", () => {
  it("captures it as one content-addressed snapshot, report keys relative to the bucket", { timeout: 60_000 }, async () => {
    expect(captureKeys({ environments: [], terragucci: true })).toContain("/api/terragucci/timeline");
    expect(captureKeys({ environments: [] })).not.toContain("/api/terragucci/timeline");
    vi.mocked(composeEstate).mockImplementation((async () => IR()) as never);
    const dir = join(scratch(), "tg-example");
    for (const env of ["dev", "staging"]) {
      mkdirSync(join(dir, "envs", env, "orders"), { recursive: true });
      writeFileSync(join(dir, "envs", env, "orders", "main.tf"), 'terraform {\n}\n\nresource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n');
    }
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "terragucci.yml"), "binary: tofu\n");
    const out = join(scratch(), "views", "behold");
    const w = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runExport({ projectDir: dir, projectDirs: [dir], port: 0, terragucci: { source: BUCKET } }, out);
    } finally {
      w.mockRestore();
    }
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { keyToFile: Record<string, string> };
    const file = manifest.keyToFile["/api/terragucci/timeline"]!;
    expect(file).toMatch(/^snapshots\/api_terragucci_timeline\.[0-9a-f]{16}\.json$/);
    const tl = JSON.parse(readFileSync(join(out, file), "utf8")) as ReturnType<typeof timelineAnswer>;
    expect(tl.files).toBe(VIEWS_REPORTS_BASE);
    expect(tl.entries).toHaveLength(3);
    expect(tl.entries[2]).toMatchObject({ at: "2026-10-08T09:30:00.000Z", run: { report: expect.stringMatching(/^github\.com\/acme\/shop\/.*\/tf-apply-wave-1\/report\.html$/) } });
    expect(tl.source).not.toContain(dirname(BUCKET));
  });
});
