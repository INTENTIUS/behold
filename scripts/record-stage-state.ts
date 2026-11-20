/**
 * behold#1236: records src/__fixtures__/stage-state/status-prod.json, the
 * `chant workspace status prod --json` document the Stages tab's tests read.
 *
 *   npx tsx scripts/record-stage-state.ts <chant checkout>
 *
 * It builds a scratch workspace in a temp directory with three members, each
 * with its own `.chant/pipeline.ts`: `network` (kind terraform), `shop`
 * (kind pulumi) and `orders-db` (kind sql). chant's own ledger writers fill
 * `chant/lifecycle` there, the way chant's status-stages test does, and
 * chant's `workspaceStatus` reads it at a fixed time. Nothing is pushed and
 * nothing outside the temp directory is written but the fixture.
 *
 * Each member writes its ledger from its own directory, so chant keeps it
 * under `_members/<member>/`. The scene:
 *  - shop: dev is paused by carol with v1.1.0 waiting behind the pause; the
 *    canary's soak holds the promote into prod with an hour left; prod runs
 *    v1.1.0, its verify failed, and a rollback to v1.0.0 waits at its gate;
 *    v1.2.0 waits for prod in the stage log.
 *  - network: prod's gate waits for v1.1.0, and the release's risk is over the
 *    stage's threshold, so the gate takes more approvals.
 *  - orders-db: prod is held for a schema review, and its last failure has
 *    no earlier release to go back to, so the rollback is held.
 *
 * The chant checkout is the source tree (`packages/core/src`) with its
 * node_modules installed; the fixture names the chant version it was read
 * with in the test that loads it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const chant = process.argv[2];
if (!chant) {
  console.error("usage: npx tsx scripts/record-stage-state.ts <chant checkout>");
  process.exit(2);
}
const src = resolve(chant, "packages/core/src");
const out = resolve(import.meta.dirname, "../src/__fixtures__/stage-state/status-prod.json");

const { workspaceStatus } = await import(join(src, "workspace/status.ts"));
const { appendCut, makeRelease, persistRelease } = await import(join(src, "lifecycle/release-store.ts"));
const { appendReleaseRecord } = await import(join(src, "lifecycle/release-ledger.ts"));
const { appendGateResolution, appendPendingGate } = await import(join(src, "lifecycle/gate-ledger.ts"));
const { gitStageLedgerPort } = await import(join(src, "pipeline/stage-ledger.ts"));
const { gitStageLogPort } = await import(join(src, "lifecycle/stage-log.ts"));
const { contentDigest } = await import(join(src, "content-digest.ts"));

const NOW = "2026-11-20T12:00:00.000Z";
const at = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();

const pipelines: Record<string, { dir: string; kind: string; text: string }> = {
  network: {
    dir: "network",
    kind: "terraform",
    text: `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "net",
  defaults: { op: "net", step: { kind: "terraform-apply", root: "{target}" }, runner: "ubuntu-latest" },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never", holds: { risk: { approveAbove: 0.9 } } } },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }], gate: { holds: { risk: { approveAbove: 0.3 } } } },
  ],
});
`,
  },
  shop: {
    dir: "shop",
    kind: "pulumi",
    text: `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "shop",
  defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" }, runner: "ubuntu-latest" },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never", holds: { risk: { approveAbove: 0.9 } } } },
    {
      name: "canary",
      canary: true,
      waves: [{ name: "canary", runs: [{ target: "canary" }] }],
      gate: { holds: { risk: { approveAbove: 0.3 } } },
      soak: { duration: "2h", checks: [{ kind: "http", name: "up", url: "https://canary.example/healthz" }] },
    },
    {
      name: "prod",
      queue: "replace",
      waves: [{ name: "prod", runs: [{ target: "prod" }] }],
      gate: { holds: { risk: { approveAbove: 0.5 } } },
      onVerifyFail: "rollback",
    },
  ],
});
`,
  },
  "orders-db": {
    dir: "db",
    kind: "sql",
    text: `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "db",
  defaults: { op: "db", step: { kind: "sql-migrate", environment: "{target}", spec: "yodel-waves.json" }, runner: "ubuntu-latest" },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
    {
      name: "prod",
      waves: [{ name: "prod", runs: [{ target: "prod" }] }],
      hold: { reason: "schema review", description: "Read the orders migration plan before lifting the hold." },
      onVerifyFail: "rollback",
    },
  ],
});
`,
  },
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const dir = mkdtempSync(join(tmpdir(), "behold-stage-state-"));
git(dir, "init", "-q", "-b", "main");
git(dir, "config", "user.email", "fixture@behold.test");
git(dir, "config", "user.name", "fixture");
writeFileSync(
  join(dir, "chant.workspace.json"),
  JSON.stringify({ name: "acme", schema: 1, members: Object.entries(pipelines).map(([name, p]) => ({ name, dir: p.dir, kind: p.kind, because: "the stage-state fixture" })) }, null, 2),
);
for (const p of Object.values(pipelines)) {
  mkdirSync(join(dir, p.dir, ".chant"), { recursive: true });
  writeFileSync(join(dir, p.dir, ".chant", "pipeline.ts"), p.text);
}
git(dir, "add", ".");
git(dir, "commit", "-q", "-m", "init");
const commits = [git(dir, "rev-parse", "HEAD")];
for (const m of ["next", "after"]) {
  git(dir, "commit", "-q", "--allow-empty", "-m", m);
  commits.push(git(dir, "rev-parse", "HEAD"));
}

const risk = (commit: string, score: number, op: string) => ({
  version: 1,
  commit,
  score,
  level: score < 0.3 ? "low" : score < 0.6 ? "medium" : "high",
  waves: [{ op: `${op}-dev`, wave: 1, name: "dev", digest: contentDigest(`plan ${op} ${commit}`), risk: { version: 1, score, level: "medium", reasons: [], approveAbove: null, over: false, overBy: [] } }],
});
type Rel = { releaseDigest: string; commit: string };
const ref = (r: Rel, label: string) => ({ digest: r.releaseDigest, label });

/**
 * One member's ledger, written from its own directory, so chant keeps it
 * under `_members/<member>/` the way a member's own runs do. Cuts v1.0.0,
 * v1.1.0 (scored `score`) and v1.2.0 of the member's one component.
 */
