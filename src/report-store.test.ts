/**
 * behold#1228: every product's reports in chant's format, and history in the
 * formats the products wrote before.
 *
 * The old-format fixtures are terragucci's (example-terragucci-reports/, the
 * control repo's run views in __fixtures__/terragucci-control/, and
 * __fixtures__/terragucci-audit.jsonl) and sql-yodeler's
 * (__fixtures__/sql-yodeler-audit.jsonl). Each is turned into chant's format
 * with chant's own `neutralReport` and `readAuditLine`, the way a product that
 * moved to chant writes it, and behold must read the old files, the new ones
 * and a bucket holding both the same. The plywood bucket in
 * __fixtures__/plywood-reports/ was written by chant's estate and audit code.
 */
import { afterAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { neutralReport, readAuditLine } from "@intentius/chant/report-store";
import { checkAuditLine, checkStoreDoc, productView, storeProduct } from "./report-store.ts";
import { readTerragucci, terragucciValidator, TerragucciReadError } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";
import { readControlEstate, runViewValidator, structuralRun as estateRunCheck } from "./terragucci-estate.ts";
import { structuralRun as progressRunCheck } from "./terragucci-progress.ts";
import { auditValidator, parseAudit, readTimeline } from "./terragucci-timeline.ts";
import { doraFromFile } from "./prometheus-metrics.ts";

const HERE = import.meta.dirname;
const TG_BUCKET = join(HERE, "..", "example-terragucci-reports");
const TG_CONTROL = join(HERE, "__fixtures__", "terragucci-control");
const TG_AUDIT = join(HERE, "__fixtures__", "terragucci-audit.jsonl");
const TG_SCHEMAS = join(HERE, "__fixtures__", "terragucci-schemas");
const YODEL_AUDIT = join(HERE, "__fixtures__", "sql-yodeler-audit.jsonl");
const PLYWOOD = join(HERE, "__fixtures__", "plywood-reports");
const ROOTS = ["dev", "staging", "prod"].flatMap((e) => ["platform", "email", "orders", "payments", "search"].map((s) => `envs/${e}/${s}`));
const NOW = new Date("2026-11-20T12:00:00.000Z");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-report-store-"));
  made.push(d);
  return d;
};
/** A directory with @intentius/terragucci installed, carrying the schemas behold's fixtures copy. */
function withTerragucci(): string {
  const d = scratch();
  const pkg = join(d, "node_modules", "@intentius", "terragucci");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/terragucci", version: "0.4.9", exports: { "./report.schema.json": "./dist/report.schema.json" } }));
  for (const f of readdirSync(TG_SCHEMAS).filter((f) => f.endsWith(".schema.json"))) cpSync(join(TG_SCHEMAS, f), join(pkg, "dist", f));
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

/** Every file under `dir`, relative. */
function files(dir: string, at = ""): string[] {
  return readdirSync(join(dir, at)).flatMap((n) => (statSync(join(dir, at, n)).isDirectory() ? files(dir, join(at, n)) : [join(at, n)]));
}

/** `src` copied, with each terragucci document whose name `pick` takes rewritten in chant's format. */
function inChantFormat(src: string, pick: (file: string) => boolean = () => true): string {
  const d = join(scratch(), "bucket");
  cpSync(src, d, { recursive: true });
  for (const f of files(d)) {
    if (!pick(f)) continue;
    const at = join(d, f);
    if (f.endsWith("audit.jsonl")) {
      const lines = readFileSync(at, "utf8").split("\n").filter((l) => l.trim());
      writeFileSync(at, lines.map((l) => JSON.stringify(readAuditLine(JSON.parse(l)))).join("\n") + "\n");
      continue;
    }
    if (!f.endsWith(".json")) continue;
    const doc = JSON.parse(readFileSync(at, "utf8")) as { schema?: string };
    const kind = doc.schema === "terragucci.estate/v1" ? "estate" : doc.schema === "terragucci.report/v1" || doc.schema === "terragucci.run/v1" ? "run" : doc.schema === "terragucci.dora/v1" ? "dora" : undefined;
    if (kind) writeFileSync(at, JSON.stringify(neutralReport(doc as { schema: string }, kind, "terragucci")));
  }
  return d;
}

describe("chant's report-store schemas (behold#1228)", () => {
  it("checks a document by its kind, under the neutral id or a product's", () => {
    const estate = JSON.parse(readFileSync(join(PLYWOOD, "estate", "estate.json"), "utf8"));
    expect(estate).toMatchObject({ schema: "chant.estate/v1", product: "plywood" });
    expect(checkStoreDoc("estate", estate)).toBeUndefined();
    expect(checkStoreDoc("dora", JSON.parse(readFileSync(join(PLYWOOD, "estate", "dora.json"), "utf8")))).toBeUndefined();
    expect(checkStoreDoc("estate", JSON.parse(readFileSync(join(TG_BUCKET, "estate.json"), "utf8")))).toBeUndefined();
    expect(checkStoreDoc("run", estate)).toMatch(/^its schema is "chant.estate\/v1", not chant.run\/v1/);
    const { product: _, ...anon } = estate;
    expect(checkStoreDoc("estate", anon)).toMatch(/rejects it: \/ must have required property 'product'/);
    expect(storeProduct(estate)).toBe("plywood");
    expect(storeProduct({ schema: "terragucci.report/v1" })).toBe("terragucci");
  });

  it("gives a neutral document back in its product's words, and refuses another product's", () => {
    const doc = JSON.parse(readFileSync(join(TG_BUCKET, "estate.json"), "utf8"));
    const neutral = neutralReport(doc, "estate", "terragucci");
    expect(productView(neutral, "terragucci.estate/v1")).toEqual({ doc, neutral: true });
    expect(productView(doc, "terragucci.estate/v1")).toEqual({ doc, neutral: false });
    expect(productView(neutralReport(doc, "estate", "plywood"), "terragucci.estate/v1").problem).toBe('it is chant.estate/v1 from "plywood", not from terragucci');
  });

  it("reads an audit line in any format chant reads, and refuses the rest", () => {
    const tg = JSON.parse(readFileSync(TG_AUDIT, "utf8").split("\n")[0]!);
    expect(checkAuditLine(tg).line).toMatchObject({ schema: "chant.audit/v1", product: "terragucci" });
    const yo = JSON.parse(readFileSync(YODEL_AUDIT, "utf8").split("\n")[0]!);
    expect(checkAuditLine(yo, { project: "shop" }).line).toMatchObject({ product: "sql-yodeler", project: "shop", environment: "dev", kind: "approval-requested" });
    expect(checkAuditLine({ schema: "chant.audit/v1", id: "x" }).problem).toMatch(/lacks an id, a kind chant names/);
    expect(checkAuditLine({ schema: "other/v1" }).problem).toBe('its schema is "other/v1", not an audit id');
  });
});

describe("history in the old formats stays readable after a product switches (behold#1228)", () => {
  for (const [name, validator] of [
    ["terragucci's schemas", () => terragucciValidator([withTerragucci()])],
    ["the structural check", () => terragucciValidator([scratch()])],
  ] as const) {
    it(`terragucci's bucket reads the same in its own format, in chant's, and mixed, by ${name}`, async () => {
      const read = (dir: string) => readTerragucci(terragucciSource(dir), { roots: ROOTS, validator: validator(), now: NOW });
      const old = await read(TG_BUCKET);
      const strip = (r: Awaited<typeof old>) => ({ ...r, source: "" });
      expect(old.waiting.length).toBeGreaterThan(0);
      expect(strip(await read(inChantFormat(TG_BUCKET)))).toEqual(strip(old));
      // Written before and after the switch: the estate and the newer runs in chant's format, the rest in terragucci's.
      expect(strip(await read(inChantFormat(TG_BUCKET, (f) => f === "estate.json" || f.includes("tf-apply"))))).toEqual(strip(old));
    });
  }

  it("a control repo's run views read the same as chant.run/v1", async () => {
    const opts = () => ({ validator: terragucciValidator([scratch()]), runValidator: runViewValidator([scratch()]), now: NOW });
    const old = await readControlEstate(terragucciSource(TG_CONTROL), "c", opts());
    const neutral = await readControlEstate(terragucciSource(inChantFormat(TG_CONTROL)), "c", opts());
    expect({ ...neutral, source: "" }).toEqual({ ...old, source: "" });
    expect(old.projects.some((p) => p.run)).toBe(true);
    // The progress reader checks the same views the same way.
    const view = JSON.parse(readFileSync(join(TG_CONTROL, files(TG_CONTROL).find((f) => f.endsWith("run.json"))!), "utf8"));
    expect(estateRunCheck(neutralReport(view, "run", "terragucci"))).toBeUndefined();
    expect(progressRunCheck(neutralReport(view, "run", "terragucci"))).toBe(progressRunCheck(view));
    expect(estateRunCheck(neutralReport(view, "run", "plywood"))).toBe('it is chant.run/v1 from "plywood", not from terragucci');
  });

  for (const [name, dirs] of [
    ["terragucci's audit schema", () => [withTerragucci()]],
    ["the structural check", () => [scratch()]],
  ] as const) {
    it(`terragucci's audit record reads the same in its own format, in chant's, and mixed, by ${name}`, () => {
      const text = readFileSync(TG_AUDIT, "utf8");
      const lines = text.split("\n").filter((l) => l.trim());
      const neutral = lines.map((l) => JSON.stringify(readAuditLine(JSON.parse(l))));
      const v = auditValidator(dirs());
      const old = parseAudit(text, "old", v);
      expect(old.length).toBe(lines.length);
      expect(old.every((e) => e.product === "terragucci")).toBe(true);
      expect(parseAudit(neutral.join("\n"), "new", v)).toEqual(old);
      expect(parseAudit(lines.map((l, i) => (i % 2 ? neutral[i] : l)).join("\n"), "mixed", v)).toEqual(old);
    });
  }

  it("sql-yodeler's audit record reads the same in its own format and in chant's", async () => {
    const text = readFileSync(YODEL_AUDIT, "utf8");
    const neutral = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.stringify(readAuditLine(JSON.parse(l), { project: "github.com/acme/shop-db" })))
      .join("\n");
    const at = (body: string) => {
      const d = scratch();
      writeFileSync(join(d, "audit.jsonl"), body);
      return terragucciSource(d);
    };
    const opts = { checkoutProject: "github.com/acme/shop-db", validator: auditValidator([scratch()]), now: NOW };
    const old = await readTimeline(at(text), opts);
    expect(old.project).toBe("github.com/acme/shop-db");
    expect(old.entries.length).toBe(13);
    expect(old.entries.every((e) => e.product === "sql-yodeler" && e.environment)).toBe(true);
    expect(old.entries.map((e) => e.kind)).toContain("silenced");
    expect({ ...(await readTimeline(at(neutral), opts)), source: "" }).toEqual({ ...old, source: "" });
  });

  it("DORA numbers read from dora.json under either id", () => {
    const text = readFileSync(join(PLYWOOD, "estate", "dora.json"), "utf8");
    const want = doraFromFile(text, "web");
    expect(want?.dora).toMatchObject({ from: "dora.json", deployments_per_week: 1.19, lead_time_seconds: 1200 });
    expect(doraFromFile(JSON.stringify({ ...JSON.parse(text), schema: "terragucci.dora/v1", product: undefined }), "web")).toEqual(want);
    expect(doraFromFile(JSON.stringify({ ...JSON.parse(text), schema: "chant.estate/v1" }), "web")).toBeNull();
  });
});

