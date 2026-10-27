// behold#1026 / chant#4532: `behold index` is chant's `runCloudIndex` with behold's
// command name, per-user store and token variables. The cases that need chant's
// command run against the chant installed beside behold (0.124.54, behold#1005);
// the rest use a fake `runCloudIndex`.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHANT_CLOUD_INDEX, chantCloudIndex, chantEnv, defaultIndexStoreDir, needsChantMessage, runIndex, type RunCloudIndex } from "./behold-index.ts";
import { CHANT_RELEASE } from "./chant-release.ts";
import { findIndexDir, userIndexDir, type Found } from "./graph-db/sources.ts";
import type { CloudScope, ListingResult } from "./graph-db/listing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ACCOUNT = "000000000000";
const ENDPOINT = "http://localhost:4566";
const EMULATOR_ENV = { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" };

function tempTree() {
  const root = mkdtempSync(join(tmpdir(), "behold-index-"));
  const cwd = join(root, "cwd");
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  for (const d of [cwd, home, xdg]) mkdirSync(d, { recursive: true });
  return { root, cwd, home, xdg };
}

/** Every file under `root`, relative and sorted. */
function files(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(root, rel)).sort()) {
    const r = rel ? join(rel, n) : n;
    if (statSync(join(root, r)).isDirectory()) out.push(...files(root, r));
    else out.push(r);
  }
  return out;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) };
}

/** A `runCloudIndex` that records what behold handed it. */
function fakeChant(code = 0) {
  const calls: Array<{ argv: readonly string[]; options: Record<string, unknown> }> = [];
  const run: RunCloudIndex = async (argv, options) => {
    calls.push({ argv, options });
    return code;
  };
  return { calls, chant: async () => run };
}

describe("behold keeps no lister of its own", () => {
  it("src/cloud-lister/ is gone; chant#4532 has it", () => {
    expect(existsSync(join(here, "cloud-lister"))).toBe(false);
    expect(existsSync(join(here, "chant-index.ts"))).toBe(false);
  });
});

describe("without chant's runCloudIndex", () => {
  it("names the chant it needs, exits 2 and writes nothing", async () => {
    const t = tempTree();
    const io = capture();
    const code = await runIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], {
      cwd: t.cwd,
      home: t.home,
      env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg },
      stdout: io.stdout,
      stderr: io.stderr,
      chant: async () => undefined,
    });
    expect(code).toBe(2);
    const text = io.err.join("");
    expect(text).toContain(`needs chant ${CHANT_RELEASE.version} or newer`);
    expect(text).toContain("chant#4532");
    expect(text).toContain(CHANT_CLOUD_INDEX);
    expect(text).toMatch(/Nothing was listed and nothing was written/);
    expect(io.out).toEqual([]);
    expect(files(t.root)).toEqual([]);
  });

  it("the message is the same one the lookup failure prints", () => {
    expect(needsChantMessage()).toMatch(/^behold index needs chant /);
  });
});

describe("with chant's runCloudIndex", () => {
  it("hands over the argv untouched, with behold's command, store, tokens and version", async () => {
    const t = tempTree();
    const chant = fakeChant();
    const io = capture();
    const argv = ["azure", "--subscription", "s", "--endpoint", "https://localhost:4577", "--apply"];
    const code = await runIndex(argv, {
      cwd: t.cwd,
      home: t.home,
      env: { XDG_DATA_HOME: t.xdg, BEHOLD_AZURE_TOKEN: "az", BEHOLD_GCP_TOKEN: "gc" },
      stdout: io.stdout,
      stderr: io.stderr,
      chant: chant.chant,
      version: "0.30.2",
    });
    expect(code).toBe(0);
    expect(chant.calls).toHaveLength(1);
    const { argv: passed, options } = chant.calls[0];
    // An action flag is chant's to refuse; behold passes it on as typed.
    expect(passed).toEqual(argv);
    expect(options.command).toBe("behold index");
    expect((options.defaultStoreDir as () => string)()).toBe(join(t.xdg, "behold"));
    expect(options.env).toMatchObject({ CHANT_AZURE_TOKEN: "az", CHANT_GCP_TOKEN: "gc" });
    expect(options.version).toBe("0.30.2");
    expect(options.cwd).toBe(t.cwd);
    expect(options.stdout).toBe(io.stdout);
  });

  it("returns chant's exit code", async () => {
    expect(await runIndex(["aws", "--apply"], { env: {}, chant: fakeChant(2).chant })).toBe(2);
  });

  it("a bad BEHOLD_INDEX_DIR stops a run with no --store, not one that names a store", async () => {
    const io = capture();
    const chant = fakeChant();
    expect(await runIndex(["aws"], { env: { BEHOLD_INDEX_DIR: "/d/elsewhere" }, home: "/h", stderr: io.stderr, chant: chant.chant })).toBe(2);
    expect(io.err.join("")).toMatch(/must end in \/index/);
    expect(chant.calls).toEqual([]);
    expect(await runIndex(["aws", "--store", "none"], { env: { BEHOLD_INDEX_DIR: "/d/elsewhere" }, home: "/h", chant: chant.chant })).toBe(0);
    expect(chant.calls).toHaveLength(1);
  });

  it("keeps chant's own token variables when both are set", () => {
    expect(chantEnv({ CHANT_GCP_TOKEN: "c", BEHOLD_GCP_TOKEN: "b" }).CHANT_GCP_TOKEN).toBe("c");
  });
});

