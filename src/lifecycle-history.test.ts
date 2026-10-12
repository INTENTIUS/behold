import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { historyAnswer, lifecycleHistoryRoute, readHistory, type HistoryAnswer } from "./lifecycle-history.ts";

// #522: a ledger history built commit by commit with real git (a request, an
// approval, a revocation, an override request and its override), read back
// through chant's gate-audit with each entry's source commit.

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-hist-test-"));
  made.push(d);
  return d;
};
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@localhost", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: { ...ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();

const D1 = `jcs1-sha256:${"1".repeat(64)}`;
const D2 = `jcs1-sha256:${"2".repeat(64)}`;
const rec = (op: string, r: object): string => JSON.stringify({ version: 1, op, ...r });
const pending1 = rec("tf-apply", { kind: "pending", gate: "wave-1", timestamp: "2026-10-09T08:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D1 });
const approve1 = rec("tf-apply", { gate: "wave-1", resolvedBy: "alice", timestamp: "2026-10-09T09:00:00Z", planDigest: D1 });
const denied = rec("policy-override", { kind: "pending", gate: "envs/prod/orders", timestamp: "2026-10-09T11:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D2, rules: ["no-destroy"] });
const override = rec("policy-override", { gate: "envs/prod/orders", resolvedBy: "bob", timestamp: "2026-10-09T12:00:00Z", planDigest: D2, note: "planned replacement" });

function fixture(): { checkout: string; commits: string[] } {
  const root = scratch();
  const origin = join(root, "origin.git");
  git(root, ["init", "--bare", "-q", origin]);
  const lane = join(root, "lane");
  mkdirSync(join(lane, "_gates", "tf-apply"), { recursive: true });
  git(lane, ["init", "-q"]);
  const commits: string[] = [];
  const step = (files: Record<string, string[]>, at: string, author: string): void => {
    for (const [p, lines] of Object.entries(files)) writeFileSync(join(lane, p), lines.map((l) => `${l}\n`).join(""));
    git(lane, ["add", "-A"]);
    git(lane, ["commit", "-q", "-m", at], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, GIT_AUTHOR_NAME: author });
    commits.push(git(lane, ["rev-parse", "HEAD"]));
  };
  step({ "_gates/tf-apply.jsonl": [pending1] }, "2026-10-09T08:00:01Z", "ci");
  step({ "_gates/tf-apply.jsonl": [pending1, approve1] }, "2026-10-09T09:00:01Z", "alice");
  step({ "_gates/tf-apply.jsonl": [pending1], "_gates/tf-apply/applied.jsonl": ["{}"] }, "2026-10-09T10:00:00Z", "carol");
  step({ "_gates/policy-override.jsonl": [denied] }, "2026-10-09T11:00:01Z", "ci");
  step({ "_gates/policy-override.jsonl": [denied, override] }, "2026-10-09T12:00:01Z", "bob");
  git(lane, ["push", "-q", origin, "HEAD:refs/heads/chant/lifecycle"]);
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, ["init", "-q"]);
  git(checkout, ["remote", "add", "origin", origin]);
  return { checkout, commits };
}

describe("gate history from chant/lifecycle (#522)", () => {
  it("reads every ledger's history through chant's gate-audit, newest first, with source commits", async () => {
    const { checkout, commits } = fixture();
    const r = await readHistory(checkout, { cacheRoot: scratch() });
    expect(r.found).toBe(true);
    expect(r.via).toBe("fetch");
    const a = historyAnswer(r);
    expect(a.ledgers).toEqual(["_gates/policy-override.jsonl", "_gates/tf-apply.jsonl"]);
    expect(a.entries.map((e) => e.kind)).toEqual(["override-recorded", "override-requested", "revoked", "approved", "approval-requested"]);
    const [ov, , rev, ap] = a.entries;
    expect(ov).toMatchObject({ actor: "bob", note: "planned replacement", rules: ["no-destroy"], source: { commit: commits[4], committer: "bob", change: "added" } });
    expect(rev).toMatchObject({ gate: "wave-1", wave: 1, subject: "approval", actor: "carol", digest: D1, source: { commit: commits[2], committer: "carol", change: "removed" } });
    expect(ap).toMatchObject({ actor: "alice", wave: 1, seal: "unsigned", source: { commit: commits[1], committer: "alice", path: "_gates/tf-apply.jsonl" } });
  });

  it("filters by op and gate, and limits, on the route", async () => {
    const { checkout } = fixture();
    const cacheRoot = scratch();
    const app = new Hono();
    lifecycleHistoryRoute(app, () => checkout, { cacheRoot });
    const res = await app.request("/api/lifecycle/history?op=tf-apply&gate=wave-1&limit=2");
    const a = (await res.json()) as HistoryAnswer;
    expect(a.source).toBe("ledger");
    expect(a.total).toBe(3);
    expect(a.entries.map((e) => e.kind)).toEqual(["revoked", "approved"]);
    expect((await app.request("/api/lifecycle/history?limit=0")).status).toBe(400);
  });

  it("says when there is no branch to read", async () => {
    const root = scratch();
    git(root, ["init", "-q"]);
    const r = await readHistory(root, { cacheRoot: scratch() });
    expect(r.found).toBe(false);
    expect(historyAnswer(r).entries).toEqual([]);
  });
});
