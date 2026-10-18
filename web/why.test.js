import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chainView, letThrough, seconds, sourceLine, whyQuery, whyView } from "./why.js";

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

// #682: the chain, drawn from what chant 0.124.29 wrote for a resource shipped
// through a gate (src/__fixtures__/why-trace/, recorded from chant main; see
// src/why-trace.test.ts). The server adds each commit's subject and each work
// item's title from the document's nodes; the rest is chant's trace.
const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "__fixtures__", "why-trace", "intent-node.json"), "utf8"));
const subjects = { [recorded.trace.commits[0].sha]: "serve the app on 8081", [recorded.trace.commits[1].sha]: "the shop and W-001" };
const chained = (edit = (t) => t) => {
  const trace = structuredClone(recorded.trace);
  for (const c of trace.commits) {
    c.subject = subjects[c.sha];
    if (c.work) for (const w of c.work.items) w.title = "Serve the app on 8081";
  }
  return answer({ trace: edit(trace), chain: { full: true, floor: "0.124.29", note: null } });
};
const LINKED = recorded.trace.commits[0].sha;
const BASE = recorded.trace.commits[1].sha;
const DIGEST = recorded.trace.releases[0].releaseDigest;
const CHANGE_SET = recorded.trace.releases[0].gates[0].changeSet;