async function member(name: string, component: string, op: string, score: number) {
  const opts = { cwd: join(dir, pipelines[name]!.dir) };
  const cut = (commit: string): Rel => makeRelease({ member: name, commit, artifactDigests: [{ component, kind: "image", path: `${component}.tar`, digest: contentDigest(`${component} ${commit}`) }], targets: [] });
  const [v1, v2, v3] = commits.map(cut) as [Rel, Rel, Rel];
  await persistRelease(v1, [], opts);
  await appendCut({ releaseDigest: v1.releaseDigest, label: "v1.0.0", actor: "alice", timestamp: at(-48), runOrigin: null }, opts);
  await persistRelease(v2, [], opts);
  await appendCut({ releaseDigest: v2.releaseDigest, label: "v1.1.0", actor: "alice", timestamp: at(-24), runOrigin: null, risk: risk(commits[1]!, score, op) }, opts);
  await persistRelease(v3, [], opts);
  await appendCut({ releaseDigest: v3.releaseDigest, label: "v1.2.0", actor: "alice", timestamp: at(-0.2), runOrigin: null, risk: risk(commits[2]!, 0.2, op) }, opts);
  const deploy = (stage: string, release: Rel, timestamp: string) =>
    appendReleaseRecord({ env: stage, component, digest: contentDigest(`${component} ${release.commit}`), gitSha: release.commit, runId: `run-${op}-${stage}`, actor: "ci", timestamp, releaseDigest: release.releaseDigest }, opts);
  const stages = gitStageLedgerPort(opts);
  const line = (input: Record<string, unknown>) => stages.append({ version: 1, pipeline: op, ...input });
  return { opts, v1, v2, v3, deploy, line };
}

