import { describe, expect, it } from "vitest";
import { focusRoots, frameSrc, factLines, pendingApproval, runPin } from "./kiosk.js";

const demo = (step, extra = {}) => ({ cycle: 1, scenario: "a-output", title: "t", step, label: "", started_at: "2026-10-15T03:00:00Z", next: null, pull: 7, commit: "abc12345", ...extra });
const answer = {
  roots: ["app", "edge", "network", "other"].map((name) => ({ member: "demo", name, path: name })),
  pull_request: { run: { pull_request: "7", commit: "abc12345" }, roots: ["app", "edge", "network"], reads: [], waves: [], totals: { update: 3 }, totals_roots: 3, blast: { roots: ["app", "edge", "network"], downstream: [] } },
};
const progress = (states, reads = []) => ({ run: { present: true, commit: "abc12345", updated: "2026-10-15T03:05:00Z" }, states, reads });

describe("focusRoots (#569)", () => {
  it("brings the pull request's roots forward while it is planned", () => {
    expect(focusRoots(demo("planned"), answer, null)).toEqual(["app", "edge", "network"]);
  });
  it("brings the wave that waits, applies or failed forward, and nothing once applied", () => {
    const p = progress([
      { number: 1, state: "applied", roots: ["network", "other"], reads: [] },
      { number: 2, state: "waiting", roots: ["app"], reads: [1] },
    ]);
    expect(focusRoots(demo("waiting"), answer, p)).toEqual(["app"]);
    expect(focusRoots(demo("applied"), answer, p)).toBe(null);
    expect(focusRoots(demo("reset"), answer, p)).toBe(null);
  });
  it("brings a failed wave forward with the waves before it that stay applied", () => {
    const p = progress([
      { number: 1, state: "applied", roots: ["network", "other"], reads: [] },
      { number: 2, state: "failed", roots: ["app"], reads: [1] },
      { number: 3, state: "not-started", roots: ["edge"], reads: [2] },
    ]);
    expect(focusRoots(demo("failed"), answer, p)).toEqual(["app", "network", "other"]);
  });
  it("leaves a root its wave plans no change in out (#569 review)", () => {
    const p = progress([{ number: 1, state: "waiting", roots: ["network", "other"], reads: [], digest: "d", totals: { create: 1 }, changed: ["network"] }]);
    expect(focusRoots(demo("waiting"), answer, p)).toEqual(["network"]);
    expect(pendingApproval(demo("waiting", { next: { action: "approve wave-1", at: null } }), p).roots).toEqual(["network"]);
  });
  it("takes every root of a composed run", () => {
    const p = progress([{ number: 1, state: "applying", roots: ["network"], reads: [], composed: { roots: ["network", "app", "edge"] } }]);
    expect(focusRoots(demo("applying"), answer, p)).toEqual(["network", "app", "edge"]);
  });
});

describe("frameSrc (#569)", () => {
  it("frames behold's own view, bare, told its host", () => {
    expect(frameSrc("http://localhost:4700")).toBe("/?embed=1&bare=1&zoom=resources&host=http%3A%2F%2Flocalhost%3A4700");
  });
});

describe("factLines (#569)", () => {
  it("says the pull request's totals and blast radius", () => {
    expect(factLines(demo("planned"), answer)).toEqual(["pull request #7 changes across 3 roots: 3 update", "blast radius: app, edge, network", "not touched: other"]);
  });
});

describe("runPin: the frame stays on the cycle's run (#569)", () => {
  it("draws the pull request's plan, then the cycle's commit up to applied, then the base", () => {
    expect(runPin(demo("pull-request"))).toBe("none");
    expect(runPin(demo("planned"))).toBe("none");
    for (const step of ["merged", "applying", "waiting", "approved", "failed", "resumed", "applied"]) expect(runPin(demo(step))).toBe("abc12345");
    expect(runPin(demo("reset"))).toBe("base");
    expect(runPin(demo("applied", { scenario: "base" }))).toBe("base");
    expect(runPin(demo("stalled", { commit: null }))).toBe("none");
    expect(runPin(null)).toBe(null);
  });
});
