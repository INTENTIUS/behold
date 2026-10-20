import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { readWorkspace } from "./workspace.ts";
import { makeReportUrlWorkspace } from "./ci-report-url-fixture.ts";

// #818 against a real chant: a workspace declaring ci.reportUrl as a file://
// URL of the fan-out demo's reports (which hold a run index), read through
// `chant workspace ls --json`, served with no --ci-report-url. The runs pane's
// route reads the index there and says the declaration named it; the flag
// still wins over it, and a workspace that declares none serves no such route.
//
// ci.reportUrl is new in chant 0.124.32 (chant#4160), so the test runs only
// when BEHOLD_TEST_CHANT_BIN names a chant that writes it (a local pack of
// chant main at 7f1bd9130 was used). HOME and git's global config live in the
// temp directories.

const CHANT = process.env.BEHOLD_TEST_CHANT_BIN;
const REPORTS = join(import.meta.dirname, "__fixtures__", "chant-demo", "reports");

const made: string[] = [];
const saved: Record<string, string | undefined> = {};
const ISOLATE = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "behold-818-home-"));
  made.push(home);
  for (const k of ISOLATE) saved[k] = process.env[k];
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
});
afterAll(() => {
  for (const k of ISOLATE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function serve(reportUrl: string | undefined, flag?: string) {
  const scratch = mkdtempSync(join(tmpdir(), "behold-818-ws-"));
  made.push(scratch);
  const root = makeReportUrlWorkspace(scratch, { chant: CHANT!, ...(reportUrl ? { reportUrl } : {}) });
  const read = await readWorkspace(root);
  if (!read.ok) throw new Error(read.refusal.error);
  const declared = read.workspace.ciReportUrl;
  const broadcaster = new Broadcaster();
  const app = createApp(
    { projectDir: root, port: 0, ...(flag ? { ciReportUrl: flag } : {}), ...(declared ? { ciReportUrlDeclared: declared } : {}) },
    broadcaster,
    new FrameBuffer(),
    new OpRunner({ projectDir: root, broadcaster, onDone: () => {} }),
  );
  return { app, declared };
}

describe.skipIf(!CHANT || !existsSync(CHANT))("the declared CI report URL, through chant (#818)", () => {
  it("reads the run index at the declared URL when serve has no --ci-report-url", async () => {
    const { app, declared } = await serve(`file://${REPORTS}`);
    expect(declared).toBe(`file://${REPORTS}`);
    const body = (await (await app.request("/api/chant/ci/runs")).json()) as Record<string, any>;
    expect(body).toMatchObject({ urlFrom: "declaration", chant: "0.124.31" });
    expect(body.doc.runs).toHaveLength(5);
  }, 60_000);

  it("lets --ci-report-url override it", async () => {
    const { app } = await serve("file:///nowhere/at/all", REPORTS);
    const body = (await (await app.request("/api/chant/ci/runs")).json()) as Record<string, any>;
    expect(body).toMatchObject({ urlFrom: "flag", source: REPORTS });
  }, 60_000);

  it("changes nothing when the workspace declares none", async () => {
    const { app, declared } = await serve(undefined);
    expect(declared).toBeUndefined();
    expect((await app.request("/api/chant/ci/runs")).status).toBe(404);
  }, 60_000);
});
