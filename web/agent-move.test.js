import { describe, expect, it } from "vitest";
import { AGENT_STACK_MAX, agentBanner, agentEntry, clockTime, wholeQuestion } from "./agent-move.js";

describe("agentBanner (#914)", () => {
  const at = new Date(2026, 9, 23, 14, 2, 11);
  it("says who asked what, when, and which request", () => {
    expect(agentBanner({ by: "claude-code", q: "attr:internetFacing=true", id: "7f3a" }, at).text).toBe(
      "Moved by an agent: claude-code asked `attr:internetFacing=true` at 14:02:11 (request 7f3a).",
    );
  });
  it("without a question, says the view moved", () => {
    expect(agentBanner({ by: "curl/8.7.1", q: "", id: "1" }, at).text).toBe("Moved by an agent: curl/8.7.1 moved this view at 14:02:11 (request 1).");
    expect(agentBanner({}, new Date("nope")).text).toBe("Moved by an agent: an agent moved this view.");
  });
  it("clockTime pads", () => {
    expect(clockTime(new Date(2026, 0, 1, 3, 4, 5))).toBe("03:04:05");
  });
});

describe("agentEntry (#914)", () => {
  it("pushes a numbered entry over the person's own", () => {
    const e = agentEntry({ other: 1 }, { id: "a" });
    expect(e).toEqual({ push: true, state: { other: 1, beholdMove: { id: "a", depth: 1 } } });
    expect(agentEntry(e.state, { id: "b" })).toEqual({ push: true, state: { other: 1, beholdMove: { id: "b", depth: 2 } } });
    expect(agentEntry(null, { id: "c" }).push).toBe(true);
  });
  it("stops pushing at the cap of 20, replacing the newest agent entry instead", () => {
    let state = null;
    let pushes = 0;
    for (let i = 0; i < 30; i++) {
      const e = agentEntry(state, { id: String(i) });
      if (e.push) pushes++;
      state = e.state;
    }
    expect(AGENT_STACK_MAX).toBe(20);
    expect(pushes).toBe(20);
    expect(state.beholdMove).toEqual({ id: "29", depth: 20 });
  });
});

describe("wholeQuestion (#908 stage 3)", () => {
  it("clears the question keys a question move leaves out and the tab holds", () => {
    const tab = { q: "kind:aws_", countBy: "module", plan: true, env: "prod", zoom: "resources" };
    expect(wholeQuestion({ q: "cap:internet-reachable(22)" }, tab)).toEqual({ q: "cap:internet-reachable(22)", countBy: null, plan: false });
    expect(wholeQuestion({ countBy: "kind" }, tab)).toEqual({ countBy: "kind", q: null, plan: false });
    expect(wholeQuestion({ q: "a", plan: true }, { q: "b", countBy: "kind" })).toEqual({ q: "a", plan: true, countBy: null });
  });

  it("leaves a move that asks no question, and keys the tab doesn't hold, as they are", () => {
    const tab = { q: "kind:aws_", countBy: "module" };
    expect(wholeQuestion({ zoom: "attributes" }, tab)).toEqual({ zoom: "attributes" });
    expect(wholeQuestion({ q: "a" }, { zoom: "resources" })).toEqual({ q: "a" });
    expect(wholeQuestion({ q: "a" }, undefined)).toEqual({ q: "a" });
  });
});
