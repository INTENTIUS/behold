import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { readWorkspace, setServedWorkspace, type Workspace } from "./workspace.ts";
import { hudAddress, hudReviewUrl, readWhy, whyFromIntent, whyRegion, WHY_COMMITS_SHOWN } from "./workspace-why.ts";
import { createWhyFixture, type WhyFixture } from "./workspace-why-fixture.ts";
import { isScheduledRead } from "./chant.ts";
import { labelRead } from "./read-stats.ts";
import { withReadSignal } from "./read-scheduler.ts";
import { readArgv } from "./workspace-reader.ts";

const ws = (members: Array<[string, string]>): Workspace => ({
  name: "w",
  root: "/w",
  file: "chant.workspace.json",
  chant: "0.102.0",
  members: members.map(([name, dir]) => ({ name, dir, kind: "chant", abs: `/w/${dir}`, reason: null, because: null })),
});

describe("whyRegion (#471)", () => {
  const w = ws([["delivery", "delivery"], ["root", "."]]);
  it("asks about a member by its declared directory", () => {
    expect(whyRegion(w, { member: "delivery" })).toEqual({ ok: true, region: "delivery", member: "delivery" });
    expect(whyRegion(w, { member: "root" })).toEqual({ ok: true, region: ".", member: "root" });
  });
  it("asks about a node by its id, inside a declared member", () => {
    expect(whyRegion(w, { node: "delivery/appService" })).toEqual({ ok: true, region: "delivery/appService", member: "delivery" });
  });
  it("refuses what the workspace doesn't declare, and never passes a page's path on", () => {
    expect(whyRegion(w, { member: "nope" }).ok).toBe(false);
    expect(whyRegion(w, { node: "nope/x" }).ok).toBe(false);
    expect(whyRegion(w, { node: "delivery/" }).ok).toBe(false);
    expect(whyRegion(w, { member: "delivery", node: "other/x" }).ok).toBe(false);
    expect(whyRegion(w, {}).ok).toBe(false);
  });
});

describe("the why read is a scheduled read (#471)", () => {
  it("takes a slot in the read budget and files under its own name", () => {
    const argv = readArgv("graph --intent", ["delivery"]);
    expect(argv).toEqual(["workspace", "graph", "--intent", "delivery", "--json"]);
    expect(isScheduledRead(argv)).toBe(true);
    expect(labelRead(argv, "/w")).toEqual({ dir: "/w", what: "workspace graph --intent", live: false });
  });
});

describe("hud links (#471)", () => {
  it("takes only an http or https address", () => {
    expect(hudAddress("http://localhost:7000/")).toBe("http://localhost:7000");
    expect(hudAddress("javascript:alert(1)")).toBeNull();
    expect(hudAddress("not a url")).toBeNull();
    expect(hudAddress(undefined)).toBeNull();
  });
  it("opens the decision the way arugula's workspace block does", () => {
    expect(hudReviewUrl("https://hud.example/", "fix-002")).toBe("https://hud.example/decisions#fix-002");
  });
});

