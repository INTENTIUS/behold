import { describe, expect, it } from "vitest";
import { WHAT_TEXT, WHAT_TEXT_CHANT, introLine, storyGate, whatLine, whatParts, whatTextFor, whatTool } from "./kiosk.js";

// behold#741: the #740 kiosk features (track, chapters, wedge, waiting modal,
// pacing, wave blocks, applied earlier, one tip at a time, the title line)
// are on for a chant repo's loop, or a terragucci repo whose demo.json step
// carries `chapter`. b-waves, failure and tg-planned-outputs carry none.
const step = (extra = {}) => ({ cycle: 3, scenario: "b-waves", step: "applying", pull: 12, ...extra });
const chapter = { n: 2, of: 4, headline: "cluster-a breaks" };

describe("the kiosk's story gate (behold#741)", () => {
  it("is chant's for a chant repo's loop, whatever the step carries", () => {
    expect(storyGate({ chantLoop: true, demo: step() })).toBe("chant");
    expect(storyGate({ chantLoop: true, terragucciRepo: false, demo: null })).toBe("chant");
  });
  it("is terragucci's for a terragucci repo only when the step carries a chapter", () => {
    expect(storyGate({ terragucciRepo: true, demo: step({ scenario: "fan-out", chapter }) })).toBe("terragucci");
    for (const scenario of ["b-waves", "failure", "tg-planned-outputs"]) expect(storyGate({ terragucciRepo: true, demo: step({ scenario }) })).toBe(null);
    expect(storyGate({ terragucciRepo: true, demo: step({ chapter: { headline: "no number" } }) })).toBe(null);
    expect(storyGate({ terragucciRepo: true, demo: null })).toBe(null);
  });
  it("is off for a repo that is neither, chapter or not", () => {
    expect(storyGate({ demo: step({ chapter }) })).toBe(null);
  });
});

describe("a terragucci story's title line (behold#741)", () => {
  it("names terragucci, its engine and its forge, with only the marks behold ships", () => {
    expect(whatLine({ scenario: "fan-out" }, "forgejo", { tools: ["opentofu"] })).toBe("terragucci · OpenTofu · on Forgejo · fan-out · live demo");
    const parts = whatParts({ scenario: "fan-out" }, "forgejo", { tools: ["opentofu"] });
    // No terragucci mark ships: its name alone.
    expect(parts[0].logo).toBeUndefined();
    expect(parts[1].logo).toBe("opentofu");
    expect(parts[2].logo).toBe("forgejo");
  });
  it("says Terraform by name alone, and no engine when none is declared", () => {
    expect(whatTool(["terraform"])).toEqual({ id: "terraform", name: "Terraform" });
    expect(whatTool([])).toBe(null);
    expect(whatLine({ scenario: "fan-out" }, null, { tools: [] })).toBe("terragucci · fan-out · live demo");
  });
  it("leaves chant's line as it was", () => {
    expect(whatLine({ scenario: "fan-out" }, "forgejo")).toBe("chant's pull-request pipeline · on Forgejo · fan-out · live demo");
  });
});

// behold#777: a phone names behold and whose pipeline it watches in one line under the title, and "What is this?" agrees.
describe("the phone's intro line and What is this? (behold#777)", () => {
  it("names behold and terragucci for a terragucci repo, in the popover too", () => {
    const line = introLine({ tg: true });
    expect(line).toMatch(/^behold, a live view of infrastructure/);
    expect(line).toMatch(/terragucci/);
    const pop = whatTextFor({ tg: true });
    expect(pop).toMatch(/^This is behold, a live view of infrastructure/);
    expect(pop).toMatch(/terragucci/);
  });
  it("keeps chant's words for chant's pipeline, and the plain words elsewhere", () => {
    expect(whatTextFor({ chant: true, tg: true })).toBe(WHAT_TEXT_CHANT);
    expect(whatTextFor({})).toBe(WHAT_TEXT);
    expect(introLine({ chant: true })).toMatch(/chant's pull-request pipeline/);
    expect(introLine({})).toMatch(/^behold, a live view of infrastructure/);
  });
  it("says nothing on a tool's page, which may not name the others", () => {
    expect(introLine({ tg: true, vendor: true })).toBeNull();
  });
});
