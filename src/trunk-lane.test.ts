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
import { CHANT_FLOORS, CI_LIST_CHANT_FLOOR, PROMOTION_ORDER_CHANT_FLOOR, RELEASE_LIST_CHANT_FLOOR, floorFor } from "./chant-floors.ts";
import { gatesFromStatus } from "./workspace-gates.ts";
import { laneFloorRefusal, laneFrom, promotionOrder, readTrunkLane, releaseMembers, type TrunkLane } from "./trunk-lane.ts";
import { WorkspaceReadError, workspaceReader, type WorkspaceDocument } from "./workspace-reader.ts";
import ciListSchema from "./trunk-lane-schemas/ci-list.schema.json" with { type: "json" };
import releasesSchema from "./trunk-lane-schemas/releases.schema.json" with { type: "json" };
import statusSchema from "./trunk-lane-schemas/status.schema.json" with { type: "json" };

// #680. The fixtures are what chant 0.124.28 (chant main at 67ddb7e, which
// still calls itself 0.124.27) printed for a throwaway workspace: member `web`
// promoting staging then prod, four trunk commits (two green, one green then
// revoked, one undecided), release v1 cut from the first and running in prod,
// v2 cut from the second and running in staging, and a gate in prod waiting on
// the second. Two hand edits, each still valid against chant's schema: work
// items on three commits (chant#4029 needs a declared work kind to write
// them) and the change set on the prod gate (chant#4022 needs one stored).
// The schemas in src/trunk-lane-schemas/ are chant's, from the same commit.

const FIX = join(import.meta.dirname, "__fixtures__", "trunk-lane");
const fixture = (name: string): WorkspaceDocument => JSON.parse(readFileSync(join(FIX, name), "utf8")) as WorkspaceDocument;
const C1 = "6828a7f5b398ea48543fe27c018ba302ce2aba14";
const C2 = "a14610e4f51778c969efcc77694a360412c34d88";
const C3 = "9c4250fa1ed203aa9c61eca708c8f0bbf4a06ddd";
const C4 = "0c7c85ae8cca01463f304a3bd69bc3e977899d5f";

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

/** The lane joined from the fixtures, in the order chant declared. */
function lane(): TrunkLane {
  const statuses = ["staging", "prod"].map((env) => {
    const status = fixture(`status-${env}.json`);
    const gates = gatesFromStatus(status, "/ws");
    if (!gates.ok) throw new Error(gates.refusal.error);
    return { env, canary: false, members: ["web"], status, gates: gates.gates };
  });
  return laneFrom({ ci: fixture("ci-list.json"), statuses, releaseLists: [{ member: "web", doc: fixture("release-list.json") }], order: "promotion", at: new Date("2026-10-16T00:00:00Z") });
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
    expect(staging).toMatchObject({ env: "staging", releases: [{ member: "web", label: "v2", commit: C2, listed: true, components: ["web"], cutBy: "github:alice", approver: null }], deploys: [], waiting: [] });
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
    expect(at.get(C3)).toEqual([]);
  });

  it("names a deploy record no release covers, and says nothing it was not told", () => {
    const status = fixture("status-prod.json");
    const l = laneFrom({
      ci: fixture("ci-list.json"),
      statuses: [{ env: "prod", canary: false, members: ["web"], status, gates: [] }],
      releaseLists: [],
      order: "promotion",
      at: new Date(),
    });
    expect(l.environments[0].releases).toEqual([]);
    expect(l.environments[0].deploys).toEqual([expect.objectContaining({ component: "web", gitSha: C1, listed: true, approver: "github:alice", runId: "run-1" })]);
    // An environment with no deploy record at all is empty, not guessed at.
    const bare = laneFrom({ ci: fixture("ci-list.json"), statuses: [{ env: "dev", canary: false, members: [], status, gates: [] }], releaseLists: [], order: "env", at: new Date() });
    expect(bare.environments[0]).toMatchObject({ env: "dev", releases: [], deploys: [], waiting: [] });
  });

  it("keeps chant's refusals: no ci.green, and a member whose releases can't be read", () => {
    const l = laneFrom({
      ci: { $schema: "x", contract: 1, chant: "0.124.28", error: { code: "ci-green-undeclared", message: "the workspace declares no ci.green" } },
      statuses: [],
      releaseLists: [{ member: "web", doc: { contract: 1, chant: "0.124.28", error: { code: "ledger-unreadable", message: "no chant/lifecycle" } } }],
      order: "env",
      at: new Date(),
    });
    expect(l.trunk).toBeNull();
    expect(l.trunkRefusal).toMatchObject({ code: "ci-green-undeclared", error: "chant ci list: the workspace declares no ci.green" });
    expect(l.releaseRefusals).toEqual([{ member: "web", refusal: expect.objectContaining({ code: "ledger-unreadable" }) }]);
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

  it("refuses on a chant below the floor without spawning it, and the rest of behold answers", async () => {
    const dir = root("0.124.24");
    const app = serve(dir);
    const body = (await (await app.request("/api/workspace/lane")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old", error: "Trunk commits needs chant 0.124.28 or newer. This project has chant 0.124.24." });
    expect(existsSync(join(dir, "node_modules", "@intentius", "chant", "bin", "calls"))).toBe(false);
    expect((await app.request("/api/project")).status).toBe(200);
  });
});
