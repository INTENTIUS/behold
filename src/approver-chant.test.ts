import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { readWorkspace } from "./workspace.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import type { ApproverOptions } from "./approver.ts";

// #690 against the chant behold resolves, end to end: a throwaway workspace
// whose declaration at base sets identity.attribution to identified and names
// gate `ship` in identity.gates, a signers file listing a key made here for
// github:alice, and two pending gates on chant/lifecycle. behold reads them
// with `chant workspace status`, approves through `chant approve`, and the
// ledger and status read back what chant recorded. Nothing outside the temp
// directory is touched: git's global config, HOME and the key all live in it.

const hasSshKeygen = spawnSync("ssh-keygen", ["-Y"], { stdio: "ignore" }).error === undefined;
const DIGEST = `sha256:${"a".repeat(64)}`;

const made: string[] = [];
const saved: Record<string, string | undefined> = {};
const ISOLATE = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "USER", "GITHUB_ACTOR", "GITLAB_USER_LOGIN"];
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "behold-690-home-"));
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
  delete process.env.GITHUB_ACTOR;
  delete process.env.GITLAB_USER_LOGIN;
});
afterAll(() => {
  for (const k of ISOLATE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();

/** A workspace with gates `review` (any approver) and `ship` (signed), both waiting on the same plan. */
function workspace(): { root: string; key: string } {
  const scratch = mkdtempSync(join(tmpdir(), "behold-690-ws-"));
  made.push(scratch);
  const root = join(scratch, "repo");
  mkdirSync(join(root, ".chant"), { recursive: true });
  git(scratch, ["init", "-q", "-b", "main", root]);
  const key = join(scratch, "key-alice");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "alice", "-f", key]);
  const pub = readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  writeFileSync(join(root, ".chant", "allowed_signers"), `github:alice ${pub}\n`);
  writeFileSync(
    join(root, "chant.workspace.json"),
    JSON.stringify({
      name: "acme",
      schema: 1,
      members: [{ name: "web", dir: ".", kind: "other", because: "holds the gates for this test" }],
      identity: { attribution: "identified", gates: { ship: {} } },
    }),
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  // The pending facts a run leaves, written straight onto chant/lifecycle.
  const pending = (gate: string) => JSON.stringify({ version: 1, kind: "pending", op: "web", gate, timestamp: "2026-10-15T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: DIGEST });
  const blob = git(root, ["hash-object", "-w", "--stdin"], `${pending("review")}\n${pending("ship")}\n`);
  const gates = git(root, ["mktree"], `100644 blob ${blob}\tweb.jsonl\n`);
  const tree = git(root, ["mktree"], `040000 tree ${gates}\t_gates\n`);
  git(root, ["update-ref", "refs/heads/chant/lifecycle", git(root, ["commit-tree", tree, "-m", "lane"])]);
  return { root, key };
}

async function serve(root: string, approver?: ApproverOptions) {
  const read = await readWorkspace(root);
  if (!read.ok) throw new Error(read.refusal.error);
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: root, broadcaster, onDone: () => {} });
  return createApp({ projectDir: root, workspace: read.workspace, port: 0, ...(approver ? { approver } : {}) }, broadcaster, new FrameBuffer(), runner);
}

const approve = (app: Awaited<ReturnType<typeof serve>>, key: string) =>
  app.request("/api/workspace/gates/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, env: "local" }) });

/** The resolution lines chant wrote for `gate`. */
const resolutions = (root: string, gate: string): Record<string, unknown>[] =>
  git(root, ["show", "chant/lifecycle:_gates/web.jsonl"])
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.kind !== "pending" && r.gate === gate);

describe.skipIf(!hasSshKeygen)("approving as a person, through chant (#690)", () => {
  it("records the person as a forge identity, which identity.attribution identified accepts", async () => {
    const { root } = workspace();
    const app = await serve(root, { as: "github:alice" });
    const listed = (await (await app.request("/api/workspace/gates?env=local")).json()) as { approver: string; approverIdentity: unknown; gates: { key: string; signed: boolean }[] };
    expect(listed.approver).toBe("github:alice");
    expect(listed.approverIdentity).toEqual({ principal: "github:alice", source: "configured", forge: true, signs: false });
    expect(listed.gates.map((g) => [g.key, g.signed])).toEqual([["web/web/review", false], ["web/web/ship", true]]);

    const res = await approve(app, "web/web/review");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, key: "web/web/review", approver: "github:alice", signed: false });
    expect(resolutions(root, "review")).toEqual([expect.objectContaining({ resolvedBy: "github:alice", note: "approved in behold", planDigest: DIGEST })]);
    // The gate has its approval, so it no longer waits.
    const after = (await (await app.request("/api/workspace/gates?env=local")).json()) as { gates: { key: string }[] };
    expect(after.gates.map((g) => g.key)).toEqual(["web/web/ship"]);
  }, 60_000);

  it("leaves chant to refuse the user running behold under identified, as before", async () => {
    const { root } = workspace();
    const res = await approve(await serve(root), "web/web/review");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/"alex" names no identity the workspace can check/);
    expect(resolutions(root, "review")).toEqual([]);
  }, 60_000);

  it("approves a signed gate with the person's key", async () => {
    const { root, key } = workspace();
    const app = await serve(root, { as: "github:alice", signingKey: key });
    const listed = (await (await app.request("/api/workspace/gates?env=local")).json()) as { approverIdentity: { signs: boolean } };
    expect(listed.approverIdentity.signs).toBe(true);
    const res = await approve(app, "web/web/ship");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, key: "web/web/ship", approver: "github:alice", signed: true });
    const [line] = resolutions(root, "ship");
    expect(line).toMatchObject({ resolvedBy: "github:alice", note: "approved in behold", seal: { signer: "github:alice" } });
    // chant counts it: the signed gate no longer waits.
    const after = (await (await app.request("/api/workspace/gates?env=local")).json()) as { gates: { key: string }[] };
    expect(after.gates.map((g) => g.key)).toEqual(["web/web/review"]);
  }, 60_000);

  it("keeps refusing a signed gate when behold holds no key for the person", async () => {
    const { root } = workspace();
    const res = await approve(await serve(root, { as: "github:alice" }), "web/web/ship");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("signed");
    expect(body.error).toMatch(/behold holds no key for github:alice\. Run: chant approve web ship --plan sha256:a+ --sign/);
    expect(resolutions(root, "ship")).toEqual([]);
  }, 60_000);
});
