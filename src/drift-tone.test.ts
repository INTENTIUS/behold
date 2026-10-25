// behold#995: the one (status, read) table every card colours through.
import { describe, expect, it } from "vitest";
import { DRIFT_STATUSES, DRIFT_READS } from "./drift-line.ts";
import { DRIFT_TONE_TABLE, TABLE_READS, TABLE_STATUSES, toneFor } from "./drift-tone.ts";

describe("the (status, read) table", () => {
  it("has a cell for every status and every read chant names, and nothing else", () => {
    expect([...TABLE_STATUSES]).toEqual([...DRIFT_STATUSES]);
    expect([...TABLE_READS]).toEqual([...DRIFT_READS]);
    for (const s of TABLE_STATUSES) expect(Object.keys(DRIFT_TONE_TABLE[s]).sort()).toEqual([...TABLE_READS].sort());
  });

  it("paints the statuses as the overlay always has", () => {
    expect(toneFor({ status: "in-sync", read: "live-read" }).tone).toBe("good");
    expect(toneFor({ status: "drifted", read: "plan" }).tone).toBe("warn");
    expect(toneFor({ status: "pending", read: "state" }).tone).toBe("accent");
    expect(toneFor({ status: "missing", read: "live-read" }).tone).toBe("warn");
    expect(toneFor({ status: "unclaimed", read: "ownership" }).tone).toBe("warn");
    expect(toneFor({ status: "undeclared", read: "ownership" }).tone).toBe("warn");
    expect(toneFor({ status: "runtime", read: "live-read" }).tone).toBe("runtime");
    expect(toneFor({ status: "recorded", read: "state" }).tone).toBe("neutral");
    expect(toneFor({ status: "not-observed", read: "plan" }).tone).toBe("neutral");
  });

  it("an ownership read's in-sync is bound, green, and never says nothing changed (#404)", () => {
    const t = toneFor({ status: "in-sync", read: "ownership" });
    expect(t.tone).toBe("good");
    expect(t.label).toMatch(/ownership only/);
  });

  it("a state read is never green: recorded is neutral, and in-sync or drifted from state is a record chant refuses", () => {
    expect(toneFor({ status: "recorded", read: "state" })).toEqual({ tone: "neutral", label: "recorded (state only, not a live read)" });
    for (const status of ["in-sync", "drifted"]) {
      const t = toneFor({ status, read: "state" });
      expect(t.tone).toBe("neutral");
      expect(t.unknown).toBe(true);
    }
  });

  it("not-observed says its reason", () => {
    expect(toneFor({ status: "not-observed", read: "ownership", unobserved: { reason: "not-reached" } }).label).toBe("not observed: not-reached");
    expect(toneFor({ status: "not-observed", read: "ownership" }).label).toBe("not observed: no reason given");
  });

  it("an unknown status is neutral and labelled unknown", () => {
    expect(toneFor({ status: "quarantined", read: "plan" })).toEqual({ tone: "neutral", label: 'unknown status "quarantined"', unknown: true });
  });

  it("a known status from an unknown read is neutral and labelled unknown", () => {
    expect(toneFor({ status: "in-sync", read: "telepathy" })).toEqual({ tone: "neutral", label: 'in-sync from an unknown read "telepathy"', unknown: true });
  });

  it("is keyed on status and read only: the engine is not an input", () => {
    // A Pulumi refresh (path 2) colours through the same cells as any other read.
    expect(toneFor({ status: "drifted", read: "refresh" }).tone).toBe("warn");
    expect(toneFor({ status: "in-sync", read: "refresh" }).tone).toBe("good");
    expect(toneFor.length).toBe(1);
  });
});
