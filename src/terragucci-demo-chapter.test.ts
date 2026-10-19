import { describe, expect, it } from "vitest";
import { chapterOf, demoOf, demoProblem, outsideOf, type Demo } from "./terragucci-demo.ts";

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

// behold#743: terragucci#1163's demo.json `outside`, an apply made outside the pipeline at this step.
describe("a demo step's apply made outside the pipeline", () => {
  const base = { cycle: 589, scenario: "fan-out-choudoufu", title: "t", step: "applying", label: "l", started_at: "2026-10-19T00:29:38Z", next: null, pull: 36, commit: null, about: null } as unknown as Demo;
  const outside = { who: "an operator", estate: "fo-app-01", command: "choudoufu apply -target=aws_sqs_queue.alarms", state: "applying", started_at: "2026-10-19T00:31:14.836Z", ended_at: null, resources: ["aws_sqs_queue.alarms"], log: [] };
  it("is read as the driver writes it", () => {
    expect(outsideOf(outside)).toEqual(outside);
    expect(demoOf({ ...base, outside } as unknown as Demo).outside).toEqual(outside);
  });
  it("is absent when null, missing or not of its form, so other steps read as before", () => {
    expect("outside" in demoOf(base)).toBe(false);
    for (const v of [null, undefined, {}, "x", { ...outside, state: "queued" }, { ...outside, estate: "" }, { ...outside, estate: 3 }]) {
      expect(outsideOf(v)).toBeUndefined();
      expect("outside" in demoOf({ ...base, outside: v } as unknown as Demo)).toBe(false);
    }
  });
  it("fills what is missing or of the wrong type, and keeps only the last lines of its log", () => {
    const o = outsideOf({ estate: "fo-app-01", state: "applied", started_at: "soon", resources: ["a", 3, " "], log: Array.from({ length: 30 }, (_, i) => `line ${i}`) });
    expect(o).toMatchObject({ who: "someone", command: "an apply", started_at: null, ended_at: null, resources: ["a"] });
    expect(o!.log).toHaveLength(20);
    expect(o!.log.at(-1)).toBe("line 29");
  });
  it("never refuses the narration it rides in", () => {
    expect(demoProblem({ ...base, outside: { state: 1 } })).toBeUndefined();
  });
});
