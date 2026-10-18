import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { setServedWorkspace, type Workspace } from "./workspace.ts";
import { CHANT_FLOORS, CI_LIST_CHANT_FLOOR, PROMOTION_ORDER_CHANT_FLOOR, RELEASE_COLUMN_CHANT_FLOOR, RELEASE_LIST_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { gatesFromStatus } from "./workspace-gates.ts";
import { laneFloorRefusal, laneFrom, promotionOrder, readTrunkLane, releaseColumn, releaseMembers, type TrunkLane } from "./trunk-lane.ts";
import { C1, C2, C3, C4, R1, R2, R3 } from "./trunk-lane-fixture.ts";
import { WorkspaceReadError, workspaceReader, type WorkspaceDocument } from "./workspace-reader.ts";
import ciListSchema from "./trunk-lane-schemas/ci-list.schema.json" with { type: "json" };
import releasesSchema from "./trunk-lane-schemas/releases.schema.json" with { type: "json" };
import statusSchema from "./trunk-lane-schemas/status.schema.json" with { type: "json" };

// #680, #692. The fixtures are what chant main at 08334f407 (which ships the
// 0.124.29 fields and still calls itself 0.124.28) printed for the workspace
// src/trunk-lane-fixture.ts makes: member `web` promoting staging then prod
// (not alphabetical), four trunk commits (two green, one green then revoked,
// one undecided), and three releases: v1 from the first, running in prod; v2
// from the second with v1's image digest (config-only), running in staging,
// with a gate in prod waiting on its commit; v3 from the revoked commit with a
// new image digest, running component api in staging, its release gate in prod
// superseded. One hand edit, still valid against chant's schema: work items on
// three commits (chant#4029 needs a declared work kind to write them). The
// schemas in src/trunk-lane-schemas/ are chant's, from the same commit.
// status.schema.json was refreshed from chant main at 0689d28f0 for #683,
// which only adds featureFlags.

const FIX = join(import.meta.dirname, "__fixtures__", "trunk-lane");
const fixture = (name: string): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, name), "utf8")) as WorkspaceDocument;

/** A document as chant 0.124.28 prints it: without the fields chant#4033 and chant#4043 add in 0.124.29. */
function as124_28(doc: WorkspaceDocument): WorkspaceDocument {
  const d = structuredClone(doc) as Record<string, any>;
  for (const r of d.releases ?? []) delete r.revoked;
  for (const m of d.members ?? []) {
    for (const e of m.environments ?? []) for (const r of e.releases ?? []) for (const k of ["releaseDigest", "releaseLabel", "revoked"]) delete r[k];
    for (const g of m.gates ?? []) {
      if (g.revoked) g.state = "pending";
      delete g.revoked;
    }
  }
  return d as WorkspaceDocument;
}

