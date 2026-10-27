// behold#1028: the diff of two index versions. Two fixture versions of one aws scope
// (src/graph-db/__fixtures__/index-diff/), the scope-mismatch refusal, a type unobserved in
// one read never reported as removed, edges, and the routes over a project's local store.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { coverageForFallback, diffIndexVersions, IndexScopeMismatch, type DiffDocument } from "./index-diff.ts";
import { coverageLookup, diffFromStores, listIndexVersions, mountIndexDiff, overlayFor } from "./index-diff-routes.ts";
import { LOCAL_INDEX_DIR } from "./sources.ts";

const DIR = join(import.meta.dirname, "__fixtures__", "index-diff");
const V1 = "20261026T120000Z-aaaaaaaaaaaa.json";
const V2 = "20261026T130000Z-bbbbbbbbbbbb.json";
const load = (name: string): DiffDocument => JSON.parse(readFileSync(join(DIR, name), "utf8")) as DiffDocument;
const B = (n: string) => `aws/000000000000/us-east-1/AWS::S3::Bucket/${n}`;
const ROLE = "aws/000000000000/us-east-1/AWS::IAM::Role/app-role";
const QUEUE = "aws/000000000000/us-east-1/AWS::SQS::Queue/jobs";

describe("diffIndexVersions over two fixture versions", () => {
  const d = diffIndexVersions(load(V1), load(V2), { fromVersion: V1, toVersion: V2 });

  it("shows both stamps and the scope", () => {
    expect(d.scopeKey).toBe("cloud/aws/000000000000/5c1f0e2a9b7d");
    expect(d.from).toMatchObject({ version: V1, observedAt: "2026-10-26T12:00:00Z" });
    expect(d.to).toMatchObject({ version: V2, observedAt: "2026-10-26T13:00:00Z" });
    expect(d.unchanged).toBe(false);
  });

  it("one changed property on the edited bucket, and nothing for the tag that did not move", () => {
    expect(d.nodes.changed).toEqual([
      { key: B("web-logs"), kind: "AWS::S3::Bucket", listedType: "AWS::S3::Bucket", location: "us-east-1", properties: [{ path: "attrs.VersioningConfiguration.Status", before: "Suspended", after: "Enabled" }] },
    ]);
    expect(d.counts.properties).toBe(1);
  });

  it("adds and removes nodes only where both reads listed the type", () => {
    expect(d.nodes.added.map((n) => n.key)).toEqual([B("new-bucket")]);
    expect(d.nodes.removed.map((n) => n.key)).toEqual([B("old-bucket")]);
  });

  it("edges: added, removed, and not observed when an end's type was not listed", () => {
    expect(d.edges.added.map((e) => [e.from, e.to])).toEqual([[ROLE, B("new-bucket")]]);
    expect(d.edges.removed.map((e) => [e.from, e.to])).toEqual([[ROLE, B("old-bucket")]]);
    expect(d.edges.notObserved).toEqual([expect.objectContaining({ from: ROLE, to: QUEUE, side: "to", unobservedEnd: QUEUE, verdict: "read-failed" })]);
    expect(d.edges.removed.some((e) => e.to === QUEUE)).toBe(false);
  });

  it("names the coverage verdict that moved", () => {
    expect(d.coverage).toEqual([{ listedType: "AWS::SQS::Queue", location: "us-east-1", before: "listed", after: "read-failed" }]);
  });

  it("the reverse diff swaps added and removed, and the queue is first observed, never added", () => {
    const r = diffIndexVersions(load(V2), load(V1));
    expect(r.nodes.added.map((n) => n.key)).toEqual([B("old-bucket")]);
    expect(r.nodes.removed.map((n) => n.key)).toEqual([B("new-bucket")]);
    expect(r.nodes.notObserved).toEqual([expect.objectContaining({ key: QUEUE, side: "from", verdict: "read-failed" })]);
  });

  it("same digest: unchanged, nothing walked", () => {
    const a = load(V1);
    const u = diffIndexVersions(a, { ...a, graph: { nodes: [], edges: [] } });
    expect(u.unchanged).toBe(true);
    expect(u.counts.removed).toBe(0);
  });
});

