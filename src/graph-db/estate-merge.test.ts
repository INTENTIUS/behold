// behold#1246: the estate merge. Pure comparison over loaded rows, then the route over the bundled
// example-estate-merge (two chant projects, each with a recorded engine document).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { createApp } from "../server.ts";
import { estateMerge, MergeSidesRefused, resolveSides, splitNames } from "./estate-merge.ts";
import { GRAPH_ROUTES, mountGraphPane, type GraphPaneDeps } from "./pane.ts";
import { emptyRows, finishRows, rowsFromChantIr } from "./rows.ts";

const EXAMPLE = join(import.meta.dirname, "..", "..", "example-estate-merge");
const SHARED = "acme-shared-exports-91c2";

/** What `chant graph` reads from the two example projects, composed as src/estate.ts composes them. */
const chantIr: GraphIR = {
  version: 1,
  nodes: [
    { id: "shop/assets", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { BucketName: "acme-shop-assets-7f3a" } },
    { id: "shop/exportsBucket", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { BucketName: SHARED } },
    { id: "analytics/warehouse", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { BucketName: "acme-analytics-warehouse-44d0" } },
    { id: "analytics/exportsBucket", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { BucketName: SHARED } },
  ],
  edges: [],
  groups: {},
};

function pane(over: Partial<GraphPaneDeps> = {}) {
  const app = new Hono();
  const deps: GraphPaneDeps = {
    projectDir: () => join(EXAMPLE, "shop"),
    members: () => [
      { name: "shop", dir: join(EXAMPLE, "shop"), kind: "chant" },
      { name: "analytics", dir: join(EXAMPLE, "analytics"), kind: "chant" },
    ],
    readChant: async () => ({ ir: chantIr, members: ["shop", "analytics"], from: "behold's estate read" }),
    git: () => {
      throw new Error("not a git repository");
    },
    peer: async () => {
      throw Object.assign(new Error("Cannot find package '@ladybugdb/core'"), { code: "ERR_MODULE_NOT_FOUND" });
    },
    dbDir: mkdtempSync(join(tmpdir(), "behold-merge-db-")),
    env: { BEHOLD_INDEX_DIR: join(tmpdir(), "behold-merge-no-user-index") },
    now: () => new Date("2026-11-21T10:00:00Z"),
    ...over,
  };
  mountGraphPane(app, deps);
  return app;
}

