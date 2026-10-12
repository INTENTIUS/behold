import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { migrateOpLane, parseYodelWaves, readSqlYodelerLane, yodelApproveCommand } from "./sql-yodeler-lane.ts";
import { sqlCardFields, sqlIconFor, sqlKindLabel } from "./sql-kinds.ts";
import { graphIr } from "./chant.ts";

// #524: a SQL Yodeler repo's lane, from a fixture chant/lifecycle built with
// real git: dev applied, staging approved, prod waiting on its wave, and
// dev's migrations op waiting on its own gate.

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@localhost", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@localhost", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

const D1 = `jcs1-sha256:${"1".repeat(64)}`;
const D2 = `jcs1-sha256:${"2".repeat(64)}`;
const D3 = `jcs1-sha256:${"3".repeat(64)}`;
const D4 = `sha256:${"4".repeat(64)}`;
const FAR = "2099-01-01T00:00:00Z";
const apply = (r: object): string => JSON.stringify({ version: 1, op: "yodel-apply", ...r });

const WAVES = JSON.stringify({
  name: "yodel-apply",
  op: "migrate-dev",
  waves: ["dev", "staging", "prod"].map((env) => ({ name: env, runs: [{ target: env, op: `migrate-${env}` }], gate: env === "prod" ? "always" : "on-destructive" })),
});

const LANE: Record<string, string> = {
  "_gates/yodel-apply.jsonl": [
    apply({ kind: "pending", gate: "yodel-apply-wave-1", timestamp: "2026-10-09T08:00:00Z", expiresAt: FAR, planDigest: D1 }),
    apply({ gate: "yodel-apply-wave-1", resolvedBy: "alice", timestamp: "2026-10-09T08:30:00Z", planDigest: D1 }),
    apply({ kind: "pending", gate: "yodel-apply-wave-2", timestamp: "2026-10-09T09:00:00Z", expiresAt: FAR, planDigest: D2 }),
    apply({ gate: "yodel-apply-wave-2", resolvedBy: "bob", timestamp: "2026-10-09T09:30:00Z", planDigest: D2 }),
    apply({ kind: "pending", gate: "yodel-apply-wave-3", timestamp: "2026-10-09T10:00:00Z", expiresAt: FAR, planDigest: D3 }),
  ].join("\n"),
  "_gates/yodel-apply/applied.jsonl": apply({ kind: "applied", gate: "yodel-apply-wave-1", planDigest: D1, approvedAt: "2026-10-09T08:30:00Z", approvedBy: "alice", timestamp: "2026-10-09T08:40:00Z" }),
  "_gates/migrate-dev.jsonl": JSON.stringify({ version: 1, kind: "pending", op: "migrate-dev", gate: "approve-migrate-dev", timestamp: "2026-10-09T11:00:00Z", expiresAt: FAR, planDigest: D4 }),
};

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "behold-yodel-test-"));
  made.push(root);
  const origin = join(root, "origin.git");
  git(root, ["init", "--bare", "-q", origin]);
  const work = join(root, "work");
  mkdirSync(join(work, "ops"), { recursive: true });
  git(work, ["init", "-q"]);
  writeFileSync(join(work, "yodel.config.ts"), "export default {};\n");
  writeFileSync(join(work, "yodel-waves.json"), WAVES);
  writeFileSync(join(work, "ops", "migrate-dev.op.ts"), "// migrate-dev\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "main"]);
  git(work, ["push", "-q", origin, "HEAD:refs/heads/main"]);
  const lane = join(root, "lane");
  mkdirSync(lane);
  git(lane, ["init", "-q"]);
  for (const [p, text] of Object.entries(LANE)) {
    mkdirSync(dirname(join(lane, p)), { recursive: true });
    writeFileSync(join(lane, p), text);
  }
  git(lane, ["add", "."]);
  git(lane, ["commit", "-q", "-m", "lane"]);
  git(lane, ["push", "-q", origin, "HEAD:refs/heads/chant/lifecycle"]);
  const checkout = join(root, "checkout");
  git(root, ["clone", "-q", "--single-branch", "--branch", "main", origin, checkout]);
  return checkout;
}

