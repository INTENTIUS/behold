import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readYodelReport, yodelValidator, YodelReadError } from "./yodel-report.ts";

const fx = join(import.meta.dirname, "__fixtures__", "yodel-report");

describe("yodel report (#526)", () => {
  it("reads a report and the drift beside it, dated, checked against the pinned schemas", () => {
    const r = readYodelReport(join(fx, "good", "report.json"), yodelValidator([]));
    expect(r.validation).toMatchObject({ by: "schema", from: "pinned" });
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
      expect((e as YodelReadError).refusal.error).toMatch(/^drift-prod\.json is not a SQL Yodeler drift document: drift\.schema\.json rejects it: \/dialect/);
    }
  });
});
