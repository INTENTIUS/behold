import { describe, expect, it } from "vitest";
import { demoFrameOk } from "./kiosk.js";
import { CHANT_DEMO_READS, TERRAGUCCI_READS } from "./kiosk-source.js";

// behold#765: /chant-fanout under --chant-demo reads chant's records, so there is
// no terragucci answer naming the served repo, and a behold serving one checkout
// sends no viewRepos for repoParam to match. frameOk was false, the body took
// k-nograph and the graph pane folded away while the frame held all 15 cards.
const REPO = "chant-demo/fan-out-estate";

describe("whether chant's demo shows its graph (behold#765)", () => {
  it("one checkout served: the operator paired it with the demo, so the frame is the demo's repo", () => {
    expect(demoFrameOk(CHANT_DEMO_READS.own, true, REPO, null)).toBe(true);
    // Before the step names a repo too.
    expect(demoFrameOk(CHANT_DEMO_READS.own, true, null, null)).toBe(true);
  });
  it("several served (--repos): only when one of them is the step's repo", () => {
    expect(demoFrameOk(CHANT_DEMO_READS.own, false, REPO, ["fan-out-estate", "demo-fanout"])).toBe(true);
    expect(demoFrameOk(CHANT_DEMO_READS.own, false, REPO, ["demo-fanout"])).toBe(false);
  });
  it("not before /api/project has said which", () => {
    expect(demoFrameOk(CHANT_DEMO_READS.own, null, REPO, null)).toBe(false);
  });
  it("terragucci's loop keeps its own gate (its answer's project, or the served repo by name)", () => {
    expect(demoFrameOk(TERRAGUCCI_READS.own, true, REPO, null)).toBe(false);
  });
});
