import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { joinTerragucci, type CheckoutRoot } from "./terragucci-overlay.ts";
import { readTerragucci, INDEX_SCHEMA } from "./terragucci-reports.ts";
import { terragucciSource } from "./terragucci-source.ts";
// @ts-expect-error the kiosk's browser modules have no declaration files
import { cardLines, lineState, planOf, unknownSlots } from "../web/kiosk-light.js";
// @ts-expect-error see above
import { sceneModel } from "../web/kiosk-estate-scene.js";

// behold#1008 (ruled: report.json): chant#4439's `show -json` feed, drawn through the estate scene behold#940 draws a
// composed choudoufu run with. `chant terraform report` wrote src/__fixtures__/chant-report/<stage>/report.json
// (terragucci.report/v1 minor 48, `compose.estate`) from a three-estate composed plan: network creates a subnet and
// updates its vpc, app reads network's `subnet_id` unknown, edge reads app's `sg` unknown. The edges come from each
// root's `reads[]`. The bare change-set.json beside each report is copied too and not read (see the fixtures' README).
const FIX = join(import.meta.dirname, "__fixtures__", "chant-report");
const doc = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));
const ROOTS: CheckoutRoot[] = ["network", "app", "edge"].map((n) => ({ member: "demo", name: n, path: `estates/${n}` }));
const PROJECT = "forgejo:3000/admin/demo-terragrunt";
const COMMIT = "4439c0ffee";
const SUBNET = "demo/network/aws_subnet.new";
const OPEN = { width: 1900, height: 740 };

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function write(dir: string, path: string, body: unknown): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), JSON.stringify(body));
}
/** A report bucket holding the tf-plan report, and the tf-apply report after it when `applied`. */
function bucket(applied: boolean): string {
  const d = mkdtempSync(join(tmpdir(), "behold-chant-report-"));
  made.push(d);
  const rows: Record<string, unknown>[] = [{ project: PROJECT, commit: COMMIT, stage: "tf-plan", finished: "2026-10-25T10:00:00Z", path: "p/plan", pull_request: "1" }];
  write(d, "p/plan/report.json", doc("tf-plan/report.json"));
  if (applied) {
    write(d, "p/apply/report.json", doc("tf-apply/report.json"));
    rows.push({ project: PROJECT, commit: COMMIT, stage: "tf-apply", wave: 1, finished: "2026-10-25T10:05:00Z", path: "p/apply", approval: "not-requested", applied: "2026-10-25T10:05:00Z" });
  }
  write(d, "index.json", { schema: INDEX_SCHEMA, reports: rows });
  return d;
}
async function answerOf(applied: boolean) {
  const read = await readTerragucci(terragucciSource(bucket(applied)), { roots: ROOTS.map((r) => r.path) });
  const marks = joinTerragucci(read, [], ROOTS);
  return { ...marks, roots: marks.roots.map((r) => ({ member: r.member, name: r.name, path: r.path })), pull_request: read.pull_request };
}
const progressApplied = { states: [{ number: 1, state: "applied", roots: ROOTS.map((r) => r.path), composed: { members: ROOTS.map((r) => ({ root: r.path, apply: "applied", state: "written" })) } }], reads: [] };

describe("chant#4439's report.json through the estate scene (behold#1008)", () => {
  for (const stage of ["tf-plan", "tf-apply"] as const) {
    describe(stage, () => {
      const applied = stage === "tf-apply";

      it("draws three member boxes, network on top, with each estate's cards", async () => {
        const a = await answerOf(applied);
        const m = sceneModel(a, planOf(a), null, OPEN);
        expect(m.roots).toHaveLength(3);
        expect(m.roots.map((r: { path: string }) => r.path)).toEqual(["estates/network", "estates/app", "estates/edge"]);
        expect(m.roots.map((r: { cards: { id: string }[] }) => r.cards.map((c) => c.id))).toEqual([
          ["demo/network/aws_subnet.new", "demo/network/aws_vpc.main"],
          ["demo/app/aws_security_group.sg"],
          ["demo/edge/aws_route_table.rt"],
        ]);
        const state = applied ? "applied" : "planned";
        expect(a.estateScene!.roots.flatMap((r) => r.resources).every((x) => x.state === state)).toBe(true);
      });

      it("draws the edges network to app and app to edge from the roots' reads, and no other", async () => {
        const a = await answerOf(applied);
        expect(planOf(a).edges).toEqual([
          { from: "estates/network", to: "estates/app" },
          { from: "estates/app", to: "estates/edge" },
        ]);
        expect(a.pull_request!.reads.map((r) => [r.upstream, r.root, r.unknown])).toEqual([
          ["estates/network", "estates/app", ["subnet_id"]],
          ["estates/app", "estates/edge", ["sg"]],
        ]);
      });

      it("marks network's subnet id known after apply", async () => {
        const a = await answerOf(applied);
        const plan = planOf(a);
        const id = cardLines(plan).find((l: { cardId: string; path: string }) => l.cardId === SUBNET && l.path === "id");
        expect(id).toMatchObject({ path: "id", kind: "unknown" });
        expect(lineState(id, a, null)).toEqual({ state: "unknown", text: "id: known after apply" });
        const slots = unknownSlots(plan).map((s: { root: string; address: string; path: string }) => `${s.root}/${s.address}.${s.path}`);
        expect(slots).toEqual([
          "estates/network/aws_subnet.new.arn",
          "estates/network/aws_subnet.new.id",
          "estates/app/aws_security_group.sg.id",
          "estates/app/aws_security_group.sg.vpc_id",
          "estates/edge/aws_route_table.rt.id",
          "estates/edge/aws_route_table.rt.vpc_id",
        ]);
        // Every card keeps at most two lines.
        const per: Record<string, number> = {};
        for (const l of cardLines(plan)) per[l.cardId] = (per[l.cardId] || 0) + 1;
        expect(Math.max(...Object.values(per))).toBeLessThanOrEqual(2);
      });
    });
  }

  it("fills the subnet id with the value the tf-apply report states, once the run view says applied", async () => {
    const a = await answerOf(true);
    const id = cardLines(planOf(a)).find((l: { cardId: string; path: string }) => l.cardId === SUBNET && l.path === "id");
    expect(lineState(id, a, progressApplied)).toEqual({ state: "applied", text: "id: subnet-0a1b" });
    // The plan alone states no value: the mark stays known after apply.
    const p = await answerOf(false);
    const pid = cardLines(planOf(p)).find((l: { cardId: string; path: string }) => l.cardId === SUBNET && l.path === "id");
    expect(lineState(pid, p, null).text).toBe("id: known after apply");
  });
});
