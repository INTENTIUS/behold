import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { localRunRoutes, type LocalRun } from "./ci-local-run.ts";
import { Broadcaster } from "./events.ts";
import { OpRunner } from "./op-runner.ts";
import type { Workspace } from "./workspace.ts";

// behold#685 against a real chant: behold starts `chant ci run plan --local
// --events-json` through its route and draws the run from the stream. It runs
// only when BEHOLD_TEST_CHANT_BIN names a chant binary with `ci run --local`
// (chant 0.124.32, chant#4161). That chant is the project's chant at 0.124.32
// in a throwaway two-commit workspace with a bare origin. The project's chant
// is a wrapper that adds `--image <its own> --chant <stand-in>` after behold's
// argv, as chant's own ci-run tests do: the stand-in is the job's command,
// since pr-plan needs a member that plans, and an image of its own leaves out
// the default image's set-up lines, which download OpenTofu. HOME and git's
// config live in the temp directory. Nothing may leave the machine: origin
// is unchanged.

const CHANT = process.env.BEHOLD_TEST_CHANT_BIN;
const made: string[] = [];
const saved: Record<string, string | undefined> = {};
const ISOLATE = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "behold-685-home-"));
  made.push(home);
  for (const k of ISOLATE) saved[k] = process.env[k];
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" });
});
afterAll(() => {
  for (const k of ISOLATE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function workspace(chant: string): { top: string; root: string } {
  const top = mkdtempSync(join(tmpdir(), "behold-685-ws-"));
  made.push(top);
  const root = join(top, "root");
  mkdirSync(join(root, "app"), { recursive: true });
  git(top, "init", "-q", "--bare", join(top, "origin"));
  git(top, "init", "-q", "-b", "main", root);
  writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "the app" }] }));
  writeFileSync(join(root, ".gitignore"), "node_modules\n.chant/pr/\n");
  writeFileSync(join(root, "app", "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  writeFileSync(join(root, "app", "b.txt"), "b\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "change");
  git(root, "remote", "add", "origin", join(top, "origin"));
  git(root, "push", "-q", "origin", "main");
  // The job's command: writes the report pr-plan would and says one line.
  const stand = join(top, "stand-in");
  writeFileSync(stand, ["#!/bin/sh", "mkdir -p .chant/pr", `echo '{"stage": "plan"}' > ".chant/pr/$2.json"`, 'echo "planned 0 changes for $2"', ""].join("\n"));
  chmodSync(stand, 0o755);
  // The project's chant, at the floor.
  const pkg = join(root, "node_modules", "@intentius", "chant");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  // A main, so the project resolves the package (src/chant.ts resolveChant).
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version: "0.124.32", main: "index.js", bin: { chant: "bin/chant" } }));
  writeFileSync(join(pkg, "index.js"), "");
  writeFileSync(join(pkg, "bin", "chant"), `#!/bin/sh\nexec ${JSON.stringify(chant)} "$@" --image behold-685:local --chant ${JSON.stringify(stand)}\n`);
  chmodSync(join(pkg, "bin", "chant"), 0o755);
  return { top, root };
}

describe.skipIf(!CHANT || !existsSync(CHANT))("a local plan from a real chant (#685)", () => {
  it("starts chant ci run plan --local in the member, draws it from the stream, and pushes nothing", async () => {
    const { top, root } = workspace(CHANT!);
    const head = git(root, "rev-parse", "HEAD");
    const origin = () => git(top, "--git-dir", join(top, "origin"), "rev-parse", "main");
    const before = origin();
    const ws: Workspace = { name: "acme", root, file: "chant.workspace.json", chant: "0.124.32", members: [{ name: "app", dir: "app", kind: "other", abs: join(root, "app"), reason: null, because: "the app" }] };
    const broadcaster = new Broadcaster();
    const runner = new OpRunner({ projectDir: root, broadcaster, onDone: () => {} });
    const app = new Hono();
    localRunRoutes(app, { workspace: () => ws, runner, broadcaster, env: "prod" });
    const r = await app.request("/api/chant/ci/local", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job: "plan", commit: head, pr: 7, member: "app", forge: "github" }) });
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as { id: string };
    await vi.waitFor(() => expect(runner.running).toBeNull(), { timeout: 120_000, interval: 200 });
    const doc = ((await (await app.request(`/api/chant/ci/local/${id}`)).json()) as { doc: LocalRun }).doc;
    expect(doc).toMatchObject({ status: "success", commit: head, pull: 7, member: "app", where: { forge: "local", runtime: "local" } });
    expect(doc.runId).toMatch(/^chant-/);
    expect(doc.jobs[0]!.steps!.find((s) => s.name === "plan")!.log.some((l) => l.endsWith("| planned 0 changes for pr-plan"))).toBe(true);
    expect(origin()).toBe(before);
  }, 180_000);
});
