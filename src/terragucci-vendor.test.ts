// behold#571: the per-tool pages' routes and the read of a tool's latest cycle.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { VENDOR_TOOLS, cycleProblem, kioskRoute, readCycle, readDemo, terragucciCyclesRoute, vendorFallback, vendorPage, vendorRoutes } from "./terragucci-demo.ts";
import { terragucciSource, type TerragucciSource } from "./terragucci-source.ts";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "terragucci-demo");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
const source = (doc: unknown): TerragucciSource => ({ kind: "dir", location: "fx", read: async () => JSON.stringify(doc) });
const WEB = join(import.meta.dirname, "..", "web");

const step = (name: string, at: string, extra: Record<string, unknown> = {}) => ({ ...fixture(name), tool: "terragrunt", repo: "admin/demo-terragrunt", at, ...extra });
const cycle = (extra: Record<string, unknown> = {}) => ({
  schema: "demo.cycle/v1",
  tool: "terragrunt",
  repo: "admin/demo-terragrunt",
  scenario: "b-waves",
  cycle: 12,
  started: "2026-10-20T10:00:00Z",
  ended: "2026-10-20T10:06:00Z",
  steps: [step("demo-pull-request.json", "2026-10-20T10:00:00Z"), step("demo-applied.json", "2026-10-20T10:05:00Z"), step("demo-reset.json", "2026-10-20T10:06:00Z")],
  runs: [443, 444],
  ...extra,
});

describe("demo.json's tool and repo (behold#571)", () => {
  it("passes them through, and reads a demo.json without them as null", async () => {
    const a = await readDemo(source({ ...fixture("demo-waiting.json"), tool: "terragrunt", repo: "admin/demo-terragrunt" }));
    expect(a.demo && [a.demo.tool, a.demo.repo]).toEqual(["terragrunt", "admin/demo-terragrunt"]);
    const b = await readDemo(source(fixture("demo-waiting.json")));
    expect(b.demo && [b.demo.tool, b.demo.repo]).toEqual([null, null]);
  });
});

describe("a tool's latest cycle (behold#571)", () => {
  it("reads the driver's format, each step as demo.json reads with its at", async () => {
    const a = await readCycle(source(cycle()), "terragrunt");
    expect("cycle" in a && a.cycle).toBeTruthy();
    const c = a.cycle!;
    expect([c.tool, c.repo, c.cycle, c.runs]).toEqual(["terragrunt", "admin/demo-terragrunt", 12, [443, 444]]);
    expect(c.steps.map((s) => [s.step, s.at, s.tool])).toEqual([
      ["pull-request", "2026-10-20T10:00:00Z", "terragrunt"],
      ["applied", "2026-10-20T10:05:00Z", "terragrunt"],
      ["reset", "2026-10-20T10:06:00Z", "terragrunt"],
    ]);
  });
  it("refuses another tool's cycle, a step that is not demo.json, a step with no time, and runs that are not ids", () => {
    expect(cycleProblem(cycle(), "terraform")).toMatch(/tool/);
    expect(cycleProblem(cycle({ steps: [{ ...step("demo-reset.json", "2026-10-20T10:06:00Z"), step: "exploded" }] }), "terragrunt")).toMatch(/steps\[0\]/);
    expect(cycleProblem(cycle({ steps: [{ ...fixture("demo-reset.json") }] }), "terragrunt")).toMatch(/at/);
    expect(cycleProblem(cycle({ runs: ["443"] }), "terragrunt")).toMatch(/runs/);
    expect(cycleProblem(cycle({ steps: [] }), "terragrunt")).toMatch(/steps/);
    expect(cycleProblem(cycle(), "terragrunt")).toBeUndefined();
  });
  it("says a tool with no cycle yet is absent", async () => {
    const empty: TerragucciSource = { kind: "dir", location: "fx", read: async () => undefined };
    const a = await readCycle(empty, "choudoufu");
    expect("absent" in a && a.absent).toMatch(/cycles\/choudoufu\/latest\.json/);
  });
});

describe("GET /api/terragucci/cycles/:tool (behold#571)", () => {
  const dir = mkdtempSync(join(tmpdir(), "behold-cycles-"));
  mkdirSync(join(dir, "cycles", "terragrunt"), { recursive: true });
  writeFileSync(join(dir, "cycles", "terragrunt", "latest.json"), JSON.stringify(cycle()));
  mkdirSync(join(dir, "cycles", "terraform"), { recursive: true });
  writeFileSync(join(dir, "cycles", "terraform", "latest.json"), JSON.stringify(cycle()));
  const app = new Hono();
  terragucciCyclesRoute(app, terragucciSource(dir));
  it("answers a tool's cycle, 404 before it has one or for a tool with no page, 502 for another tool's document", async () => {
    const ok = await app.request("/api/terragucci/cycles/terragrunt");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { cycle: { scenario: string } }).cycle.scenario).toBe("b-waves");
    expect((await app.request("/api/terragucci/cycles/choudoufu")).status).toBe(404);
    expect((await app.request("/api/terragucci/cycles/pulumi")).status).toBe(404);
    expect((await app.request("/api/terragucci/cycles/terraform")).status).toBe(502);
  });
});

describe("GET /<tool> (behold#571)", () => {
  const app = (enabled = true) => {
    const a = new Hono();
    kioskRoute(a, WEB, enabled);
    vendorRoutes(a, WEB, enabled);
    a.get("/app.js", (c) => c.text("js"));
    vendorFallback(a);
    return a;
  };
  it("serves the kiosk page for each tool, told its tool", async () => {
    for (const tool of VENDOR_TOOLS) {
      const r = await app().request(`/${tool}`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain(`<meta name="kiosk-tool" content="${tool}" />`);
      expect(html).toContain('id="bar"');
    }
    expect(await (await app().request("/kiosk")).text()).not.toContain("kiosk-tool");
  });
  it("answers a short path that is no tool 404, with a link to /kiosk; other paths as before", async () => {
    const r = await app().request("/pulumi");
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('href="/kiosk"');
    expect((await app().request("/app.js")).status).toBe(200);
    expect(await (await app().request("/a/b")).text()).not.toContain("/kiosk");
  });
  it("takes GET alone, and says what /kiosk says without --terragucci", async () => {
    expect((await app().request("/terraform", { method: "POST" })).status).toBe(404);
    const off = await app(false).request("/terragrunt");
    expect(off.status).toBe(404);
    expect(await off.text()).toContain("--terragucci");
  });
  it("puts the meta tag in the head, after the charset", () => {
    const html = vendorPage(readFileSync(join(WEB, "kiosk.html"), "utf8"), "cdk-terrain");
    expect(html.indexOf('name="kiosk-tool"')).toBeGreaterThan(html.indexOf("charset"));
    expect(html.indexOf('name="kiosk-tool"')).toBeLessThan(html.indexOf("</head>"));
  });
});
