import { describe, it, expect, vi, beforeEach } from "vitest";

// Route-level guard/409 tests for the delegated-write routes (M3 #54's
// /api/apply, alongside the pre-existing /api/rollback) — mock the chant
// shell-out the same way op-runner.test.ts does, so the real OpRunner
// running-guard is exercised end-to-end through the HTTP layer without a
// real chant binary or project on disk.
let resolveDone: (code: number) => void;
const streamMock = vi.fn(() => ({
  pid: 1,
  kill: vi.fn(),
  done: new Promise<number>((res) => {
    resolveDone = res;
  }),
}));
vi.mock("./chant.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chant.ts")>();
  return { ...actual, runChantStream: () => streamMock() };
});

import { createApp } from "./server.ts";
import { OpRunner } from "./op-runner.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";

function makeApp(env?: string) {
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: "/proj", broadcaster, onDone: () => {} });
  const app = createApp({ projectDir: "/proj", env, port: 0 }, broadcaster, new FrameBuffer(), runner);
  return { app, runner };
}

describe("POST /api/apply", () => {
  beforeEach(() => streamMock.mockClear());

  it("400s with no environment available — no ?env=, no launch --env", async () => {
    const { app } = makeApp(undefined);
    const res = await app.request("/api/apply", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/environment/);
  });

  it("triggers the delegated write and returns 200 with the target/env it started", async () => {
    const { app } = makeApp("local");
    const res = await app.request("/api/apply?component=shared-foundation", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ started: true, component: "shared-foundation", env: "local" });
  });

  it('defaults component to "all" when unset — the whole-set apply', async () => {
    const { app } = makeApp("local");
    const res = await app.request("/api/apply", { method: "POST" });
    const body = (await res.json()) as { component: string };
    expect(body.component).toBe("all");
  });

  it("?env= overrides the launch --env for this one apply", async () => {
    const { app } = makeApp("local");
    const res = await app.request("/api/apply?env=staging&component=all", { method: "POST" });
    const body = (await res.json()) as { env: string };
    expect(body.env).toBe("staging");
  });

  it("409s a second apply while the first is still running — one delegated write at a time", async () => {
    const { app } = makeApp("local");
    const first = await app.request("/api/apply?component=all", { method: "POST" });
    expect(first.status).toBe(200);

    const second = await app.request("/api/apply?component=loom-db", { method: "POST" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/busy/);
  });

  it("409s /api/rollback while an apply is in flight — the SAME running-guard covers every delegated write", async () => {
    const { app } = makeApp("local");
    await app.request("/api/apply?component=all", { method: "POST" });
    const res = await app.request("/api/rollback?to=abc123", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("409s an apply while a rollback is in flight — guard is shared in both directions", async () => {
    const { app } = makeApp("local");
    await app.request("/api/rollback?to=abc123", { method: "POST" });
    const res = await app.request("/api/apply?component=all", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("frees the guard once the process ends, so a follow-up apply can start", async () => {
    const { app } = makeApp("local");
    await app.request("/api/apply?component=all", { method: "POST" });
    resolveDone(0);
    await Promise.resolve();
    await Promise.resolve();
    const res = await app.request("/api/apply?component=all", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/ops — applyProgress + running surface the write state", () => {
  it("reports applyProgress: idle and running: null before anything has run", async () => {
    const { app } = makeApp("local");
    const res = await app.request("/api/ops");
    const body = (await res.json()) as { running: string | null; applyProgress: { status: string } };
    expect(body.running).toBeNull();
    expect(body.applyProgress).toEqual({ status: "idle", waves: [], components: [] });
  });

  it('reports running: "apply <target>" while an apply is in flight', async () => {
    const { app } = makeApp("local");
    await app.request("/api/apply?component=all", { method: "POST" });
    const res = await app.request("/api/ops");
    const body = (await res.json()) as { running: string | null };
    expect(body.running).toBe("apply all");
  });
});
