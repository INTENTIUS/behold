import { describe, expect, it } from "vitest";
import type { ReleaseRecord } from "@intentius/chant";
import { orderEnvironments, releaseCells, type ReleaseSource } from "./lifecycle-releases.ts";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;
const C = `sha256:${"c".repeat(64)}`;

const rec = (env: string, component: string, digest: string, timestamp: string, extra: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  version: 1,
  component,
  env,
  digest,
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  runId: "18234771902",
  timestamp,
  actor: "alex",
  ...extra,
});

// dev, staging and prod; one tenant (schema/acme); prod's schema is C, which staging never recorded.
const ledgers = new Map<string, ReleaseRecord[]>([
  ["dev", [rec("dev", "schema", A, "2026-10-01T09:00:00Z"), rec("dev", "schema", B, "2026-10-05T09:00:00Z"), rec("dev", "schema/acme", B, "2026-10-05T09:05:00Z")]],
  ["staging", [rec("staging", "schema", A, "2026-10-02T09:00:00Z"), rec("staging", "schema", B, "2026-10-06T09:00:00Z"), rec("staging", "schema/acme", B, "2026-10-06T09:05:00Z")]],
  ["prod", [rec("prod", "schema", C, "2026-10-08T09:00:00Z", { approver: "sam" }), rec("prod", "schema/acme", B, "2026-10-07T09:05:00Z")]],
]);
const sources = new Map<string, ReleaseSource>(
  ["dev", "staging", "prod"].map((env) => [env, { branch: "chant/lifecycle", path: `${env}/releases.jsonl`, commit: "f".repeat(40), committed: "2026-10-08T09:00:01Z" }]),
);

describe("releaseCells (#525)", () => {
  it("orders columns by the waves, then by name", () => {
    expect(orderEnvironments(["prod", "dev", "qa", "staging"], ["dev", "staging", "prod"])).toEqual(["dev", "staging", "prod", "qa"]);
    expect(orderEnvironments(["prod", "dev"], undefined)).toEqual(["dev", "prod"]);
  });

  it("marks the prod digest staging never had, dated, and leaves the tenant unmarked", () => {
    const { components, cells } = releaseCells(ledgers, ["dev", "staging", "prod"], sources);
    expect(components).toEqual(["schema", "schema/acme"]);
    const prod = cells.find((c) => c.env === "prod" && c.component === "schema")!;
    expect(prod.digest).toBe(C);
    expect(prod.timestamp).toBe("2026-10-08T09:00:00Z");
    expect(prod.approver).toBe("sam");
    expect(prod.differs).toEqual({ from: "staging", digest: B, everHad: false });
    expect(prod.source.commit).toBe("f".repeat(40));
    expect(cells.find((c) => c.env === "staging" && c.component === "schema")!.differs).toBeUndefined();
    expect(cells.find((c) => c.env === "prod" && c.component === "schema/acme")!.differs).toBeUndefined();
    expect(cells.find((c) => c.env === "dev" && c.component === "schema")!.differs).toBeUndefined();
  });
});

describe("readReleases on a real chant/lifecycle branch (#525)", () => {
  it("fetches into behold's cache and reads it with chant's reader, in wave order", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { readReleases } = await import("./lifecycle-releases.ts");
    const root = mkdtempSync(join(tmpdir(), "behold-rel-test-"));
    const origin = join(root, "origin");
    const work = join(root, "work");
    const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    mkdirSync(origin);
    mkdirSync(work);
    g(origin, "init", "-q");
    g(origin, "checkout", "-q", "--orphan", "chant/lifecycle");
    for (const [env, list] of ledgers) {
      mkdirSync(join(origin, env));
      writeFileSync(join(origin, env, "releases.jsonl"), list.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    g(origin, "add", "-A");
    g(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ledger");
    g(work, "init", "-q");
    g(work, "remote", "add", "origin", origin);
    writeFileSync(join(work, "yodel-waves.json"), JSON.stringify({ waves: [{ name: "dev" }, { name: "staging" }, { name: "prod" }] }));
    const a = await readReleases(work, { cacheRoot: root });
    expect(a.found).toBe(true);
    expect(a.via).toBe("fetch");
    expect(a.order).toBe("waves");
    expect(a.environments).toEqual(["dev", "staging", "prod"]);
    const prod = a.cells.find((c) => c.env === "prod" && c.component === "schema")!;
    expect(prod.differs).toEqual({ from: "staging", digest: B, everHad: false });
    expect(prod.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