describe("a scope mismatch", () => {
  it("is refused by name, with both scope keys", () => {
    const a = load(V1);
    const b = load(V2);
    b.stamp = { ...b.stamp, scopeKey: "cloud/aws/000000000000/0123456789ab" };
    expect(() => diffIndexVersions(a, b)).toThrow(IndexScopeMismatch);
    try {
      diffIndexVersions(a, b);
    } catch (e) {
      expect((e as IndexScopeMismatch).code).toBe("index-scope-mismatch");
      expect((e as Error).message).toContain("cloud/aws/000000000000/5c1f0e2a9b7d");
      expect((e as Error).message).toContain("cloud/aws/000000000000/0123456789ab");
    }
  });
});

describe("an unobserved type is never reported as removed", () => {
  it("a type with no coverage entry in the later read is not observed, not removed", () => {
    const b = load(V2);
    b.coverage = b.coverage.filter((c) => c.listedType !== "AWS::S3::Bucket");
    const d = diffIndexVersions(load(V1), b);
    expect(d.nodes.removed).toEqual([]);
    expect(d.nodes.notObserved.filter((n) => n.listedType === "AWS::S3::Bucket" && n.side === "to").map((n) => [n.key, n.verdict])).toEqual([[B("old-bucket"), "not-in-coverage"]]);
  });

  it("a wildcard entry speaks for every type and location; a wildcard read-failed does not", () => {
    const b = load(V2);
    b.coverage = [{ listedType: "*", location: "*", verdict: "listed" }];
    expect(diffIndexVersions(load(V1), b).nodes.removed.map((n) => n.key)).toEqual([B("old-bucket"), QUEUE]);
    b.coverage = [{ listedType: "*", location: "us-east-1", verdict: "read-failed" }];
    const d = diffIndexVersions(load(V1), b);
    expect(d.nodes.removed).toEqual([]);
    expect(d.edges.removed).toEqual([]);
  });

  it("the fallback rule picks the exact entry over a wildcard", () => {
    const cov = [
      { listedType: "*", location: "*", verdict: "listed" },
      { listedType: "AWS::SQS::Queue", location: "*", verdict: "access-denied" },
      { listedType: "AWS::SQS::Queue", location: "eu-west-1", verdict: "listed" },
    ];
    expect(coverageForFallback(cov, "AWS::SQS::Queue", "eu-west-1")?.verdict).toBe("listed");
    expect(coverageForFallback(cov, "AWS::SQS::Queue", "us-east-1")?.verdict).toBe("access-denied");
    expect(coverageForFallback(cov, "AWS::S3::Bucket", "us-east-1")?.verdict).toBe("listed");
    expect(coverageForFallback([], "AWS::S3::Bucket", "us-east-1")).toBeUndefined();
  });

  it("agrees with chant's indexCoverageFor when the installed chant has it", async () => {
    const { lookup, rule } = await coverageLookup();
    const cov = [
      { listedType: "*", location: "*", verdict: "listed" },
      { listedType: "AWS::SQS::Queue", location: "*", verdict: "access-denied" },
    ];
    for (const [t, l] of [["AWS::SQS::Queue", "x"], ["AWS::S3::Bucket", "x"]] as const) expect(lookup(cov, t, l)).toEqual(coverageForFallback(cov, t, l));
    expect(["chant", "behold-fallback"]).toContain(rule);
  });
});

