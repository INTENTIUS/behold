// behold#1026: `behold index <substrate>` over a fake lister. The refusal of every
// action flag, the default store location, and that nothing is written outside the
// store. The cases that need chant's index pipeline (chant#4519, #4521, #4522) run
// against the chant installed beside behold and skip when it has none (published
// chant 0.124.52 has none); the rest use a fake of chant's functions.
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_FLAGS,
  IndexUsageError,
  defaultIndexStoreDir,
  findChantProject,
  parseIndexArgs,
  planIndexStore,
  runIndex,
  scopeAndTarget,
  type IndexDeps,
} from "./behold-index.ts";
import { chantIndexApi, type ChantIndexApi, type ChantIndexLookup, type IndexStore } from "./chant-index.ts";
import { listCloud, type CloudScope, type ListingResult, type SubstrateTarget } from "./cloud-lister/index.ts";
import { fakeFetcher, refusingChains } from "./cloud-lister/fakes.ts";
import { findIndexDir, userIndexDir, type Found } from "./graph-db/sources.ts";
import type { IndexDocument } from "./graph-db/types.ts";

const ACCOUNT = "000000000000";
const ENDPOINT = "http://localhost:4566";
const EMULATOR_ENV = { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" };

function listing(scope: CloudScope, startedAt: string): ListingResult {
  const at = startedAt;
  const res = (listedType: string, nativeId: string, properties: Record<string, unknown>) => ({
    id: `aws/${scope.scopeId}/${listedType.startsWith("AWS::IAM::") ? "global" : "us-east-1"}/${listedType}/${nativeId}`,
    listedType,
    location: listedType.startsWith("AWS::IAM::") ? "global" : "us-east-1",
    nativeId,
    cloudIds: [{ kind: "import-id" as const, value: nativeId }],
    tags: {},
    properties,
    observedAt: at,
    facts: { cloudIds: [{ kind: "import-id" as const, value: nativeId }], observedAt: at },
  });
  return {
    listing: "v1",
    source: { name: "behold-lister", version: "test" },
    scope,
    startedAt: at,
    completedAt: at,
    resources: [
      res("AWS::S3::Bucket", "web-assets", { BucketName: "web-assets", Arn: "arn:aws:s3:::web-assets" }),
      res("AWS::IAM::Role", "app-role", { RoleName: "app-role", Arn: `arn:aws:iam::${scope.scopeId}:role/app-role` }),
    ],
    coverage: [
      { listedType: "AWS::IAM::Role", location: "global", verdict: "listed" },
      { listedType: "AWS::S3::Bucket", location: "us-east-1", verdict: "listed" },
    ],
    notes: [],
  };
}

/** A lister that records what it was asked and answers {@link listing}, one second later each call. */
function fakeLister(start = "2026-10-26T12:00:00.000Z") {
  const calls: Array<{ scope: CloudScope; target: SubstrateTarget }> = [];
  let t = Date.parse(start);
  return {
    calls,
    list: async (scope: CloudScope, target: SubstrateTarget) => {
      calls.push({ scope, target });
      const at = new Date(t).toISOString();
      t += 1000;
      return listing(scope, at);
    },
  };
}

/** chant's three functions, faked: typeListing stamps the listing, deriveEdges adds one edge, the store keeps writes in memory. */
function fakeChant() {
  const writes: IndexDocument[] = [];
  const opened: unknown[] = [];
  let lookups = 0;
  const store: IndexStore = {
    kind: "local",
    where: "fake-store",
    writable: true,
    async writeIndex(doc) {
      writes.push(doc);
      const name = `${doc.stamp.observedAt.replace(/[-:]|\.\d{3}/g, "")}-${doc.stamp.digest.slice(0, 12)}.json`;
      return { written: true, path: `${doc.stamp.scopeKey}/${name}` };
    },
    async listIndex() {
      return [];
    },
  };
  const api: ChantIndexApi = {
    typeListing: (l) => ({
      index: "v1",
      stamp: {
        source: { kind: "cloud", name: "behold-lister" },
        scope: { kind: "cloud", ...l.scope },
        scopeKey: `cloud/${l.scope.substrate}/${l.scope.scopeId}/aaaaaaaaaaaa`,
        observedAt: l.startedAt,
        digest: "b".repeat(64),
      },
      coverage: l.coverage,
      graph: { version: 1, nodes: l.resources.map((r) => ({ id: r.id, kind: r.listedType, lexicon: "aws", attrs: r.properties })), edges: [], groups: {} } as unknown as IndexDocument["graph"],
    }),
    deriveEdges: (doc) => ({
      ...doc,
      graph: { ...doc.graph, edges: [{ from: doc.graph.nodes[0].id, to: doc.graph.nodes[1].id, kind: "ref", origin: "derived", rule: "aws:test" }] } as unknown as IndexDocument["graph"],
    }),
    storeConfig: (configured) => configured as { store: string },
    createStore: (config) => {
      opened.push(config);
      return store;
    },
    projectStore: async (dir) => {
      opened.push({ project: dir });
      return store;
    },
  };
  return {
    writes,
    opened,
    get lookups() {
      return lookups;
    },
    chant: async (): Promise<ChantIndexLookup> => {
      lookups++;
      return { api, missing: [] };
    },
  };
}

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

const noLexicons: IndexDeps["lexicons"] = async () => ({ lexicons: [] });

describe("behold index refuses every action flag", () => {
  it("names the flag, wherever it sits and in either form", () => {
    for (const flag of ACTION_FLAGS) {
      for (const argv of [["aws", flag], [flag, "aws"], ["aws", "--account", ACCOUNT, `${flag}=1`]]) {
        let caught: unknown;
        try {
          parseIndexArgs(argv);
        } catch (e) {
          caught = e;
        }
        expect(caught, `${argv.join(" ")}`).toBeInstanceOf(IndexUsageError);
        expect((caught as IndexUsageError).actionFlag).toBe(flag);
        expect((caught as Error).message).toMatch(/read-only/);
      }
    }
  });

  it("the action flags include behold's action side", () => {
    for (const f of ["--apply", "--deploy", "--destroy", "--rollback", "--op", "--approve", "--enable-api"]) expect(ACTION_FLAGS).toContain(f);
  });

  it("stops before chant, the lister or the store is touched", async () => {
    const t = tempTree();
    const chant = fakeChant();
    const lister = fakeLister();
    const io = capture();
    for (const flag of ACTION_FLAGS) {
      const code = await runIndex(["aws", "--account", ACCOUNT, "--regions", "us-east-1", flag], {
        cwd: t.cwd,
        home: t.home,
        env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg },
        stdout: io.stdout,
        stderr: io.stderr,
        list: lister.list,
        chant: chant.chant,
        lexicons: noLexicons,
      });
      expect(code, flag).toBe(2);
    }
    expect(chant.lookups).toBe(0);
    expect(lister.calls).toEqual([]);
    expect(chant.writes).toEqual([]);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toMatch(/refuses --apply/);
    expect(files(t.root)).toEqual([]);
  });

  it("an unknown flag is a usage error, not a pass", () => {
    expect(() => parseIndexArgs(["aws", "--frobnicate"])).toThrow(/unknown argument/);
    expect(() => parseIndexArgs(["--account", ACCOUNT])).toThrow(/needs a substrate/);
    expect(() => parseIndexArgs(["cloudflare"])).toThrow(/unknown substrate/);
  });
});

