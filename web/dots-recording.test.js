import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { readCarve, ownersAt, carveShow, walkthroughShow, ownersAtTime, phaseAt } from "./dots-recording.js";
import { parentsOf } from "./dots-layout.js";

// #457's committed recording of the terralith-14 carve, and the walkthrough's
// snapshots as src/terralith-demo.ts reads them (src/dots-preview.test.ts
// checks the server hands the page the same model).
const text = gunzipSync(readFileSync(fileURLToPath(new URL("../scripts/dot-bench/carve-terralith-14.jsonl.gz", import.meta.url)))).toString("utf8");

describe("the carve recording reader (#712)", () => {
  const rec = readCarve(text);
  it("reads the roster, the keyframes and every move", () => {
    expect(rec.roster).toHaveLength(1041);
    expect(rec.roster.filter((r) => r.taggable)).toHaveLength(467);
    expect(rec.keyframes.map((k) => k.seq)).toEqual([0, 100, 200, 300, 400, 463]);
    expect(rec.timeline).toHaveLength(463);
    expect(rec.timeline.filter((m) => !m.ok)).toHaveLength(14);
    expect(rec.estates).toHaveLength(9);
    expect(rec.timeline.every((m) => m.start <= m.t)).toBe(true);
    expect(rec.timeline.find((m) => !m.ok).refusal).toBe("plan_changes_more_than_tags");
  });
  it("refuses a file that is not a recording", () => {
    expect(() => readCarve('{"kind":"move"}\n')).toThrow(/not a carve recording/);
  });
  it("starts with every resource in the source and ends in the last keyframe's owners", () => {
    const parents = parentsOf(rec.roster);
    const start = ownersAt(rec, 0, parents);
    expect(new Set(start.values())).toEqual(new Set([rec.header.source]));
    const end = ownersAt(rec, 463, parents);
    expect(new Set(end.values()).size).toBe(9);
  });
  it("replays its moves to the account's own answer at the end", () => {
    const parents = parentsOf(rec.roster);
    const show = carveShow(rec, parents);
    const replayed = ownersAtTime(show, Infinity);
    const differ = rec.roster.filter((r) => replayed.get(r.address) !== show.ownersEnd.get(r.address));
    expect(differ).toEqual([]);
    expect(show.events.filter((e) => e.kind === "write")).toHaveLength(463);
  });
});

describe("the walkthrough reader (#712)", async () => {
  const { readTerralith } = await import("../src/terralith-demo.ts");
  const model = readTerralith(fileURLToPath(new URL("../src/__fixtures__/terralith", import.meta.url)));
  const show = walkthroughShow(model);
  it("takes the roster from the stock phase and its events from the snapshots", () => {
    expect(show.roster).toHaveLength(23);
    expect(show.events.filter((e) => e.kind === "adopt")).toHaveLength(17);
    expect(show.events.filter((e) => e.kind === "write")).toHaveLength(15);
    expect(show.events.filter((e) => e.kind === "planned")).toHaveLength(3);
    expect(show.threads).toEqual([
      { from: "terralith", to: "team-a", name: "log_retention_days", known: true },
      { from: "terralith", to: "team-b", name: "log_retention_days", known: true },
      { from: "terralith", to: "team-c", name: "log_retention_days", known: true },
    ]);
    expect(show.spaced).toBe(true);
  });
  it("ends with the split's owners, followers included", () => {
    const end = ownersAtTime(show, Infinity);
    expect(end.get("aws_iam_role_policy.team_a_inline")).toBe("team-a");
    expect(end.get("aws_vpc.main")).toBe("terralith");
    for (const r of show.roster) expect(end.get(r.address)).toBe(show.ownersEnd.get(r.address));
  });
  it("knows its phase at a time", () => {
    expect(phaseAt(show, show.t0).id).toBe("stock");
    expect(phaseAt(show, show.t1).id).toBe("plan");
  });
});
