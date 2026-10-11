import { describe, it, expect } from "vitest";
import { cardProgress, countsLine, progressLines, progressRows, progressTag, resourceLine } from "./terragucci-progress.js";

// #511: the progress words. Every mark is dated by the records read it came
// from; none says "live".
const NOW = new Date("2026-10-08T09:45:00Z");
const mark = (over = {}) => ({
  wave: 2,
  state: "applying",
  read: "2026-10-08T09:43:00.000Z",
  status: "in-flight",
  counts: { done: 1, "in-flight": 1, waiting: 0, "not-applied": 0 },
  resources: [
    { root: "envs/prod/orders", address: "module.service.aws_dynamodb_table.records[0]", action: "replace", status: "done", done_at: "2026-10-08T09:42:20.000Z" },
    { root: "envs/prod/orders", address: "module.service.aws_dynamodb_table.records[1]", action: "replace", status: "in-flight" },
  ],
  ...over,
});

describe("progress marks (#511)", () => {
  it("tags a card with its newest wave's status and the read's age", () => {
    const m = cardProgress([mark({ wave: 1, status: "done" }), mark()]);
    expect(m.wave).toBe(2);
    expect(progressTag(m, NOW)).toEqual({ text: "▶ wave 2 in flight · 2m", tone: "in-flight" });
    expect(cardProgress([])).toBeNull();
  });

  it("dates every line by the records read, and a done instance by when a read found it", () => {
    expect(progressLines(mark(), NOW)).toEqual([
      "wave 2 in flight, records read 09:43 UTC, 2m ago",
      "module.service.aws_dynamodb_table.records[0] (replace): done 09:42 UTC",
      "module.service.aws_dynamodb_table.records[1] (replace): in flight",
    ]);
    expect(resourceLine({ address: "a.b", action: "create", status: "not-applied" }, NOW)).toBe("a.b (create): not applied");
  });

  it("counts a wave the way terragucci's log line does", () => {
    expect(countsLine({ done: 2, "in-flight": 1, waiting: 2, "not-applied": 0 })).toBe("2 of 5 done, 1 in flight, 2 waiting");
    expect(countsLine({ done: 2, "in-flight": 0, waiting: 0, "not-applied": 3 })).toBe("2 of 5 done, 0 in flight, 0 waiting, 3 not applied");
  });

  it("says when there is no run view, and never paints one as live", () => {
    expect(progressRows({ run: { commit: "c", key: "k", present: false }, absent: "has no k" }, NOW)).toEqual({ head: "has no k", title: "", waves: [] });
    const rows = progressRows(
      {
        read: "2026-10-08T09:44:00Z",
        run: { commit: "d3e4f5a6b7c8d9e0", key: "p/runs/d3e4/run.json", present: true, html: "p/runs/d3e4/run.html" },
        watching: true,
        unmatched: [{ root: "envs/prod/payments", address: "module.service.aws_iam_role.worker" }],
        waves: [{ number: 2, state: "applying", read: "2026-10-08T09:43:00.000Z", counts: { done: 2, "in-flight": 1, waiting: 2, "not-applied": 0 }, resources: [] }],
      },
      NOW,
    );
    expect(rows.head).toBe("apply progress of d3e4f5a6b7c8, from terragucci's run view · asked again while a wave moves");
    expect(rows.head).not.toMatch(/\blive\b/);
    expect(rows.title).toContain("no card: envs/prod/payments: module.service.aws_iam_role.worker");
    expect(rows.waves[0]).toMatchObject({ text: "wave 2 applying: 2 of 5 done, 1 in flight, 2 waiting", read: "records read 09:43 UTC, 2m ago", tone: "in-flight" });
  });
});