/** A project with both fixture versions in its local store, and one version of another scope. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-index-diff-"));
  const scope = join(dir, LOCAL_INDEX_DIR, "cloud", "aws", "000000000000", "5c1f0e2a9b7d");
  mkdirSync(scope, { recursive: true });
  copyFileSync(join(DIR, V1), join(scope, V1));
  copyFileSync(join(DIR, V2), join(scope, V2));
  const other = join(dir, LOCAL_INDEX_DIR, "cloud", "aws", "000000000000", "0123456789ab");
  mkdirSync(other, { recursive: true });
  copyFileSync(join(DIR, V1), join(other, "20261026T140000Z-cccccccccccc.json"));
  return dir;
}

const noGit = () => {
  throw new Error("not a git repository");
};

describe("loading two versions from the stores", () => {
  it("lists versions per scope, oldest first", () => {
    const dir = project();
    const vs = listIndexVersions({ projectDir: dir, git: noGit, env: { BEHOLD_INDEX_DIR: join(dir, "none") } });
    expect(vs.filter((v) => v.scopeKey.endsWith("5c1f0e2a9b7d")).map((v) => v.version)).toEqual([V1, V2]);
    expect(vs.every((v) => v.store === "project-local")).toBe(true);
  });

  it("defaults to the scope's last two versions and draws the overlay", async () => {
    const dir = project();
    const a = await diffFromStores({ scope: "cloud/aws/000000000000/5c1f0e2a9b7d" }, { projectDir: dir, git: noGit, env: { BEHOLD_INDEX_DIR: join(dir, "none") } });
    expect(a.diff.from.version).toBe(V1);
    expect(a.diff.to.version).toBe(V2);
    const byKey = Object.fromEntries(a.draw.nodes.map((n) => [n.key, n.change]));
    expect(byKey).toMatchObject({ [B("web-logs")]: "changed", [B("old-bucket")]: "removed", [B("new-bucket")]: "added", [QUEUE]: "not-observed" });
    expect(a.draw.edges.find((e) => e.to === QUEUE)?.change).toBe("not-observed");
  });

  it("refuses two versions under different scope paths before reading either", async () => {
    const dir = project();
    await expect(
      diffFromStores({ from: `cloud/aws/000000000000/5c1f0e2a9b7d/${V1}`, to: "cloud/aws/000000000000/0123456789ab/20261026T140000Z-cccccccccccc.json" }, { projectDir: dir, git: noGit, env: { BEHOLD_INDEX_DIR: join(dir, "none") } }),
    ).rejects.toMatchObject({ code: "index-scope-mismatch", status: 409 });
  });

  it("refuses a stored version whose stamp names another scope than its path", async () => {
    const dir = project();
    // The other scope's file holds V1's document, whose stamp names 5c1f0e2a9b7d.
    const other = "cloud/aws/000000000000/0123456789ab";
    const vs = listIndexVersions({ projectDir: dir, git: noGit, env: { BEHOLD_INDEX_DIR: join(dir, "none") } });
    expect(vs.some((v) => v.scopeKey === other)).toBe(true);
    const a = load(V1);
    const b = { ...load(V2), stamp: { ...load(V2).stamp, scopeKey: other } };
    expect(() => diffIndexVersions(a, b)).toThrow(/different scopes/);
  });

  it("the overlay leaves unchanged nodes with no changed neighbour out", () => {
    const a = load(V1);
    const b = load(V2);
    const lone = { id: B("lone"), kind: "AWS::S3::Bucket", attrs: { BucketName: "lone" }, listedType: "AWS::S3::Bucket", location: "us-east-1" };
    a.graph = { ...a.graph, nodes: [...a.graph.nodes, lone] };
    b.graph = { ...b.graph, nodes: [...b.graph.nodes, lone] };
    const draw = overlayFor(diffIndexVersions(a, b), a, b);
    expect(draw.nodes.some((n) => n.key === B("lone"))).toBe(false);
    expect(draw.omitted).toBeGreaterThanOrEqual(1);
  });
});

describe("the routes", () => {
  const app = (dir: string) => {
    const h = new Hono();
    mountIndexDiff(h, { projectDir: () => dir, git: noGit, env: { BEHOLD_INDEX_DIR: join(dir, "none") } });
    return h;
  };

  it("GET /api/graphdb/index-diff answers the diff; a scope mismatch is 409 by name", async () => {
    const dir = project();
    const ok = await app(dir).request(`/api/graphdb/index-diff?scope=${encodeURIComponent("cloud/aws/000000000000/5c1f0e2a9b7d")}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { diff: { counts: { properties: number } }; coverageRule: string };
    expect(body.diff.counts.properties).toBe(1);
    const bad = await app(dir).request(
      `/api/graphdb/index-diff?from=${encodeURIComponent(`cloud/aws/000000000000/5c1f0e2a9b7d/${V1}`)}&to=${encodeURIComponent("cloud/aws/000000000000/0123456789ab/20261026T140000Z-cccccccccccc.json")}`,
    );
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ code: "index-scope-mismatch", fromScopeKey: "cloud/aws/000000000000/5c1f0e2a9b7d", toScopeKey: "cloud/aws/000000000000/0123456789ab" });
  });

  it("with two scopes and none named, asks for one", async () => {
    const res = await app(project()).request("/api/graphdb/index-diff");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "index-scope-needed" });
  });

  it("a public serve refuses both routes", async () => {
    const h = new Hono();
    mountIndexDiff(h, { projectDir: () => project(), git: noGit, public: true });
    for (const p of ["/api/graphdb/index-versions", "/api/graphdb/index-diff"]) expect((await h.request(p)).status).toBe(403);
  });

  it("the diff module imports nothing from the rest of behold", () => {
    const src = readFileSync(join(import.meta.dirname, "index-diff.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.filter((i) => !i.startsWith("node:") && !i.startsWith("@intentius/chant"))).toEqual([]);
  });
});
