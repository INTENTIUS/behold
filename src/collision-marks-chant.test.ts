import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { readWorkspace, setServedWorkspace } from "./workspace.ts";
import { COLLISION_ITEMS, COLLISION_NODE, COLLISION_SOURCE, makeCollisionWorkspace } from "./collision-fixture.ts";

// #684 against a real chant, end to end, in the workspace
// src/collision-fixture.ts makes: two in-flight work items, W-001 and W-002,
// each with a commit that changes web/queue.ts, and a release gate waiting in
// staging whose stored change set has an entry on the node web/Queue, declared
// in that file. behold marks the node, lists the items and the shared file, and
// on an older chant reads nothing.
//
// overlap is new in chant 0.124.29, so the test runs only when
// BEHOLD_TEST_CHANT_BIN names a chant that writes it (a chant checkout's
// packages/core/bin/chant at main, which still calls itself 0.124.28). It is
// put in the workspace as the project's chant at 0.124.29, and once at
// 0.124.28 for the degraded tab. HOME and git's global config live in the
// temp directories, and nothing is approved.

const CHANT = process.env.BEHOLD_TEST_CHANT_BIN;

const made: string[] = [];
const saved: Record<string, string | undefined> = {};
const ISOLATE = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "USER", "GITHUB_ACTOR", "GITLAB_USER_LOGIN"];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "behold-684-home-"));
  made.push(home);
  for (const k of ISOLATE) saved[k] = process.env[k];
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", USER: "alex" });
  for (const k of ["GITHUB_ACTOR", "GITLAB_USER_LOGIN"]) delete process.env[k];
});
afterAll(() => {
  for (const k of ISOLATE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setServedWorkspace(undefined);
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function workspace(version: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "behold-684-ws-"));
  made.push(scratch);
  return makeCollisionWorkspace(scratch, { chant: CHANT, version });
}

async function serve(root: string) {
  const read = await readWorkspace(root);
  if (!read.ok) throw new Error(read.refusal.error);
  setServedWorkspace(read.workspace);
  const broadcaster = new Broadcaster();
  return createApp({ projectDir: root, workspace: read.workspace, port: 0, env: "staging" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: root, broadcaster, onDone: () => {} }));
}

describe.skipIf(!CHANT || !existsSync(CHANT))("collision marks, through chant (#684)", () => {
  it("marks the node two in-flight work items reach, lists both, and lists the shared file", async () => {
    const app = await serve(workspace("0.124.29"));
    const body = (await (await app.request("/api/workspace/collisions")).json()) as Record<string, any>;
    expect(body.refusal).toBeUndefined();
    expect(body.nodes).toEqual([
      expect.objectContaining({ node: COLLISION_NODE, items: [...COLLISION_ITEMS], entries: [expect.objectContaining({ member: "web", address: "web", source: COLLISION_SOURCE })] }),
    ]);
    expect(body.files).toEqual([{ items: [...COLLISION_ITEMS], files: [COLLISION_SOURCE] }]);
    expect(body.items.map((i: any) => [i.item, i.state, i.with])).toEqual([
      ["work:W-001", "in-progress", ["work:W-002"]],
      ["work:W-002", "in-progress", ["work:W-001"]],
    ]);
    expect(body.unattributed).toBe(0);
  }, 180_000);

  it("on chant 0.124.28 reads nothing and says what the tab is missing", async () => {
    const app = await serve(workspace("0.124.28"));
    const body = (await (await app.request("/api/workspace/collisions")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(body.degraded).toMatch(/no collision marks/);
  }, 60_000);
});