const get = async (app: Hono, path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("the demo estates", () => {
  it("show the exports bucket as one shared claim, and nothing else shared", async () => {
    const r = await get(pane(), "/api/graphdb/estate-merge");
    expect(r.status).toBe(200);
    const values = r.body.shared.map((c: { value: string }) => c.value).sort();
    expect(values).toEqual([SHARED, `arn:aws:s3:::${SHARED}`].sort());
    for (const claim of r.body.shared) {
      expect(claim.left.map((c: { member: string }) => c.member)).toEqual(["shop"]);
      expect(claim.right.map((c: { member: string }) => c.member)).toEqual(["analytics"]);
      expect(claim.left[0].key).toBe("shop/choudoufu/aws_s3_bucket.exports");
      expect(claim.right[0].key).toBe("analytics/choudoufu/aws_s3_bucket.exports");
    }
  });

  it("draws the policy naming the shop's assets bucket as a derived reference from the right into the left", async () => {
    const r = await get(pane(), "/api/graphdb/estate-merge?left=shop&right=analytics");
    const refs = r.body.references as Array<{ from: string; fromKey: string; toKey: string; viaAttr: string; origin: string; rule: string; ambiguous: boolean }>;
    const policy = refs.filter((x) => x.fromKey.endsWith("aws_iam_policy.read_shop_assets"));
    expect(policy).toEqual([
      expect.objectContaining({ from: "right", toKey: "shop/choudoufu/aws_s3_bucket.assets", viaAttr: "policy_resource", origin: "derived", rule: "identity:arn", ambiguous: false }),
    ]);
  });

  it("flags the bucket name each chant source declares as ambiguous, because it names a resource on each side", async () => {
    const r = await get(pane(), "/api/graphdb/estate-merge?left=shop&right=analytics");
    const named = (r.body.references as Array<{ from: string; fromKey: string; viaAttr: string; ambiguous: boolean }>).filter((x) => x.viaAttr === "BucketName");
    expect(named.map((x) => [x.from, x.fromKey, x.ambiguous]).sort()).toEqual([
      ["left", "shop/exportsBucket", true],
      ["right", "analytics/exportsBucket", true],
    ]);
  });

  it("lists each side's members and substrates, from the lexicons the resources carry", async () => {
    const r = await get(pane(), "/api/graphdb/estate-merge");
    expect(r.body.left.members).toEqual([{ name: "shop", kind: "chant", resources: 4 }]);
    expect(r.body.right.members).toEqual([{ name: "analytics", kind: "chant", resources: 5 }]);
    expect(r.body.left.substrates).toEqual([
      { lexicon: "aws", resources: 2 },
      { lexicon: "terraform", resources: 2 },
    ]);
    expect(r.body.right.substrates.map((s: { lexicon: string }) => s.lexicon).sort()).toEqual(["aws", "terraform"]);
    expect(r.body.sources.length).toBeGreaterThan(0);
  });

  it("swapping the sides swaps the claimants and the direction of each reference", async () => {
    const r = await get(pane(), "/api/graphdb/estate-merge?left=analytics&right=shop");
    expect(r.body.shared[0].left[0].member).toBe("analytics");
    const policy = r.body.references.find((x: { fromKey: string }) => x.fromKey.endsWith("read_shop_assets"));
    expect(policy.from).toBe("left");
  });
});

describe("naming the sides", () => {
  const members = ["a", "b", "c"];

  it("an estate of two members compares them without being told", () => {
    expect(resolveSides(["a", "b"], {})).toEqual({ left: ["a"], right: ["b"] });
  });

  it("more than two members need both sides named", () => {
    expect(() => resolveSides(members, {})).toThrowError(MergeSidesRefused);
    expect(() => resolveSides(members, { left: ["a"] })).toThrowError(/right is empty/);
    expect(resolveSides(members, { left: ["a", "b"], right: ["c"] })).toEqual({ left: ["a", "b"], right: ["c"] });
  });

  it("refuses a name that is not a served member, and a member on both sides", () => {
    expect(() => resolveSides(members, { left: ["../etc"], right: ["a"] })).toThrowError(/not a served member: \.\.\/etc/);
    expect(() => resolveSides(members, { left: ["a", "b"], right: ["b"] })).toThrowError(/both sides: b/);
  });

  it("reads repeated and comma-separated values, once each", () => {
    expect(splitNames(["a,b", " b ", ""])).toEqual(["a", "b"]);
    expect(splitNames(undefined)).toEqual([]);
  });

  it("answers 400 with the served members and a code", async () => {
    const r = await get(pane(), "/api/graphdb/estate-merge?left=shop");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "empty-side", members: ["shop", "analytics"] });
    const u = await get(pane(), "/api/graphdb/estate-merge?left=shop&right=nope");
    expect(u.body.code).toBe("unknown-member");
    const one = await get(pane({ members: () => [{ name: "shop", dir: join(EXAMPLE, "shop"), kind: "chant" }] }), "/api/graphdb/estate-merge");
    expect(one.status).toBe(400);
    expect(one.body.code).toBe("sides-needed");
  });

  it("is refused under --public, which shows the declared source only", async () => {
    const r = await get(pane({ public: true }), "/api/graphdb/estate-merge");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("public");
  });
});

