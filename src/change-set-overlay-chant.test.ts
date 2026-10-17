import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { readWorkspace, setServedWorkspace } from "./workspace.ts";

// #681 against a real chant, end to end: a throwaway workspace whose member
// `web` promotes staging then prod, with a release gate waiting in prod on
// commit a14610e and the change set it binds stored on chant/lifecycle (the
// fixture's document, which chant composed and which verifies against its
// digest). behold reads the lane, finds the gate's change set on its card,
// and reads the overlay through `chant workspace status` and `chant
// change-set show`. Nothing is approved.
//
// Runs only when BEHOLD_TEST_CHANT_BIN names a chant that answers these reads
// (a chant checkout's packages/core/bin/chant), put in the workspace as the
// project's chant at 0.124.28. HOME, git's global config and the ledger live
// in the temp directory.

const CHANT = process.env.BEHOLD_TEST_CHANT_BIN;
const FIX = join(import.meta.dirname, "__fixtures__", "change-set-overlay");
const C2 = "a14610e4f51778c969efcc77694a360412c34d88";
const KEY = "web/release/promote";

const made: string[] = [];
const saved: Record<string, string | undefined> = {};
const ISOLATE = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE", "USER", "GITHUB_ACTOR", "GITLAB_USER_LOGIN"];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "behold-681-home-"));
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

const git = (cwd: string, args: string[], input?: string, env?: Record<string, string>): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", input, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }).trim();

function workspace(): { root: string; digest: string } {
  const scratch = mkdtempSync(join(tmpdir(), "behold-681-ws-"));
  made.push(scratch);
  const root = join(scratch, "repo");
  git(scratch, ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, "web"));
  writeFileSync(
    join(root, "chant.workspace.json"),
    `{ "name": "acme", "schema": 1, "minReader": "0.108.0",
  "members": [{ "name": "web", "dir": "web", "kind": "chant", "because": "the app" }],
  "ci": { "green": { "branch": "main", "window": "3650d", "phases": { "test": ["test"] }, "require": ["test"] } } }
`,
  );
  writeFileSync(join(root, "web", "chant.config.ts"), 'export default { environments: ["staging", "prod"] };\n');
  ["base", "add the cart"].forEach((msg, i) => {
    const at = `2026-10-0${i + 1}T10:00:00Z`;
    writeFileSync(join(root, "web", "log.txt"), ["base", "add the cart"].slice(0, i + 1).join("\n") + "\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", msg], undefined, { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  });
  expect(git(root, ["rev-parse", "HEAD"])).toBe(C2);

  // chant/lifecycle under _members/web/: the stored change set and the release gate's pending fact.
  const doc = JSON.parse(readFileSync(join(FIX, "change-set-show.json"), "utf8")).changeSet as Record<string, string>;
  const blob = (text: string) => git(root, ["hash-object", "-w", "--stdin"], `${text}\n`);
  const tree = (entries: string[]) => git(root, ["mktree"], `${entries.join("\n")}\n`);
  const pending = { version: 1, kind: "pending", op: "release", gate: "promote", environment: "prod", timestamp: "2026-10-04T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: doc.digest, gitSha: C2, runId: "run-9", releaseDigest: doc.releaseDigest };
  const gates = tree([`100644 blob ${blob(JSON.stringify(pending))}\trelease.jsonl`]);
  const sets = tree([`100644 blob ${blob(JSON.stringify(doc))}\t${doc.digest.replace(/:/g, "_")}.json`]);
  const web = tree([`040000 tree ${gates}\t_gates`, `040000 tree ${sets}\t_change-sets`]);
  const top = tree([`040000 tree ${tree([`040000 tree ${web}\tweb`])}\t_members`]);
  git(root, ["update-ref", "refs/heads/chant/lifecycle", git(root, ["commit-tree", top, "-m", "gate"])]);

  const pkg = join(root, "node_modules", "@intentius", "chant");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version: "0.124.28", main: "index.js", bin: { chant: "bin/chant" } }));
  writeFileSync(join(pkg, "index.js"), "");
  writeFileSync(join(pkg, "bin", "chant"), `#!/bin/sh\nexec ${JSON.stringify(CHANT)} "$@"\n`);
  chmodSync(join(pkg, "bin", "chant"), 0o755);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  return { root, digest: doc.digest };
}

describe.skipIf(!CHANT || !existsSync(CHANT))("the change-set overlay, through chant (#681)", () => {
  it("reaches the gate's change set from the lane and reads it keyed by node", async () => {
    const { root, digest } = workspace();
    const read = await readWorkspace(root);
    if (!read.ok) throw new Error(read.refusal.error);
    setServedWorkspace(read.workspace);
    const broadcaster = new Broadcaster();
    const app = createApp({ projectDir: root, workspace: read.workspace, port: 0, env: "prod" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: root, broadcaster, onDone: () => {} }));

    const lane = (await (await app.request("/api/workspace/lane")).json()) as Record<string, any>;
    const prod = lane.environments.find((e: any) => e.env === "prod");
    expect(prod.waiting).toEqual([expect.objectContaining({ key: KEY, gitSha: C2, changeSet: digest, releaseDigest: expect.stringMatching(/^jcs1-sha256:1a23268f/) })]);

    const res = await app.request(`/api/workspace/change-set?gate=${encodeURIComponent(KEY)}&env=prod`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.refusal).toBeUndefined();
    expect(body.digest).toBe(digest);
    expect(body.gate).toMatchObject({ key: KEY, gitSha: C2, runId: "run-9" });
    expect(body.planned).toMatchObject({ environment: "prod" });
    expect(body.nodes).toEqual({
      "web/AppBucket": { bucket: "change", actions: { update: 1 } },
      "web/AppFunction": { bucket: "change", actions: { replace: 1 } },
      "web/AppQueue": { bucket: "create", actions: { create: 1 } },
    });
    expect(body.entries.filter((e: any) => e.node === null).map((e: any) => e.address)).toEqual(["LegacyTopic"]);

    const missing = await app.request(`/api/workspace/change-set?gate=${encodeURIComponent("web/web/promote")}&env=prod`);
    expect(missing.status).toBe(404);
  }, 180_000);
});