describe("behold index over a fake lister", () => {
  it("lists the scope asked for, types it, derives edges and writes one version", async () => {
    const t = tempTree();
    const chant = fakeChant();
    const lister = fakeLister();
    const io = capture();
    const code = await runIndex(
      ["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1,eu-west-1", "--types", "AWS::S3::Bucket,AWS::IAM::Role", "--tag", "team=web"],
      { cwd: t.cwd, home: t.home, env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg }, stdout: io.stdout, stderr: io.stderr, list: lister.list, chant: chant.chant, lexicons: noLexicons },
    );
    expect(io.err).toEqual([]);
    expect(code).toBe(0);
    expect(lister.calls).toHaveLength(1);
    expect(lister.calls[0].scope).toEqual({
      substrate: "aws",
      scopeId: ACCOUNT,
      locations: ["us-east-1", "eu-west-1"],
      types: ["AWS::S3::Bucket", "AWS::IAM::Role"],
      tagFilter: { team: "web" },
    });
    expect(lister.calls[0].target).toEqual({ substrate: "aws", aws: { endpoint: ENDPOINT, credentials: { accessKeyId: "test", secretAccessKey: "test" } } });
    // The default store is the per-user one (no project, no --store).
    expect(chant.opened).toEqual([{ store: "local", dir: join(t.xdg, "behold") }]);
    expect(chant.writes).toHaveLength(1);
    expect(chant.writes[0].graph.nodes).toHaveLength(2);
    expect(chant.writes[0].graph.edges).toHaveLength(1);
    const text = io.out.join("");
    expect(text).toMatch(/2 nodes \(2 typed, 0 of unknown kind\), 1 derived edges/);
    expect(text).toMatch(/^behold index: wrote 20261026T120000Z-bbbbbbbbbbbb\.json under cloud\/aws\/000000000000\/aaaaaaaaaaaa in fake-store$/m);
  });

  it("a second run writes a second version", async () => {
    const t = tempTree();
    const chant = fakeChant();
    const lister = fakeLister();
    const deps: IndexDeps = { cwd: t.cwd, home: t.home, env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg }, stdout: () => {}, stderr: () => {}, list: lister.list, chant: chant.chant, lexicons: noLexicons };
    expect(await runIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], deps)).toBe(0);
    expect(await runIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], deps)).toBe(0);
    expect(chant.writes.map((d) => d.stamp.observedAt)).toEqual(["2026-10-26T12:00:00.000Z", "2026-10-26T12:00:01.000Z"]);
  });

  it("--json prints one object with the verdict fields", async () => {
    const t = tempTree();
    const chant = fakeChant();
    const io = capture();
    const code = await runIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1", "--json"], {
      cwd: t.cwd,
      home: t.home,
      env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg },
      stdout: io.stdout,
      stderr: io.stderr,
      list: fakeLister().list,
      chant: chant.chant,
      lexicons: noLexicons,
    });
    expect(code).toBe(0);
    const summary = JSON.parse(io.out.join(""));
    expect(summary).toMatchObject({ substrate: "aws", scopeId: ACCOUNT, written: true, nodes: 2, derivedEdges: 1, coverage: { listed: 2, notObserved: 0 } });
  });

  it("without chant's index pipeline it says what is missing and lists nothing", async () => {
    const t = tempTree();
    const lister = fakeLister();
    const io = capture();
    const code = await runIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], {
      cwd: t.cwd,
      home: t.home,
      env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg },
      stdout: io.stdout,
      stderr: io.stderr,
      list: lister.list,
      chant: async () => ({ api: undefined, missing: ["typeListing (chant#4521, @intentius/chant/lifecycle/type-listing)"] }),
    });
    expect(code).toBe(2);
    expect(lister.calls).toEqual([]);
    expect(io.err.join("")).toMatch(/lacks typeListing \(chant#4521.*Nothing was listed and nothing was written/);
    expect(files(t.root)).toEqual([]);
  });

  it("with an endpoint and no static credentials it is refused, and no SDK chain is asked", async () => {
    const t = tempTree();
    const chant = fakeChant();
    const chains = refusingChains();
    const fake = fakeFetcher(() => undefined);
    const io = capture();
    const code = await runIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], {
      cwd: t.cwd,
      home: t.home,
      env: { XDG_DATA_HOME: t.xdg },
      stdout: io.stdout,
      stderr: io.stderr,
      list: (scope, target, o) => listCloud(scope, target, { ...o, fetcher: fake.fetcher, chains, retryDelays: [] }),
      chant: chant.chant,
      lexicons: noLexicons,
    });
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/needs static credentials/);
    expect(chains.count).toEqual({ aws: 0, azure: 0, gcp: 0 });
    expect(fake.calls).toEqual([]);
    expect(chant.writes).toEqual([]);
  });

  it("the CLI itself writes nothing: with a fake store the tree is unchanged", async () => {
    const t = tempTree();
    const chant = fakeChant();
    await runIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], {
      cwd: t.cwd,
      home: t.home,
      env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg },
      stdout: () => {},
      stderr: () => {},
      list: fakeLister().list,
      chant: chant.chant,
      lexicons: noLexicons,
    });
    expect(chant.writes).toHaveLength(1);
    expect(files(t.root)).toEqual([]);
  });
});

