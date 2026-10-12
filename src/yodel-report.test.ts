import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readYodelReport, yodelValidator, YodelReadError } from "./yodel-report.ts";
import { cardsFor, joinMarks, markLine } from "../web/yodel-report.js";

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
  });

  it("places drift on the example's table cards and lists the rest", () => {
    const r = readYodelReport(join(fx, "good"), yodelValidator([]));
    const j = joinMarks(r, ["shop/orders", "shop/shopSchema"]);
    expect(Object.keys(j.cards)).toEqual(["shop/orders"]);
    expect(j.unmatched.map((m) => m.object)).toEqual(["ordersStatusIdx"]);
    expect(cardsFor("orders", ["orders", "x/orders", "ordersX"])).toEqual(["orders", "x/orders"]);
    expect(markLine(j.cards["shop/orders"]![0], new Date("2026-10-11T10:00:00Z"))).toContain("prod: changed out of band (columns[2].default) · drift-prod.json, written");
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
