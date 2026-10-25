import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { joinTerragucci, type CheckoutRoot } from "./terragucci-overlay.ts";
import { readTerragucci, INDEX_SCHEMA } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";
// @ts-expect-error the kiosk's browser modules have no declaration files
import { sceneModel } from "../web/kiosk-estate-scene.js";
// @ts-expect-error see above
import { planOf } from "../web/kiosk-light.js";
// @ts-expect-error see above
import { readEdges, readCardIds } from "../web/terragucci-change.js";

// behold#965: the lines between estates in the Terragrunt and Atmos demos. The fixtures are the plan reports chant's
// `terraform report` wrote for those demos (src/__fixtures__/terragucci-demo-ask/report-{terragrunt,atmos}-plan.json).
// Terragrunt's checkout holds one unit, `live/all`, with the estates as modules, while the report's roots are
// `estates/network`, `estates/app` and `estates/edge`: the reads name the report's paths, which the checkout does not list.
const FIX = join(import.meta.dirname, "__fixtures__", "terragucci-demo-ask");
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function answerOf(fixture: string, repo: string, checkout: CheckoutRoot[]) {
  const d = mkdtempSync(join(tmpdir(), "behold-estate-lines-"));
  made.push(d);
  mkdirSync(join(d, "p/plan"), { recursive: true });
  writeFileSync(join(d, "p/plan/report.json"), readFileSync(join(FIX, fixture)));
  const project = `forge.example/demo/${repo}`;
  mkdirSync(dirname(join(d, "index.json")), { recursive: true });
  writeFileSync(join(d, "index.json"), JSON.stringify({ schema: INDEX_SCHEMA, reports: [{ project, commit: "c0ffee0000000000000000000000000000000001", stage: "tf-plan", finished: "2026-10-24T10:01:00.000Z", path: "p/plan", pull_request: "41" }] }));
  const read = await readTerragucci(terragucciSource(d), { roots: checkout.map((r) => r.path) });
  const marks = joinTerragucci(read, [], checkout);
  return { ...marks, roots: marks.roots.map((r) => ({ member: r.member, name: r.name, path: r.path })), pull_request: read.pull_request, binaries: Object.fromEntries(Object.keys(read.roots).map((p) => [p, "choudoufu"])) };
}

const cases = [
  { name: "Terragrunt (one unit, estates as modules)", fixture: "report-terragrunt-plan.json", member: "demo-terragrunt-choudoufu", checkout: [{ member: "demo-terragrunt-choudoufu", name: "live/all", path: "live/all" }], prefix: "estates/" },
  { name: "Atmos (components/terraform/<estate>)", fixture: "report-atmos-plan.json", member: "demo-atmos-choudoufu", checkout: ["app", "edge", "network"].map((n) => ({ member: "demo-atmos-choudoufu", name: n, path: `components/terraform/${n}` })), prefix: "components/terraform/" },
];

describe.each(cases)("the lines between estates: $name", ({ fixture, member, checkout, prefix }) => {
  it("tells the page every estate the reads name, so each has a box to draw a line to", async () => {
    const a = await answerOf(fixture, member, checkout);
    const paths = a.roots.map((r) => r.path);
    for (const e of ["network", "app", "edge"]) expect(paths).toContain(`${prefix}${e}`);
    for (const r of a.pull_request!.reads) {
      expect(paths).toContain(r.root);
      expect(paths).toContain(r.upstream);
    }
  });

  it("draws network to app to edge, one edge per pair", async () => {
    const a = await answerOf(fixture, member, checkout);
    const plan = planOf(a);
    expect(plan.edges).toEqual(expect.arrayContaining([
      { from: `${prefix}network`, to: `${prefix}app` },
      { from: `${prefix}app`, to: `${prefix}edge` },
      { from: `${prefix}network`, to: `${prefix}edge` },
    ]));
    // The reads the page draws a line for: each reader and read root is a root the page knows (web/app.js rootOf).
    const known = new Set(a.roots.map((r) => r.path));
    const lines = readEdges(a, null);
    // One line per pair: app reads network through two data blocks (its outputs, and subnet_b_id new in the change),
    // drawn as one read with the unknown output.
    expect(lines.map((e: { from: string; to: string; unknown: string[] }) => [e.from.slice(prefix.length), e.to.slice(prefix.length), e.unknown])).toEqual([
      ["app", "network", ["subnet_b_id"]],
      ["edge", "app", []],
      ["edge", "network", []],
    ]);
    for (const e of lines) {
      expect(known.has(e.from)).toBe(true);
      expect(known.has(e.to)).toBe(true);
    }
    // The reader's data card is found by its root's member and name.
    const card = readCardIds(a, lines.find((e: { from: string; data: string }) => e.from === `${prefix}app`));
    expect(card[0]).toBe(`${member}/app/data.terraform_remote_state.network`);
  });

  it("lays the estates out upstream first with a card edge for the reach between neighbours", async () => {
    const a = await answerOf(fixture, member, checkout);
    const model = sceneModel(a, planOf(a), null, null);
    expect(model.roots.map((r: { name: string }) => r.name)).toEqual(["network", "app", "edge"]);
  });
});
