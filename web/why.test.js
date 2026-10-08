import { describe, expect, it } from "vitest";
import { seconds, whyQuery, whyView } from "./why.js";

const answer = (over = {}) => ({
  workspace: true,
  member: "delivery",
  ms: 4120,
  chant: "0.102.0",
  region: "region:delivery/src/app.ts",
  path: "delivery/src/app.ts",
  type: "file",
  answered: true,
  explained: true,
  decisions: [
    { id: "fix-002", title: "Where kept records wait", state: "proposed", relevance: "member", current: true, closed: false, lines: 0, decidedBy: null, decidedOn: null, review: "http://hud.test/decisions#fix-002" },
    { id: "fix-001", title: "How the app is deployed", state: "decided", relevance: "member", current: true, closed: false, lines: 0, decidedBy: "lex00", decidedOn: "2026-09-24", review: null },
  ],
  runs: [{ id: "conformance-run", lines: 4, commits: ["6b3865dd9936437b58ca8bf84db0ec5264d85f7b"], unit: null, by: "conformance", harness: "conformance", model: "none", outcome: "done", startedAt: "2026-01-01T00:00:00Z", endedAt: null, decisions: [] }],
  commits: [{ sha: "6b3865dd9936437b58ca8bf84db0ec5264d85f7b", subject: "the reader conformance workspace", date: "2026-10-07T23:45:37-06:00", author: "chant", pullRequest: null, run: "conformance-run" }],
  commitsTotal: 1,
  uncommittedLines: 0,
  gaps: [],
  ...over,
});

describe("whyQuery (#471)", () => {
  it("asks about the node when there is one, the member otherwise", () => {
    expect(whyQuery({ member: "delivery", node: "delivery/appService" })).toBe("/api/workspace/why?node=delivery%2FappService");
    expect(whyQuery({ member: "delivery" })).toBe("/api/workspace/why?member=delivery");
  });
});

describe("whyView (#471)", () => {
  it("names the decisions in chant's order, linking a proposed one to hud", () => {
    const v = whyView(answer());
    expect(v.headline).toBe("2 decisions cover delivery/src/app.ts.");
    expect(v.decisions.map((d) => d.id)).toEqual(["fix-002", "fix-001"]);
    expect(v.decisions[0].href).toBe("http://hud.test/decisions#fix-002");
    expect(v.decisions[1].href).toBeNull();
    expect(v.decisions[1].meta).toContain("decided by lex00 on 2026-09-24");
    expect(v.runs[0].meta).toContain("commit 6b3865dd");
    expect(v.commits[0]).toMatchObject({ sha: "6b3865dd", subject: "the reader conformance workspace" });
    expect(v.footer).toBe("read in 4.1 s · chant 0.102.0 · chant workspace graph --intent delivery/src/app.ts");
  });

  it("without hud, a proposed decision is its id and says where it is reviewed", () => {
    const d = answer().decisions[0];
    const v = whyView(answer({ decisions: [{ ...d, review: null }] }));
    expect(v.decisions[0].href).toBeNull();
    expect(v.decisions[0].note).toContain("under review in hud");
  });

  it("says when nothing covers it, and what chant couldn't account for", () => {
    const v = whyView(answer({ decisions: [], explained: false, uncommittedLines: 2, gaps: [{ code: "intent-why-no-decision", message: "no current decision governs it" }] }));
    expect(v.headline).toBe("No decision covers delivery/src/app.ts.");
    expect(v.gaps).toEqual(["2 lines aren't committed yet.", "no current decision governs it"]);
  });

  it("an old chant, a refusal and a missing workspace each say so in words", () => {
    expect(whyView(answer({ answered: false, chant: "0.95.0" })).headline).toContain("needs chant 0.102.0");
    expect(whyView({ workspace: true, refusal: { error: "nope", remedy: "do this" }, region: "delivery/x", ms: 600 }).refusal.error).toBe("nope");
    expect(whyView({ workspace: false, error: "not a workspace" }).refusal.error).toBe("not a workspace");
  });

  it("counts seconds the way the reading line does", () => {
    expect(seconds(950)).toBe("0.9 s");
    expect(seconds(29_400)).toBe("29 s");
  });
});
