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
/** A report bucket holding the tf-plan report, and the tf-apply report after it when `applied`; with `applyOnly`, the tf-apply report alone. */
function bucket(applied: boolean, applyOnly = false): string {
  const d = mkdtempSync(join(tmpdir(), "behold-chant-report-"));
  made.push(d);
  const rows: Record<string, unknown>[] = [];
  if (!applyOnly) {
    rows.push({ project: PROJECT, commit: COMMIT, stage: "tf-plan", finished: "2026-10-25T10:00:00Z", path: "p/plan", pull_request: "1" });
    write(d, "p/plan/report.json", doc("tf-plan/report.json"));
  }
  if (applied || applyOnly) {
    write(d, "p/apply/report.json", doc("tf-apply/report.json"));
    rows.push({ project: PROJECT, commit: COMMIT, stage: "tf-apply", wave: 1, finished: "2026-10-25T10:05:00Z", path: "p/apply", approval: "not-requested", applied: "2026-10-25T10:05:00Z" });
  }
  write(d, "index.json", { schema: INDEX_SCHEMA, reports: rows });
  return d;
}
async function answerOf(applied: boolean, applyOnly = false) {
  const read = await readTerragucci(terragucciSource(bucket(applied, applyOnly)), { roots: ROOTS.map((r) => r.path) });
  const marks = joinTerragucci(read, [], ROOTS);
  return { ...marks, roots: marks.roots.map((r) => ({ member: r.member, name: r.name, path: r.path })), pull_request: read.pull_request, marks: marks.roots, read };
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

  // behold#1012 (ruled: an apply report with no plan report draws its scene; edges from reads[] stay box-to-box; no chant
  // change). The bucket holds tf-apply/report.json and nothing else, so every mark below comes from the apply report: the
  // tf-plan stage case above feeds both reports, and its tf-apply marks came from the plan (the audit correction on
  // behold#1008).
  describe("tf-apply alone, with no tf-plan report beside it", () => {
    it("reads no pull request, and takes the estates and their reads from the apply report", async () => {
      const a = await answerOf(true, true);
      expect(a.pull_request).toBeUndefined();
      expect(a.read.reports).toBe(1);
      expect(a.read.estate_apply!.compose).toMatchObject({ estate: true, roots: ["estates/app", "estates/edge", "estates/network"] });
      expect(a.read.estate_apply!.report).toBe("p/apply/report.html");
    });

    it("draws three member boxes, network on top, each card applied", async () => {
      const a = await answerOf(true, true);
      const m = sceneModel(a, planOf(a), null, OPEN);
      expect(m.roots.map((r: { path: string }) => r.path)).toEqual(["estates/network", "estates/app", "estates/edge"]);
      expect(m.roots.map((r: { cards: { id: string }[] }) => r.cards.map((c) => c.id))).toEqual([
        ["demo/network/aws_subnet.new", "demo/network/aws_vpc.main"],
        ["demo/app/aws_security_group.sg"],
        ["demo/edge/aws_route_table.rt"],
      ]);
      const resources = a.estateScene!.roots.flatMap((r) => r.resources);
      expect(resources).toHaveLength(4);
      expect(resources.every((x) => x.state === "applied")).toBe(true);
    });

    it("draws the reads network to app and app to edge box to box, root to root, and no card-to-card line", async () => {
      const a = await answerOf(true, true);
      expect(a.estateScene!.reads!.map((r) => [r.upstream, r.root, r.unknown])).toEqual([
        ["estates/network", "estates/app", ["subnet_id"]],
        ["estates/app", "estates/edge", ["sg"]],
      ]);
      const plan = planOf(a);
      expect(plan.edges).toEqual([
        { from: "estates/network", to: "estates/app" },
        { from: "estates/app", to: "estates/edge" },
      ]);
      expect(plan.reaches.size).toBe(0);
      expect(sceneModel(a, plan, null, OPEN).edges).toEqual([]);
    });

    it("puts the tf-apply mark on each root, and network's subnet id is the value the apply wrote", async () => {
      const a = await answerOf(true, true);
      for (const r of a.marks) {
        expect(r.plan, r.path).toBeUndefined();
        expect(r.apply, r.path).toMatchObject({ run: { stage: "tf-apply", commit: COMMIT, finished: "2026-10-25T10:05:00Z" } });
      }
      expect(a.applied[SUBNET]!.run.stage).toBe("tf-apply");
      expect(a.applied[SUBNET]!.values.find((v) => v.path === "id")).toMatchObject({ path: "id", after: "subnet-0a1b" });
      // The apply report states the id, so no card says it is known after apply.
      const plan = planOf(a);
      expect(unknownSlots(plan).filter((s: { root: string; address: string }) => s.root === "estates/network" && s.address === "aws_subnet.new")).toEqual([]);
      expect(cardLines(plan).filter((l: { cardId: string; kind: string }) => l.cardId === SUBNET && l.kind === "unknown")).toEqual([]);
    });
  });
});
