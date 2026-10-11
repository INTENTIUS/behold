import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { cacheDir, CHECKOUT_REF, gateEntries, parseApplied, parseLedger, parseLocks, readLifecycle, redact, samePlanDigest, waveRecords, type LifecycleAnswer } from "./terragucci-lifecycle.ts";

// #505: the chant/lifecycle lane, read from a fixture repo built here with
// real git: an origin holding the branch, and a checkout of it that behold
// must leave exactly as it found it.

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "behold-lc-test-"));
  made.push(d);
  return d;
};

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@localhost", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: { ...ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();

const D1 = `jcs1-sha256:${"1".repeat(64)}`;
const D2 = `jcs1-sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const line = (r: object): string => JSON.stringify({ version: 1, op: "tf-apply", ...r });

/** The branch's files: wave 1 approved, wave 2 waiting, wave 3 applied, one lock. */
const LANE: Record<string, string> = {
  "_gates/tf-apply.jsonl": [
    line({ kind: "pending", gate: "wave-1", timestamp: "2026-10-09T08:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D1, commit: "c1" }),
    line({ gate: "wave-1", resolvedBy: "alice", timestamp: "2026-10-09T09:00:00Z", planDigest: D1 }),
    line({ kind: "pending", gate: "wave-2", timestamp: "2026-10-09T10:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D2, runId: "77" }),
    line({ kind: "pending", gate: "wave-3", timestamp: "2026-10-08T10:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: `jcs1-${D3}` }),
    line({ gate: "wave-3", resolvedBy: "bob", timestamp: "2026-10-08T11:00:00Z", planDigest: D3, seal: { signer: "bob" } }),
    "not json",
  ].join("\n"),
  "_gates/tf-apply/applied.jsonl": [
    line({ kind: "applied", gate: "wave-3", planDigest: D3, approvedAt: "2026-10-08T11:00:00Z", approvedBy: "bob", timestamp: "2026-10-08T11:05:00Z", runId: "70" }),
    line({ kind: "finished", gate: "wave-3", planDigest: D3, applied: "2026-10-08T11:05:00Z", result: "applied", timestamp: "2026-10-08T11:09:00Z" }),
  ].join("\n"),
  [`_gates/tf-apply/wave-2/${D2.replace(":", "_")}.json`]: "{}",
  "_locks/tf-apply.json": JSON.stringify({ version: 1, locks: { "envs/prod/orders": { pr: 12, by: "carol", at: "2026-10-09T07:00:00Z", head: "abc123" } } }),
};

/** A bare origin with `chant/lifecycle` (unless `branch` is false), and a checkout whose origin is it. */
function fixture(o: { branch?: boolean; files?: Record<string, string> } = {}): { origin: string; checkout: string; lane: string } {
  const root = scratch();
  const origin = join(root, "origin.git");
  git(root, ["init", "--bare", "-q", origin]);
  const work = join(root, "work");
  mkdirSync(work);
  git(work, ["init", "-q"]);
  writeFileSync(join(work, "terragucci.yml"), "binary: tofu\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "main"]);
  git(work, ["push", "-q", origin, "HEAD:refs/heads/main"]);
  // The branch is its own history, as terragucci writes it: a repo of its own here.
  const lane = join(root, "lane");
  if (o.branch !== false) {
    mkdirSync(lane);
    git(lane, ["init", "-q"]);
    for (const [p, text] of Object.entries(o.files ?? LANE)) {
      mkdirSync(dirname(join(lane, p)), { recursive: true });
      writeFileSync(join(lane, p), text);
    }
    git(lane, ["add", "."]);
    git(lane, ["commit", "-q", "-m", "lane"], { GIT_COMMITTER_DATE: "2026-10-09T10:01:00Z" });
    git(lane, ["push", "-q", origin, "HEAD:refs/heads/chant/lifecycle"]);
  }
  const checkout = join(root, "checkout");
  git(root, ["clone", "-q", "--single-branch", "--branch", "main", origin, checkout]);
  return { origin, checkout, lane };
}

/** Every ref of a repository with its value, and whether FETCH_HEAD exists: what a write would change. */
const refs = (repo: string): string => `${git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])}\nFETCH_HEAD:${existsSync(join(repo, ".git", "FETCH_HEAD"))}`;

describe("the lane's parsers mirror terragucci's", () => {
  it("skips malformed ledger lines and keeps pending and resolutions apart", () => {
    const l = parseLedger(LANE["_gates/tf-apply.jsonl"]!);
    expect(l.pending.map((p) => p.gate)).toEqual(["wave-1", "wave-2", "wave-3"]);
    expect(l.resolutions.map((r) => r.resolvedBy)).toEqual(["alice", "bob"]);
    const a = parseApplied(LANE["_gates/tf-apply/applied.jsonl"]!);
    expect(a.applied).toHaveLength(1);
    expect(a.finished[0]!.result).toBe("applied");
  });

  it("reads a lock file the way parseLocks does, and anything else as no locks", () => {
    expect(parseLocks(LANE["_locks/tf-apply.json"]!)["envs/prod/orders"]).toEqual({ pr: 12, by: "carol", at: "2026-10-09T07:00:00Z", head: "abc123" });
    expect(parseLocks("{")).toEqual({});
    expect(parseLocks(JSON.stringify({ version: 2, locks: { a: { pr: 1, by: "x", at: "t", head: "h" } } }))).toEqual({});
  });

  it("treats the two digest spellings as one", () => {
    expect(samePlanDigest(D3, `jcs1-${D3}`)).toBe(true);
    expect(samePlanDigest(D1, D2)).toBe(false);
  });

  it("names each kept wave report's digest", () => {
    expect(waveRecords([`_gates/tf-apply/wave-2/${D2.replace(":", "_")}.json`, "_gates/tf-apply/applied.jsonl"])).toEqual([{ wave: 2, digest: D2, path: `_gates/tf-apply/wave-2/${D2.replace(":", "_")}.json` }]);
  });

  it("says a pending fact past its expiry with no approval is expired, not waiting", () => {
    const g = gateEntries(
      { pending: [{ version: 1, kind: "pending", op: "tf-apply", gate: "wave-4", timestamp: "2026-10-01T00:00:00Z", expiresAt: "2026-10-02T00:00:00Z", planDigest: D1 }], resolutions: [], applied: [], finished: [] },
      [],
      { branch: "chant/lifecycle", commit: "x", committed: "2026-10-01T00:00:00Z", path: "" },
      new Date("2026-10-10T00:00:00Z"),
    );
    expect(g[0]!.state).toBe("expired");
    expect(g[0]!.command).toBeUndefined();
  });

  it("takes credentials out of a URL", () => {
    expect(redact("https://x-access-token:ghs_secret@github.com/acme/shop.git")).toBe("https://github.com/acme/shop.git");
    expect(redact("git@github.com:acme/shop.git")).toBe("git@github.com:acme/shop.git");
  });
});

describe("readLifecycle on a fixture repo (#505)", () => {
  it("fetches into behold's own cache and reads a waiting wave, an approved wave, an applied wave and a lock, each with its commit", async () => {
    const { checkout, origin } = fixture();
    const before = refs(checkout);
    const cacheRoot = scratch();
    const a = await readLifecycle(checkout, { cacheRoot, now: () => new Date("2026-10-10T00:00:00Z") });

    expect(a).toMatchObject({ branch: "chant/lifecycle", found: true, via: "fetch", origin, fetch: { ok: true }, read: { at: "2026-10-10T00:00:00.000Z" } });
    const tip = git(origin, ["rev-parse", "refs/heads/chant/lifecycle"]);
    expect(a.commit).toEqual({ sha: tip, committed: "2026-10-09T10:01:00Z" });

    const byWave = Object.fromEntries(a.gates.map((g) => [g.wave, g]));
    expect(a.gates.map((g) => g.wave)).toEqual([1, 2, 3]);
    expect(byWave[1]).toMatchObject({ gate: "wave-1", state: "approved", digest: D1, approval: { by: "alice", at: "2026-10-09T09:00:00Z", signed: false } });
    expect(byWave[1]!.command).toBeUndefined();
    expect(byWave[2]).toMatchObject({ state: "waiting", digest: D2, pending: { timestamp: "2026-10-09T10:00:00Z", runId: "77" }, command: `npx terragucci approve wave-2 --plan ${D2}` });
    expect(byWave[2]!.records).toEqual([{ digest: D2, path: `_gates/tf-apply/wave-2/${D2.replace(":", "_")}.json` }]);
    expect(byWave[3]).toMatchObject({ state: "applied", approval: { by: "bob", signed: true }, applied: { at: "2026-10-08T11:05:00Z", result: "applied", finished: "2026-10-08T11:09:00Z" } });

    expect(a.locks).toEqual([{ root: "envs/prod/orders", pr: 12, by: "carol", at: "2026-10-09T07:00:00Z", head: "abc123", source: { branch: "chant/lifecycle", commit: tip, committed: "2026-10-09T10:01:00Z", path: "_locks/tf-apply.json" } }]);
    for (const e of [...a.gates, ...a.locks]) expect(e.source).toMatchObject({ commit: tip, committed: "2026-10-09T10:01:00Z" });

    // The checkout is exactly as it was: no ref moved, nothing fetched into it.
    expect(refs(checkout)).toBe(before);
    expect(() => git(checkout, ["rev-parse", "--verify", "-q", CHECKOUT_REF])).toThrow();
    // The cache is behold's, named behold-lifecycle-*, under the root it was given.
    const cache = cacheDir(origin, cacheRoot);
    expect(basename(cache)).toMatch(/^behold-lifecycle-[0-9a-f]{16}$/);
    expect(readdirSync(cacheRoot)).toEqual([basename(cache)]);
    expect(git(cache, ["rev-parse", "refs/heads/chant/lifecycle"])).toBe(tip);
  });

  it("dates an entry by the newest commit that changed its file, not the branch tip", async () => {
    const { checkout, origin, lane } = fixture();
    writeFileSync(join(lane, "_locks/tf-apply.json"), JSON.stringify({ version: 1, locks: {} }));
    git(lane, ["commit", "-q", "-am", "unlock"], { GIT_COMMITTER_DATE: "2026-10-09T12:00:00Z" });
    git(lane, ["push", "-q", origin, "HEAD:refs/heads/chant/lifecycle"]);
    const a = await readLifecycle(checkout, { cacheRoot: scratch() });
    expect(a.commit!.committed).toBe("2026-10-09T12:00:00Z");
    expect(a.locks).toEqual([]);
    expect(a.gates[0]!.source.committed).toBe("2026-10-09T10:01:00Z");
    expect(a.gates[0]!.source.commit).not.toBe(a.commit!.sha);
  });

  it("answers no branch, not an error, when origin has no chant/lifecycle", async () => {
    const { checkout } = fixture({ branch: false });
    const a = await readLifecycle(checkout, { cacheRoot: scratch() });
    expect(a).toMatchObject({ found: false, via: "fetch", fetch: { ok: true }, gates: [], locks: [] });
    expect(a.note).toContain("has no chant/lifecycle branch");
  });

  it("falls back to the checkout's origin/chant/lifecycle, read-only, when the fetch fails, and says so", async () => {
    const { checkout, origin } = fixture();
    // The person's own earlier fetch, made before the origin went away.
    git(checkout, ["fetch", "-q", "origin", `+refs/heads/chant/lifecycle:${CHECKOUT_REF}`]);
    git(checkout, ["remote", "set-url", "origin", join(dirname(origin), "gone.git")]);
    const before = refs(checkout);
    const a = await readLifecycle(checkout, { cacheRoot: scratch() });
    expect(a).toMatchObject({ found: true, via: "checkout-ref", fetch: { ok: false } });
    expect(a.fetch.error).toBeTruthy();
    expect(a.gates.map((g) => g.state)).toEqual(["approved", "waiting", "applied"]);
    expect(a.note).toContain(CHECKOUT_REF);
    expect(refs(checkout)).toBe(before);
  });

  it("says the gates are unknown when neither the fetch nor the checkout has the branch", async () => {
    const { checkout, origin } = fixture();
    git(checkout, ["remote", "set-url", "origin", join(dirname(origin), "gone.git")]);
    const a = await readLifecycle(checkout, { cacheRoot: scratch() });
    expect(a).toMatchObject({ found: false, via: "none", fetch: { ok: false } });
    expect(a.note).toContain("unknown");
  });

  it("never names a credential from the origin URL", async () => {
    const { checkout } = fixture();
    git(checkout, ["remote", "set-url", "origin", "https://x-access-token:ghs_secret@127.0.0.1:9/acme/shop.git"]);
    const a = await readLifecycle(checkout, { cacheRoot: scratch() });
    expect(JSON.stringify(a)).not.toContain("ghs_secret");
    expect(a.origin).toBe("https://127.0.0.1:9/acme/shop.git");
  });

  it("refuses a cache directory it did not make", async () => {
    const { checkout, origin } = fixture();
    const cacheRoot = scratch();
    const squatter = cacheDir(origin, cacheRoot);
    mkdirSync(squatter);
    writeFileSync(join(squatter, "keep.txt"), "mine");
    const a = await readLifecycle(checkout, { cacheRoot });
    expect(a.via).toBe("none");
    expect(a.fetch.error).toContain("not behold's lifecycle cache");
    expect(readdirSync(squatter)).toEqual(["keep.txt"]);
  });
});

describe("GET /api/terragucci/lifecycle (#505)", () => {
  const BUCKET = join(import.meta.dirname, "..", "example-terragucci-reports");
  function served(checkout: string, cacheRoot: string) {
    const broadcaster = new Broadcaster();
    return createApp(
      { projectDir: checkout, projectDirs: [checkout], port: 0, terragucci: { source: BUCKET, pollSecs: 0, lane: { lifecycle: { cacheRoot } } } },
      broadcaster,
      new FrameBuffer(),
      new OpRunner({ projectDir: checkout, broadcaster, onDone: () => {} }),
    );
  }

  it("answers the gates and locks of the served checkout's chant/lifecycle", async () => {
    const { checkout } = fixture();
    const res = await served(checkout, scratch()).request("/api/terragucci/lifecycle");
    expect(res.status).toBe(200);
    const a = (await res.json()) as LifecycleAnswer;
    expect(a.found).toBe(true);
    expect(a.via).toBe("fetch");
    expect(a.gates.find((g) => g.state === "waiting")!.command).toBe(`npx terragucci approve wave-2 --plan ${D2}`);
    expect(a.locks[0]!.root).toBe("envs/prod/orders");
    expect(a.locks[0]!.source.commit).toBe(a.commit!.sha);
  });

  it("adds only GET routes", async () => {
    const { checkout } = fixture({ branch: false });
    const app = served(checkout, scratch());
    const lane = app.routes.filter((r) => r.path === "/api/terragucci/lifecycle" || r.path === "/api/terragucci/events");
    expect(lane.map((r) => r.method).sort()).toEqual(["GET", "GET"]);
  });
});
