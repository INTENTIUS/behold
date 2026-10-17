import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { readWorkspace, setServedWorkspace } from "./workspace.ts";
import { C1, C2, C3, C4, DIGEST, makeLaneWorkspace, R1, R2, R3 } from "./trunk-lane-fixture.ts";

// #680 and #692 against a real chant, end to end, in the workspace
// src/trunk-lane-fixture.ts makes: member `web` promoting staging then prod,
// four trunk commits with ci tags (two green, one green then revoked, one
// undecided), three releases on chant/lifecycle (v2 config-only, v3 cut from
// the revoked commit and running in staging), a gate in prod waiting on the
// second green commit and v3's release gate there. behold reads the lane and
// its release column, approves the gate through `chant approve`, and reads
// the lane again.
//
// The release column's revoked fields are new in chant 0.124.29, so the test
// runs only when BEHOLD_TEST_CHANT_BIN names a chant that writes them (a chant
// checkout's packages/core/bin/chant at main). It is put in the workspace as
// the project's chant at 0.124.29, and once more at 0.124.28 for the degraded
// column. Nothing outside the temp directories is touched: HOME, git's global
// config and the ledger live in them.

const CHANT = process.env.BEHOLD_TEST_CHANT_BIN;

const made: string[] = [];
const saved: Record<string, string | undefined> = {};
const ISOLATE = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE", "USER", "GITHUB_ACTOR", "GITLAB_USER_LOGIN"];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "behold-680-home-"));
  made.push(home);
  for (const k of ISOLATE) saved[k] = process.env[k];
  Object.assign(process.env, {
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.test",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.test",
    USER: "alex",
  });
  for (const k of ["GITHUB_ACTOR", "GITLAB_USER_LOGIN", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) delete process.env[k];
});
afterAll(() => {
  for (const k of ISOLATE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setServedWorkspace(undefined);
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

/** The workspace src/trunk-lane-fixture.ts makes, with the project's chant at `version` running CHANT. */
function workspace(version: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "behold-680-ws-"));
  made.push(scratch);
  return makeLaneWorkspace(scratch, { chant: CHANT, version });
}

describe.skipIf(!CHANT || !existsSync(CHANT))("the trunk lane, through chant (#680)", () => {
  const serve = async (root: string) => {
    const read = await readWorkspace(root);
    if (!read.ok) throw new Error(read.refusal.error);
    setServedWorkspace(read.workspace);
    const broadcaster = new Broadcaster();
    return createApp({ projectDir: root, workspace: read.workspace, port: 0, env: "prod" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: root, broadcaster, onDone: () => {} }));
  };

  it("draws the lane and its release column, approves the waiting gate, and draws it again", async () => {
    const root = workspace("0.124.29");
    const app = await serve(root);

    const lane = (await (await app.request("/api/workspace/lane")).json()) as Record<string, any>;
    expect(lane.refusal).toBeUndefined();
    expect(lane.trunk).toMatchObject({ branch: "main", require: ["test"] });
    expect(lane.commits.map((c: any) => [c.sha, c.state])).toEqual([
      [C4, "undecided"],
      [C3, "revoked"],
      [C2, "green"],
      [C1, "green"],
    ]);
    expect(lane.environments.map((e: any) => e.env)).toEqual(["staging", "prod"]);
    const [staging, prod] = lane.environments;
    expect(staging.releases).toEqual([
      expect.objectContaining({ label: "v3", commit: C3, components: ["api"], rollback: ["chant components rollback staging --component api"] }),
      expect.objectContaining({ label: "v2", commit: C2, components: ["web"], rollback: [] }),
    ]);
    expect(prod.releases).toEqual([expect.objectContaining({ label: "v1", commit: C1, approver: "github:alice" })]);
    expect(prod.waiting).toEqual([expect.objectContaining({ key: "web/web/promote", gitSha: C2, runId: "run-9", commitState: "green" })]);
    expect(prod.superseded).toEqual([expect.objectContaining({ key: "web/release/promote", releaseDigest: R3, revoked: expect.objectContaining({ tag: `ci/revoked/${C3}`, phase: "test" }) })]);
    expect(lane.commits.find((c: any) => c.sha === C2).where).toEqual([
      { env: "staging", what: "runs" },
      { env: "prod", what: "waits", gate: "web/web/promote" },
    ]);

    // #692: the column, newest first.
    expect(lane.releaseColumn).toEqual({ full: true, floor: "0.124.29" });
    expect(lane.releases.map((r: any) => [r.label, r.releaseDigest, r.configOnly, r.next, r.revoked?.rollback ?? null])).toEqual([
      ["v3", R3, false, null, ["chant components rollback staging --component api"]],
      ["v2", R2, true, "prod", null],
      ["v1", R1, null, null, null],
    ]);
    expect(lane.releases[0].cut.signature.status).toBe("unverified");
    expect(lane.releases[1].waits).toEqual([{ env: "prod", gate: "web/web/promote", state: "pending" }]);
    expect(lane.releases[0].waits).toEqual([{ env: "prod", gate: "web/release/promote", state: "superseded" }]);
    expect(lane.approver).toBe("alex");

    const res = await app.request("/api/workspace/gates/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "web/web/promote", env: "prod" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, key: "web/web/promote", approver: "alex", signed: false });
    const line = git(root, ["show", "chant/lifecycle:_members/web/_gates/web.jsonl"]).split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.kind !== "pending");
    expect(line).toMatchObject({ gate: "promote", resolvedBy: "alex", note: "approved in behold", planDigest: DIGEST });

    const after = (await (await app.request("/api/workspace/lane")).json()) as Record<string, any>;
    expect(after.environments[1].waiting).toEqual([]);
    expect(after.commits.find((c: any) => c.sha === C2).where).toEqual([{ env: "staging", what: "runs" }]);
    expect(after.releases[1].waits).toEqual([]);
  }, 180_000);

  it("draws the column from release list alone when the project's chant is 0.124.28", async () => {
    const app = await serve(workspace("0.124.28"));
    const lane = (await (await app.request("/api/workspace/lane")).json()) as Record<string, any>;
    expect(lane.refusal).toBeUndefined();
    expect(lane.releaseColumn).toEqual({ full: false, floor: "0.124.29" });
    expect(lane.releases.map((r: any) => [r.label, r.configOnly, r.revoked])).toEqual([
      ["v3", false, null],
      ["v2", true, null],
      ["v1", null, null],
    ]);
    expect(lane.environments[1].superseded).toEqual([]);
  }, 180_000);
});
