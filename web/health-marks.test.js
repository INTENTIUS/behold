import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { healthCounts, nodeHealthOf, rotationOf } from "../src/runtime-health.ts";
import { dimEdge, HEALTH_COLOR, healthHeader, healthLegendRows, healthMarks, healthRows, memberLines } from "./health-marks.js";

// #825: the marks drawn from what chant printed for the #823 prototype
// (src/__fixtures__/health): the dns member against a floci whose Azure
// check fails, and the azure member with nothing behind it (a hole).
const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "health");
const read = (f) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const nodes = { ...nodeHealthOf(read("dns-health.json"), "dns"), ...nodeHealthOf(read("azure-health.json"), "azure") };
const rotation = rotationOf(read("dns-graph-ir.json"), nodes, "dns");
const answer = { env: "prod", nodes, rotation, counts: healthCounts(nodes, rotation), members: [{ member: "dns" }, { member: "gcp", refusal: { error: "Runtime health needs chant 0.124.33 or newer.", remedy: "Upgrade." } }] };
const ids = ["dns/awsCheck", "dns/azureCheck", "dns/azureRecord", "dns/awsRecord", "azure/app", "dns/zone"];

describe("health marks (#825)", () => {
  it("tags each card with its state, rings the unhealthy one solid and the hole dashed", () => {
    const m = healthMarks(answer, ids);
    expect(m["dns/awsCheck"]).toMatchObject({ tag: "healthy", color: HEALTH_COLOR.healthy, ring: null, dim: false });
    expect(m["dns/azureCheck"]).toMatchObject({ tag: "unhealthy", color: "var(--degraded)", ring: "solid" });
    expect(m["dns/azureCheck"].title).toMatch(/0\/8 checkers healthy/);
    expect(m["azure/app"]).toMatchObject({ tag: "health not read: read-failed", color: "var(--neutral)", ring: "dashed" });
    expect(m["azure/app"].title).toMatch(/not a verdict/);
    expect(m["dns/zone"]).toBeUndefined();
  });

  it("dims the record out of rotation and its edges, and only that one", () => {
    const m = healthMarks(answer, ids);
    expect(m["dns/azureRecord"]).toMatchObject({ tag: "out of rotation: azureCheck unhealthy", dim: true });
    expect(m["dns/awsRecord"]).toMatchObject({ tag: "in rotation: awsCheck healthy", dim: false });
    expect(dimEdge(answer, "dns/azureRecord", "dns/azureCheck")).toBe(true);
    expect(dimEdge(answer, "dns/azureRecord", "dns/zone")).toBe(true);
    expect(dimEdge(answer, "dns/awsRecord", "dns/awsCheck")).toBe(false);
  });

  it("dims nothing when the check was not read", () => {
    const unread = nodeHealthOf(read("dns-unobserved.json"), "dns");
    const rot = rotationOf(read("dns-graph-ir.json"), unread, "dns");
    const a = { env: "prod", nodes: unread, rotation: rot, counts: healthCounts(unread, rot) };
    expect(Object.values(healthMarks(a, ids)).some((x) => x.dim)).toBe(false);
    expect(healthMarks(a, ids)["dns/azureRecord"].tag).toBe("rotation unknown: azureCheck not read");
  });

  it("gives the inspect pane the detail, checkedAt and what a check guards", () => {
    expect(healthRows(answer, "dns/azureCheck")).toEqual([
      ["state", "unhealthy"],
      ["detail", "0/8 checkers healthy; last: Failure: DNS resolution failed for w825-nowhere.invalid."],
      ["checked", "2026-10-21T04:48:42.977269840Z"],
      ["read", "2026-10-21T04:48:58.414Z"],
      ["type", "AWS::Route53::HealthCheck"],
      ["guards", "dns/azureRecord (out of rotation)"],
    ]);
    expect(healthRows(answer, "dns/azureRecord")).toEqual([["rotation", "out"], ["health check", "dns/azureCheck"], ["why", "out of rotation: azureCheck unhealthy"]]);
    expect(healthRows(answer, "azure/app")).toEqual([["state", "health not read"], ["reason", "read-failed"], ["detail", "fetch failed"], ["type", "Microsoft.App/containerApps"]]);
  });

  it("words the legend, a refused member, and a refusal", () => {
    expect(healthHeader(answer).text).toBe("health · prod");
    expect(healthLegendRows(answer).map((r) => [r.text, r.count])).toEqual([["healthy", "2"], ["unhealthy", "1"], ["health not read", "1"], ["records out of rotation", "1"]]);
    expect(memberLines(answer)).toEqual([{ text: "gcp: health not read: Runtime health needs chant 0.124.33 or newer.", title: "Upgrade." }]);
    const refused = { refusal: { error: "Runtime health needs chant 0.124.33 or newer.", remedy: "Upgrade." }, degraded: "the graph draws no health marks" };
    expect(healthHeader(refused)).toMatchObject({ tone: "refusal" });
    expect(healthMarks(refused, ids)).toEqual({});
    expect(healthMarks({ error: "not in this static export" }, ids)).toEqual({});
  });
});
