import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { readCarve, carveShow } from "./dots-recording.js";
import { parentsOf } from "./dots-layout.js";
import { buildScene } from "./dots-scene.js";
import { carveStory, beatAt, tipsBetween, directorFocus, DIRECTOR, shortName } from "./dots-kiosk.js";

const text = gunzipSync(readFileSync(fileURLToPath(new URL("../scripts/dot-bench/carve-terralith-14.jsonl.gz", import.meta.url)))).toString("utf8");
const rec = readCarve(text);
const scene = buildScene(carveShow(rec, parentsOf(rec.roster)));
const story = carveStory(scene);
const src = "behold-terralith-14";

describe("the kiosk's carve beats (#712)", () => {
  it("reads the carve's facts off the recording", () => {
    expect(story.moves).toHaveLength(463);
    expect(story.refused).toBe(14);
    expect(story.dests).toHaveLength(8);
    expect(story.firstRefusal.ok).toBe(false);
  });
  it("starts on one estate, says what moves, and ends carved", () => {
    const start = beatAt(story, scene, 0);
    expect(start.phase).toBe("start");
    expect(start.title).toBe(`Carving ${src} into 8 team estates`);
    expect(start.next.text).toBe("463 moves left");
    expect(start.focus).toEqual({ kind: "source" });
    const mid = beatAt(story, scene, (story.start + story.end) / 2);
    expect(mid.phase).toBe("carve");
    expect(mid.line.text).toMatch(/^(\w+: \d+ resources moved, nothing recreated|.+refused.+)$/);
    const end = beatAt(story, scene, story.end);
    expect(end.title).toBe("Carved: 8 estates");
    expect(end.line.text).toMatch(/14 moves refused, so \d+ stay in behold-terralith-14/);
    expect(end.next.fraction).toBe(1);
    expect(end.focus).toEqual({ kind: "all" });
  });
  it("names a refusal while it is the latest move", () => {
    const r = story.firstRefusal;
    const b = beatAt(story, scene, r.start + 1);
    expect(b.line.tone).toBe("bad");
    expect(b.line.text).toContain(r.address);
  });
  it("tips each estate's first landing, the first refusal and the end, once each", () => {
    const all = tipsBetween(story, -1, story.end);
    expect(all.filter((t) => t.key.startsWith("land:"))).toHaveLength(8);
    expect(all.filter((t) => t.key === "refused")).toHaveLength(1);
    expect(all.at(-1).key).toBe("end");
    const halves = [...tipsBetween(story, -1, story.end / 2), ...tipsBetween(story, story.end / 2, story.end)];
    expect(halves.map((t) => t.key).sort()).toEqual(all.map((t) => t.key).sort());
    expect(all.find((t) => t.key === "refused").text).toMatch(/Nothing was written/);
  });
  it("holds a framing before moving to another estate, but not at the start or end", () => {
    const a = directorFocus(null, { kind: "estate", estate: "x" }, 0);
    expect(directorFocus(a, { kind: "estate", estate: "y" }, DIRECTOR.holdMs - 1)).toBe(a);
    expect(directorFocus(a, { kind: "estate", estate: "y" }, DIRECTOR.holdMs + 1).focus.estate).toBe("y");
    expect(directorFocus(a, { kind: "all" }, 10).focus.kind).toBe("all");
    expect(shortName(`${src}-billing`, src)).toBe("billing");
  });
});
