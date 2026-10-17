import { describe, it, expect } from "vitest";
import { recordedWords, mergeLandings, liveBadge } from "./carve-narration.js";

describe("the carve export's narration (#712)", () => {
  it("says what the recording is", () => {
    expect(recordedWords({ src: "behold-terralith-14", recording: { kind: "carve", resources: 1041, recordedAt: Date.parse("2026-09-22T16:37:26Z") } })).toBe(
      "recorded carve of behold-terralith-14, 1,041 resources, recorded 2026-09-22, replayed",
    );
    expect(recordedWords({ src: "terralith", recording: { kind: "walkthrough" } })).toBe("recorded walkthrough of terralith, replayed");
  });
  it("puts first landings that queue together in one bubble, on the newest box", () => {
    const t = (e, at) => ({ key: `land:${e}`, estate: e, at, text: e });
    expect(mergeLandings([t("a", 1)])).toEqual(t("a", 1));
    const m = mergeLandings([t("x-a", 1), t("x-b", 2), t("x-c", 3)], { "x-a": "a", "x-b": "b", "x-c": "c" });
    expect(m.estate).toBe("x-c");
    expect(m.text).toMatch(/^a, b and c: their first resources land/);
  });
});

// behold#725: the live badge never says "live" beside the kiosk's "not updating" cue.
describe("the live badge while the kiosk can't read (behold#725)", () => {
  const live = { recording: { kind: "live" }, lastWriteAt: "2026-10-17T12:00:00.000Z", running: false };
  const t = (iso) => new Date(iso).getTime();

  it("says live, with the lag counting from now, while reads come back", () => {
    const b = liveBadge(live, { stale: false, since: null }, t("2026-10-17T12:00:30.000Z"));
    expect(b).toEqual({ word: "live", cls: "cx-badge-live", lag: "last write 30 s ago" });
  });

  it("says stale while the cue is up, its lag frozen at the last good read", () => {
    const since = new Date("2026-10-17T12:00:12.000Z");
    const b = liveBadge(live, { stale: true, since }, t("2026-10-17T12:05:00.000Z"));
    expect(b.word).toBe("stale");
    expect(b.cls).toBe("cx-badge-stale");
    expect(b.lag).toBe("last write 12 s ago");
    // Later still, the same words: frozen, not counting.
    expect(liveBadge(live, { stale: true, since }, t("2026-10-17T12:09:00.000Z")).lag).toBe("last write 12 s ago");
  });

  it("drops the lag when nothing was ever read, and goes back to live on recovery", () => {
    expect(liveBadge(live, { stale: true, since: null }).lag).toBe(null);
    expect(liveBadge(live, { stale: false, since: null }, t("2026-10-17T12:00:05.000Z")).word).toBe("live");
  });

  it("leaves a recording's badge alone", () => {
    expect(liveBadge({ recording: { kind: "carve" } }, { stale: true, since: null })).toEqual({ word: "recorded", cls: "cx-badge-recorded", lag: null });
  });
});
