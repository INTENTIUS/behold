import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChantRaw, isScheduledRead, resolveChant } from "./chant.ts";
import { createApp } from "./server.ts";
import { invalidateReadGeneration, withReadSignal } from "./read-scheduler.ts";

// Real subprocesses, no cluster. The fixture writes its instrumentation outside
// the member so observing it cannot accidentally change the source stamp.
let scratch: string, project: string, log: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "behold-read-test-"));
  project = join(scratch, "project"); log = join(scratch, "events");
  const pkg = join(project, "node_modules/@intentius/chant");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(project, "source.ts"), "// fixture source\n");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version: "0.54.0", main: "chant.cjs", bin: { chant: "chant.cjs" } }));
  writeFileSync(join(pkg, "chant.cjs"), `#!/usr/bin/env node
const fs = require('node:fs');
const log = ${JSON.stringify(log)};
const event = (value) => fs.appendFileSync(log, JSON.stringify(value) + '\\n');
event({ event: 'start', pid: process.pid, args: process.argv.slice(2) });
if (process.argv.includes('--tree')) {
  const child = require('node:child_process').spawn(process.execPath, ['-e',
    "process.on('SIGTERM', () => {}); require('node:fs').appendFileSync(" + JSON.stringify(log) + ", JSON.stringify({event:'child',pid:process.pid})+'\\\\n'); setInterval(() => {}, 1000);"
  ], { stdio: 'ignore' });
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    event({ event: 'finish', pid: process.pid });
    process.stdout.write(JSON.stringify({ pid: process.pid, variant: process.env.READ_TEST_VARIANT }));
  }, process.argv.includes('--slow') ? 1000 : 150);
}
`, { mode: 0o755 });
  expect(resolveChant(project).source).toBe("project");
  vi.stubEnv("BEHOLD_ESTATE_CONCURRENCY", "2");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(scratch, { recursive: true, force: true }); });
const events = (): { event: string; pid: number; args?: string[] }[] => {
  try { return readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s)); } catch { return []; }
};

describe("real Chant read scheduling", () => {
  it("matching HTTP and background reads share a process, then the next read is fresh", async () => {
    const args = ["graph", "source.ts", "--live", "--namespace", "app"];
    const first = withReadSignal(new AbortController().signal, () => runChantRaw(args, project));
    const second = runChantRaw(args, project);
    const [a, b] = await Promise.all([first, second]);
    expect(a.stdout).toBe(b.stdout);
    expect(events().filter((e) => e.event === "start")).toHaveLength(1);
    a.stdout = "caller mutation";
    expect(b.stdout).not.toBe(a.stdout);
    const fresh = await runChantRaw(args, project);
    expect(fresh.stdout).not.toBe(b.stdout);
  });

  it("the HTTP middleware isolates cancellation between matching requests", async () => {
    const app = createApp({ projectDir: project, port: 0 });
    app.onError((error, c) => c.json({ error: error.message }, 500));
    const caller = new AbortController();
    const first = app.request(new Request("http://localhost/api/diff?env=home", { signal: caller.signal }));
    const second = app.request("/api/diff?env=home");
    await vi.waitFor(() => expect(events().filter((e) => e.event === "start")).toHaveLength(1));
    caller.abort(new Error("client disconnected"));
    expect((await first).status).toBe(500);
    expect((await second).status).toBe(200);
    expect(events().filter((e) => e.event === "start")).toHaveLength(1);
  });

  it("namespace, effective environment, source edits, and watcher invalidation isolate reads", async () => {
    const args = ["graph", "source.ts", "--live"];
    const reads = [runChantRaw(args, project)];
    reads.push(runChantRaw([...args, "--namespace", "other"], project));
    reads.push(runChantRaw(args, project, { READ_TEST_VARIANT: "other" }));
    writeFileSync(join(project, "source.ts"), "// changed while reading\n");
    reads.push(runChantRaw(args, project));
    invalidateReadGeneration();
    reads.push(runChantRaw(args, project));
    const results = await Promise.all(reads);
    expect(new Set(results.map((r) => JSON.parse(r.stdout).pid)).size).toBe(5);
    let active = 0, peak = 0;
    for (const e of events()) { active += e.event === "start" ? 1 : -1; peak = Math.max(peak, active); }
    expect(peak).toBe(2);
  });

  it("a timed-out process releases the shared budget", async () => {
    vi.stubEnv("BEHOLD_READ_TIMEOUT_MS", "50");
    await expect(runChantRaw(["graph", "source.ts", "--slow"], project)).rejects.toThrow("exceeded 50ms");
    vi.stubEnv("BEHOLD_READ_TIMEOUT_MS", "3000");
    expect((await runChantRaw(["graph", "source.ts"], project)).code).toBe(0);
  });

  it.skipIf(process.platform === "win32")("disconnect kills the whole worker group, including a descendant ignoring TERM", async () => {
    const caller = new AbortController();
    const read = withReadSignal(caller.signal, () => runChantRaw(["graph", "source.ts", "--tree"], project));
    // Handle rejection immediately; disconnect rejects the subscriber before
    // the worker group has necessarily finished closing its pipes.
    const rejected = read.catch((error) => error);
    let child = 0;
    try {
      await vi.waitFor(() => { child = events().find((e) => e.event === "child")?.pid ?? 0; expect(child).toBeGreaterThan(0); });
      caller.abort(new Error("client left"));
      expect((await rejected).message).toBe("client left");
      await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow(), { timeout: 3000 });
    } finally {
      caller.abort(new Error("client left"));
      for (const e of events()) { try { process.kill(e.pid, "SIGKILL"); } catch {} }
    }
  });

  it("delegated mutations are never scheduled or deduplicated as reads", async () => {
    for (const args of [["approve", "op", "gate"], ["run", "apply"], ["emulator", "up"], ["carve", "emit"], ["build"]]) {
      expect(isScheduledRead(args)).toBe(false);
    }
    const results = await Promise.all([runChantRaw(["approve", "op", "gate"], project), runChantRaw(["approve", "op", "gate"], project)]);
    expect(results[0].stdout).not.toBe(results[1].stdout);
  });
});
