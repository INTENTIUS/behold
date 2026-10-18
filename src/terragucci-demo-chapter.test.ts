import { describe, expect, it } from "vitest";
import { chapterOf, demoOf, type Demo } from "./terragucci-demo.ts";

// behold#631: a chant fan-out step's chapter of the story, demo.json `chapter: { n, of, headline }`.
describe("a demo step's chapter", () => {
  it("is read when whole, with a short name when the driver gives one", () => {
    expect(chapterOf({ n: 1, of: 4, headline: " A change to the shared network goes out to all 15 stacks " })).toEqual({ n: 1, of: 4, headline: "A change to the shared network goes out to all 15 stacks" });
    expect(chapterOf({ n: 2, of: 4, headline: "cluster-a breaks", short: "cluster-a breaks" })).toMatchObject({ short: "cluster-a breaks" });
  });
  it("is nothing when it is not one", () => {
    for (const v of [null, {}, { n: 0, of: 4, headline: "x" }, { n: 5, of: 4, headline: "x" }, { n: 1, of: 4, headline: "" }, { n: 1.5, of: 4, headline: "x" }]) expect(chapterOf(v)).toBeUndefined();
  });
  it("rides demoOf only when present, so a step without one reads as before", () => {
    const base = { cycle: 1, scenario: "fan-out", title: "t", step: "planned", label: "l", started_at: "2026-10-18T00:00:00Z", next: null, pull: 1, commit: null, about: null } as unknown as Demo;
    expect("chapter" in demoOf(base)).toBe(false);
    expect(demoOf({ ...base, chapter: { n: 1, of: 4, headline: "h" } } as Demo).chapter).toEqual({ n: 1, of: 4, headline: "h" });
  });
});
