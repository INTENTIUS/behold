import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { readWorkspace, setServedWorkspace } from "./workspace.ts";
import { FLAG_CHANGE_SET, FLAG_COMMIT, FLAG_GATE, makeFlagWorkspace } from "./feature-flags-fixture.ts";

// #683 against a real chant, end to end, in the workspace
// src/feature-flags-fixture.ts makes: member `web` promoting staging then
// prod, the flag new-checkout on in staging and off in prod, the stale flag
// old-banner, and a release gate waiting in staging whose stored change set
// turns newCheckout on. behold reads the flags, opens the waiting flip as the
// gate's change set, and on an older chant reads nothing.
//
// featureFlags is new in chant 0.124.29, so the test runs only when
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
  const home = mkdtempSync(join(tmpdir(), "behold-683-home-"));
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
  const scratch = mkdtempSync(join(tmpdir(), "behold-683-ws-"));
  made.push(scratch);
  return makeFlagWorkspace(scratch, { chant: CHANT, version });
}

async function serve(root: string) {
  const read = await readWorkspace(root);
  if (!read.ok) throw new Error(read.refusal.error);
  setServedWorkspace(read.workspace);
  const broadcaster = new Broadcaster();
  return createApp({ projectDir: root, workspace: read.workspace, port: 0, env: "staging" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: root, broadcaster, onDone: () => {} }));
}

describe.skipIf(!CHANT || !existsSync(CHANT))("feature flags, through chant (#683)", () => {
  it("reads the flags on and off per environment, the stale one, and the flip waiting at staging's gate", async () => {
    const app = await serve(workspace("0.124.29"));
    const body = (await (await app.request("/api/workspace/flags")).json()) as Record<string, any>;
    expect(body.refusal).toBeUndefined();
    expect(body.environments).toEqual(["staging", "prod"]);
    expect(body.nodes).toBe("member");
    const checkout = body.flags.find((f: any) => f.id === "new-checkout");
    expect(checkout).toMatchObject({ member: "web", param: "newCheckout", owner: "alice", work: { id: "W-002", state: "in-progress" }, stale: false });
    expect(checkout.envs).toEqual({ staging: { value: true, state: "on" }, prod: { value: false, state: "off" } });
    expect(checkout.waiting).toEqual([
      { env: "staging", gate: FLAG_GATE, changeSet: FLAG_CHANGE_SET.digest, releaseDigest: FLAG_CHANGE_SET.releaseDigest, gitSha: FLAG_COMMIT, before: false, after: true, entries: [{ address: "web", node: null }] },
    ]);
    expect(checkout.turnOn.map((t: any) => t.env)).toEqual(["prod"]);
    expect(body.flags.find((f: any) => f.id === "old-banner")).toMatchObject({ stale: true, work: { id: "W-001", state: "done" } });

    // The flip's preview is the gate's change set, the overlay #681 draws.
    const cs = (await (await app.request(`/api/workspace/change-set?gate=${encodeURIComponent(FLAG_GATE)}&env=staging`)).json()) as Record<string, any>;
    expect(cs.refusal).toBeUndefined();
    expect(cs.digest).toBe(FLAG_CHANGE_SET.digest);
    expect(cs.planned).toEqual({ releaseDigest: FLAG_CHANGE_SET.releaseDigest, environment: "staging" });
    expect(cs.entries).toEqual([expect.objectContaining({ address: "web", action: "update", node: null, attributes: [{ path: "param:newCheckout", before: false, after: true }] })]);
  }, 180_000);

  it("on chant 0.124.28 reads nothing and says what the tab is missing", async () => {
    const root = workspace("0.124.28");
    const app = await serve(root);
    const body = (await (await app.request("/api/workspace/flags")).json()) as Record<string, any>;
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(body.degraded).toMatch(/no flag marks/);
  }, 60_000);
});
