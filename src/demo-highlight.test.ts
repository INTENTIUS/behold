import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DEMO_STEP_SCHEMA, readDemoCycle, readerSchema, readStep, schemaProblem } from "./chant-demo.ts";
import { demoOf, highlightOf, readCycle, terragucciCyclesRoute, terragucciDemoRoute, type Demo } from "./terragucci-demo.ts";
import type { TerragucciSource } from "./terragucci-source.ts";
import demoCycleSchema from "./demo-schemas/demo-cycle.schema.json" with { type: "json" };
import demoStepSchema from "./demo-schemas/demo-step.schema.json" with { type: "json" };

// behold#757: a step's `highlight: { title, body }`, what is special about it in the scenario's own words
// (terragucci-89's demo.json, chant#4106's demo-step/v1 and demo-cycle/v1 steps). It passes through every read
// the kiosk makes of a step, floored: both a non-empty string, else it is left out and the step reads as before.
const HL = {
  title: "Same orchestration as the commercial platforms",
  body: "Fifteen OpenTofu states, applied in dependency order: network first, then the clusters, then the apps. A reviewer approves the plan before anything applies. This is the stack-dependency orchestration Terraform automation platforms sell, run here by terragucci on plain OpenTofu and Forgejo.",
};
const BAD = [null, undefined, "x", 3, [], {}, { title: "t" }, { body: "b" }, { title: "", body: "b" }, { title: "t", body: "  " }, { title: 1, body: "b" }, { title: "t", body: ["b"] }];

const memory = (files: Record<string, unknown>): TerragucciSource => ({ kind: "dir", location: "mem", async read(key: string) { return key in files ? JSON.stringify(files[key]) : undefined; } }) as TerragucciSource;
const demo = (over: Record<string, unknown> = {}) => ({ cycle: 9, scenario: "fan-out", title: "t", step: "failed", label: "l", started_at: "2026-10-18T00:00:00Z", next: null, pull: 3, commit: null, about: null, tool: "tofu-fanout", ...over });

describe("terragucci's demo.json `highlight`", () => {
  it("is kept whole, trimmed, when its title and body are non-empty strings", () => {
    expect(highlightOf(HL)).toEqual(HL);
    expect(highlightOf({ title: "  a ", body: " b  ", extra: 1 })).toEqual({ title: "a", body: "b" });
    expect(demoOf(demo({ highlight: HL }) as unknown as Demo).highlight).toEqual(HL);
  });
  it("is left out otherwise, and the step reads as it did without one", () => {
    const plain = demoOf(demo() as unknown as Demo);
    expect("highlight" in plain).toBe(false);
    for (const v of BAD) {
      expect(highlightOf(v)).toBeUndefined();
      expect(demoOf(demo({ highlight: v }) as unknown as Demo)).toEqual(plain);
    }
  });
  it("rides /api/terragucci/demo and a tool's cycle steps", async () => {
    const steps = [demo({ step: "applying", at: "2026-10-18T00:00:00Z" }), demo({ step: "failed", at: "2026-10-18T00:00:20Z", highlight: HL }), demo({ step: "reset", at: "2026-10-18T00:00:40Z", highlight: { title: "", body: "x" } })];
    const src = memory({ "demo.json": demo({ highlight: HL }), "cycles/tofu-fanout/latest.json": { tool: "tofu-fanout", repo: "a/demo-fanout", scenario: "fan-out", cycle: 9, started: null, ended: null, runs: [1], steps } });
    const app = new Hono();
    terragucciDemoRoute(app, src);
    terragucciCyclesRoute(app, src);
    const d = (await (await app.request("/api/terragucci/demo")).json()) as { demo: Demo };
    expect(d.demo.highlight).toEqual(HL);
    const c = (await (await app.request("/api/terragucci/cycles/tofu-fanout")).json()) as { cycle: { steps: Demo[] } };
    expect(c.cycle.steps.map((s) => s.highlight ?? null)).toEqual([null, HL, null]);
    expect((await readCycle(src, "tofu-fanout")).cycle!.steps[1]!.highlight).toEqual(HL);
  });
});

describe("chant's demo-step/v1 `highlight` (chant#4106)", () => {
  const FIX = join(import.meta.dirname, "__fixtures__", "chant-demo");
  const json = (rel: string) => JSON.parse(readFileSync(join(FIX, rel), "utf8")) as Record<string, unknown>;
  const step = (over: Record<string, unknown> = {}) => ({ ...json("step.json"), ...over });
  it("rides step.json and the cycle's steps", async () => {
    expect((await readStep(memory({ "step.json": step({ highlight: HL }) }))).demo!.highlight).toEqual(HL);
    const c = json("cycles/latest.json");
    const steps = (c.steps as Record<string, unknown>[]).map((s) => (s.step === "failed" ? { ...s, highlight: HL } : s));
    const a = await readDemoCycle(memory({ "cycles/latest.json": { ...c, steps } }));
    expect(a.cycle!.steps.filter((s) => s.highlight).map((s) => [s.step, s.highlight])).toEqual([["failed", HL]]);
  });
  it("is left out when not of its form, never refusing the step", async () => {
    const plain = (await readStep(memory({ "step.json": step() }))).demo!;
    expect("highlight" in plain).toBe(false);
    for (const v of BAD) {
      const a = await readStep(memory({ "step.json": v === undefined ? step() : step({ highlight: v }) }));
      expect(a.demo).toEqual(plain);
    }
  });
  it("reads past the schema that types it: a bad one is ignored, not a refusal of the record", () => {
    // chant#4106's vendored schemas declare it, on a step and on a cycle's step; the reader's leave it to highlightOf.
    expect((demoStepSchema as { properties: Record<string, unknown> }).properties.highlight).toBeDefined();
    expect((demoCycleSchema as { $defs: { cycleStep: { properties: Record<string, unknown> } } }).$defs.cycleStep.properties.highlight).toBeDefined();
    const schema = readerSchema("demo-step") as { properties: Record<string, unknown> };
    expect(schema.properties.highlight).toBeUndefined();
    expect((readerSchema("demo-cycle") as { $defs: { cycleStep: { properties: Record<string, unknown> } } }).$defs.cycleStep.properties.highlight).toBeUndefined();
    expect(schemaProblem({ $schema: DEMO_STEP_SCHEMA, contract: 1, demo: "d", cycle: 1, step: "reset", highlight: HL }, "demo-step")).toBeUndefined();
    expect(schemaProblem({ $schema: DEMO_STEP_SCHEMA, contract: 1, demo: "d", cycle: 1, step: "reset", highlight: { title: 3 } }, "demo-step")).toBeUndefined();
  });
});
