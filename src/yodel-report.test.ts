import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAuditLine } from "@intentius/chant/report-store";
import { readYodelReport, yodelValidator, YodelReadError } from "./yodel-report.ts";

const fx = join(import.meta.dirname, "__fixtures__", "yodel-report");

describe("yodel report (#526)", () => {
  it("reads a report and the drift beside it, dated, checked against chant's audit schema and the fields behold reads", () => {
    const r = readYodelReport(join(fx, "good", "report.json"), yodelValidator([]));
    expect(r.validation).toEqual({ by: "chant", from: "chant", schemas: "@intentius/chant/report-store" });
    expect(r.report).toMatchObject({ file: "report.json", generatedAt: "2026-10-11T06:04:00.000Z" });
    expect(r.environments[0]).toMatchObject({ name: "prod", dated: { by: "generatedAt", file: "report.json" } });
    expect(r.environments[0]!.applied.map((m) => m.id)).toEqual(["20261010T1723-baseline", "20261010T1723-coupons"]);
    expect(r.environments[0]!.gaps).toHaveLength(1);
    expect(r.marks.map((m) => [m.object, m.kind, m.dated.by, m.dated.file])).toEqual([
      ["orders", "changed", "file-written", "drift-prod.json"],
      ["ordersStatusIdx", "missing", "file-written", "drift-prod.json"],
    ]);
    // #537: the audit entries, each with its own time, its source, and the report it came from.
    expect(r.audit).toEqual([
      { id: "e1", at: "2026-10-10T17:30:00.000Z", environment: "prod", kind: "applied", migration: "20261010T1723-baseline", source: { history: "shop.history", seq: 1, run: "r1" }, file: "report.json" },
    ]);
  });

  it("refuses a malformed file by name", () => {
    try {
      readYodelReport(join(fx, "malformed"), yodelValidator([]));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(YodelReadError);
      expect((e as YodelReadError).refusal.code).toBe("yodel-report");
      expect((e as YodelReadError).refusal.error).toBe('drift-prod.json is not a SQL Yodeler drift document: its dialect is "mysql", not clickhouse or postgres');
    }
  });

  // behold#1228: the same report with its audit in chant's format reads the same, and a bad entry is refused.
  const withAudit = (audit: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "behold-yodel-chant-"));
    const doc = JSON.parse(readFileSync(join(fx, "good", "report.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "report.json"), JSON.stringify({ ...doc, audit }));
    copyFileSync(join(fx, "good", "drift-prod.json"), join(dir, "drift-prod.json"));
    return dir;
  };

  it("draws a chant.audit/v1 entry in SQL Yodeler's words, as the entry it was written from", () => {
    const old = readYodelReport(join(fx, "good", "report.json"), yodelValidator([]));
    const doc = JSON.parse(readFileSync(join(fx, "good", "report.json"), "utf8")) as { project: string; audit: unknown[] };
    const lines = doc.audit.map((a) => readAuditLine(a, { product: "sql-yodeler", project: doc.project }));
    expect(lines[0]).toMatchObject({ schema: "chant.audit/v1", product: "sql-yodeler", kind: "applied", environment: "prod" });
    const r = readYodelReport(join(withAudit(lines), "report.json"), yodelValidator([]));
    expect(r.audit).toEqual(old.audit);
  });

  it("refuses an audit entry chant does not read, naming it", () => {
    try {
      readYodelReport(join(withAudit([{ schema: "chant.audit/v1", id: "x" }]), "report.json"), yodelValidator([]));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(YodelReadError);
      expect((e as YodelReadError).refusal.error).toMatch(/^report\.json is not a SQL Yodeler report document: audit entry 0: it is chant\.audit\/v1 but lacks/);
    }
  });
});