describe("whyFromIntent (#471)", () => {
  const doc = (why: unknown, extra: Record<string, unknown> = {}) => ({
    contract: 1,
    chant: "0.102.0",
    region: "region:delivery/src/app.ts",
    nodes: [
      { id: "region:delivery/src/app.ts", kind: "region", path: "delivery/src/app.ts", type: "file" },
      { id: "record:decision/fix-001", kind: "decision", record: "fix-001", title: "How the app is deployed", state: "decided", decided_by: "lex00", decided_on: "2026-09-24" },
      { id: "record:decision/fix-002", kind: "decision", record: "fix-002", title: "Where kept records wait", state: "proposed" },
      { id: "commit:aaaa", kind: "commit", sha: "a".repeat(40), subject: "first", date: "2026-01-01T00:00:00Z", author: { name: "x" }, pullRequest: 12, joins: { run: "r1" } },
      { id: "commit:bbbb", kind: "commit", sha: "b".repeat(40), subject: "second", date: "2026-02-01T00:00:00Z", author: { name: "y" }, pullRequest: null, joins: { run: null } },
      { id: "run:r1", kind: "run", run: "r1", by: "agent", harness: { name: "claude" }, model: "m", outcome: "done", startedAt: "2026-01-01T00:00:00Z" },
    ],
    ...extra,
    why,
  });

  it("keeps chant's ranking and names each id from the same document", () => {
    const read = whyFromIntent(
      doc({
        lines: { start: 1, end: 6 },
        blame: [
          { start: 1, end: 3, commit: "commit:bbbb", sha: "b".repeat(40), runs: [], narrowedBy: null },
          { start: 4, end: 4, commit: "commit:aaaa", sha: "a".repeat(40), runs: ["run:r1"], narrowedBy: null },
          { start: 5, end: 6, commit: null, sha: null, runs: [], narrowedBy: null },
        ],
        decisions: [
          { decision: "record:decision/fix-002", relevance: "member", current: true, closed: false, lines: 0 },
          { decision: "record:decision/fix-001", relevance: "member", current: true, closed: false, lines: 0 },
        ],
        runs: [{ run: "run:r1", lines: 1, commits: ["commit:aaaa"], unit: { id: "w-1", kind: "work", node: null }, decisions: ["record:decision/fix-001"] }],
        explained: true,
        gaps: [{ code: "intent-why-uncommitted", message: "lines 5-6 aren't committed" }],
      }),
      "https://hud.example",
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const w = read.why;
    expect(w.path).toBe("delivery/src/app.ts");
    expect(w.decisions.map((d) => d.id)).toEqual(["fix-002", "fix-001"]);
    expect(w.decisions[0]).toMatchObject({ state: "proposed", review: "https://hud.example/decisions#fix-002" });
    expect(w.decisions[1]).toMatchObject({ state: "decided", review: null, decidedBy: "lex00" });
    expect(w.runs[0]).toMatchObject({ id: "r1", unit: "w-1", harness: "claude", commits: ["a".repeat(40)], decisions: ["fix-001"] });
    // Blame order, each commit once.
    expect(w.commits.map((c) => c.subject)).toEqual(["second", "first"]);
    expect(w.commits[1]).toMatchObject({ pullRequest: 12, run: "r1", author: "x" });
    expect(w.uncommittedLines).toBe(2);
    expect(w.gaps.map((g) => g.code)).toEqual(["intent-why-uncommitted"]);
  });

  it("links nothing without a hud address", () => {
    const read = whyFromIntent(doc({ lines: null, blame: [], decisions: [{ decision: "record:decision/fix-002", relevance: "member", current: true, closed: false, lines: 0 }], runs: [], explained: true, gaps: [] }));
    expect(read.ok && read.why.decisions[0].review).toBeNull();
  });

  it("lists a directory's history newest first, and counts what it leaves out", () => {
    const commits = Array.from({ length: WHY_COMMITS_SHOWN + 3 }, (_, i) => ({ id: `commit:${i}`, kind: "commit", sha: String(i).padStart(40, "0"), subject: `c${i}`, date: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, joins: {} }));
    const read = whyFromIntent({ contract: 1, chant: "0.102.0", region: "region:delivery", nodes: [{ id: "region:delivery", kind: "region", path: "delivery", type: "dir" }, ...commits], why: { lines: null, blame: [], decisions: [], runs: [], explained: false, gaps: [] } });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.why.commits).toHaveLength(WHY_COMMITS_SHOWN);
    expect(read.why.commits[0].subject).toBe(`c${WHY_COMMITS_SHOWN + 2}`);
    expect(read.why.commitsTotal).toBe(WHY_COMMITS_SHOWN + 3);
  });

  it("says when the chant is too old to write a why", () => {
    const read = whyFromIntent({ contract: 1, chant: "0.95.0", region: "region:delivery", nodes: [] });
    expect(read.ok && read.why.answered).toBe(false);
  });

  it("passes chant's own refusal on", () => {
    const read = whyFromIntent({ contract: 1, chant: "0.102.0", error: { code: "intent-region-invalid", message: "delivery/x is not a path" } });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("intent-region-invalid");
  });
});

