// behold#571: the catalogue of log lines the kiosk annotates. Every pattern
// has to keep matching the line it was written for, no line may match two
// patterns, and the fixture runs (real CI logs) must come out with the
// features the kiosk shows.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANNOTATIONS, DOCS_BASES, PRODUCTS, TOUR, annotationOf, annotationsOf, docsUrl, findLine, jobMarks, runFeatures, stripStamp } from "./kiosk-annotations.js";

const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "terragucci-demo", "runs");
const runs = readdirSync(FIX).filter((f) => f !== "index.json").map((f) => JSON.parse(readFileSync(join(FIX, f), "utf8")));
const run = (id) => runs.find((r) => r.id === id);
const lines = runs.flatMap((r) => r.jobs.flatMap((j) => (j.steps || []).flatMap((s) => s.log || [])));

describe("the log annotations' catalogue (behold#571)", () => {
  it("has 48 entries, each with a unique id, a tool, a feature, one sentence, a docs page and a source", () => {
    expect(ANNOTATIONS).toHaveLength(48);
    expect(new Set(ANNOTATIONS.map((a) => a.id)).size).toBe(ANNOTATIONS.length);
    for (const a of ANNOTATIONS) {
      expect(PRODUCTS).toContain(a.product);
      expect(Object.keys(DOCS_BASES)).toContain(a.docs.product);
      expect(a.docs.path).toMatch(/^\/[\w\-/#.]*$/);
      expect(docsUrl(a)).toMatch(/^https:\/\/intentius\.io\/(terragucci|chant|behold|choudoufu)\//);
      expect(a.feature.length).toBeGreaterThan(0);
      expect(a.note.length).toBeLessThanOrEqual(160);
      expect(a.source).toMatch(/^(terragucci|chant|behold|choudoufu):[\w./-]+:\d+$/);
      expect(() => new RegExp(a.pattern)).not.toThrow();
    }
    for (const id of TOUR) expect(ANNOTATIONS.map((a) => a.id)).toContain(id);
  });

  it("matches every pattern against its own sample, and that sample against no other pattern", () => {
    const bad = ANNOTATIONS.filter((a) => {
      const hits = annotationsOf(a.sample);
      return hits.length !== 1 || hits[0].id !== a.id;
    }).map((a) => `${a.id}: ${annotationsOf(a.sample).map((x) => x.id).join(",") || "no match"}`);
    expect(bad).toEqual([]);
  });

  it("never matches one fixture line with two patterns", () => {
    const twice = lines.filter((l) => annotationsOf(l).length > 1).map((l) => `${annotationsOf(l).map((a) => a.id).join("+")}: ${l}`);
    expect(twice).toEqual([]);
  });

  it("knows the held wave's lines in the fixture runs", () => {
    const ids = new Set(lines.map((l) => annotationOf(l)).filter(Boolean).map((a) => a.id));
    for (const id of ["T04", "T05", "T07", "T08", "T09", "T11", "T12", "T13", "T14", "T20", "T21", "T36"]) expect(ids).toContain(id);
  });

  it("strips a runner's timestamp before matching", () => {
    expect(stripStamp("2026-10-15T20:53:35.5434274Z wave 2 of 3 applied")).toBe("wave 2 of 3 applied");
    expect(annotationOf("2026-10-15T20:53:35.5434274Z wave 2 of 3 applied").id).toBe("T30");
    expect(annotationOf("nothing anyone knows")).toBe(null);
  });

  it("chips a feature's first line in a job and dots the later ones", () => {
    const job = run(445).jobs.find((j) => j.name === "apply-comment");
    const marks = jobMarks(job.steps);
    const waves = [...marks.entries()].filter(([, m]) => m.a.id === "T04");
    expect(waves.length).toBe(3);
    expect(waves.map(([, m]) => m.first)).toEqual([true, false, false]);
    // Features, not patterns: T30 and T28 are one feature, so only the first of them is a chip.
    const applied = [...marks.values()].filter((m) => m.a.feature === "Apply result");
    expect(applied.filter((m) => m.first)).toHaveLength(1);
  });

  it("lists the run's features by tool, each with its first line", () => {
    const groups = runFeatures(run(444).jobs);
    expect(groups.map((g) => g.product)).toEqual(["terragucci", "chant"]);
    const t = groups[0].features.find((f) => f.a.id === "T11");
    expect(t).toMatchObject({ job: "apply-wave-2", feature: "Waiting for approval" });
    expect(run(444).jobs.find((j) => j.name === t.job).steps[t.step].log[t.n - 1]).toMatch(/waits for an approval of digest/);
    const hide = (l) => /wave 2/.test(l);
    expect(runFeatures(run(444).jobs, { hide }).flatMap((g) => g.features).some((f) => f.a.id === "T11")).toBe(false);
  });

  it("finds a run's first line of some patterns", () => {
    const f = findLine(run(445), ["T14"]);
    expect(f).toMatchObject({ job: "apply-comment", a: { id: "T14" } });
    expect(f.text).toMatch(/which is now spent$/);
    expect(findLine(run(443), ["T14"])).toBe(null);
  });
});