// shop (pulumi): a held canary and a requested rollback.
{
  const { opts, v1, v2, v3, deploy, line } = await member("shop", "api", "shop", 0.4);
  await deploy("dev", v2, at(-6));
  await deploy("canary", v2, at(-1));
  await deploy("prod", v1, at(-30));
  await deploy("prod", v2, at(-0.5));
  // The canary's soak held a promote into prod an hour in, with an hour left.
  await appendPendingGate(
    {
      op: "shop", gate: "canary-soak", environment: "canary", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, timestamp: at(-0.25), expiresAt: at(700),
      soak: { stage: "canary", to: "prod", clockStart: at(-1), due: at(1), leftMs: 4_500_000, holds: [`1h 15m left, until ${at(1)}`] },
    },
    opts,
  );
  // Prod's gate waited for v1.1.0, and bob approved it.
  await appendPendingGate({ op: "shop", gate: "prod", environment: "prod", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, timestamp: at(-0.75), expiresAt: at(24) }, opts);
  await appendGateResolution({ op: "shop", gate: "prod", environment: "prod", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, resolvedBy: "bob", timestamp: at(-0.7) }, opts);
  // Prod's verify failed on v1.1.0, and the stage asked to go back to v1.0.0.
  await line({ kind: "failed", stage: "prod", by: "ci", timestamp: at(-0.4), id: "f1", failure: "verify", failed: ref(v2, "v1.1.0"), members: [{ member: "api", state: "applied" }], detail: ["smoke failed"] });
  await line({ kind: "rollback-requested", stage: "prod", by: "ci", timestamp: at(-0.4), id: "r1", failureId: "f1", failed: ref(v2, "v1.1.0"), release: ref(v1, "v1.0.0"), members: [{ member: "api", state: "applied", rollback: "requested" }], gate: "prod-rollback" });
  await appendPendingGate({ op: "shop", gate: "prod-rollback", environment: "prod", planDigest: v1.releaseDigest, releaseDigest: v1.releaseDigest, timestamp: at(-0.4), expiresAt: at(700) }, opts);
  // Dev is paused, and a release waited behind the pause.
  await line({ kind: "pause", stage: "dev", by: "carol", reason: "db upgrade", timestamp: at(-2) });
  await line({ kind: "waiting", stage: "dev", by: "ci", timestamp: at(-1.5), release: ref(v2, "v1.1.0") });
  // Prod's stage log: v1.1.0 entered and finished, v1.2.0 waits.
  const log = gitStageLogPort(opts);
  await log.append({ version: 1, kind: "entered", op: "shop", stage: "prod", digest: v2.releaseDigest, label: "v1.1.0", timestamp: at(-0.6) });
  await log.append({ version: 1, kind: "finished", op: "shop", stage: "prod", digest: v2.releaseDigest, label: "v1.1.0", result: "applied", timestamp: at(-0.5) });
  await log.append({ version: 1, kind: "waiting", op: "shop", stage: "prod", digest: v3.releaseDigest, label: "v1.2.0", cutAt: at(-0.2), timestamp: at(-0.1) });
}

// network (terraform): prod's gate waits for v1.1.0, whose risk is over the stage's 0.3.
{
  const { opts, v1, v2, deploy } = await member("network", "vpc", "net", 0.55);
  await deploy("dev", v2, at(-5));
  await deploy("prod", v1, at(-40));
  await appendPendingGate({ op: "net", gate: "prod", environment: "prod", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, timestamp: at(-0.3), expiresAt: at(24) }, opts);
}

// orders-db (sql): prod is held, and its failure has no earlier release to go back to.
{
  const { v2, deploy, line } = await member("orders-db", "orders", "db", 0.1);
  await deploy("dev", v2, at(-8));
  await deploy("prod", v2, at(-0.3));
  await line({ kind: "failed", stage: "prod", by: "ci", timestamp: at(-0.2), id: "f2", failure: "verify", failed: ref(v2, "v1.1.0"), members: [{ member: "orders", state: "applied" }] });
  await line({ kind: "rollback-held", stage: "prod", by: "ci", timestamp: at(-0.2), failureId: "f2", held: "stage prod ran no earlier release of orders-db" });
}

const doc = await workspaceStatus({ cwd: dir, env: "prod", now: NOW });
if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
mkdirSync(resolve(out, ".."), { recursive: true });
// The temp path is not part of the fixture.
writeFileSync(out, `${JSON.stringify(doc, null, 2).replaceAll(dir, "<workspace>")}\n`);
console.log(`wrote ${out} from ${dir}`);