// The real thing: a git repository with a chant workspace, a decided and a
// proposed decision constraining `delivery`, and a commit an agent run made.
describe("the why of a real workspace (#471)", () => {
  let fx: WhyFixture;
  let w: Workspace;
  beforeAll(async () => {
    fx = createWhyFixture();
    const read = await readWorkspace(fx.dir);
    if (!read.ok) throw new Error(read.refusal.error);
    w = read.workspace;
  }, 120_000);
  afterAll(() => {
    setServedWorkspace(undefined);
    fx?.dispose();
  });

  it("a member: the decisions covering it, and the run and commit behind it", async () => {
    const read = await readWhy(w, "delivery", "http://hud.test");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.why.answered).toBe(true);
    expect(read.why.explained).toBe(true);
    expect(read.why.decisions.map((d) => [d.id, d.state, d.relevance])).toEqual(
      expect.arrayContaining([
        ["fix-001", "decided", "member"],
        ["fix-002", "proposed", "member"],
      ]),
    );
    expect(read.why.decisions.find((d) => d.id === "fix-002")?.review).toBe("http://hud.test/decisions#fix-002");
    expect(read.why.decisions.find((d) => d.id === "fix-001")?.review).toBeNull();
    expect(read.why.runs.map((r) => r.id)).toEqual(["conformance-run"]);
    expect(read.why.commits.map((c) => c.subject)).toContain("the reader conformance workspace");
  }, 120_000);

  it("a node: chant resolves it to the file that declares it, and blames that file", async () => {
    const read = await readWhy(w, "delivery/appService");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.why.path).toBe("delivery/src/app.ts");
    expect(read.why.type).toBe("file");
    expect(read.why.decisions.map((d) => d.id).sort()).toEqual(["fix-001", "fix-002"]);
    expect(read.why.runs[0]).toMatchObject({ id: "conformance-run" });
    expect(read.why.runs[0].lines).toBeGreaterThan(0);
    expect(read.why.commits[0]).toMatchObject({ subject: "the reader conformance workspace", run: "conformance-run" });
  }, 120_000);

  it("a node chant doesn't know is chant's refusal, in words", async () => {
    const read = await readWhy(w, "delivery/nope");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.code).toBe("intent-region-invalid");
  }, 120_000);

  it("stops when the request that asked goes away", async () => {
    const gone = new AbortController();
    gone.abort(new Error("the page left"));
    await expect(withReadSignal(gone.signal, () => readWhy(w, "delivery"))).rejects.toThrow("the page left");
    const leaving = new AbortController();
    const started = Date.now();
    const read = withReadSignal(leaving.signal, () => readWhy(w, "delivery"));
    setTimeout(() => leaving.abort(new Error("picked something else")), 50);
    await expect(read).rejects.toThrow("picked something else");
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 120_000);

  it("GET /api/workspace/why answers for a member, and refuses one the workspace doesn't declare", async () => {
    const broadcaster = new Broadcaster();
    const app = createApp(
      { projectDir: fx.dir, workspace: w, hud: "http://hud.test", port: 0 },
      broadcaster,
      new FrameBuffer(),
      new OpRunner({ projectDir: fx.dir, broadcaster, onDone: () => {} }),
    );
    const ok = await app.request("/api/workspace/why?member=delivery");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, any>;
    expect(body.workspace).toBe(true);
    expect(body.member).toBe("delivery");
    expect(typeof body.ms).toBe("number");
    expect(body.decisions.map((d: any) => d.id)).toEqual(expect.arrayContaining(["fix-001", "fix-002"]));

    const bad = await app.request("/api/workspace/why?member=..%2F..");
    expect(bad.status).toBe(400);
  }, 120_000);
});
