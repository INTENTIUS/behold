import { describe, it, expect } from "vitest";
import { ago, clock, cornerOf, estateLine, hrefOf, legend, markLine, rootRows, runWords, stageCell, waveCards } from "./terragucci.js";

const NOW = new Date("2026-10-08T10:04:12Z");
const run = (over = {}) => ({ stage: "tf-drift", finished: "2026-10-08T06:04:12.000Z", commit: "5e6f7a8b9c0d", report: "p/r/tf-drift/report.html", ...over });

describe("terragucci marks are dated, never live (#490)", () => {
  it("says how old a run is", () => {
    expect(ago("2026-10-08T06:04:12Z", NOW)).toBe("4h ago");
    expect(ago("2026-10-08T10:03:50Z", NOW)).toBe("just now");
    expect(ago("2026-10-08T09:34:12Z", NOW)).toBe("30m ago");
    expect(ago("2026-10-04T10:04:12Z", NOW)).toBe("4d ago");
  });

  it("names the clock in UTC, with the date when it is not today", () => {
    expect(clock("2026-10-08T06:04:12Z", NOW)).toBe("06:04 UTC");
    expect(clock("2026-10-07T06:04:00Z", NOW)).toBe("2026-10-07 06:04 UTC");
  });

  it("reads a drift mark as terragucci would say it", () => {
    const m = { verdict: "drift", action: "delete", words: "deleted outside Terraform", addresses: ["module.service.aws_sqs_queue.jobs"], attributes: [], run: run() };
    expect(markLine(m, NOW)).toBe("drift found 06:04 UTC, 4h ago: deleted outside Terraform");
  });

  it("names a plan's pull request, its attributes and its instances", () => {
    const m = { verdict: "plan", action: "replace", words: "would replace", addresses: ["x.y[0]", "x.y[1]"], attributes: ["hash_key"], run: run({ stage: "tf-plan", pull_request: "11", finished: "2026-10-08T08:00:30Z" }) };
    expect(markLine(m, NOW)).toBe("plan on PR #11 08:00 UTC, 2h ago: would replace (hash_key) · 2 instances");
    expect(runWords(m.run, NOW)).toBe("plan on PR #11 08:00 UTC, 2h ago");
  });

  it("puts drift ahead of a waiting wave and a wave ahead of a plan in the corner", () => {
    const plan = { verdict: "plan" };
    expect(cornerOf([plan, { verdict: "drift" }]).tone).toBe("drift");
    expect(cornerOf([plan, { verdict: "wave" }]).tone).toBe("wave");
    expect(cornerOf([plan]).tone).toBe("plan");
  });

  it("tells 'no report' from 'no changes', and a failure from both", () => {
    expect(stageCell(undefined, "tf-plan", NOW)).toMatchObject({ text: "no report", tone: "none" });
    expect(stageCell({ run: run(), status: "planned", changes: 0 }, "tf-drift", NOW)).toMatchObject({ text: "none, 4h ago", tone: "ok" });
    expect(stageCell({ run: run(), status: "failed", error: "AccessDenied", changes: 0 }, "tf-drift", NOW)).toMatchObject({ text: "failed, 4h ago", tone: "failed", title: expect.stringContaining("AccessDenied") });
    expect(stageCell({ run: run({ stage: "tf-apply", wave: 2 }), status: "planned", changes: 1, approval: "waiting" }, "tf-apply", NOW)).toMatchObject({ text: "wave 2 waiting, 4h ago", tone: "wave" });
  });

  it("says where the picture comes from and that it is not live", () => {
    const answer = { project: "github.com/acme/shop", source: "/b", reports: 5, validation: { by: "structural" }, roots: [{ drift: { run: run() } }] };
    const l = legend(answer, NOW);
    expect(l.text).toBe("terragucci reports of github.com/acme/shop, not live · newest run 4h ago");
    expect(l.title).toContain("5 reports read from /b");
    expect(l.title).toContain("install @intentius/terragucci");
    expect(l.text).not.toMatch(/\blive\b(?<!not live)/);
  });

  it("sorts the roots that say something first", () => {
    const answer = {
      files: "/api/terragucci/file?key=",
      roots: [
        { path: "a", drift: { run: run(), status: "planned", changes: 0 } },
        { path: "b", drift: { run: run(), status: "planned", changes: 1 } },
        { path: "c", apply: { run: run({ stage: "tf-apply", wave: 2 }), status: "planned", changes: 0, approval: "waiting" } },
      ],
    };
    const rows = rootRows(answer, NOW);
    expect(rows.map((r) => r.path)).toEqual(["b", "c", "a"]);
    expect(rows[0].drift.href).toBe("/api/terragucci/file?key=p%2Fr%2Ftf-drift%2Freport.html");
  });
});

describe("a waiting wave is a gate card with a line to copy, never a button (#490)", () => {
  const answer = {
    files: "/api/terragucci/file?key=",
    waiting: [{ wave: 2, commit: "d3e4f5a6b7c8d9e0", since: "2026-10-08T09:31:00Z", roots: ["envs/staging/email", "envs/staging/orders"], set_digest: "jcs1-sha256:2e0fba16ce38925adf41", destroys: ["envs/staging/email: x (delete)"], report: "r/report.html", command: "npx terragucci approve wave-2 --plan jcs1-sha256:2e0fba16ce38925adf41", from: "estate" }],
  };
  it("carries what the wave holds and destroys, and how long it has waited", () => {
    const [c] = waveCards(answer, NOW);
    expect(c.title).toBe("wave 2 waits for an approval");
    expect(c.facts).toBe("since 09:31 UTC, 33m ago · 2 roots · commit d3e4f5a6b7c8 · plan 2e0fba16ce38");
    expect(c.destroys).toEqual(["envs/staging/email: x (delete)"]);
    expect(c.command).toBe("npx terragucci approve wave-2 --plan jcs1-sha256:2e0fba16ce38925adf41");
    expect(c).not.toHaveProperty("button");
    expect(c.note).toContain("behold does not approve");
  });

  it("links a key through the server, or as a relative path in an export", () => {
    expect(hrefOf({ files: "/api/terragucci/file?key=" }, "a/b.html")).toBe("/api/terragucci/file?key=a%2Fb.html");
    expect(hrefOf({ files: "../../" }, "a/b.html")).toBe("../../a/b.html");
  });

  it("quotes terragucci's estate page, and links it", () => {
    expect(estateLine({ files: "../../", estate: { drifted: 1, failed: 1, waiting: 1, html: "estate.html" } })).toEqual({
      text: "terragucci's estate page: 1 root drifted · 1 failed · 1 wave waiting",
      href: "../../estate.html",
    });
    expect(estateLine({})).toBeNull();
  });
});