describe("the recorded documents are chant's (#680)", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  it.each([
    ["ci-list.json", ciListSchema],
    ["status-staging.json", statusSchema],
    ["status-prod.json", statusSchema],
    ["release-list.json", releasesSchema],
  ])("%s validates against chant's schema", (name, schema) => {
    const validate = ajv.compile(schema);
    expect(validate(fixture(name)), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("the lane's floors (#680, #691)", () => {
  it("registers one floor per read, each 0.124.28", () => {
    expect([CI_LIST_CHANT_FLOOR, RELEASE_LIST_CHANT_FLOOR, PROMOTION_ORDER_CHANT_FLOOR]).toEqual(["0.124.28", "0.124.28", "0.124.28"]);
    for (const read of ["trunk commits", "release list", "promotion order"]) expect(CHANT_FLOORS).toContain(floorFor(read));
  });
  it("registers the release column's floor, 0.124.29, which degrades the column and refuses nothing (#692)", () => {
    expect(RELEASE_COLUMN_CHANT_FLOOR).toBe("0.124.29");
    expect(floorFor("release column")).toMatchObject({ floor: "0.124.29", degraded: expect.stringMatching(/release list alone/) });
    expect(CHANT_FLOORS).toContain(floorFor("release column"));
    expect(laneFloorRefusal("0.124.28")).toBeUndefined();
  });
  it("refuses a chant below them by the first read it lacks, and passes one at them", () => {
    expect(laneFloorRefusal("0.124.24")).toEqual({
      error: "Trunk commits needs chant 0.124.28 or newer. This project has chant 0.124.24.",
      code: "chant-too-old",
      remedy: "Upgrade @intentius/chant to 0.124.28 or newer in the project.",
    });
    expect(laneFloorRefusal("0.124.28")).toBeUndefined();
    expect(laneFloorRefusal(undefined)).toBeUndefined();
  });
});

/** The lane joined from the fixtures, in the order chant declared; `old` reads them as chant 0.124.28 prints them. */
function lane({ old = false, releases = fixture("release-list.json") }: { old?: boolean; releases?: WorkspaceDocument } = {}): TrunkLane {
  const read = (doc: WorkspaceDocument) => (old ? as124_28(doc) : doc);
  const statuses = ["staging", "prod"].map((env) => {
    const status = read(fixture(`status-${env}.json`));
    const gates = gatesFromStatus(status, "/ws");
    if (!gates.ok) throw new Error(gates.refusal.error);
    return { env, canary: false, members: ["web"], status, gates: gates.gates };
  });
  return laneFrom({ ci: fixture("ci-list.json"), statuses, releaseLists: [{ member: "web", doc: read(releases) }], order: "promotion", full: !old, at: new Date("2026-10-16T00:00:00Z") });
}

describe("laneFrom (#680)", () => {
  it("lists the trunk's commits newest first, each green, revoked or undecided", () => {
    const l = lane();
    expect(l.trunk).toEqual({ branch: "main", ref: "refs/heads/main", window: "3650d", since: null, require: ["test"] });
    expect(l.commits.map((c) => [c.sha, c.state])).toEqual([
      [C4, "undecided"],
      [C3, "revoked"],
      [C2, "green"],
      [C1, "green"],
    ]);
    const revoked = l.commits[1];
    expect(revoked.revoked).toEqual({ phase: "test", run: { name: "test", url: "https://github.com/acme/app/actions/runs/113", conclusion: "failure" } });
    expect(revoked.phases).toEqual([{ phase: "test", result: "fail", runs: [{ name: "test", url: "https://github.com/acme/app/actions/runs/113", conclusion: "failure" }] }]);
  });

  it("keeps each commit's work items as chant#4029 links them", () => {
    expect(lane().commits.map((c) => c.work && [c.work.state, c.work.ids, c.work.problems.length])).toEqual([
      ["linked", ["task:12"], 0],
      ["unlinked", [], 0],
      ["wrong", [], 1],
      null,
    ]);
  });

  it("has one lane per environment, in promotion order, each with what it runs and what waits", () => {
    const [staging, prod] = lane().environments;
    expect(staging).toMatchObject({
      env: "staging",
      releases: [
        { member: "web", label: "v3", commit: C3, listed: true, components: ["api"], cutBy: "github:alice", approver: null, rollback: ["chant components rollback staging --component api"] },
        { member: "web", label: "v2", commit: C2, listed: true, components: ["web"], cutBy: "github:alice", approver: null, rollback: [] },
      ],
      deploys: [],
      waiting: [],
      superseded: [],
    });
    expect(prod.releases).toEqual([expect.objectContaining({ label: "v1", commit: C1, approver: "github:alice" })]);
    expect(prod.waiting).toEqual([
      expect.objectContaining({ key: "web/web/promote", env: "prod", gitSha: C2, runId: "run-9", changeSet: expect.stringMatching(/^sha256:4b5e57f6/), commitState: "green", approve: expect.stringMatching(/^chant approve web promote --env prod --plan sha256:/) }),
    ]);
  });

  it("places each commit where it is: running in an environment, or waiting at a gate in one", () => {
    const at = new Map(lane().commits.map((c) => [c.sha, c.where]));
    expect(at.get(C1)).toEqual([{ env: "prod", what: "runs" }]);
    expect(at.get(C2)).toEqual([
      { env: "staging", what: "runs" },
      { env: "prod", what: "waits", gate: "web/web/promote" },
    ]);
    expect(at.get(C3)).toEqual([{ env: "staging", what: "runs" }]);
  });

  it("names a deploy record no release covers, and says nothing it was not told", () => {
    const status = fixture("status-prod.json");
    const l = laneFrom({
      ci: fixture("ci-list.json"),
      statuses: [{ env: "prod", canary: false, members: ["web"], status, gates: [] }],
      releaseLists: [],
      order: "promotion",
      full: true,
      at: new Date(),
    });
    expect(l.environments[0].releases).toEqual([]);
    expect(l.environments[0].deploys).toEqual([
      expect.objectContaining({ component: "web", gitSha: C1, listed: true, approver: "github:alice", runId: "run-1", release: { releaseDigest: R1, label: "v1" }, rollback: null }),
    ]);
    // An environment with no deploy record at all is empty, not guessed at.
    const bare = laneFrom({ ci: fixture("ci-list.json"), statuses: [{ env: "dev", canary: false, members: [], status, gates: [] }], releaseLists: [], order: "env", full: true, at: new Date() });
    expect(bare.environments[0]).toMatchObject({ env: "dev", releases: [], deploys: [], waiting: [] });
  });

  it("keeps chant's refusals: no ci.green, and a member whose releases can't be read", () => {
    const l = laneFrom({
      ci: { $schema: "x", contract: 1, chant: "0.124.28", error: { code: "ci-green-undeclared", message: "the workspace declares no ci.green" } },
      statuses: [],
      releaseLists: [{ member: "web", doc: { contract: 1, chant: "0.124.28", error: { code: "ledger-unreadable", message: "no chant/lifecycle" } } }],
      order: "env",
      full: true,
      at: new Date(),
    });
    expect(l.trunk).toBeNull();
    expect(l.trunkRefusal).toMatchObject({ code: "ci-green-undeclared", error: "chant ci list: the workspace declares no ci.green" });
    expect(l.releaseRefusals).toEqual([{ member: "web", refusal: expect.objectContaining({ code: "ledger-unreadable" }) }]);
  });
});

describe("the release column (#692)", () => {
  it("renders for two releases across two environments: each with its commit, its cut and where it runs and waits", () => {
    const l = lane();
    expect(l.releaseColumn).toEqual({ full: true, floor: "0.124.29" });
    expect(l.releases.map((r) => [r.label, r.commit, r.runs])).toEqual([
      ["v3", C3, [{ env: "staging", components: ["api"] }]],
      ["v2", C2, [{ env: "staging", components: ["web"] }]],
      ["v1", C1, [{ env: "prod", components: ["web"] }]],
    ]);
    const [, v2, v1] = l.releases;
    expect(v2).toMatchObject({ member: "web", releaseDigest: R2, listed: true, artifacts: 1, cut: { by: "github:alice", at: "2026-10-03T09:00:00Z", signature: { status: "unsigned" } }, revoked: null });
    // Promotion moves v2 from staging to prod, where a gate waits on its commit; v1 runs in the last environment.
    expect(v2).toMatchObject({ next: "prod", waits: [{ env: "prod", gate: "web/web/promote", state: "pending" }] });
    expect(v1).toMatchObject({ next: null, waits: [] });
    // Each commit names the releases cut from it.
    expect(l.commits.map((c) => c.cuts.map((x) => x.label))).toEqual([[], ["v3"], ["v2"], ["v1"]]);
  });

  it("puts the environments in the declared order, not alphabetical order, and a release's environments too", () => {
    expect(["staging", "prod"]).not.toEqual(["staging", "prod"].sort());
    // v2 promoted to prod too: release list names its environments sorted by env (prod, staging).
    const releases = fixture("release-list.json") as Record<string, any>;
    releases.releases[1].environments = [{ env: "prod", components: ["web"] }, { env: "staging", components: ["web"] }];
    const l = lane({ releases });
    expect(l.environments.map((e) => e.env)).toEqual(["staging", "prod"]);
    expect(l.releases[1].runs.map((r) => r.env)).toEqual(["staging", "prod"]);
    expect(l.releases[1].next).toBeNull();
  });

  it("marks a release config-only when its artifact digests equal the previous release's, and not when one changed", () => {
    const [v3, v2, v1] = lane().releases;
    expect(v2).toMatchObject({ configOnly: true, previous: { releaseDigest: R1, label: "v1" } });
    expect(v3).toMatchObject({ configOnly: false, previous: { releaseDigest: R2, label: "v2" } });
    // The oldest has nothing to compare with.
    expect(v1).toMatchObject({ configOnly: null, previous: null });
  });

  it("finds the previous release by the commit's place in the trunk, then release list's order, and never marks a release with no artifacts", () => {
    const image = (d: string) => [{ component: "web", kind: "image", path: "web/Dockerfile", digest: d }];
    const rel = (digest: string, commit: string, artifacts: unknown[]) => ({ releaseDigest: digest, label: digest.slice(-2), commit, artifactDigests: artifacts, cuts: [], environments: [] });
    const OLD = "f".repeat(40);
    const sha = (n: string) => `sha256:${n.repeat(64)}`;
    // Listed newest cut first, but cut out of trunk order: the cut from C1 after the one from C2.
    const doc = { releases: [rel(sha("1"), C1, image("x")), rel(sha("2"), C2, image("x")), rel(sha("3"), OLD, []), rel(sha("4"), OLD, image("x"))] } as WorkspaceDocument;
    const rows = releaseColumn([{ member: "web", doc }], [{ sha: C2 }, { sha: C1 }], [], true);
    expect(rows.map((r) => [r.releaseDigest, r.previous?.releaseDigest ?? null, r.configOnly, r.listed])).toEqual([
      [sha("2"), sha("1"), true, true],
      [sha("1"), sha("3"), false, true],
      [sha("3"), sha("4"), null, false],
      [sha("4"), null, null, false],
    ]);
  });

  it("marks a revoked release with chant's tag and the line that rolls it back, and its release gate as superseded", () => {
    const l = lane();
    const v3 = l.releases[0];
    expect(v3.revoked).toEqual({
      tag: `ci/revoked/${C3}`,
      tagged: "2026-10-05T00:00:00Z",
      phase: "test",
      run: { name: "test", url: "https://github.com/acme/app/actions/runs/113", conclusion: "failure" },
      signer: null,
      rollback: ["chant components rollback staging --component api"],
    });
    expect(v3).toMatchObject({ next: null, waits: [{ env: "prod", gate: "web/release/promote", state: "superseded" }], cut: { signature: { status: "unverified" } } });
    const prod = l.environments[1];
    expect(prod.superseded).toEqual([expect.objectContaining({ key: "web/release/promote", releaseDigest: R3, gitSha: C3, runId: "run-12", revoked: expect.objectContaining({ phase: "test" }) })]);
    // A superseded gate is never one that waits to be approved.
    expect(prod.waiting.map((g) => g.key)).toEqual(["web/web/promote"]);
  });

  it("on chant 0.124.28 draws the column from release list alone, with no revoked mark", () => {
    const l = lane({ old: true });
    expect(l.releaseColumn).toEqual({ full: false, floor: "0.124.29" });
    expect(l.releases.map((r) => [r.label, r.configOnly, r.revoked])).toEqual([
      ["v3", false, null],
      ["v2", true, null],
      ["v1", null, null],
    ]);
    expect(l.environments.flatMap((e) => e.superseded)).toEqual([]);
    expect(l.environments.flatMap((e) => e.releases.flatMap((r) => r.rollback))).toEqual([]);
    // chant 0.124.28 reads v3's release gate as pending: the column says what chant says.
    expect(l.releases[0].waits).toEqual([{ env: "prod", gate: "web/release/promote", state: "pending" }]);
    // The same documents from a newer chant, read below the floor, read the same way.
    const statuses = ["staging", "prod"].map((env) => {
      const status = fixture(`status-${env}.json`);
      const gates = gatesFromStatus(status, "/ws");
      if (!gates.ok) throw new Error(gates.refusal.error);
      return { env, canary: false, members: ["web"], status, gates: gates.gates };
    });
    const below = laneFrom({ ci: fixture("ci-list.json"), statuses, releaseLists: [{ member: "web", doc: fixture("release-list.json") }], order: "promotion", full: false, at: new Date() });
    expect(below.releases.map((r) => r.revoked)).toEqual([null, null, null]);
    expect(below.environments[0].deploys).toEqual([]);
  });
});

describe("promotion order and release members (#680)", () => {
  it("reads the members' promotion order, and asks release list only of members that declare environments", () => {
    const status = fixture("status-prod.json");
    expect(promotionOrder(status)).toEqual([
      { env: "staging", canary: false, members: ["web"] },
      { env: "prod", canary: false, members: ["web"] },
    ]);
    expect(releaseMembers(status)).toEqual([{ name: "web", dir: "web" }]);
    const merged = { members: [{ name: "a", promotionOrder: [{ name: "dev", canary: false }, { name: "prod", canary: false }] }, { name: "b", promotionOrder: [{ name: "dev", canary: false }, { name: "eu", canary: true }, { name: "prod", canary: false }] }, { name: "c", promotionOrder: null }] };
    expect(promotionOrder(merged)).toEqual([
      { env: "dev", canary: false, members: ["a", "b"] },
      { env: "prod", canary: false, members: ["a", "b"] },
      { env: "eu", canary: true, members: ["b"] },
    ]);
  });
});

describe("readTrunkLane (#680)", () => {
  const ws: Workspace = { name: "acme", root: "/ws", file: "chant.workspace.json", chant: "0.124.28", members: [] };
  /** A transport that answers from the fixtures and records each call. */
  function transport() {
    const calls: { argv: string[]; dir?: string }[] = [];
    const answer = (argv: string[]): WorkspaceDocument => {
      const line = argv.join(" ");
      if (line === "workspace status staging --json") return fixture("status-staging.json");
      if (line === "workspace status prod --json") return fixture("status-prod.json");
      if (line === "ci list --json") return fixture("ci-list.json");
      if (line === "release list --json") return fixture("release-list.json");
      throw new Error(`unexpected chant ${line}`);
    };
    return {
      calls,
      run: async (argv: string[], options?: { dir?: string }) => {
        calls.push({ argv, ...(options?.dir !== undefined ? { dir: options.dir } : {}) });
        return { status: 0, stdout: JSON.stringify(answer(argv)), stderr: "" };
      },
    };
  }

  it("reads status once per environment, ci list at the root and release list in each member, through the reader", async () => {
    const t = transport();
    const read = await readTrunkLane(ws, { env: "prod", reader: workspaceReader(t) });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.lane.environments.map((e) => e.env)).toEqual(["staging", "prod"]);
    expect(read.lane.order).toBe("promotion");
    expect(t.calls).toEqual(
      expect.arrayContaining([
        { argv: ["workspace", "status", "prod", "--json"] },
        { argv: ["workspace", "status", "staging", "--json"] },
        { argv: ["ci", "list", "--json"] },
        { argv: ["release", "list", "--json"], dir: "web" },
      ]),
    );
    // The first status read is reused for its own environment.
    expect(t.calls).toHaveLength(4);
  });

  it("refuses the whole lane when status can't be read, and only a part when another read can't", async () => {
    const bad = { run: async () => ({ status: 1, stdout: "", stderr: "boom" }) };
    const read = await readTrunkLane(ws, { env: "prod", reader: workspaceReader(bad) });
    expect(read.ok).toBe(false);
    const t = transport();
    const partial = workspaceReader({
      run: async (argv, options) => (argv[0] === "ci" ? { status: 1, stdout: "{}", stderr: "" } : t.run(argv, options)),
    });
    const r = await readTrunkLane(ws, { env: "prod", reader: partial });
    expect(r.ok && r.lane.trunkRefusal?.code).toBe("workspace-contract");
    expect(r.ok && r.lane.environments).toHaveLength(2);
  });

  it("names a trunk read by its own command when chant writes another contract", async () => {
    const reader = workspaceReader({ run: async () => ({ status: 0, stdout: JSON.stringify({ contract: 2 }), stderr: "" }) });
    await expect(reader.readTrunk("ci list", [])).rejects.toThrow(WorkspaceReadError);
    await expect(reader.readTrunk("ci list", [])).rejects.toThrow(/chant ci list wrote a document with contract 2/);
  });
});

// The route over the app, with a project chant that answers from the
// fixtures: version 0.124.28, `workspace status`, `ci list` and `release list`
// print the recorded documents, and `chant approve` records the approval in a
// file beside it, after which `workspace status prod` no longer lists the gate.
describe("GET /api/workspace/lane (#680)", () => {
  const made: string[] = [];
  afterAll(() => {
    setServedWorkspace(undefined);
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  function root(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "behold-680-lane-"));
    made.push(dir);
    mkdirSync(join(dir, "web"));
    const pkg = join(dir, "node_modules", "@intentius", "chant");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version, main: "index.js", bin: { chant: "bin/chant" } }));
    writeFileSync(join(pkg, "index.js"), "");
    const bin = join(pkg, "bin", "chant");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const fix = ${JSON.stringify(FIX)};
const approved = join(__dirname, "approved");
const argv = process.argv.slice(2);
appendFileSync(join(__dirname, "calls"), JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const line = argv.join(" ");
const print = (name, edit) => { const d = JSON.parse(readFileSync(join(fix, name), "utf8")); if (edit) edit(d); process.stdout.write(JSON.stringify(d)); };
if (line === "workspace status staging --json") print("status-staging.json");
else if (line === "workspace status prod --json") print("status-prod.json", (d) => { if (existsSync(approved)) for (const m of d.members) m.gates = []; });
else if (line === "ci list --json") print("ci-list.json");
else if (line === "release list --json") print("release-list.json");
else if (argv[0] === "approve") { writeFileSync(approved, line); }
else { process.stderr.write("unexpected " + line); process.exit(2); }
`,
    );
    chmodSync(bin, 0o755);
    return dir;
  }

  const serve = (dir: string) => {
    const w: Workspace = { name: "acme", root: dir, file: "chant.workspace.json", chant: "0.124.28", members: [{ name: "web", dir: "web", kind: "chant" } as Workspace["members"][number]] };
    setServedWorkspace(w);
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: dir, workspace: w, port: 0, env: "prod" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
  };

  it("renders for a workspace with two environments, a waiting gate and a revoked commit", async () => {
    const app = serve(root("0.124.28"));
    const res = await app.request("/api/workspace/lane");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.workspace).toBe(true);
    expect(body.chant).toBe("0.124.28");
    expect(body.environments.map((e: any) => e.env)).toEqual(["staging", "prod"]);
    expect(body.commits.map((c: any) => c.state)).toEqual(["undecided", "revoked", "green", "green"]);
    expect(body.environments[1].waiting.map((g: any) => g.key)).toEqual(["web/web/promote"]);
    // The gate's directory stays on the server, as on /api/workspace/gates.
    expect(body.environments[1].waiting[0].dir).toBeUndefined();
    expect(typeof body.approver).toBe("string");
    expect(body.approverIdentity).toMatchObject({ source: "process" });
  });

  it("approving from the lane resolves the gate through the gates route, and the lane updates", async () => {
    const dir = root("0.124.28");
    const app = serve(dir);
    const res = await app.request("/api/workspace/gates/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "web/web/promote", env: "prod" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recorded: true, key: "web/web/promote" });
    const approve = readFileSync(join(dir, "node_modules", "@intentius", "chant", "bin", "approved"), "utf8");
    expect(approve).toMatch(/^approve web promote --env prod --plan sha256:4b5e57f6\S+ (--actor \S+ )?--note approved in behold$/);
    const after = (await (await app.request("/api/workspace/lane")).json()) as Record<string, any>;
    expect(after.environments[1].waiting).toEqual([]);
    expect(after.commits.find((c: any) => c.sha === C2).where).toEqual([{ env: "staging", what: "runs" }]);
  });

  it("answers the release column, with revoked marks from chant 0.124.29 and without them below it (#692)", async () => {
    const full = (await (await serve(root("0.124.29")).request("/api/workspace/lane")).json()) as Record<string, any>;
    expect(full.releaseColumn).toEqual({ full: true, floor: "0.124.29" });
    expect(full.releases.map((r: any) => [r.label, r.configOnly, r.revoked?.phase ?? null])).toEqual([
      ["v3", false, "test"],
      ["v2", true, null],
      ["v1", null, null],
    ]);
    expect(full.environments[1].superseded.map((g: any) => g.key)).toEqual(["web/release/promote"]);
    const old = (await (await serve(root("0.124.28")).request("/api/workspace/lane")).json()) as Record<string, any>;
    expect(old.refusal).toBeUndefined();
    expect(old.releaseColumn).toEqual({ full: false, floor: "0.124.29" });
    expect(old.releases.map((r: any) => [r.label, r.configOnly, r.revoked])).toEqual([
      ["v3", false, null],
      ["v2", true, null],
      ["v1", null, null],
    ]);
  });

  it("refuses on a chant below the floor without spawning it, and the rest of behold answers", async () => {
    const dir = root("0.124.24");
    const app = serve(dir);
    const body = (await (await app.request("/api/workspace/lane")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old", error: "Trunk commits needs chant 0.124.28 or newer. This project has chant 0.124.24." });
    expect(existsSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"))).toBe(false);
    expect((await app.request("/api/project")).status).toBe(200);
  });
});
