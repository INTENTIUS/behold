import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { cacheDir, CHECKOUT_REF, decideLaneGate, gateEntries, MODE_INFERRED, opWavesLane, parseLocks, readGateLedgerText, readLifecycle, redact, waveOfGate, waveRecords, type GateLedger, type LifecycleAnswer } from "./terragucci-lifecycle.ts";
import { overridePending } from "@intentius/chant/override-gate";
import { decideGateApproval, type GateSigners } from "@intentius/chant/gate-decision";

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
function fixture(o: { branch?: boolean; files?: Record<string, string>; main?: Record<string, string> } = {}): { origin: string; checkout: string; lane: string } {
  const root = scratch();
  const origin = join(root, "origin.git");
  git(root, ["init", "--bare", "-q", origin]);
  const work = join(root, "work");
  mkdirSync(work);
  git(work, ["init", "-q"]);
  writeFileSync(join(work, "terragucci.yml"), "binary: tofu\n");
  for (const [p, text] of Object.entries(o.main ?? {})) {
    mkdirSync(dirname(join(work, p)), { recursive: true });
    writeFileSync(join(work, p), text);
  }
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

describe("the lane reads with chant's parsers (#520)", () => {
  it("skips malformed ledger lines and keeps pending, resolutions, applied and finished apart", () => {
    const l = readGateLedgerText(LANE["_gates/tf-apply.jsonl"]!, LANE["_gates/tf-apply/applied.jsonl"]!);
    expect(l.pending.map((p) => p.gate)).toEqual(["wave-1", "wave-2", "wave-3"]);
    expect(l.resolutions.map((r) => r.resolvedBy)).toEqual(["alice", "bob"]);
    expect(l.applied).toHaveLength(1);
    expect(l.finished[0]!.result).toBe("applied");
  });

  it("reads a lock file the way parseLocks does, and anything else as no locks", () => {
    expect(parseLocks(LANE["_locks/tf-apply.json"]!)["envs/prod/orders"]).toEqual({ pr: 12, by: "carol", at: "2026-10-09T07:00:00Z", head: "abc123" });
    expect(parseLocks("{")).toEqual({});
    expect(parseLocks(JSON.stringify({ version: 2, locks: { a: { pr: 1, by: "x", at: "t", head: "h" } } }))).toEqual({});
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

describe("each wave decided by chant's gate-decision (#520)", () => {
  const NOW = new Date("2026-10-10T00:00:00Z");
  const pending = (gate: string, digest: string, at = "2026-10-09T08:00:00Z") => ({ version: 1 as const, kind: "pending" as const, op: "tf-apply", gate, timestamp: at, expiresAt: "2099-01-01T00:00:00Z", planDigest: digest });
  const approval = (gate: string, digest: string, at: string, extra: object = {}) => ({ version: 1 as const, op: "tf-apply", gate, resolvedBy: "alice", timestamp: at, planDigest: digest, ...extra });
  const ledger = (l: Partial<GateLedger>): GateLedger => ({ pending: [], resolutions: [], applied: [], finished: [], ...l });
  const chant = (l: GateLedger, gate: string, digest: string, mode: "ledger" | "sealed", signers?: GateSigners) =>
    decideGateApproval({ ledger: l, gate, planDigest: digest, mode, ...(signers ? { signers } : {}), now: NOW.toISOString(), spend: true });

  it("refuses when an unspent approval stands for another digest, with that digest and no approve line", () => {
    const l = ledger({ pending: [pending("wave-1", D2)], resolutions: [approval("wave-1", D1, "2026-10-09T09:00:00Z")] });
    const g = gateEntries(l, [], { branch: "chant/lifecycle", commit: "x", committed: "2026-10-09T09:00:00Z", path: "" }, NOW)[0]!;
    expect(g).toMatchObject({ state: "refused", digest: D2, refused: { digest: D1, by: "alice" } });
    expect(g.command).toBeUndefined();
    expect(chant(l, "wave-1", D2, "ledger")).toMatchObject({ status: "waiting", mismatched: { planDigest: D1 } });
  });

  it("does not count a spent approval: the wave waits for its own", () => {
    const l = ledger({
      pending: [pending("wave-1", D2, "2026-10-09T08:00:00Z")],
      resolutions: [approval("wave-1", D1, "2026-10-09T09:00:00Z")],
      applied: [{ version: 1, kind: "applied", op: "tf-apply", gate: "wave-1", planDigest: D1, approvedAt: "2026-10-09T09:00:00Z", approvedBy: "alice", timestamp: "2026-10-09T09:05:00Z" }],
    });
    const d = decideLaneGate(l, "wave-1", { mode: "ledger" }, NOW);
    expect(d.state).toBe("waiting");
    expect(d.spent).toMatchObject({ by: "alice", planDigest: D1 });
    expect(chant(l, "wave-1", D2, "ledger").status).toBe("waiting");
  });

  it("does not count an unsealed approval under sealed, and says why", () => {
    const signers: GateSigners = { base: "b", signersPath: ".chant/allowed_signers", active: true, signers: [], problems: [] };
    const l = ledger({ pending: [pending("wave-1", D1)], resolutions: [approval("wave-1", D1, "2026-10-09T09:00:00Z", { seal: { signer: "alice" } })] });
    const d = decideLaneGate(l, "wave-1", { mode: "sealed", signers }, NOW);
    expect(d.state).toBe("waiting");
    expect(d.uncounted?.[0]?.approval.signed).toBe(false);
    expect(d.uncounted?.[0]?.reason).toMatch(/seal/);
    expect(chant(l, "wave-1", D1, "sealed", signers).status).toBe("waiting");
    expect(decideLaneGate(l, "wave-1", { mode: "ledger" }, NOW).state).toBe("approved");
  });

  it("applies identity.gates under ledger with chant's judge from base: an approval it refuses does not count (#537, chant#3862)", () => {
    const l = ledger({ pending: [pending("wave-1", D1)], resolutions: [approval("wave-1", D1, "2026-10-09T09:00:00Z")] });
    const judge = (gate: string, cls: string | null) => ({ requirement: { gate, class: cls }, refuses: () => "alice is not in class human" });
    const d = decideLaneGate(l, "wave-1", { mode: "ledger", identityGates: [judge("wave-1", "human")] }, NOW);
    expect(d.state).toBe("waiting");
    expect(d.uncounted?.[0]?.reason).toBe("identity.gates.wave-1 at base: alice is not in class human");
    expect(d.identity).toEqual({ class: "human" });
    expect(decideLaneGate(l, "wave-1", { mode: "ledger", identityGates: [judge("wave-2", null)] }, NOW).state).toBe("approved");
  });

  it("carries relayedBy, the review's head and reviewers, and the pending members", () => {
    const l = ledger({
      pending: [{ ...pending("wave-1", D1), members: [{ member: "envs/prod", planDigest: D1 }], neverOverMcp: true as const } as GateLedger["pending"][number]],
      resolutions: [approval("wave-1", D1, "2026-10-09T09:00:00Z", { relayedBy: "slackbot", via: "pr-review", pr: 4, head: "abc", reviewers: ["bob"] })],
    });
    const d = decideLaneGate(l, "wave-1", { mode: "ledger" }, NOW);
    expect(d).toMatchObject({ state: "approved", approval: { relayedBy: "slackbot", via: "pr-review", pr: 4, head: "abc", reviewers: ["bob"] }, pending: { members: [{ member: "envs/prod", planDigest: D1 }], neverOverMcp: true } });
  });
});

describe("chant op-waves records (#521)", () => {
  const NOW = new Date("2026-10-10T00:00:00Z");
  const SRC = { branch: "chant/lifecycle" as const, commit: "x", committed: "2026-10-09T12:00:00Z", path: "" };
  const ledger = (l: Partial<GateLedger>): GateLedger => ({ pending: [], resolutions: [], applied: [], finished: [], ...l });
  const pending = (op: string, gate: string, digest: string, extra: object = {}, at = "2026-10-09T08:00:00Z") =>
    ({ version: 1 as const, kind: "pending" as const, op, gate, timestamp: at, expiresAt: "2099-01-01T00:00:00Z", planDigest: digest, ...extra }) as GateLedger["pending"][number];

  it("accepts wave-<k>, chant's <gate>-wave-<k> and a product's own name, and nothing else", () => {
    expect(["wave-2", "tf-apply-wave-2", "yodel-apply-wave-3", "approve-migrate-prod", "pr-12", "wave-x"].map(waveOfGate)).toEqual([2, 2, 3, undefined, undefined, undefined]);
  });

  it("draws chant's default gate name with terragucci's approve line, by wave", () => {
    const g = gateEntries(ledger({ pending: [pending("tf-apply", "tf-apply-wave-2", D2)] }), [], SRC, NOW)[0]!;
    expect(g).toMatchObject({ gate: "tf-apply-wave-2", wave: 2, op: "tf-apply", state: "waiting", command: `npx terragucci approve wave-2 --plan ${D2}` });
  });

  it("draws a product's gate name with chant's approve line, the op from the ledger", () => {
    const spec = opWavesLane("yodel-apply");
    const g = gateEntries(ledger({ pending: [pending("yodel-apply", "yodel-apply-wave-1", D1)] }), [], SRC, NOW, { mode: "sealed" }, spec)[0]!;
    expect(g).toMatchObject({ gate: "yodel-apply-wave-1", wave: 1, op: "yodel-apply", state: "waiting", command: `chant approve yodel-apply yodel-apply-wave-1 --plan ${D1} --sign` });
    expect(spec.ledgerPath).toBe("_gates/yodel-apply.jsonl");
  });

  it("labels a review approval (review.pr, review.head, approver.kind, no via) as review", () => {
    const l = ledger({
      pending: [pending("tf-apply", "tf-apply-wave-1", D1)],
      resolutions: [{ version: 1, kind: "resolution", op: "tf-apply", gate: "tf-apply-wave-1", resolvedBy: "bob", timestamp: "2026-10-09T09:00:00Z", planDigest: D1, approver: { kind: "human" }, review: { pr: 42, head: "abc", approvers: ["bob", "carol"] } } as GateLedger["resolutions"][number]],
    });
    const g = gateEntries(l, [], SRC, NOW)[0]!;
    expect(g).toMatchObject({ state: "approved", approval: { by: "bob", via: "review", pr: 42, head: "abc", reviewers: ["bob", "carol"] } });
  });

  it("says applied with no outcome when chant wrote no finished line", () => {
    const l = ledger({
      pending: [pending("tf-apply", "tf-apply-wave-1", D1)],
      resolutions: [{ version: 1, op: "tf-apply", gate: "tf-apply-wave-1", resolvedBy: "alice", timestamp: "2026-10-09T09:00:00Z", planDigest: D1 }],
      applied: [{ version: 1, kind: "applied", op: "tf-apply", gate: "tf-apply-wave-1", planDigest: D1, approvedAt: "2026-10-09T09:00:00Z", approvedBy: "alice", timestamp: "2026-10-09T09:05:00Z" }],
    });
    const g = gateEntries(l, [], SRC, NOW)[0]!;
    expect(g.state).toBe("applied");
    expect(g.applied).toMatchObject({ at: "2026-10-09T09:05:00Z" });
    expect(g.applied!.result).toBeUndefined();
  });

  it("draws a wave the policy refused, from the wave its fact names, with the override line and no approve line (chant#3839)", () => {
    // The hook's own reason as the description: the wave is read from the fact's field, never the text.
    const denial = { ...overridePending({ subject: "envs/prod/db", planDigest: D3, rules: ["no-destroy"], timestamp: "2026-10-09T10:00:00Z", expiresAt: "2099-01-01T00:00:00Z", description: "the prod database may not be destroyed" }), wave: { number: 2, name: "apps", op: "tf-apply" } };
    const l = readGateLedgerText(line({ kind: "pending", gate: "tf-apply-wave-1", timestamp: "2026-10-09T08:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D1 }), "", { ledgers: { "_gates/policy-override.jsonl": JSON.stringify(denial) } });
    const g = gateEntries(l, [], SRC, NOW).find((e) => e.wave === 2)!;
    expect(g).toMatchObject({ gate: "wave-2", state: "refused-by-policy", denials: [{ member: "envs/prod/db", plan: D3, rules: ["no-destroy"], command: 'chant approve policy-override envs/prod/db --rule no-destroy --reason "<why>"' }] });
    expect(g.command).toBeUndefined();
    // An override from a listed overrider with a reason lets the wave go on.
    const over = { version: 1, op: "policy-override", gate: "envs/prod/db", resolvedBy: "dana", timestamp: "2026-10-09T11:00:00Z", planDigest: denial.planDigest, note: "planned migration" };
    const l2 = readGateLedgerText("", "", { ledgers: { "_gates/policy-override.jsonl": [JSON.stringify(denial), JSON.stringify(over)].join("\n") } });
    expect(gateEntries(l2, [], SRC, NOW, { mode: "ledger", overriders: { principals: ["dana"], path: "policy.override" } })).toEqual([]);
    expect(gateEntries(l2, [], SRC, NOW, { mode: "ledger", overriders: { principals: [], path: "policy.override" } })[0]!.state).toBe("refused-by-policy");
  });

  it("draws a wave held on another op's gate, from the wave its fact names, with that gate's approve line, until it is approved (chant#3839)", () => {
    const held = JSON.stringify({ version: 1, kind: "pending", op: "tf-migrate", gate: "move-db", timestamp: "2026-10-09T10:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D2, description: "migrate the orders table first", wave: { number: 1, name: "base", op: "tf-apply" } });
    const l = readGateLedgerText("", "", { ledgers: { "_gates/tf-migrate.jsonl": held } });
    const g = gateEntries(l, [], SRC, NOW)[0]!;
    expect(g).toMatchObject({ gate: "wave-1", wave: 1, state: "held", heldOn: { op: "tf-migrate", gate: "move-db", digest: D2, description: "migrate the orders table first" }, command: `chant approve tf-migrate move-db --plan ${D2}` });
    const ok = JSON.stringify({ version: 1, op: "tf-migrate", gate: "move-db", resolvedBy: "alice", timestamp: "2026-10-09T11:00:00Z", planDigest: D2 });
    expect(gateEntries(readGateLedgerText("", "", { ledgers: { "_gates/tf-migrate.jsonl": `${held}\n${ok}` } }), [], SRC, NOW)).toEqual([]);
    // Another spec's wave, and a fact that names no wave, hold nothing here.
    const other = held.replace('"op":"tf-apply"', '"op":"yodel-apply"');
    expect(gateEntries(readGateLedgerText("", "", { ledgers: { "_gates/tf-migrate.jsonl": other } }), [], SRC, NOW)).toEqual([]);
    const unnamed = JSON.stringify({ version: 1, kind: "pending", op: "tf-migrate", gate: "move-db", timestamp: "2026-10-09T10:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D2, description: "wave 1 (base) of tf-apply is held on it by after-plan hook migrate" });
    expect(gateEntries(readGateLedgerText("", "", { ledgers: { "_gates/tf-migrate.jsonl": unnamed } }), [], SRC, NOW)).toEqual([]);
  });

  it("decides a held wave's gate under the mode its fact records (chant#3861)", () => {
    const held = JSON.stringify({ version: 1, kind: "pending", op: "tf-migrate", gate: "move-db", timestamp: "2026-10-09T10:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D2, approvalMode: "sealed", wave: { number: 1, name: "base", op: "tf-apply" } });
    const g = gateEntries(readGateLedgerText("", "", { ledgers: { "_gates/tf-migrate.jsonl": held } }), [], SRC, NOW)[0]!;
    expect(g).toMatchObject({ state: "held", mode: "sealed", approvalMode: { mode: "sealed", from: "pending" }, command: `chant approve tf-migrate move-db --plan ${D2} --sign` });
  });

  it("decides a wave under the approval mode its pending fact records, else the mode at base (chant#3861)", () => {
    const signers: GateSigners = { base: "b", signersPath: ".chant/allowed_signers", active: true, signers: [], problems: [] };
    const l = ledger({
      pending: [pending("tf-apply", "tf-apply-wave-1", D1, { approvalMode: "sealed" }), pending("tf-apply", "tf-apply-wave-2", D2)],
      resolutions: [{ version: 1, op: "tf-apply", gate: "tf-apply-wave-1", resolvedBy: "alice", timestamp: "2026-10-09T09:00:00Z", planDigest: D1 }],
    });
    const [w1, w2] = gateEntries(l, [], SRC, NOW, { mode: "ledger", signers });
    expect(w1).toMatchObject({ state: "waiting", mode: "sealed", approvalMode: { mode: "sealed", from: "pending" }, command: `npx terragucci approve wave-1 --plan ${D1} --sign` });
    expect(w1!.uncounted?.[0]?.reason).toMatch(/seal/);
    expect(w2).toMatchObject({ state: "waiting", approvalMode: { mode: "ledger", from: "base" } });
    expect(w2!.mode).toBeUndefined();
  });

  it("answers a decision-point gate with chant workspace points answer, and needs no commit on the pending fact", () => {
    const l = ledger({ pending: [pending("tf-apply", "tf-apply-wave-3", D1, { answer: { point: "go-live", id: "pt-7", path: ".chant/points/go-live/pt-7.json" } })] });
    const g = gateEntries(l, [], SRC, NOW)[0]!;
    expect(g).toMatchObject({ state: "waiting", pending: { answer: { point: "go-live", id: "pt-7" } }, command: "chant workspace points answer pt-7" });
    expect(g.pending!.commit).toBeUndefined();
  });

  it("reads the other ledgers off the branch", async () => {
    const denial = { ...overridePending({ subject: "envs/prod/db", planDigest: D3, rules: ["no-destroy"], timestamp: "2026-10-09T11:00:00Z", expiresAt: "2099-01-01T00:00:00Z", description: `wave 2 (apps) of tf-apply: envs/prod/db: plan ${D3} denied by no-destroy` }), wave: { number: 2, name: "apps", op: "tf-apply" } };
    const { checkout } = fixture({ files: { ...LANE, "_gates/policy-override.jsonl": JSON.stringify(denial) } });
    const a = await readLifecycle(checkout, { cacheRoot: scratch(), now: () => NOW });
    expect(a.gates.find((g) => g.wave === 2)).toMatchObject({ state: "refused-by-policy", denials: [{ member: "envs/prod/db" }] });
    expect(a.gates.find((g) => g.wave === 1)!.state).toBe("approved");
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
    expect(byWave[3]).toMatchObject({ state: "applied", approval: { by: "bob", signed: false }, applied: { at: "2026-10-08T11:05:00Z", result: "applied", finished: "2026-10-08T11:09:00Z" } });

    // None of these facts records the mode it asked under: each wave takes the mode at base, and the lane says so.
    expect(a.gates.every((g) => g.approvalMode?.from === "base")).toBe(true);
    expect(a.approval).toMatchObject({ mode: "ledger", inferred: MODE_INFERRED });

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

  it("calls nothing inferred when every wave's fact records its mode (chant#3861)", async () => {
    const files = { "_gates/tf-apply.jsonl": line({ kind: "pending", gate: "wave-1", timestamp: "2026-10-09T08:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D1, approvalMode: "ledger" }) };
    const { checkout } = fixture({ files });
    const a = await readLifecycle(checkout, { cacheRoot: scratch(), now: () => new Date("2026-10-10T00:00:00Z") });
    expect(a.gates[0]).toMatchObject({ state: "waiting", approvalMode: { mode: "ledger", from: "pending" } });
    expect(a.approval!.inferred).toBeUndefined();
  });

  it("reads a member's recorded head plans with chant's readHeadPlans for a wave whose fact asked under pr-review (chant#3865)", async () => {
    const plans = (head: string, digest: string, at: string) => JSON.stringify({ version: 1, name: "tf-apply", head, timestamp: at, waves: [{ wave: 1, name: "base", digest }] });
    const files = {
      "_members/db/_gates/tf-apply.jsonl": line({ kind: "pending", gate: "tf-apply-wave-1", timestamp: "2026-10-09T08:00:00Z", expiresAt: "2099-01-01T00:00:00Z", planDigest: D1, approvalMode: "pr-review" }),
      "_members/db/_wave-plans/tf-apply/abc123.json": plans("abc123", D1, "2026-10-09T07:00:00Z"),
      "_members/db/_wave-plans/tf-apply/def456.json": plans("def456", D2, "2026-10-09T07:30:00Z"),
      "_members/db/_wave-plans/tf-apply/broken.json": "{",
    };
    const { checkout } = fixture({ files });
    const spec = opWavesLane("tf-apply", { headPlans: "tf-apply", ledgerPrefix: "_members/db/" });
    const a = await readLifecycle(checkout, { cacheRoot: scratch(), now: () => new Date("2026-10-10T00:00:00Z"), spec });
    expect(a.gates[0]).toMatchObject({ state: "waiting", mode: "pr-review", approvalMode: { mode: "pr-review", from: "pending" } });
    expect(a.gates[0]!.headPlans).toEqual([{ head: "abc123", timestamp: "2026-10-09T07:00:00Z", path: "_members/db/_wave-plans/tf-apply/abc123.json" }]);
  });

  it("judges an identity.gates gate's class with chant's rule at base (chant#3862)", async () => {
    const main = { "chant.workspace.json": JSON.stringify({ version: 1, members: [], identity: { gates: { "wave-1": { class: "human" } } } }) };
    const { checkout } = fixture({ main });
    const a = await readLifecycle(checkout, { cacheRoot: scratch(), now: () => new Date("2026-10-10T00:00:00Z") });
    expect(a.approval!.identityGates).toEqual([{ gate: "wave-1", class: "human" }]);
    const w1 = a.gates.find((g) => g.wave === 1)!;
    // alice's approval is unsealed: chant's judge refuses it, and the gate waits.
    expect(w1).toMatchObject({ state: "waiting", identity: { class: "human" } });
    expect(w1.uncounted?.[0]?.reason).toMatch(/^identity\.gates\.wave-1 at base: /);
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