describe("the comparison", () => {
  const readAt = "2026-11-21T10:00:00Z";
  const ir = (nodes: GraphIR["nodes"], edges: GraphIR["edges"] = []): GraphIR => ({ version: 1, nodes, edges, groups: {} });

  it("matches the same cloud id across the sides, and a short id never", () => {
    const rows = rowsFromChantIr(
      ir([
        { id: "a/one", kind: "k", lexicon: "x", attrs: {}, physicalId: "shared-bucket-1" },
        { id: "b/two", kind: "k", lexicon: "x", attrs: {}, physicalId: "shared-bucket-1" },
        { id: "a/three", kind: "k", lexicon: "x", attrs: {}, physicalId: "web" },
        { id: "b/four", kind: "k", lexicon: "x", attrs: {}, physicalId: "web" },
      ]),
      { members: ["a", "b"], readAt, from: "t" },
      emptyRows(),
    );
    finishRows(rows);
    const m = estateMerge(rows, { left: ["a"], right: ["b"] });
    expect(m.shared.map((c) => c.value)).toEqual(["shared-bucket-1"]);
  });

  it("joins an Azure id spelled in two cases as one claim", () => {
    const id = "/subscriptions/0000/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct";
    const rows = rowsFromChantIr(
      ir([
        { id: "a/one", kind: "k", lexicon: "x", attrs: {}, physicalId: id },
        { id: "b/two", kind: "k", lexicon: "x", attrs: {}, physicalId: id.toLowerCase() },
      ]),
      { members: ["a", "b"], readAt, from: "t" },
      emptyRows(),
    );
    finishRows(rows);
    expect(estateMerge(rows, { left: ["a"], right: ["b"] }).shared).toHaveLength(1);
  });

  it("does not call two resources of one side a shared claim, and counts members left out as on neither side", () => {
    const rows = rowsFromChantIr(
      ir([
        { id: "a/one", kind: "k", lexicon: "x", attrs: {}, physicalId: "same-bucket-id" },
        { id: "a/two", kind: "k", lexicon: "x", attrs: {}, physicalId: "same-bucket-id" },
        { id: "b/three", kind: "k", lexicon: "y", attrs: {} },
        { id: "c/four", kind: "k", lexicon: "x", attrs: {}, physicalId: "same-bucket-id" },
      ]),
      { members: ["a", "b", "c"], readAt, from: "t" },
      emptyRows(),
    );
    finishRows(rows);
    const m = estateMerge(rows, { left: ["a"], right: ["b"] });
    expect(m.shared).toEqual([]);
    expect(m.unassigned).toBe(1);
    expect(m.notes.join("\n")).toMatch(/right side carries no cloud ids/);
  });

  it("reports a declared edge across the sides with its origin, and none inside a side", () => {
    const rows = rowsFromChantIr(
      ir(
        [
          { id: "a/one", kind: "k", lexicon: "x", attrs: {} },
          { id: "a/two", kind: "k", lexicon: "x", attrs: {} },
          { id: "b/three", kind: "k", lexicon: "x", attrs: {} },
        ],
        [
          { from: "a/one", to: "a/two", kind: "ref" },
          { from: "a/one", to: "b/three", kind: "ref", viaAttr: "queue" },
        ],
      ),
      { members: ["a", "b"], readAt, from: "t" },
      emptyRows(),
    );
    const m = estateMerge(rows, { left: ["a"], right: ["b"] });
    expect(m.references).toEqual([{ from: "left", fromKey: "a/one", toKey: "b/three", viaAttr: "queue", origin: "declared", rule: "", relation: "reference", ambiguous: false }]);
  });
});

describe("the route is a read", () => {
  it("is listed with the pane's routes, a GET, and in behold's app any other method is refused", async () => {
    const mine = GRAPH_ROUTES.filter((r) => r.path === "/api/graphdb/estate-merge");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.method).toBe("GET");
    const app = createApp({ projectDir: mkdtempSync(join(tmpdir(), "behold-merge-app-")), port: 0 });
    const res = await app.request("/api/graphdb/estate-merge", { method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1" } });
    expect([403, 404, 405, 409]).toContain(res.status);
    const index = (await (await app.request("/api")).json()) as { routes: Array<{ path: string }> };
    expect(index.routes.some((r) => r.path === "/api/graphdb/estate-merge")).toBe(true);
  });
});
