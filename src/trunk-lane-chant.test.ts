import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { readWorkspace, setServedWorkspace } from "./workspace.ts";

// #680 against a real chant, end to end: a throwaway workspace whose member
// `web` promotes staging then prod, four trunk commits with ci tags (two
// green, one green then revoked, one undecided), two releases on
// chant/lifecycle with a deploy record each, and a gate in prod waiting on
// the second green commit. behold reads the lane, approves the gate through
// `chant approve`, and reads the lane again.
//
// The reads are new in chant 0.124.28, which behold's own dependency predates,
// so the test runs only when BEHOLD_TEST_CHANT_BIN names a chant that answers
// them (a chant checkout's packages/core/bin/chant). It is put in the
// workspace as the project's chant at 0.124.28. Nothing outside the temp
// directory is touched: HOME, git's global config and the ledger live in it.

const CHANT = process.env.BEHOLD_TEST_CHANT_BIN;

// Commits made with fixed content, author and dates, so their shas, and the
// release digests over them (chant's computeReleaseDigest), are fixed too.
const C1 = "6828a7f5b398ea48543fe27c018ba302ce2aba14";
const C2 = "a14610e4f51778c969efcc77694a360412c34d88";
const C3 = "9c4250fa1ed203aa9c61eca708c8f0bbf4a06ddd";
const C4 = "0c7c85ae8cca01463f304a3bd69bc3e977899d5f";
const R1 = "jcs1-sha256:e3956171ab72fcab2d812cbd3621ef18c04a46c96a9f1e1a8590dae0d9279185";
const R2 = "jcs1-sha256:1a23268fa8b1fc419cffde4c1780f4387ff0346495f97bd9e22b0508bef99f9d";
const DIGEST = "sha256:4b5e57f6eb2f42b9039b3d1e13929295f231749c510cbe341cd68036d9af97e2";

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

const git = (cwd: string, args: string[], input?: string, env?: Record<string, string>): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8", input, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }).trim();

const run = (id: number, conclusion: string) => ({ name: "test", id, conclusion, url: `https://github.com/acme/app/actions/runs/${id}` });