describe("a plywood repo's bucket (behold#1228)", () => {
  it("shows the whole estate, its waiting waves, newest runs and delivery numbers", async () => {
    const r = await readTerragucci(terragucciSource(PLYWOOD), { checkoutProject: "github.com/acme/shop-infra", now: NOW });
    expect(r).toMatchObject({
      project: "shop-infra",
      product: "plywood",
      members: ["network", "web"],
      validation: { by: "chant", schemas: "@intentius/chant/report-store" },
      reports: 0,
      roots: {},
      estate: { html: "estate/estate.html", drifted: 1, failed: 0, waiting: 1, status: "ok" },
    });
    expect(r.waiting).toEqual([{ project: "web", wave: 1, commit: "p2", since: "2026-10-27T09:02:00.000Z", roots: [], set_digest: null, destroys: [], report: "estate/estate.html", gate: "wave-1", from: "estate" }]);
    expect(r.recent?.[0]).toMatchObject({ project: "web", stage: "pulumi-up", approval: "waiting" });
    // Two members have numbers, so the whole estate's read names none of them.
    expect(r.dora).toBeUndefined();
  });

  it("reads one member, with its delivery numbers, when one is named", async () => {
    const r = await readTerragucci(terragucciSource(PLYWOOD), { project: "web", now: NOW });
    expect(r.project).toBe("web");
    expect(r.members).toBeUndefined();
    expect(r.estate).toMatchObject({ waiting: 1 });
    expect(r.dora).toMatchObject({ key: "estate/dora.json", deployments_per_week: 1.19, lead_time_seconds: 1200 });
    expect((await refusal(readTerragucci(terragucciSource(PLYWOOD), { project: "billing" }))).error).toMatch(/holds the projects network, web, and none is billing/);
  });

  it("refuses an estate chant's schema rejects, naming the file and the schema", async () => {
    const d = join(scratch(), "bucket");
    cpSync(PLYWOOD, d, { recursive: true });
    const e = JSON.parse(readFileSync(join(d, "estate", "estate.json"), "utf8"));
    delete e.recent;
    writeFileSync(join(d, "estate", "estate.json"), JSON.stringify(e));
    const why = await refusal(readTerragucci(terragucciSource(d)));
    expect(why).toMatchObject({ code: "terragucci-report" });
    expect(why.error).toMatch(/^estate\/estate.json in .* is not a chant estate: chant's estate.schema.json rejects it/);
  });

  it("draws its audit record in chant's words, an approval with the roots of its gate", async () => {
    const t = await readTimeline(terragucciSource(PLYWOOD), { checkoutProject: "github.com/acme/shop-infra", validator: auditValidator([scratch()]), now: NOW });
    expect(t.project).toBe("shop-infra");
    expect(t.entries.map((e) => [e.kind, e.what, e.who, e.result])).toEqual([
      ["revoked", "wave-2", "dana", "revoked"],
      ["override-recorded", "wave-3", "lee", "unsigned"],
      ["applied", "wave-2", "ci", "applied"],
      ["approved", "wave-2", "dana", "unsigned"],
      ["approval-requested", "wave-2", null, "waiting"],
    ]);
    expect(t.entries.every((e) => e.product === "plywood")).toBe(true);
    // chant's override names its gate, not a root, so it takes no root from `what`.
    expect(t.entries.find((e) => e.kind === "override-recorded")!.roots).toEqual([]);
    expect(t.entries.find((e) => e.kind === "approved")!).toMatchObject({ roots: ["web"], wave: 2 });
  });
});

describe("a gs:// or az:// reports bucket (behold#1228)", () => {
  it("reads one key at a time through chant's report store, a missing key as absent", async () => {
    const asked: string[] = [];
    const cloud = (url: string) => async (key: string) => {
      asked.push(`${url} ${key}`);
      return key === "estate/estate.json" ? readFileSync(join(PLYWOOD, "estate", "estate.json"), "utf8") : null;
    };
    const s = terragucciSource("gs://reports/shop/", { cloud });
    expect(s).toMatchObject({ kind: "gs", location: "gs://reports/shop" });
    expect(s.list).toBeUndefined();
    const r = await readTerragucci(s, { project: "web", now: NOW });
    expect(r).toMatchObject({ kind: "gs", product: "plywood", estate: { waiting: 1 } });
    expect(asked).toEqual(["gs://reports/shop index.json", "gs://reports/shop estate.json", "gs://reports/shop estate/estate.json", "gs://reports/shop estate/dora.json"]);
    expect(terragucciSource("az://acct/reports", { cloud }).kind).toBe("az");
  });
});
