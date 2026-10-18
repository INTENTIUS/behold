import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flagsFrom, shownKey } from "../src/feature-flags.ts";
import { gatesFromStatus } from "../src/workspace-gates.ts";
import { flagMarks, flagRow, flagsFor, flagsHeader, gapLines, NODES_NOTE, pickEnv, STALE_WORDS, STATE_COLORS, stateWords, TURN_ON_NOTE } from "./feature-flags.js";

// #683: the flags drawn from what chant printed for the fixture workspace
// (src/__fixtures__/feature-flags), as the route answers it: new-checkout on
// in staging and off in prod, old-banner stale, and a release gate in staging
// whose change set turns new-checkout on.
const FIX = join(import.meta.dirname, "..", "src", "__fixtures__", "feature-flags");
const fixture = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const gatesOf = (name) => gatesFromStatus(fixture(name), "/ws").gates.map(({ dir: _dir, ...g }) => g);
const GATE = "web/release/promote";
const answer = {
  workspace: true,
  chant: "0.124.29",
  ...flagsFrom({
    status: fixture("status-staging.json"),
    env: "staging",
    gates: [
      { env: "staging", gates: gatesOf("status-staging.json") },
      { env: "prod", gates: gatesOf("status-prod.json") },
    ],
    shown: new Map([[shownKey("staging", GATE), fixture("change-set-show.json")]]),
    at: new Date("2026-10-17T00:00:00Z"),
  }),
};
const member = (id) => id.split("/")[0];
const IDS = ["web/CheckoutFunction", "web/BannerConfig", "api/Queue"];
const one = { ...answer, flags: answer.flags.filter((f) => f.id === "new-checkout") };

describe("flag marks on the graph (#683)", () => {
  it("marks a flagged member's cards on in staging and off in prod, and leaves other members alone", () => {
    const staging = flagMarks(one, "staging", IDS, member);
    expect(Object.keys(staging)).toEqual(["web/CheckoutFunction", "web/BannerConfig"]);
    expect(staging["web/CheckoutFunction"]).toMatchObject({ tag: "new-checkout: on", color: STATE_COLORS.on, stale: false });
    const prod = flagMarks(one, "prod", IDS, member);
    expect(prod["web/CheckoutFunction"]).toMatchObject({ tag: "new-checkout: off", color: STATE_COLORS.off });
    expect(prod["web/CheckoutFunction"].title).toContain(NODES_NOTE);
  });
  it("counts several flags on one card, and names the stale one", () => {
    const prod = flagMarks(answer, "prod", IDS, member);
    expect(prod["web/CheckoutFunction"]).toMatchObject({ tag: "2 flags: 1 on, 1 stale", stale: true });
    expect(prod["web/CheckoutFunction"].title).toContain(`old-banner (banner): on in prod, ${STALE_WORDS}`);
    expect(prod["web/CheckoutFunction"].title).toContain("new-checkout (newCheckout): off in prod");
  });
  it("draws nothing for a refusal, and picks the environment the tab asks for when it has it", () => {
    expect(flagMarks({ refusal: { error: "x" } }, "prod", IDS, member)).toEqual({});
    expect(pickEnv(answer, "prod")).toBe("prod");
    expect(pickEnv(answer, "local")).toBe("staging");
    expect(stateWords({ state: "default", value: null })).toBe("unset");
    expect(stateWords({ state: "set", value: "blue" })).toBe('"blue"');
  });
  it("lists a card's flags in the inspect pane", () => {
    expect(flagsFor(answer, "web", "staging").map((r) => r.text)).toEqual(["new-checkout: on in staging", `old-banner: on in staging, ${STALE_WORDS}`]);
    expect(flagsFor(answer, "api", "staging")).toEqual([]);
  });
});

describe("the Flags tab (#683)", () => {
  it("shows each flag's owner, work item and values", () => {
    const r = flagRow(answer.flags.find((f) => f.id === "new-checkout"), "prod");
    expect(r.title).toBe("web/new-checkout");
    expect(r.facts).toBe("param newCheckout · owner alice · work W-002 (in-progress)");
    expect(r.values.map((v) => [v.text, v.current])).toEqual([
      ["staging on", false],
      ["prod off", true],
    ]);
    expect(r.stale).toBeNull();
  });
  it("opens a flip waiting at a gate as that gate's change set, with no toggle", () => {
    const r = flagRow(answer.flags.find((f) => f.id === "new-checkout"), "staging");
    expect(r.waiting).toEqual([
      expect.objectContaining({ env: "staging", gate: GATE, text: `newCheckout false to true waits at gate ${GATE} in staging`, link: "change set 05c8b35bc9a3" }),
    ]);
    expect(r.waiting[0].title).toContain("web, on no graph node");
  });
  it("gives the lines a person runs to turn it on where nothing waits, and says what follows", () => {
    const r = flagRow(answer.flags.find((f) => f.id === "new-checkout"), "prod");
    expect(r.turnOn).toEqual([{ env: "prod", head: "To turn it on in prod:", lines: expect.arrayContaining([expect.stringContaining("chant workspace records amend new-checkout")]) }]);
    expect(TURN_ON_NOTE).toMatch(/does not change flags/);
  });
  it("marks the flag the stale-flag lint reports, with why", () => {
    const r = flagRow(answer.flags.find((f) => f.id === "old-banner"), "prod");
    expect(r.stale).toEqual({ text: STALE_WORDS, title: expect.stringContaining("W-001 implements d-001 (confirmed)") });
    expect(flagsHeader(answer)).toMatchObject({ text: `2 flags, 1 ${STALE_WORDS}`, tone: "quiet" });
  });
  it("says why nothing was read, and what is missing below the floor", () => {
    const h = flagsHeader({ refusal: { error: "Feature flags needs chant 0.124.29 or newer.", remedy: "Upgrade." }, degraded: "the graph draws no flag marks" });
    expect(h).toMatchObject({ tone: "refusal", text: "flags not read: Feature flags needs chant 0.124.29 or newer." });
    expect(h.title).toContain("Without it, the graph draws no flag marks.");
    expect(gapLines({ ...answer, unreadable: ["api"], refusals: [{ env: "prod", error: "boom", remedy: "r" }] }).map((g) => g.text)).toEqual(["chant could not read the flag records of api", "prod was not read: boom"]);
  });
});