describe("chainView (#682)", () => {
  it("shows the chain for a resource shipped through a gate, each link with the line that opens its source", () => {
    const v = chainView(chained());
    expect(v.note).toBeNull();
    expect(v.commits.map((c) => [c.sha, c.subject])).toEqual([
      [LINKED.slice(0, 8), "serve the app on 8081"],
      [BASE.slice(0, 8), "the shop and W-001"],
    ]);
    const rows = v.commits[0].rows;
    expect(rows.map((r) => [r.label, r.text, r.missing])).toEqual([
      ["asked for by", "work:W-001", false],
      ["in the window of", "work:W-001", false],
      ["ci tag", `ci/green/${LINKED}`, false],
      ["release", "v1", false],
      ["gate", "let through by bob on cli at 2026-10-16T10:30:00.000Z", false],
      ["change set", `chant change-set show ${CHANGE_SET} --member delivery`, false],
      ["deploy prod", "app run run-9 at 2026-10-16T10:40:00.000Z", false],
      ["deploy staging", "app run run-1 at 2026-10-16T09:30:00.000Z", false],
    ]);
    expect(rows[0].meta).toBe("Serve the app on 8081");
    expect(rows[0].source.open).toBe(`git show ${LINKED}`);
    expect(rows[0].source.title).toContain("Chant-Record: work:W-001");
    // The window is listed apart and is never a link.
    expect(rows[1].source).toBeNull();
    expect(rows[1].meta).toBe("the commit fell in its window, which does not link them");
    expect(rows[2].source.open).toBe(`git show refs/tags/ci/green/${LINKED}`);
    expect(rows[2].meta).toBe("counts unsigned");
    expect(rows[3].meta).toBe("cut from this commit · cut by alice at 2026-10-16T10:00:00.000Z");
    expect(rows[3].source.open).toBe(`git show chant/lifecycle:_members/delivery/_releases/${DIGEST.replace(/:/g, "_")}.json`);
    expect(rows[4].meta).toBe("prod-release in prod");
    expect(rows[4].source.open).toBe("git show chant/lifecycle:_members/delivery/_gates/release.jsonl");
    expect(rows[5].source.open).toBe(`git show chant/lifecycle:_members/delivery/_change-sets/${CHANGE_SET.replace(/:/g, "_")}.json`);
    expect(rows[6].meta).toBe("release v1 · admitted by prod-release, let through by bob on cli at 2026-10-16T10:30:00.000Z · approved by bob");
    expect(rows[6].source.open).toBe("git show chant/lifecycle:_members/delivery/prod/releases.jsonl");
    expect(rows[7].meta).toBe("names no release · admitted by no gate resolution chant could find");
  });

  it("shows a missing link as missing, with chant's reason where it gives one", () => {
    const base = chainView(chained()).commits[1].rows;
    expect(base.filter((r) => r.missing).map((r) => [r.label, r.text, r.meta])).toEqual([
      ["asked for by", "missing", "no work item: the commit names none in a Chant-Record or Chant-Lease trailer"],
      ["ci tag", "no green tag", ""],
    ]);
    // It still shipped: v1 contains it.
    expect(base.find((r) => r.label === "release").meta).toContain(`contains this commit; cut from ${LINKED.slice(0, 8)}`);

    const v = chainView(
      chained((t) => {
        t.commits[0].work = { state: "wrong", items: [{ id: "work:W-404", node: null, source: { ref: LINKED, field: "Chant-Record", value: "work:W-404" } }], problems: [{ trailer: "Chant-Record", message: "work:W-404 is not a work item in this workspace" }] };
        t.commits[1].tag.ignored = [{ tag: `ci/green/${BASE}`, status: "unsigned", reason: "the tag carries no signature, and ci.green requires one" }];
        t.commits[1].releases = [];
        t.commits[1].deploys = [];
        t.releases[0].gates = [];
        return t;
      }),
    );
    const [linked, bare] = v.commits.map((c) => c.rows.filter((r) => r.missing));
    expect(linked.map((r) => [r.label, r.text, r.meta])).toEqual([
      ["asked for by", "work:W-404", "the commit names a work item chant could not take as its link · chant read no record with this id · Chant-Record: work:W-404 is not a work item in this workspace"],
      ["gate", "missing", "no release gate resolution names v1"],
    ]);
    expect(bare.map((r) => [r.label, r.text, r.meta])).toEqual([
      ["asked for by", "missing", "no work item: the commit names none in a Chant-Record or Chant-Lease trailer"],
      ["ci tag", "no green tag", `ci/green/${BASE} is unsigned: the tag carries no signature, and ci.green requires one`],
      ["release", "missing", "no release is cut from this commit or from one that has it in its history"],
      ["deploy", "missing", "no deploy record is built from this commit or from one that has it in its history"],
    ]);
  });

  it("says when part of the chain could not be read, and keeps the rest", () => {
    const v = chainView(chained((t) => ({ ...t, reasons: [{ code: "ledger-unreadable", message: "delivery's ledger on chant/lifecycle: bad object" }] })));
    expect(v.reasons).toEqual(["Part of the chain could not be read (ledger-unreadable): delivery's ledger on chant/lifecycle: bad object"]);
    expect(v.commits).toHaveLength(2);
    expect(chainView(chained((t) => ({ ...t, commits: [] }))).note).toBe("chant walked no commit for this region, so there is no chain to show.");
  });

  it("on a chant below 0.124.29 keeps today's view and says the chain needs 0.124.29", () => {
    const v = whyView(answer({ trace: null, chain: { full: false, floor: "0.124.29", note: "Why chain needs chant 0.124.29 or newer. This project has chant 0.124.28." } }));
    expect(v.decisions).toHaveLength(2);
    expect(v.chain).toEqual({ note: "Why chain needs chant 0.124.29 or newer. This project has chant 0.124.28.", reasons: [], commits: [], more: 0 });
    // A server before #682 sends no chain field, and the section draws none.
    expect(whyView(answer()).chain).toBeNull();
  });

  it("opens each kind of source with git, and words a gate resolution as 'let through by'", () => {
    expect(sourceLine({ ref: "work/W-001-serve-on-8081.md", field: "window", value: "worked" }).open).toBe("git show HEAD:work/W-001-serve-on-8081.md");
    expect(sourceLine(null)).toBeNull();
    expect(letThrough({ resolvedBy: "bob", channel: null, at: "2026-10-16T10:30:00.000Z" })).toBe("let through by bob at 2026-10-16T10:30:00.000Z");
  });
});
