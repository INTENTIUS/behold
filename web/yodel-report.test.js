import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readYodelReport, yodelValidator } from "../src/yodel-report.ts";
import { cardsFor, joinMarks, markLine } from "./yodel-report.js";

const fx = join(import.meta.dirname, "..", "src", "__fixtures__", "yodel-report");

describe("yodel report marks on cards (#526)", () => {
  it("places drift on the example's table cards and lists the rest", () => {
    const r = readYodelReport(join(fx, "good"), yodelValidator([]));
    const j = joinMarks(r, ["shop/orders", "shop/shopSchema"]);
    expect(Object.keys(j.cards)).toEqual(["shop/orders"]);
    expect(j.unmatched.map((m) => m.object)).toEqual(["ordersStatusIdx"]);
    expect(cardsFor("orders", ["orders", "x/orders", "ordersX"])).toEqual(["orders", "x/orders"]);
    expect(markLine(j.cards["shop/orders"][0], new Date("2026-10-11T10:00:00Z"))).toContain("prod: changed out of band (columns[2].default) · drift-prod.json, written");
  });

});
