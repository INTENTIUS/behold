import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { readWorkspace, setServedWorkspace } from "./workspace.ts";
import { GATE_AT, makeTraceWorkspace, NODE, PROD_AT, RELEASE_LABEL } from "./why-trace-fixture.ts";

// #682 against a real chant, end to end, in the workspace
// src/why-trace-fixture.ts makes: a resource node, delivery/appService, whose
// file a commit linking W-001 changed; that commit green, release v1 cut from
// it, let through to prod by bob's resolution of the release gate (with the
// change set it was for stored), and deployed there; a plain staging deploy;
// and an older commit with no work item and no tag. behold reads the why of
// the node and gets chant's chain with it.
//
// The chain is new in chant 0.124.29, so the test runs only when
// BEHOLD_TEST_CHANT_BIN names a chant that writes it (a chant checkout's
// packages/core/bin/chant at main). It is put in the workspace as the
// project's chant at 0.124.29, and once more at 0.124.28 for today's view.
// Nothing outside the temp directories is touched: HOME, git's global config
// and the ledger live in them, and nothing is approved or deployed.

const CHANT = process.env.BEHOLD_TEST_CHANT_BIN;

const made: string[] = [];
const saved: Record<string, string | undefined> = {};
const ISOLATE = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE", "USER", "GITHUB_ACTOR", "GITLAB_USER_LOGIN"];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "behold-682-home-"));
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

describe.skipIf(!CHANT || !existsSync(CHANT))("the why chain, through chant (#682)", () => {
  const serve = async (version: string) => {
    const scratch = mkdtempSync(join(tmpdir(), "behold-682-ws-"));
    made.push(scratch);
    const ws = makeTraceWorkspace(scratch, { chant: CHANT, version });
    const read = await readWorkspace(ws.root);
    if (!read.ok) throw new Error(read.refusal.error);
    setServedWorkspace(read.workspace);
    const broadcaster = new Broadcaster();
    const app = createApp({ projectDir: ws.root, workspace: read.workspace, port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: ws.root, broadcaster, onDone: () => {} }));
    const res = await app.request(`/api/workspace/why?node=${encodeURIComponent(NODE)}`);
    expect(res.status).toBe(200);
    return { ws, body: (await res.json()) as Record<string, any> };
  };

  it("the why pane's answer for a resource shipped through a gate carries the whole chain", async () => {
    const { ws, body } = await serve("0.124.29");
    expect(body.refusal).toBeUndefined();
    expect(body.path).toBe("delivery/src/app.ts");
    expect(body.chain).toEqual({ full: true, floor: "0.124.29", note: null });
    const t = body.trace;
    expect(t.reasons).toEqual([]);
    expect(t.commits.map((c: any) => [c.sha, c.subject])).toEqual([
      [ws.linked, "serve the app on 8081"],
      [ws.base, "the shop and W-001"],
    ]);
    const [linked, base] = t.commits;
    // Who asked for it.
    expect(linked.work).toEqual({ state: "linked", items: [{ id: "work:W-001", node: "record:work/W-001", title: "Serve the app on 8081", source: { ref: ws.linked, field: "Chant-Record", value: "work:W-001" } }], problems: [] });
    expect(linked.tag).toMatchObject({ state: "green", green: { tag: `ci/green/${ws.linked}`, source: { ref: `refs/tags/ci/green/${ws.linked}` } } });
    expect(linked.releases).toEqual([{ release: ws.releaseDigest, link: "cut-from", source: { ref: `chant/lifecycle:_members/delivery/_releases/${ws.releaseDigest.replace(/:/g, "_")}.json`, field: "commit", value: ws.linked } }]);
    expect(linked.deploys.map((d: any) => [d.env, d.link])).toEqual([
      ["prod", "built-from"],
      ["staging", "built-from"],
    ]);
    // Who let it ship: the gate resolution, its channel and time, and the change set it was for.
    expect(t.releases).toHaveLength(1);
    expect(t.releases[0]).toMatchObject({ releaseDigest: ws.releaseDigest, label: RELEASE_LABEL, commit: ws.linked, cuts: [{ actor: "alice" }] });
    expect(t.releases[0].gates).toEqual([
      expect.objectContaining({ op: "release", gate: "prod-release", environment: "prod", resolvedBy: "bob", channel: "cli", at: GATE_AT, changeSet: ws.changeSet, changeSetSource: { ref: `chant/lifecycle:_members/delivery/_change-sets/${ws.changeSet.replace(/:/g, "_")}.json`, field: "planDigest", value: ws.changeSet } }),
    ]);
    const prod = t.deploys.find((d: any) => d.env === "prod");
    expect(prod).toMatchObject({ timestamp: PROD_AT, release: ws.releaseDigest, approver: "bob", admittedBy: { gate: "prod-release", resolvedBy: "bob", at: GATE_AT } });
    expect(t.deploys.find((d: any) => d.env === "staging")).toMatchObject({ release: null, admittedBy: null });
    // The older commit: no work item and no tag, which the pane shows as missing; v1 contains it.
    expect(base.work).toMatchObject({ state: "unlinked", items: [] });
    expect(base.tag.state).toBe("none");
    expect(base.releases).toEqual([expect.objectContaining({ release: ws.releaseDigest, link: "contains" })]);
    // Today's answer is still there.
    expect(body.decisions.map((d: any) => d.id)).toEqual(["fix-001"]);
  }, 240_000);

  it("on a project whose chant is 0.124.28 the pane keeps today's view and says the chain needs 0.124.29", async () => {
    const { body } = await serve("0.124.28");
    expect(body.refusal).toBeUndefined();
    expect(body.trace).toBeNull();
    expect(body.chain).toEqual({ full: false, floor: "0.124.29", note: "Why chain needs chant 0.124.29 or newer. This project has chant 0.124.28." });
    expect(body.decisions.map((d: any) => d.id)).toEqual(["fix-001"]);
  }, 240_000);
});