describe("the default store location (behold#1025 Q4)", () => {
  it("is behold's per-user data directory, whose index/ the graph pane loads", () => {
    expect(defaultIndexStoreDir({ XDG_DATA_HOME: "/x" }, "/h")).toBe(join("/x", "behold"));
    expect(defaultIndexStoreDir({}, "/h")).toBe(join("/h", ".local", "share", "behold"));
    expect(defaultIndexStoreDir({ BEHOLD_INDEX_DIR: "/d/index" }, "/h")).toBe("/d");
    expect(() => defaultIndexStoreDir({ BEHOLD_INDEX_DIR: "/d/elsewhere" }, "/h")).toThrow(/must end in \/index/);
    for (const env of [{ XDG_DATA_HOME: "/x" }, {}, { BEHOLD_INDEX_DIR: "/d/index" }]) {
      expect(join(defaultIndexStoreDir(env, "/h"), "index")).toBe(userIndexDir(env, "/h"));
    }
  });
});

function listing(scope: CloudScope, startedAt: string): ListingResult {
  const res = (listedType: string, nativeId: string, properties: Record<string, unknown>) => {
    const location = listedType.startsWith("AWS::IAM::") ? "global" : "us-east-1";
    return {
      id: `aws/${scope.scopeId}/${location}/${listedType}/${nativeId}`,
      listedType,
      location,
      nativeId,
      cloudIds: [{ kind: "import-id" as const, value: nativeId }],
      tags: {},
      properties,
      observedAt: startedAt,
      facts: { cloudIds: [{ kind: "import-id" as const, value: nativeId }], observedAt: startedAt },
    };
  };
  return {
    listing: "v1",
    source: { name: "chant-lister", version: "test" },
    scope,
    startedAt,
    completedAt: startedAt,
    resources: [
      res("AWS::S3::Bucket", "web-assets", { BucketName: "web-assets" }),
      res("AWS::IAM::Role", "app-role", { RoleName: "app-role" }),
    ],
    coverage: [
      { listedType: "AWS::IAM::Role", location: "global", verdict: "listed" },
      { listedType: "AWS::S3::Bucket", location: "us-east-1", verdict: "listed" },
    ],
    notes: [],
  };
}

// Against chant's real command and local store (chant#4532, in chant 0.124.54, behold#1005).
const real = await chantCloudIndex();

describe("behold index with chant's runCloudIndex and local store", () => {
  it("the default lookup finds chant's command", () => {
    expect(real).toBeTypeOf("function");
  });

  it("writes only under behold's per-user store, two runs give two versions, and the graph pane's loader reads them", async () => {
    const t = tempTree();
    let clock = Date.parse("2026-10-26T12:00:00.000Z");
    const list = async (scope: CloudScope) => {
      const at = new Date(clock).toISOString();
      clock += 1000;
      return listing(scope, at);
    };
    const env = { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg };
    const io = capture();
    const deps = { cwd: t.cwd, home: t.home, env, stdout: io.stdout, stderr: io.stderr, passThrough: { list, lexicons: async () => ({ lexicons: [] }), exists: () => false } };
    const argv = ["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1", "--types", "AWS::S3::Bucket,AWS::IAM::Role"];
    expect(await runIndex(argv, deps)).toBe(0);
    expect(await runIndex(argv, deps)).toBe(0);
    expect(io.out.join("")).toMatch(/^behold index: wrote /m);

    const all = files(t.root);
    const storeIndex = relative(t.root, join(t.xdg, "behold", "index")) + sep;
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(f.startsWith(storeIndex), f).toBe(true);
    expect(files(t.cwd)).toEqual([]);
    expect(files(t.home)).toEqual([]);

    const versions = all.filter((f) => /\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/.test(f));
    expect(versions).toHaveLength(2);
    expect(all.filter((f) => f.endsWith(`${sep}scope.json`))).toHaveLength(1);

    // behold#1027's loader reads the latest version of the scope from the per-user store.
    const found: Found = { documents: [], notes: [] };
    findIndexDir(userIndexDir(env, t.home), found);
    expect(found.notes).toEqual([]);
    expect(found.documents).toHaveLength(1);
    const d = found.documents[0];
    expect(d.kind).toBe("index");
    if (d.kind !== "index") return;
    expect(d.doc.stamp.scope).toMatchObject({ kind: "cloud", substrate: "aws", scopeId: ACCOUNT });
    expect(d.version).toBe(versions.map((v) => v.split(sep).pop()!).sort()[1]);
  });

  it("refuses an action flag before anything is listed", async () => {
    const t = tempTree();
    let listed = 0;
    const io = capture();
    const code = await runIndex(["aws", "--account", ACCOUNT, "--apply"], {
      cwd: t.cwd,
      home: t.home,
      env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg },
      stdout: io.stdout,
      stderr: io.stderr,
      passThrough: { list: async () => ((listed++, undefined) as never), exists: () => false },
    });
    expect(code).toBe(2);
    expect(listed).toBe(0);
    expect(io.err.join("")).toMatch(/^behold index is read-only and refuses --apply/);
    expect(files(t.root)).toEqual([]);
  });
});
