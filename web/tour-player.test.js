// The tour player (behold.tour/v1): the chapter a cycle is in from its events,
// the facts filled into a chapter's lines (a fact with no record is left out),
// the live badge's lag, and a landed dot's provenance.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { chapterAt, firedBy, shownAt, railOf, fill, chapterLines, cardRows, lagText, LAG_WAIT_MS, provenanceText, jobNumber, stepMsFor, SLOWED, migrationTool } from "./tour-player.js";

const tour = JSON.parse(readFileSync(new URL("./tours/terralith.json", import.meta.url), "utf8"));
const beat = (b, step = "applying", at = 1_000) => ({ kind: "beat", beat: b, step, at });

describe("the chapter from demo.json's beat", () => {
  it("maps each beat to its chapter, in the tour's order", () => {
    const ids = ["stock", "adopt", "split", "team", "cross"].map((b) => chapterAt(tour, [beat(b)]).chapter.id);
    expect(ids).toEqual(["stock", "adopt", "split", "team", "cross"]);
  });

  it("is the epilogue once the cross beat applied, and through the reset", () => {
    expect(chapterAt(tour, [beat("cross", "applied")]).chapter.id).toBe("epilogue");
    expect(chapterAt(tour, [{ kind: "beat", beat: null, step: "reset", at: 5 }]).chapter.id).toBe("epilogue");
  });

  it("is no chapter before any trigger fires", () => {
    expect(chapterAt(tour, [])).toBeNull();
    expect(chapterAt(tour, [beat("stock", "applying", 50)], 10)).toBeNull();
  });

  it("says how far a chapter has got from the step, and the rail marks done, current and ahead", () => {
    const at = chapterAt(tour, [beat("split", "applied")], Infinity, "applied");
    expect(at.progress).toBe(1);
    expect(chapterAt(tour, [beat("split", "planned")], Infinity, "planned").progress).toBeCloseTo(1 / 7);
    expect(railOf(tour, at).map((c) => c.state)).toEqual(["done", "done", "current", "ahead", "ahead", "ahead"]);
  });
});

describe("triggers on lines and waves", () => {
  it("fires on a migration's last line, and on a wave only after the named run's finish", () => {
    const events = [
      { kind: "line", migration: "split", line: "first", at: 10 },
      { kind: "wave", wave: 1, edge: "start", at: 20 },
      { kind: "wave", wave: 1, edge: "start", at: 40 },
    ];
    expect(firedBy({ migration: "split", line: "last" }, events)).toBeNull();
    expect(firedBy({ migration: "split", line: "first" }, events).at).toBe(10);
    expect(firedBy({ wave: 1, edge: "start", after_at: 30 }, events).at).toBe(40);
    expect(firedBy({ wave: 1, edge: "start", blocked: true }, events)).toBeNull();
  });

  it("shows a visual with no `when` at once, and one with a `when` once it fires", () => {
    const ch = { show: [{ kind: "light" }, { kind: "checks", when: { migration: "split", line: "last" } }] };
    expect(shownAt(ch, []).map((s) => s.kind)).toEqual(["light"]);
    expect(shownAt(ch, [{ kind: "line", migration: "split", line: "last", at: 7 }]).map((s) => s.kind)).toEqual(["light", "checks"]);
  });
});

describe("facts in a chapter's lines", () => {
  const team = tour.chapters.find((c) => c.id === "team");

  it("fills the contrast from both plans' numbers", () => {
    expect(chapterLines(team, { teamPlanned: 3, planned: 82, of: 82 })).toEqual(["Team B changes one policy, and only team B is planned.", "Planned 3 of 82 · chapter 1: 82 of 82"]);
  });

  it("leaves a line out when a fact it names has no record, never showing 0", () => {
    expect(chapterLines(team, { planned: 82, of: 82 })).toEqual(["Team B changes one policy, and only team B is planned."]);
    expect(fill("{n} moved", {})).toBeNull();
    expect(fill("{n} refused", { n: 0 })).toBe("0 refused");
  });

  it("drops an epilogue row whose record is missing", () => {
    const rows = cardRows([{ label: "tag writes", text: "{writes}" }, { label: "recreated", text: "{recreated}" }], { writes: 86 });
    expect(rows).toEqual([{ label: "tag writes", text: "86" }]);
  });
});

describe("the live badge's lag", () => {
  const now = Date.parse("2026-10-17T17:00:00Z");
  it("counts from the newest line's time", () => {
    expect(lagText("2026-10-17T16:59:48Z", now, true)).toBe("last write 12 s ago");
    expect(lagText(now - 5 * 60_000, now, false)).toBe("last write 5 min ago");
  });
  it("says it waits for the job once the gap passes a minute while a migration runs", () => {
    expect(lagText(now - LAG_WAIT_MS - 1, now, true)).toBe("waiting for the job");
    expect(lagText(now - LAG_WAIT_MS - 1, now, false)).toBe("last write 1 min ago");
  });
  it("says nothing with no write to count from", () => {
    expect(lagText(null, now, true)).toBeNull();
  });
});

describe("a landed dot's provenance", () => {
  it("names the write, its time and its job", () => {
    expect(provenanceText({ outcome: "moved", tool: "live-mv", address: "aws_iam_role.team_0000_role", from: "tl54-terralith", to: "tl54-team-a", at: "2026-10-17T16:57:49.66896996Z", job: 3655 })).toBe(
      "live-mv retagged aws_iam_role.team_0000_role from tl54-terralith to tl54-team-a at 16:57:49.668 UTC · job #3655",
    );
  });
  it("names a stamp and a refusal in their own words, and leaves out a job no run names", () => {
    expect(provenanceText({ outcome: "stamped", tool: "live-import", address: "aws_ecs_cluster.main", to: "tl54-terralith", at: "2026-10-17T16:54:06.283Z" })).toBe("live-import stamped aws_ecs_cluster.main into tl54-terralith at 16:54:06.283 UTC");
    expect(provenanceText({ outcome: "refused", address: "aws_ecs_service.a", from: "x", to: "y", reason: "marker rewrite", at: "bad" })).toBe("live-mv refused to retag aws_ecs_service.a from x to y: marker rewrite");
  });
  it("reads the job number from a run's URL, and the tool from the record's change", () => {
    expect(jobNumber("http://forgejo:3000/a/b/actions/runs/3655")).toBe(3655);
    expect(jobNumber("https://gitlab.example/a/-/jobs/12")).toBe(12);
    expect(jobNumber(null)).toBeNull();
    expect(migrationTool("adopt")).toBe("live-import");
    expect(migrationTool("retag")).toBe("live-mv");
  });
});

describe("slowed playback", () => {
  it("is real time unless a person picks a slowed factor", () => {
    expect(SLOWED[0]).toEqual({ n: 1, words: "real time", stepMs: 0 });
    expect(stepMsFor(1)).toBe(0);
    expect(stepMsFor(4)).toBe(50);
    expect(SLOWED.slice(1).every((s) => s.words.startsWith("slowed ×"))).toBe(true);
  });
});
