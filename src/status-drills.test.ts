import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flagsFromStatus } from "./feature-flags.ts";
import { stagesFromStatus } from "./stage-state.ts";
import { promotionOrder, releaseMembers } from "./trunk-lane.ts";
import { gatesFromStatus } from "./workspace-gates.ts";
import type { WorkspaceDocument } from "./workspace-reader.ts";

// chant#5450 added `members[].drills` to `workspace status`: the newest restore drill of each store a member has
// drilled in the environment asked for. behold has no view of it; every parser of the status document reads the
// fields it names and must not change its answer, or refuse the document, because this one is present. The
// document is the stage-state fixture with a drill (shaped as chant's status.schema.json `drill`) on each member.
const base = (): WorkspaceDocument => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "stage-state", "status-prod.json"), "utf8")) as WorkspaceDocument;
const drill = {
  store: "orders-db",
  kind: "rds",
  env: "prod",
  id: "drill-2026-11-20-0900",
  op: "restore-orders",
  at: "2026-11-20T09:40:00Z",
  outcome: "missed",
  met: false,
  rtoMs: 2_400_000,
  rpoMs: 300_000,
  targets: { rtoMs: 1_800_000, rpoMs: 900_000 },
  shortfall: { rtoMs: 600_000 },
  checks: { passed: 3, total: 4, failed: ["row-count"] },
  backup: null,
  error: null,
  tornDown: true,
};
const withDrills = (): WorkspaceDocument => {
  const doc = base();
  for (const m of doc.members as Record<string, unknown>[]) m.drills = [drill];
  return doc;
};

describe("a status document that carries members[].drills (chant#5450)", () => {
  it("gives the same gates", () => {
    expect(gatesFromStatus(withDrills(), "/work")).toEqual(gatesFromStatus(base(), "/work"));
    expect(gatesFromStatus(withDrills(), "/work").ok).toBe(true);
  });

  it("gives the same stages", () => {
    const read = stagesFromStatus(withDrills(), { readAt: "2026-11-20T12:00:00.000Z" });
    expect(read).toEqual(stagesFromStatus(base(), { readAt: "2026-11-20T12:00:00.000Z" }));
    expect(read.ok).toBe(true);
  });

  it("gives the same lane inputs and flags", () => {
    expect(promotionOrder(withDrills())).toEqual(promotionOrder(base()));
    expect(releaseMembers(withDrills())).toEqual(releaseMembers(base()));
    expect(flagsFromStatus(withDrills())).toEqual(flagsFromStatus(base()));
  });
});
