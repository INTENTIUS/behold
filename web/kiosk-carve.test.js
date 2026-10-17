// #715: the kiosk takes the live carve's state only from its own origin's
// frame, and only when the frame says it is live; a kiosk whose frame never
// mounts the layer is told nothing and draws nothing new.
import { describe, it, expect } from "vitest";
import { liveCarveMessage, startKioskCarve } from "./kiosk-carve.js";
import { badgeText, recordedWords } from "./carve-narration.js";

const O = "http://127.0.0.1:4000";

describe("the kiosk's live carve (#715)", () => {
  it("reads only a live state from its own origin", () => {
    expect(liveCarveMessage({ origin: O, data: { type: "behold:dots-state", live: true } }, O)).toBe(true);
    expect(liveCarveMessage({ origin: O, data: { type: "behold:dots-state" } }, O)).toBe(false);
    expect(liveCarveMessage({ origin: "http://elsewhere", data: { type: "behold:dots-state", live: true } }, O)).toBe(false);
    expect(liveCarveMessage({ origin: O, data: { type: "behold:shot" } }, O)).toBe(false);
  });
  it("does nothing without Watch's elements", () => {
    expect(() => startKioskCarve({ frame: () => null, watch: null, eh: null, origin: O }).tellMode()).not.toThrow();
  });
  it("says live over a live carve and recorded over a replay", () => {
    const live = { src: "terralith", recording: { kind: "live", resources: 79, migration: "carve", from: "s3://reports" } };
    expect(badgeText(live)).toBe("live");
    expect(recordedWords(live)).toMatch(/^live carve of terralith, 79 resources, drawn from the estate rosters/);
    expect(badgeText({ src: "x", recording: { kind: "carve" } })).toBe("recorded");
  });
});
