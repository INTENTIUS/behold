import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpRunner } from "./op-runner.ts";
import { Broadcaster } from "./events.ts";

// #679 against a real chant: behold starts `chant run gated-probe
// --events-json` through OpRunner and renders the stream, then a second
// runner follows the same run with `chant run events <run> --json --follow`.
// It runs only when BEHOLD_TEST_CHANT_BIN names a chant checkout's
// packages/core/bin/chant. That chant is put in a throwaway git repository as
// the project's chant at 0.124.28 (a chant built from main may report an
// older version while carrying the stream), with `@intentius/chant/op`
// re-exported from the checkout so the Op compiles. HOME and git's config
// live in the temp directory; nothing outside it is written.

const CHANT = process.env.BEHOLD_TEST_CHANT_BIN;
const HERE = dirname(fileURLToPath(import.meta.url));

const made: string[] = [];
const saved: Record<string, string | undefined> = {};
const ISOLATE = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "USER"];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "behold-679-home-"));
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
});
afterAll(() => {
  for (const k of ISOLATE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function project(chant: string): string {
  const root = mkdtempSync(join(tmpdir(), "behold-679-proj-"));
  made.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "probe", type: "module", private: true }));
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  mkdirSync(join(root, "src"));
  copyFileSync(join(HERE, "__fixtures__", "run-events", "gated-probe.op.ts.txt"), join(root, "src", "gated-probe.op.ts"));
  const core = dirname(dirname(chant));
  const pkg = join(root, "node_modules", "@intentius", "chant");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@intentius/chant", version: "0.124.28", type: "module", bin: { chant: "bin/chant" }, exports: { "./op": "./op.ts", "./package.json": "./package.json" } }),
  );
  writeFileSync(join(pkg, "op.ts"), `export * from ${JSON.stringify(join(core, "src", "op", "index.ts"))};\n`);
  writeFileSync(join(pkg, "bin", "chant"), `#!/bin/sh\nexec ${JSON.stringify(chant)} "$@"\n`);
  chmodSync(join(pkg, "bin", "chant"), 0o755);
  return root;
}

describe.skipIf(!CHANT || !existsSync(CHANT))("run events from a real chant (#679)", () => {
  it("renders a run behold starts from its events, then follows the same run from a fresh session", async () => {
    const root = project(CHANT!);
    const said: string[] = [];
    const broadcaster = new Broadcaster();
    broadcaster.subscribe((type, data) => type === "op" && said.push(data));
    const runner = new OpRunner({ projectDir: root, broadcaster, onDone: () => {} });

    expect(runner.trigger("gated-probe", undefined, root)).toBe(true);
    await vi.waitFor(() => expect(runner.running).toBeNull(), { timeout: 120_000, interval: 200 });
    expect(said[0]).toBe("▶ chant run gated-probe --events-json");
    const ran = runner.runState;
    expect(ran).toMatchObject({ op: "gated-probe", status: "gated", source: "events", runtime: "local", gate: { signalName: "approve-probe" } });
    expect(ran.steps.map((s) => `${s.phase}/${s.step}:${s.state}`)).toEqual(["Before/shellCmd:ok", "Approve/gate:approve-probe:gated"]);
    expect(ran.runId).toMatch(/^local-/);

    // A session that did not start the run reads it back from what chant kept.
    const fresh = new OpRunner({ projectDir: root, broadcaster: new Broadcaster(), onDone: () => {} });
    expect(fresh.follow("gated-probe", { runId: ran.runId!, runtime: "local" }, root)).toBe(true);
    await vi.waitFor(() => expect(fresh.runState.following).toBe(false), { timeout: 60_000, interval: 200 });
    expect(fresh.runState).toMatchObject({ status: "gated", runId: ran.runId, gate: { signalName: "approve-probe" } });
    expect(fresh.runState.steps.map((s) => s.state)).toEqual(["ok", "gated"]);
  }, 180_000);
});