describe("scope and target from flags and the environment", () => {
  const deps = { cwd: "/w", home: "/h" };
  it("aws takes its region from AWS_REGION and its endpoint from AWS_ENDPOINT_URL", () => {
    const { scope, target } = scopeAndTarget(parseIndexArgs(["aws", "--account", ACCOUNT]), { ...deps, env: { ...EMULATOR_ENV, AWS_REGION: "us-west-2", AWS_ENDPOINT_URL: ENDPOINT } });
    expect(scope).toEqual({ substrate: "aws", scopeId: ACCOUNT, locations: ["us-west-2"], types: "*" });
    expect(target).toEqual({ substrate: "aws", aws: { endpoint: ENDPOINT, credentials: { accessKeyId: "test", secretAccessKey: "test" } } });
  });
  it("gcp --anonymous sends no token, and needs an endpoint", () => {
    const { target } = scopeAndTarget(parseIndexArgs(["gcp", "--project", "plc-corpus", "--endpoint", "http://localhost:4588/cloudasset", "--anonymous"]), { ...deps, env: {} });
    expect(target).toEqual({ substrate: "gcp", gcp: { endpoint: "http://localhost:4588/cloudasset", token: null } });
    expect(() => parseIndexArgs(["gcp", "--project", "p", "--anonymous"])).toThrow(/needs --endpoint/);
  });
  it("needs a scope id, and skips TLS checks only on loopback", () => {
    expect(() => scopeAndTarget(parseIndexArgs(["azure"]), { ...deps, env: {} })).toThrow(/--subscription/);
    expect(() => scopeAndTarget(parseIndexArgs(["azure", "--subscription", "s", "--endpoint", "https://management.azure.com", "--insecure-skip-verify"]), { ...deps, env: {} })).toThrow(/loopback/);
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

  it("is used with no project and no --store, wherever the command runs", () => {
    const none = () => false;
    expect(planIndexStore({ cwd: "/a/b", env: { XDG_DATA_HOME: "/x" }, home: "/h", exists: none })).toEqual({ kind: "user", dir: join("/x", "behold") });
    expect(planIndexStore({ cwd: "/elsewhere", env: { XDG_DATA_HOME: "/x" }, home: "/h", exists: none })).toEqual({ kind: "user", dir: join("/x", "behold") });
  });

  it("gives way to a chant project's store, and to --store", () => {
    const exists = (p: string) => p === join("/proj", "chant.config.ts");
    expect(findChantProject(join("/proj", "sub"), exists)).toBe("/proj");
    expect(planIndexStore({ cwd: join("/proj", "sub"), env: {}, home: "/h", exists })).toEqual({ kind: "project", projectDir: "/proj" });
    const local = planIndexStore({ store: "local:out", cwd: "/w", env: {}, home: "/h", exists });
    expect(local).toMatchObject({ kind: "spec", configured: { store: "local" }, env: { CHANT_SNAPSHOT_STORE: "local", CHANT_SNAPSHOT_STORE_DIR: join("/w", "out") } });
    const s3 = planIndexStore({ store: "s3://bucket/some/prefix/", cwd: "/w", env: {}, home: "/h" });
    expect(s3).toMatchObject({ kind: "spec", env: { CHANT_SNAPSHOT_STORE: "s3", CHANT_SNAPSHOT_S3_BUCKET: "bucket", CHANT_SNAPSHOT_S3_PREFIX: "some/prefix" } });
    expect(planIndexStore({ store: "git-ref:refs/x", cwd: "/w", env: {}, home: "/h" })).toMatchObject({ configured: { store: "git-ref", ref: "refs/x" } });
    expect(() => planIndexStore({ store: "orphan-branch", cwd: "/w", env: {}, home: "/h" })).toThrow(/read-only/);
    expect(() => planIndexStore({ store: "ftp://x", cwd: "/w", env: {}, home: "/h" })).toThrow(/not a store spec/);
  });
});

// Against chant's real pipeline and local store: skipped unless the chant beside
// behold has them (a local build of chant's integration/consolidation-graph).
const real = await chantIndexApi();

describe.skipIf(!real.api)("behold index with chant's pipeline and local store", () => {
  it("writes only under the per-user store, two runs give two versions, and the graph pane's loader reads them", async () => {
    const t = tempTree();
    const lister = fakeLister();
    const env = { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg };
    const deps: IndexDeps = { cwd: t.cwd, home: t.home, env, stdout: () => {}, stderr: () => {}, list: lister.list, lexicons: noLexicons };
    const argv = ["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1", "--types", "AWS::S3::Bucket,AWS::IAM::Role"];
    expect(await runIndex(argv, deps)).toBe(0);
    expect(await runIndex(argv, deps)).toBe(0);

    const all = files(t.root);
    const storeIndex = relative(t.root, join(t.xdg, "behold", "index")) + sep;
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(f.startsWith(storeIndex), f).toBe(true);
    expect(files(t.cwd)).toEqual([]);
    expect(files(t.home)).toEqual([]);

    const versions = all.filter((f) => /\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/.test(f));
    expect(versions).toHaveLength(2);
    expect(all.filter((f) => f.endsWith(`${sep}scope.json`))).toHaveLength(1);
    expect(versions.every((v) => v.includes(`${sep}cloud${sep}aws${sep}${ACCOUNT}${sep}`))).toBe(true);

    // behold#1027's loader reads the latest version of the scope from the per-user store.
    const found: Found = { documents: [], notes: [] };
    findIndexDir(userIndexDir(env, t.home), found);
    expect(found.notes).toEqual([]);
    expect(found.documents).toHaveLength(1);
    const d = found.documents[0];
    expect(d.kind).toBe("index");
    if (d.kind !== "index") return;
    expect(d.doc.stamp.scope).toMatchObject({ kind: "cloud", substrate: "aws", scopeId: ACCOUNT });
    expect(d.doc.graph.nodes.map((n) => n.id).sort()).toEqual([
      `aws/${ACCOUNT}/global/AWS::IAM::Role/app-role`,
      `aws/${ACCOUNT}/us-east-1/AWS::S3::Bucket/web-assets`,
    ]);
    expect(d.version).toBe(versions.map((v) => v.split(sep).pop()!).sort()[1]);

    // The first version stays readable through the store.
    const store = real.api!.createStore({ store: "local", dir: join(t.xdg, "behold") }, { cwd: t.cwd });
    expect(await store.listIndex(d.doc.stamp.scopeKey)).toHaveLength(2);
  });
});