describe("the SQL Yodeler lane (#524)", () => {
  it("reads the waves spec in order", () => {
    const w = parseYodelWaves(WAVES);
    expect(w.waves.map((x) => [x.k, x.env, x.gate])).toEqual([
      [1, "dev", "on-destructive"],
      [2, "staging", "on-destructive"],
      [3, "prod", "always"],
    ]);
    expect(parseYodelWaves("{").error).toMatch(/not JSON/);
  });

  it("gives SQL Yodeler's own approve line", () => {
    expect(yodelApproveCommand("prod", D3)).toBe(`npx yodel approve prod --plan ${D3}`);
    expect(yodelApproveCommand("prod", D3, "sealed")).toBe(`npx yodel approve prod --plan ${D3} --sign`);
    expect(migrateOpLane("dev").waveOf("approve-migrate-dev")).toBe(1);
    expect(migrateOpLane("dev").waveOf("approve-migrate-prod")).toBeUndefined();
  });

  it("shows waiting, approved and applied environments with their approve lines", async () => {
    const checkout = fixture();
    const a = await readSqlYodelerLane(checkout, { cacheRoot: mkdtempSync(join(tmpdir(), "behold-yodel-cache-")), now: () => new Date("2026-10-10T00:00:00Z") });
    expect(a.found).toBe(true);
    expect(a.order.source).toBe("yodel-waves.json");
    expect(a.environments.map((e) => e.env)).toEqual(["dev", "staging", "prod"]);
    const [dev, staging, prod] = a.environments;
    const wave = (e: typeof dev) => e!.gates.find((g) => g.kind === "wave");
    expect(wave(dev)!.state).toBe("applied");
    expect(wave(staging)!.state).toBe("approved");
    expect(wave(prod)!.state).toBe("waiting");
    expect(wave(prod)!.command).toBe(`npx yodel approve prod --plan ${D3}`);
    const migrate = dev!.gates.find((g) => g.kind === "migrate")!;
    expect(migrate.gate).toBe("approve-migrate-dev");
    expect(migrate.state).toBe("waiting");
    expect(migrate.command).toBe(`npx yodel approve dev --plan ${D4}`);
  });
});

describe("the sql lexicon's kinds (#524)", () => {
  it("names each kind and leads a card with it", () => {
    expect(sqlIconFor("Postgres::Table")).toBe("table");
    expect(sqlIconFor("ClickHouse::Database")).toBe("database");
    expect(sqlIconFor("Chant::Op")).toBeUndefined();
    expect(sqlKindLabel("ClickHouse::MaterializedView")).toBe("ClickHouse materialized view");
    expect(sqlCardFields({ kind: "Postgres::Table", attrs: { schema: "shop", name: "orders", columns: [{}, {}], foreignKeys: [{}] } })).toEqual([
      { label: "Postgres table", value: "shop.orders" },
      { label: "columns", value: "2, 1 foreign key" },
    ]);
  });

  const fk = resolve(__dirname, "..", "e2e", "fixtures", "sql-yodeler-fk");
  // #537: skipped even with @intentius/chant-lexicon-sql installed. Tried
  // 0.124.8 (with chant 0.124.9): `chant graph --format ir` on this fixture
  // emits no graph, it refuses with "source has lint errors". Every SQL lint
  // rule (SQLCH001-004, SQLPG001-003, SQLPG005) throws
  // "ts.isImportDeclaration is not a function", because the lexicon takes
  // typescript as a peer (^5.9.3) and behold's root typescript is 7.0.2,
  // which has no JS API. The lexicon does see the foreign key (its SQLPG102
  // warning names orders.customer_id -> shop.customers). Un-skip once the
  // lexicon runs alongside typescript 7, or behold's root typescript is 5.
  it.skip("draws a REFERENCES foreign key as an edge", async () => {
    const ir = await graphIr(fk);
    const id = (name: string) => ir.nodes.find((n) => n.kind === "Postgres::Table" && JSON.stringify(n).includes(name))?.id;
    const orders = id("orders");
    const customers = id("customers");
    expect(orders && customers).toBeTruthy();
    expect(ir.edges.some((e) => e.from === orders && e.to === customers)).toBe(true);
  });
});
