import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resetExecutorCache } from "./project.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";

// #165: the executor contract at the routes. A designated env is never applied
// from this machine — the guard sits before every other guard on /api/apply,
// an ApplyOp for that env is refused the same way, and /api/project says what
// Deploy can do so the SPA disables the gesture with the reason.
function project(executor: unknown, workflows: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-executor-"));
  writeFileSync(join(dir, "chant.config.ts"), "export default { lexicons: [\"aws\", \"github\"], environments: [\"prod\", \"staging\"] };\n");
  writeFileSync(join(dir, ".behold.json"), JSON.stringify({ executor }));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (const [f, text] of Object.entries(workflows)) writeFileSync(join(dir, ".github", "workflows", f), text);
  return dir;
}

function appFor(dir: string, env?: string, members?: string[]) {
  const broadcaster = new Broadcaster();
  const dirs = members ? [dir, ...members] : undefined;
  return createApp({ projectDir: dir, port: 0, ...(env ? { env } : {}), ...(dirs ? { projectDirs: dirs } : {}) }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir: dir, broadcaster, onDone: () => {} }));
}

/** A member with its own designation and its own committed ApplyOp for prod. */
function memberWithOp(executor: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-executor-member-"));
  writeFileSync(join(dir, "chant.config.ts"), "export default { lexicons: [\"aws\"], environments: [\"prod\"] };\n");
  writeFileSync(join(dir, ".behold.json"), JSON.stringify({ executor }));
  mkdirSync(join(dir, "ops"), { recursive: true });
  writeFileSync(join(dir, "ops", "prod-apply.op.ts"), 'export default ApplyOp({ name: "member-prod-apply", env: "prod", target: "cloudformation" });\n');
  return dir;
}

const DISPATCHABLE = "name: chant-components-prod\non:\n  workflow_dispatch:\njobs:\n  web:\n    runs-on: x\n";
const PUSH_ONLY = "on:\n  push:\njobs:\n  web:\n    runs-on: x\n";

let designated: string;
let broken: string;
let noWorkflow: string;
let plainPrimary: string;
let member: string;
beforeAll(() => {
  resetExecutorCache();
  plainPrimary = project({});
  member = memberWithOp({ prod: { forge: "github", workflow: "deploy-prod.yml" } });
  designated = project({ prod: { forge: "github", workflow: "deploy-prod.yml" } }, { "deploy-prod.yml": DISPATCHABLE });
  broken = project({ prod: { forge: "github", workflow: "deploy-prod.yml" } }, { "deploy-prod.yml": PUSH_ONLY });
  noWorkflow = project({ prod: { forge: "gitub", workflow: "deploy-prod.yml" } });
});
afterAll(() => {
  for (const d of [designated, broken, noWorkflow, plainPrimary, member]) rmSync(d, { recursive: true, force: true });
});

describe("the executor contract (#165)", () => {
  it("/api/apply for a designated env is refused before anything else, and names the way that works", async () => {
    const res = await appFor(designated).request("/api/apply?env=prod", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; remedy: string };
    expect(body.code).toBe("executor-forge");
    expect(body.error).toMatch(/prod deploys through github \(deploy-prod\.yml\)/);
    expect(body.remedy).toMatch(/\/api\/ci\/dispatch\?env=prod/);
  });

  it("an undesignated env is untouched by the guard (it proceeds to the next one)", async () => {
    const res = await appFor(designated).request("/api/apply?env=staging", { method: "POST" });
    expect(res.status).not.toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).not.toBe("executor-forge");
  });

  it("an invalid designation still refuses — fail-closed — and the remedy is the fix", async () => {
    const res = await appFor(noWorkflow).request("/api/apply?env=prod", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { remedy: string };
    expect(body.remedy).toMatch(/Fix \.behold\.json: executor\.prod\.forge/);
  });

  it("/api/project reports each designation's status: dispatchable, or disabled with the reason", async () => {
    const ok = (await (await appFor(designated).request("/api/project")).json()) as { executor: Record<string, { ok: boolean; reason?: string; workflow?: string }> };
    expect(ok.executor.prod).toEqual({ forge: "github", workflow: "deploy-prod.yml", ok: true });
    const bad = (await (await appFor(broken).request("/api/project")).json()) as { executor: Record<string, { ok: boolean; reason?: string }> };
    expect(bad.executor.prod.ok).toBe(false);
    expect(bad.executor.prod.reason).toMatch(/declares no workflow_dispatch/);
    const invalid = (await (await appFor(noWorkflow).request("/api/project")).json()) as { executor: Record<string, { ok: boolean; reason?: string }> };
    expect(invalid.executor.prod.ok).toBe(false);
    expect(invalid.executor.prod.reason).toMatch(/executor\.prod\.forge must be one of/);
  });

  it("a member's own designation guards the member's ApplyOp, though the primary designates nothing", async () => {
    const res = await appFor(plainPrimary, "prod", [member]).request("/api/ops/member-prod-apply/run", { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("executor-forge");
    expect(body.error).toMatch(/running member-prod-apply is refused: env prod deploys through github \(deploy-prod\.yml\)/);
  });

  it("/api/ci/dispatch for an invalid designation refuses with the fix, before touching gh", async () => {
    const res = await appFor(noWorkflow).request("/api/ci/dispatch?env=prod", { method: "POST" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("executor-forge");
  });
});