function workspace(): string {
  const scratch = mkdtempSync(join(tmpdir(), "behold-680-ws-"));
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
  const shas: string[] = [];
  ["base", "add the cart", "break the cart", "fix the cart"].forEach((msg, i) => {
    const at = `2026-10-0${i + 1}T10:00:00Z`;
    writeFileSync(join(root, "web", "log.txt"), ["base", "add the cart", "break the cart", "fix the cart"].slice(0, i + 1).join("\n") + "\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", msg], undefined, { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
    shas.push(git(root, ["rev-parse", "HEAD"]));
  });
  expect(shas).toEqual([C1, C2, C3, C4]);

  // The tags chant ci tick makes, with the annotations it writes.
  const tag = (name: string, subject: string, record: unknown, sha: string) => git(root, ["tag", "-a", name, "-m", `${subject}\n\n${JSON.stringify(record)}`, sha]);
  [C1, C2, C3].forEach((sha, i) =>
    tag(`ci/green/${sha}`, "ci: every required phase passed (test)", { schema: 1, tag: "green", commit: sha, branch: "main", at: "2026-10-05T00:00:00Z", phases: { test: [run(101 + i, "success")] } }, sha),
  );
  tag(`ci/revoked/${C3}`, "ci: phase test failed in test (failure)", { schema: 1, tag: "revoked", commit: C3, branch: "main", at: "2026-10-05T00:00:00Z", phase: "test", run: run(113, "failure") }, C3);

  // chant/lifecycle under _members/web/: two releases and their cuts, a deploy
  // record per environment naming one, and the gate a run left pending in prod.
  const release = (commit: string, digest: string) => ({ version: 1, releaseDigest: digest, member: "web", commit, artifactDigests: [], targets: [{ env: "prod", templates: [], params: [] }, { env: "staging", templates: [], params: [] }] });
  const cut = (digest: string, label: string, at: string) => ({ version: 1, releaseDigest: digest, label, actor: "github:alice", timestamp: at, runOrigin: null, signature: null });
  const deploy = (env: string, gitSha: string, releaseDigest: string, more: Record<string, unknown>) => ({ version: 1, component: "web", env, digest: DIGEST, gitSha, actor: "ci", releaseDigest, ...more });
  const blob = (text: string) => git(root, ["hash-object", "-w", "--stdin"], `${text}\n`);
  const tree = (entries: string[]) => git(root, ["mktree"], `${entries.join("\n")}\n`);
  const releases = tree([
    `100644 blob ${blob(JSON.stringify(release(C1, R1)))}\t${R1.replace(/:/g, "_")}.json`,
    `100644 blob ${blob(JSON.stringify(release(C2, R2)))}\t${R2.replace(/:/g, "_")}.json`,
    `100644 blob ${blob([cut(R1, "v1", "2026-10-02T09:00:00Z"), cut(R2, "v2", "2026-10-03T09:00:00Z")].map((c) => JSON.stringify(c)).join("\n"))}\tcuts.jsonl`,
  ]);
  const prod = tree([`100644 blob ${blob(JSON.stringify(deploy("prod", C1, R1, { runId: "run-1", timestamp: "2026-10-02T12:00:00Z", approver: "github:alice" })))}\treleases.jsonl`]);
  const staging = tree([`100644 blob ${blob(JSON.stringify(deploy("staging", C2, R2, { runId: "run-2", timestamp: "2026-10-03T12:00:00Z" })))}\treleases.jsonl`]);
  const pending = { version: 1, kind: "pending", op: "web", gate: "promote", environment: "prod", timestamp: "2026-10-04T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: DIGEST, gitSha: C2, runId: "run-9" };
  const gates = tree([`100644 blob ${blob(JSON.stringify(pending))}\tweb.jsonl`]);
  const web = tree([`040000 tree ${gates}\t_gates`, `040000 tree ${releases}\t_releases`, `040000 tree ${prod}\tprod`, `040000 tree ${staging}\tstaging`]);
  const top = tree([`040000 tree ${tree([`040000 tree ${web}\tweb`])}\t_members`]);
  git(root, ["update-ref", "refs/heads/chant/lifecycle", git(root, ["commit-tree", top, "-m", "lane"])]);

  // The project's chant: the one named, at the version that adds the reads.
  const pkg = join(root, "node_modules", "@intentius", "chant");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version: "0.124.28", main: "index.js", bin: { chant: "bin/chant" } }));
  writeFileSync(join(pkg, "index.js"), "");
  writeFileSync(join(pkg, "bin", "chant"), `#!/bin/sh\nexec ${JSON.stringify(CHANT)} "$@"\n`);
  chmodSync(join(pkg, "bin", "chant"), 0o755);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  return root;
}

describe.skipIf(!CHANT || !existsSync(CHANT))("the trunk lane, through chant (#680)", () => {
  it("draws the lane, approves the waiting gate, and draws it again", async () => {
    const root = workspace();
    const read = await readWorkspace(root);
    if (!read.ok) throw new Error(read.refusal.error);
    setServedWorkspace(read.workspace);
    const broadcaster = new Broadcaster();
    const app = createApp({ projectDir: root, workspace: read.workspace, port: 0, env: "prod" }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: root, broadcaster, onDone: () => {} }));

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
    expect(staging.releases).toEqual([expect.objectContaining({ label: "v2", commit: C2, components: ["web"] })]);
    expect(prod.releases).toEqual([expect.objectContaining({ label: "v1", commit: C1, approver: "github:alice" })]);
    expect(prod.waiting).toEqual([expect.objectContaining({ key: "web/web/promote", gitSha: C2, runId: "run-9", commitState: "green" })]);
    expect(lane.commits.find((c: any) => c.sha === C2).where).toEqual([
      { env: "staging", what: "runs" },
      { env: "prod", what: "waits", gate: "web/web/promote" },
    ]);
    expect(lane.approver).toBe("alex");

    const res = await app.request("/api/workspace/gates/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "web/web/promote", env: "prod" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true, key: "web/web/promote", approver: "alex", signed: false });
    const line = git(root, ["show", "chant/lifecycle:_members/web/_gates/web.jsonl"]).split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.kind !== "pending");
    expect(line).toMatchObject({ gate: "promote", resolvedBy: "alex", note: "approved in behold", planDigest: DIGEST });

    const after = (await (await app.request("/api/workspace/lane")).json()) as Record<string, any>;
    expect(after.environments[1].waiting).toEqual([]);
    expect(after.commits.find((c: any) => c.sha === C2).where).toEqual([{ env: "staging", what: "runs" }]);
  }, 180_000);
});
