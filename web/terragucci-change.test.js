import { describe, expect, it } from "vitest";
import { readCardIds, readLabel, rootStates, viewCaption } from "./terragucci-change.js";

const roots = ["app", "edge", "network", "other"].map((name) => ({ member: "demo", name, path: name }));
const prAnswer = {
  roots,
  pull_request: {
    run: { pull_request: "201", finished: "2026-10-15T03:11:13.605Z", commit: "c9dfc649c704" },
    reads: [{ root: "app", upstream: "network", data: "network", outputs: "planned", unknown: ["http_proxy_port"] }],
    roots: ["app", "edge", "network"],
    waves: [
      { number: 1, roots: ["network"], state: "planned", review_digest: "jcs1-sha256:f8851fb619215c0eab", waits: false },
      { number: 2, roots: ["app"], state: "planned", review_digest: null, waits: true, replans_after: [1] },
      { number: 3, roots: ["edge"], state: "planned", review_digest: null, waits: true, replans_after: [2] },
    ],
  },
};
const run = (states, reads) => ({ run: { present: true, commit: "6b9f7e255f6f", updated: "2026-10-15T03:20:00.000Z" }, states, reads });

describe("rootStates (#569)", () => {
  it("puts each planned wave on its roots, and says which root the change leaves out", () => {
    const { stage, roots: r } = rootStates(prAnswer, null);
    expect(stage).toBe("pull-request");
    expect(r.network).toMatchObject({ wave: 1, state: "planned", tone: "plan", words: "wave 1 · planned", facts: ["plan f8851fb61921"] });
    expect(r.app.facts).toEqual(["plans again once wave 1 applies", "will wait for an approval"]);
    expect(r.other).toMatchObject({ state: "outside", words: "not in this change" });
  });
  it("shows a failed wave's roots failed and the waves before it applied", () => {
    const p = run(
      [
        { number: 1, state: "applied", roots: ["network", "other"], reads: [], totals: { update: 1 } },
        { number: 2, state: "failed", roots: ["app"], reads: [1], totals: { create: 1, update: 1 } },
        { number: 3, state: "not-started", roots: ["edge"], reads: [2] },
      ],
      [],
    );
    const { roots: r } = rootStates(prAnswer, p);
    expect(r.network).toMatchObject({ state: "applied", tone: "ok", facts: ["the wave applied 1 update"] });
    expect(r.app).toMatchObject({ state: "failed", tone: "bad", words: "wave 2 · failed", facts: ["planned 1 create · 1 update", "wave 1 stays applied"] });
    expect(r.edge).toMatchObject({ state: "not-started", tone: "idle", facts: [] });
  });
  it("names the plan a waiting wave waits on", () => {
    const p = run([{ number: 2, state: "waiting", roots: ["app"], reads: [1], digest: "jcs1-sha256:83b0533bb8085dfad2" }], []);
    expect(rootStates(prAnswer, p).roots.app).toMatchObject({ state: "waiting", tone: "wait", facts: ["approve plan 83b0533bb808"] });
  });
  it("gives each root of a composed run that failed part way its own outcome", () => {
    const p = run(
      [{ number: 1, state: "failed", roots: ["network"], reads: [], composed: { roots: ["network", "app"], members: [{ root: "network", module: "module.network", apply: "applied", state: "written" }, { root: "app", module: "module.app", apply: "failed", state: "written" }] } }],
      [{ root: "app", wave: 2, reads: ["network"], composed: { wave: 1, own_wave: 2, module: "module.app" } }],
    );
    const { roots: r } = rootStates(prAnswer, p);
    expect(r.network).toMatchObject({ wave: 1, state: "applied", words: "wave 1 · applied, composed", facts: ["applied; state written"] });
    expect(r.app).toMatchObject({ wave: 1, state: "failed" });
    expect(r.edge.state).toBe("outside");
  });
});

describe("readLabel (#569)", () => {
  it("says what is read and when it is known", () => {
    expect(readLabel({ from: "app", to: "network", outputs: "planned", unknown: ["http_proxy_port"] })).toBe("reads http_proxy_port from network: unknown until network applies");
    expect(readLabel({ from: "app", to: "network", outputs: "planned", unknown: [] })).toBe("reads network's planned outputs");
    expect(readLabel({ from: "app", to: "network", outputs: "applied", unknown: [] })).toBe("reads network's applied state");
    expect(readLabel({ from: "app", to: "network", outputs: "planned", unknown: ["subnet_id"], composed: 1 })).toBe("reads network in wave 1's composed run: subnet_id known once network's part applies");
  });
});

describe("readCardIds (#569)", () => {
  it("tries the block named after the root read when the run view names none", () => {
    expect(readCardIds({ roots }, { from: "edge", to: "app", data: null, stage: "apply" })[0]).toBe("demo/edge/data.terraform_remote_state.app");
    expect(readCardIds({ roots }, { from: "edge", to: "app", data: null, stage: "pull-request" })).toEqual([]);
  });
});

describe("viewCaption (#569)", () => {
  it("says which run the marks come from", () => {
    const now = new Date("2026-10-15T03:30:00Z");
    expect(viewCaption(prAnswer, null, now)).toBe("the plan of pull request #201 at 03:11 UTC: not merged yet, nothing applied");
    expect(viewCaption(prAnswer, run([{ number: 1, state: "applied", roots: ["network"], reads: [] }], []), now)).toBe("the run of merge 6b9f7e25, as of 03:20 UTC");
  });
});
