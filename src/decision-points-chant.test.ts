import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { readWorkspace, setServedWorkspace } from "./workspace.ts";
import { GATE_POINT, LOOSE_POINT, makePointsWorkspace } from "./decision-points-fixture.ts";

// #472 against a real chant, end to end, in the workspace
// src/decision-points-fixture.ts makes: gate approve-apply of op deploy waits
// in staging on a staging-apply question, and a launch-tier question no gate
// waits on. behold lists both open questions, the gate names the first, and
// the approve route refuses that gate. Nothing is answered.
//
// The test runs only when BEHOLD_TEST_CHANT_BIN names a chant 0.107.0 or newer
// (an installed 0.124.31's node_modules/.bin/chant, or a checkout's
// packages/core/bin/chant). HOME and git's global config live in the temp
// directories.

const CHANT = process.env.BEHOLD_TEST_CHANT_BIN;

const made: string[] = [];
const saved: Record<string, string | undefined> = {};
const ISOLATE = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "USER", "GITHUB_ACTOR", "GITLAB_USER_LOGIN"];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "behold-472-home-"));
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

async function serve(root: string) {
  const read = await readWorkspace(root);
  if (!read.ok) throw new Error(read.refusal.error);
  setServedWorkspace(read.workspace);
  const broadcaster = new Broadcaster();
  return createApp({ projectDir: root, workspace: read.workspace, port: 0, env: "staging" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: root, broadcaster, onDone: () => {} }));
}

describe.skipIf(!CHANT || !existsSync(CHANT))("open decision points, through chant (#472)", () => {
  it("lists both open questions, and the waiting gate names its own", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "behold-472-ws-"));
    made.push(scratch);
    const { root, gateQuestion } = makePointsWorkspace(scratch, { chant: CHANT! });
    const app = await serve(root);
    const body = (await (await app.request("/api/workspace/points")).json()) as Record<string, any>;
    expect(body.refusal).toBeUndefined();
    expect(body.points.map((p: any) => p.point).sort()).toEqual([LOOSE_POINT, GATE_POINT].sort());
    const asked = body.points.find((p: any) => p.id === gateQuestion);
    expect(asked).toMatchObject({ gate: { op: "deploy", gate: "approve-apply", env: "staging" }, quorum: { count: 2, roles: ["maintainer"] }, state: "escalated" });
    const gates = (await (await app.request("/api/workspace/gates?env=staging")).json()) as Record<string, any>;
    const g = gates.gates.find((x: any) => x.key === "web/deploy/approve-apply");
    expect(g.answer.id).toBe(gateQuestion);
    expect(g.approve).toBe(asked.command);
    const res = await app.request("/api/workspace/gates/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: g.key, env: "staging" }) });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Record<string, any>).code).toBe("decision-point");
  }, 180_000);
});
