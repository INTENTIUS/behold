// behold#1028: the diff of two index versions, chant's diffIndexVersions (chant#4533) since behold#1005. Two fixture versions of one aws scope
// (src/graph-db/__fixtures__/index-diff/), the scope-mismatch refusal, a type unobserved in
// one read never reported as removed, edges, and the routes over a project's local store.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { diffIndexVersionRefs, diffIndexVersions, IndexScopeMismatch, readIndexVersionRef } from "@intentius/chant/lifecycle/index-diff";
import type { IndexDocument } from "@intentius/chant/lifecycle/index-document";
import { chantIndexStore, diffFromStores, listIndexVersions, mountIndexDiff, overlayFor, type ChantIndexStore, type ChantIndexStoreApi, type DiffDocument } from "./index-diff-routes.ts";
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
/** A project whose chant store cannot be opened: only behold's local reads run (behold#1034). */
const publishedChant = async () => undefined;

describe("loading two versions from the stores", () => {
  it("lists versions per scope, oldest first", () => {
    const dir = project();
    const vs = listIndexVersions({ projectDir: dir, git: noGit, chantStore: publishedChant, env: { BEHOLD_INDEX_DIR: join(dir, "none") } });
    expect(vs.filter((v) => v.scopeKey.endsWith("5c1f0e2a9b7d")).map((v) => v.version)).toEqual([V1, V2]);
    expect(vs.every((v) => v.store === "project-local")).toBe(true);
  });

  it("defaults to the scope's last two versions and draws the overlay", async () => {
    const dir = project();
    const a = await diffFromStores({ scope: "cloud/aws/000000000000/5c1f0e2a9b7d" }, { projectDir: dir, git: noGit, chantStore: publishedChant, env: { BEHOLD_INDEX_DIR: join(dir, "none") } });
    expect(a.diff.from.version).toBe(V1);
    expect(a.diff.to.version).toBe(V2);
    const byKey = Object.fromEntries(a.draw.nodes.map((n) => [n.key, n.change]));
    expect(byKey).toMatchObject({ [B("web-logs")]: "changed", [B("old-bucket")]: "removed", [B("new-bucket")]: "added", [QUEUE]: "not-observed" });
    expect(a.draw.edges.find((e) => e.to === QUEUE)?.change).toBe("not-observed");
  });

  it("refuses two versions under different scope paths before reading either", async () => {
    const dir = project();
    await expect(
      diffFromStores({ from: `cloud/aws/000000000000/5c1f0e2a9b7d/${V1}`, to: "cloud/aws/000000000000/0123456789ab/20261026T140000Z-cccccccccccc.json" }, { projectDir: dir, git: noGit, chantStore: publishedChant, env: { BEHOLD_INDEX_DIR: join(dir, "none") } }),
    ).rejects.toMatchObject({ code: "index-scope-mismatch", status: 409 });
  });

  it("refuses a stored version whose stamp names another scope than its path", async () => {
    const dir = project();
    // The other scope's file holds V1's document, whose stamp names 5c1f0e2a9b7d.
    const other = "cloud/aws/000000000000/0123456789ab";
    const vs = listIndexVersions({ projectDir: dir, git: noGit, chantStore: publishedChant, env: { BEHOLD_INDEX_DIR: join(dir, "none") } });
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
    mountIndexDiff(h, { projectDir: () => dir, git: noGit, chantStore: publishedChant, env: { BEHOLD_INDEX_DIR: join(dir, "none") } });
    return h;
  };

  it("GET /api/graphdb/index-diff answers the diff; a scope mismatch is 409 by name", async () => {
    const dir = project();
    const ok = await app(dir).request(`/api/graphdb/index-diff?scope=${encodeURIComponent("cloud/aws/000000000000/5c1f0e2a9b7d")}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { diff: { counts: { properties: number } } };
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
    mountIndexDiff(h, { projectDir: () => project(), git: noGit, chantStore: publishedChant, public: true });
    for (const p of ["/api/graphdb/index-versions", "/api/graphdb/index-diff"]) expect((await h.request(p)).status).toBe(403);
  });
});

describe("behold#1034: versions read through chant's store API", () => {
  const SCOPE = "cloud/aws/000000000000/5c1f0e2a9b7d";
  /** An s3-kind store held in memory: no folders behold could walk. */
  const fakeS3 = (versions: Record<string, DiffDocument>, calls: string[] = []): ChantIndexStore => ({
    kind: "s3",
    where: "s3://fake-bucket/chant",
    listIndex: async (scopeKey) => {
      calls.push(`list ${scopeKey}`);
      return scopeKey === SCOPE ? Object.keys(versions).sort() : [];
    },
    readIndexAt: async (scopeKey, version) => {
      calls.push(`read ${version}`);
      return scopeKey === SCOPE ? ((versions[version] as unknown as IndexDocument | undefined) ?? null) : null;
    },
  });
  /** chant#4533's two readers, as lifecycle/index-diff.ts has them, over the bundled diff. */
  const notAVersion = (m: string) => Object.assign(new Error(m), { code: "not-an-index-version" });
  const fakeReaders = (calls: string[]): Omit<ChantIndexStoreApi, "store"> => ({
    readIndexVersionRef: async (store, ref) => {
      calls.push(`readIndexVersionRef ${ref.version}`);
      const version = ref.version ?? (await store.listIndex(ref.scopeKey)).pop();
      if (!version) throw notAVersion(`the ${store.kind} store holds no index version under ${ref.scopeKey}`);
      const doc = await store.readIndexAt(ref.scopeKey, version);
      if (!doc) throw notAVersion(`the ${store.kind} store holds no index version ${ref.scopeKey}/${version}`);
      return { scopeKey: ref.scopeKey, version, doc: doc as DiffDocument };
    },
    diffIndexVersionRefs: async (store, from, to) => {
      calls.push(`diffIndexVersionRefs ${from.version}..${to?.version}`);
      const a = (await store.readIndexAt(from.scopeKey, from.version!)) as DiffDocument | null;
      const b = (await store.readIndexAt(to!.scopeKey, to!.version!)) as DiffDocument | null;
      if (!a || !b) throw notAVersion("missing");
      return diffIndexVersions(a, b, { fromVersion: from.version, toVersion: to!.version });
    },
  });
  const empty = () => mkdtempSync(join(tmpdir(), "behold-index-diff-s3-"));
  const readers = (dir: string, chantStore: () => Promise<ChantIndexStoreApi | undefined>) => ({ projectDir: dir, git: noGit, env: { BEHOLD_INDEX_DIR: join(dir, "none") }, chantStore });

  it("diffs two versions only an s3 store holds, through chant's readers", async () => {
    const calls: string[] = [];
    const store = fakeS3({ [V1]: load(V1), [V2]: load(V2) }, calls);
    const a = await diffFromStores({ scope: SCOPE }, readers(empty(), async () => ({ store, ...fakeReaders(calls) })));
    expect(a.diff.from.version).toBe(V1);
    expect(a.diff.to.version).toBe(V2);
    expect(a.diff.counts.properties).toBe(1);
    expect(a.stores).toEqual({ from: "chant-store", to: "chant-store" });
    expect(a.chantStore).toEqual({ kind: "s3", where: "s3://fake-bucket/chant" });
    expect(calls).toContain(`diffIndexVersionRefs ${V1}..${V2}`);
    expect(calls).toContain(`readIndexVersionRef ${V1}`);
    // chant's diff and the overlay share one read of each version.
    expect(calls.filter((c) => c.startsWith("read 2"))).toEqual([`read ${V1}`, `read ${V2}`]);
    expect(Object.fromEntries(a.draw.nodes.map((n) => [n.key, n.change]))).toMatchObject({ [B("web-logs")]: "changed", [B("new-bucket")]: "added" });
  });

  it("on a published chant, the same project reads its local store as before", async () => {
    const a = await diffFromStores({ scope: SCOPE }, readers(project(), publishedChant));
    expect(a.stores).toEqual({ from: "project-local", to: "project-local" });
    expect(a.chantStore).toBeUndefined();
    expect(a.diff.counts.properties).toBe(1);
    // and an s3-only project has nothing to diff
    await expect(diffFromStores({ scope: SCOPE }, readers(empty(), publishedChant))).rejects.toMatchObject({ code: "index-scope-unknown", status: 404 });
  });

  it("a scope chant's store does not hold falls back to the local read", async () => {
    const calls: string[] = [];
    const a = await diffFromStores({ scope: SCOPE }, readers(project(), async () => ({ store: fakeS3({}, calls), ...fakeReaders(calls) })));
    expect(a.stores).toEqual({ from: "project-local", to: "project-local" });
    expect(calls).toContain(`list ${SCOPE}`);
    expect(calls.some((c) => c.startsWith("diffIndexVersionRefs"))).toBe(false);
  });

  it("a version in chant's store and one only local are read each where it is", async () => {
    const calls: string[] = [];
    const a = await diffFromStores({ scope: SCOPE }, readers(project(), async () => ({ store: fakeS3({ [V2]: load(V2) }, calls), ...fakeReaders(calls) })));
    expect(a.stores).toEqual({ from: "project-local", to: "chant-store" });
    expect(a.chantStore?.kind).toBe("s3");
    expect(a.diff.counts.properties).toBe(1);
  });

  it("chant's refusal is read by its code", async () => {
    const store = fakeS3({ [V1]: load(V1), [V2]: load(V2) });
    const refusing = { ...fakeReaders([]), diffIndexVersionRefs: async () => { throw notAVersion("gone"); } };
    await expect(diffFromStores({ scope: SCOPE }, readers(empty(), async () => ({ store, ...refusing })))).rejects.toMatchObject({ code: "not-an-index-version", status: 400 });
  });

  it("the routes list and diff an s3-only scope once it is named", async () => {
    const store = fakeS3({ [V1]: load(V1), [V2]: load(V2) });
    const h = new Hono();
    const dir = empty();
    mountIndexDiff(h, { projectDir: () => dir, git: noGit, env: { BEHOLD_INDEX_DIR: join(dir, "none") }, chantStore: async () => ({ store, ...fakeReaders([]) }) });
    const listed = await h.request(`/api/graphdb/index-versions?scope=${encodeURIComponent(SCOPE)}`);
    expect(await listed.json()).toEqual({ scopes: [{ scopeKey: SCOPE, versions: [{ version: V1, store: "chant-store" }, { version: V2, store: "chant-store" }] }] });
    const res = await h.request(`/api/graphdb/index-diff?scope=${encodeURIComponent(SCOPE)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stores: { from: "chant-store", to: "chant-store" }, chantStore: { kind: "s3" } });
  });

  it("chant's real readers give the same answer over the fake store", async () => {
    const store = fakeS3({ [V1]: load(V1), [V2]: load(V2) });
    const a = await diffFromStores({ scope: SCOPE }, readers(empty(), async () => ({ store, readIndexVersionRef, diffIndexVersionRefs })));
    expect(a.diff).toEqual(diffIndexVersions(load(V1), load(V2), { fromVersion: V1, toVersion: V2 }));
  });

  it("the default opens the project's chant store with chant's readers", async () => {
    const api = await chantIndexStore(empty());
    expect(api?.store.kind).toBeTypeOf("string");
    expect(api?.diffIndexVersionRefs).toBe(diffIndexVersionRefs);
  });
});
