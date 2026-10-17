import { describe, expect, it } from "vitest";
import { clockUtc, linkState, linkWords, noteBack, noteRead, onLinkChange, pageStaleness, readFailed, shareLink } from "./kiosk-link.js";

// behold#725: the kiosk's stopped-updating cue.
describe("the kiosk's link to behold (behold#725)", () => {
  const at = (s) => new Date(`2026-10-17T12:03:${s}Z`);

  it("says nothing while every read comes back", () => {
    const st = linkState();
    noteRead(st, "poll", true, at("04"));
    noteRead(st, "stream", true, at("05"));
    expect(linkWords(st)).toBe(null);
  });

  it("says since when nothing has come in once a read fails, keeping the last good read's time", () => {
    const st = linkState();
    noteRead(st, "poll", true, at("04"));
    noteRead(st, "poll", false, at("09"));
    expect(linkWords(st)).toBe("Not updating since 12:03:04 UTC, retrying");
    noteRead(st, "poll", false, at("14"));
    expect(linkWords(st)).toBe("Not updating since 12:03:04 UTC, retrying");
  });

  it("clears on the first good read after", () => {
    const st = linkState();
    noteRead(st, "poll", true, at("04"));
    noteRead(st, "stream", false, at("09"));
    noteRead(st, "stream", true, at("20"));
    expect(linkWords(st)).toBe(null);
    expect(clockUtc(st.lastGood)).toBe("12:03:20");
  });

  it("stays up while any one source is still failing", () => {
    const st = linkState();
    noteRead(st, "poll", false, at("09"));
    noteRead(st, "stream", false, at("09"));
    noteRead(st, "poll", true, at("10"));
    expect(linkWords(st)).toBe("Not updating since 12:03:10 UTC, retrying");
    noteBack(st, "stream");
    expect(linkWords(st)).toBe(null);
  });

  it("has words before any good read", () => {
    expect(linkWords(noteRead(linkState(), "poll", false, at("01")))).toBe("Not updating yet, retrying");
  });

  it("counts an unreachable behold as a failed read, and an answer with its own error as a read", () => {
    expect(readFailed({ error: "x", unreachable: true })).toBe(true);
    expect(readFailed(null)).toBe(false);
    expect(readFailed({ error: "terragucci reports are not configured" })).toBe(false);
    expect(readFailed({ demo: null })).toBe(false);
  });

  it("shares the page's link with the parts that say live, and tells them when it changes", () => {
    const st = linkState();
    let told = 0;
    const stop = onLinkChange(() => told++);
    shareLink(st);
    expect(pageStaleness()).toEqual({ stale: false, since: null });
    noteRead(st, "poll", true, at("04"));
    noteRead(st, "poll", false, at("09"));
    shareLink(st);
    expect(pageStaleness()).toEqual({ stale: true, since: at("04") });
    expect(told).toBe(2);
    stop();
    shareLink(linkState());
    expect(told).toBe(2);
  });
});
