// behold#1027: the loaders, over chant#4527's fixture documents
// (packages/core/src/graph-schema/fixtures on chant's integration/consolidation-graph,
// copied to ./__fixtures__), a small chant IR, a composed estate and a cloud listing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphIR } from "@intentius/chant";
import type { ListingResult } from "../cloud-lister/types.ts";
import {
  cloudScopeKey,
  emptyRows,
  engineScopeKey,
  finishRows,
  IDENTITY_MIN_LENGTH,
  rowsFromChantIr,
  rowsFromEngineGraph,
  rowsFromIndex,
  rowsFromListing,
} from "./rows.ts";
import { isEngineGraphDocument, isIndexDocument, isListingResult, type EngineGraphDocument, type IndexDocument } from "./types.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8"));
const choudoufu = fixture("choudoufu.engine-graph.json") as EngineGraphDocument;
const plunge = fixture("plunge.engine-graph.json") as EngineGraphDocument;
const index = fixture("index.json") as IndexDocument;
const readAt = "2026-10-26T13:00:00.000Z";

const chantIr: GraphIR = {
  version: 1,
  nodes: [
    { id: "aws_s3_bucket.logs", kind: "aws_s3_bucket", lexicon: "terraform", attrs: { name: "logs", bucket: "web-logs", password: "hunter2" }, physicalId: "web-logs" },
    { id: "aws_instance.web", kind: "aws_instance", lexicon: "terraform", attrs: { name: "web", logs_bucket: "arn:aws:s3:::web-logs" } },
  ],
  edges: [
    { from: "aws_instance.web", to: "aws_s3_bucket.logs", kind: "ref", viaAttr: "logs_bucket" },
    { from: "aws_instance.web", to: "aws_vpc.gone", kind: "ref" },
  ],
  groups: {},
};

const listing: ListingResult = {
  listing: "v1",
  source: { name: "behold-lister", version: "0.30.2" },
  scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: ["AWS::S3::Bucket"] },
  startedAt: "2026-10-26T11:00:00Z",
  completedAt: "2026-10-26T11:00:02Z",
  resources: [
    {
      id: "aws/000000000000/us-east-1/AWS::S3::Bucket/assets-4f1c2e9",
      listedType: "AWS::S3::Bucket",
      location: "us-east-1",
      nativeId: "assets-4f1c2e9",
      cloudIds: [{ kind: "arn", value: "arn:aws:s3:::assets-4f1c2e9" }, { kind: "import-id", value: "assets-4f1c2e9" }],
      tags: { Name: "assets" },
      properties: { BucketName: "assets-4f1c2e9" },
      observedAt: "2026-10-26T11:00:01Z",
      facts: { cloudIds: [{ kind: "arn", value: "arn:aws:s3:::assets-4f1c2e9" }], observedAt: "2026-10-26T11:00:01Z" },
    },
  ],
  coverage: [{ listedType: "AWS::S3::Bucket", location: "us-east-1", verdict: "listed" }],
  notes: [],
};

describe("the fixtures are the shapes the loaders take", () => {
  it("classifies chant#4527's documents", () => {
    expect(isEngineGraphDocument(choudoufu)).toBe(true);
    expect(isEngineGraphDocument(plunge)).toBe(true);
    expect(isIndexDocument(index)).toBe(true);
    expect(isListingResult(listing)).toBe(true);
    expect(isEngineGraphDocument(index)).toBe(false);
    expect(isIndexDocument(choudoufu)).toBe(false);
  });
});

describe("chant IR", () => {
  it("one project: keys are the ids chant search prints, the source is declared (no observedAt), and a dangling edge is dropped", () => {
    const rows = rowsFromChantIr(chantIr, { readAt, from: "chant graph --format ir" });
    expect(rows.resources.map((r) => r.key)).toEqual(["aws_s3_bucket.logs", "aws_instance.web"]);
    expect(rows.refs).toEqual([expect.objectContaining({ from: "aws_instance.web", to: "aws_s3_bucket.logs", origin: "declared", viaAttr: "logs_bucket" })]);
    expect(rows.sources).toEqual([expect.objectContaining({ scopeKey: "chant/.", source: "chant", observedAt: null, readAt, nodes: 2, edges: 1 })]);
  });

  it("masks every attribute the lister's key list names, whatever the source", () => {
    const rows = rowsFromChantIr(chantIr, { readAt, from: "x" });
    const attrs = JSON.parse(rows.resources[0]!.attrs) as Record<string, unknown>;
    expect(attrs.password).not.toBe("hunter2");
    expect(attrs.bucket).toBe("web-logs");
  });

  it("one member: keys are <member>/<id>, as chant workspace search prints them", () => {
    const rows = rowsFromChantIr(chantIr, { member: "web", readAt, from: "x" });
    expect(rows.resources.map((r) => r.key)).toEqual(["web/aws_s3_bucket.logs", "web/aws_instance.web"]);
    expect(rows.sources[0]).toMatchObject({ scopeKey: "chant/web", member: "web" });
  });

  it("a composed estate: one source line per member, and edges that cross members load once", () => {
    const composed: GraphIR = {
      version: 1,
      nodes: [
        { id: "net/aws_vpc.main", kind: "aws_vpc", lexicon: "terraform", attrs: {} },
        { id: "app/aws_instance.web", kind: "aws_instance", lexicon: "terraform", attrs: {} },
      ],
      edges: [{ from: "app/aws_instance.web", to: "net/aws_vpc.main", kind: "ref", viaAttr: "vpc_id" }],
      groups: {},
    };
    const rows = rowsFromChantIr(composed, { members: ["net", "app"], readAt, from: "estate" });
    expect(rows.sources.map((s) => [s.scopeKey, s.nodes, s.edges])).toEqual([
      ["chant/app", 1, 1],
      ["chant/net", 1, 0],
    ]);
    expect(rows.refs).toHaveLength(1);
  });
});

describe("engine graph documents (chant#4520 section 3)", () => {
  it("choudoufu: keyed under its estate, facts nested in facts, and the read time from meta.engineGraph.observedAt", () => {
    const rows = rowsFromEngineGraph(choudoufu, { readAt, from: "engine-graph.json" });
    expect(engineScopeKey(choudoufu)).toBe("engine/choudoufu/web");
    const eip = rows.resources.find((r) => r.id === "module.app[0].aws_eip.pool[1]")!;
    expect(eip.key).toBe("engine/choudoufu/web/module.app[0].aws_eip.pool[1]");
    // behold#906 Q4: the engine's verdict has its own column; chant's (IRNode.ownership) is absent on an engine node.
    expect(eip.engineOwnership).toBe("bound");
    expect(eip.ownership).toBe("");
    expect(eip.address).toBe("module.app[0].aws_eip.pool[1]");
    expect(JSON.parse(eip.facts)).toMatchObject({ ownedBy: "marker", markers: { source: "live" } });
    expect(rows.sources[0]).toMatchObject({ source: "engine", name: "choudoufu", version: "0.33.0", observedAt: "2026-10-26T12:00:00Z", readAt });
    expect(rows.refs.every((e) => e.grain === "block" && e.origin === "observed")).toBe(true);
    // A gap the engine reported is a note, never a node.
    expect(rows.notes.some((n) => n.includes("aws_iam_role.legacy"))).toBe(true);
  });

  it("choudoufu: each cloud id is a CloudId the node is KNOWN_AS", () => {
    const rows = rowsFromEngineGraph(choudoufu, { readAt, from: "x" });
    const key = "engine/choudoufu/web/aws_s3_bucket.logs";
    expect(rows.knownAs.filter((k) => k.key === key).map((k) => k.value).sort()).toEqual(["arn:aws:s3:::web-logs", "web-logs"]);
  });

  it("plunge: keyed under project/stack, URN ids kept, instance and property edges both kept", () => {
    const rows = rowsFromEngineGraph(plunge, { readAt, from: "x" });
    expect(engineScopeKey(plunge)).toBe("engine/plunge/app/dev");
    expect(rows.resources.every((r) => r.id.startsWith("urn:pulumi:"))).toBe(true);
    const policy = rows.refs.filter((e) => e.from.endsWith("assets-policy"));
    expect(policy.map((e) => e.grain).sort()).toEqual(["instance", "property"]);
    expect(rows.sources[0]).toMatchObject({ name: "plunge", observedAt: "2026-10-26T12:00:00Z" });
  });

  it("a document beside a member takes the member's name", () => {
    const rows = rowsFromEngineGraph(choudoufu, { member: "web", readAt, from: "web/engine-graph.json" });
    expect(rows.resources[0]!.key.startsWith("web/choudoufu/")).toBe(true);
    expect(rows.sources[0]).toMatchObject({ member: "web" });
  });
});

describe("index versions (chant#4519, behold#1025)", () => {
  it("keyed <stamp.scopeKey>/<id>, versioned by the store's name, observed at the stamp", () => {
    const rows = rowsFromIndex(index, { version: "20261026T120000Z-e2f92b265a4d.json", readAt, from: "_index/..." });
    const key = `${index.stamp.scopeKey}/aws/000000000000/us-east-1/AWS::S3::Bucket/web-logs`;
    expect(rows.resources.map((r) => r.key)).toEqual([key]);
    expect(rows.resources[0]).toMatchObject({ source: "index", version: "20261026T120000Z-e2f92b265a4d.json", observedAt: "2026-10-26T12:00:00Z" });
    expect(rows.sources[0]).toMatchObject({ scopeKey: index.stamp.scopeKey, name: "behold-lister", observedAt: "2026-10-26T12:00:00Z" });
  });

  it("a (type, location) that was not listed is a note: absent there means not observed", () => {
    const rows = rowsFromIndex(index, { version: "v", readAt, from: "x" });
    expect(rows.notes.some((n) => n.includes("AWS::SQS::Queue") && n.includes("read-failed"))).toBe(true);
  });
});

describe("cloud listings (behold#1029)", () => {
  it("load before chant types them: kind is the listed type, lexicon the substrate, under the scope key chant's store would give", () => {
    const rows = rowsFromListing(listing, { readAt, from: "x" });
    const scopeKey = cloudScopeKey(listing.scope);
    expect(scopeKey).toMatch(/^cloud\/aws\/000000000000\/[0-9a-f]{12}$/);
    expect(rows.resources[0]).toMatchObject({ key: `${scopeKey}/${listing.resources[0]!.id}`, kind: "AWS::S3::Bucket", lexicon: "aws", nativeId: "assets-4f1c2e9", location: "us-east-1", name: "assets", source: "cloud" });
    expect(rows.sources[0]).toMatchObject({ source: "cloud", observedAt: "2026-10-26T11:00:00Z" });
  });

  it("gives the same scope key as chant#4519's fixture for the fixture's scope", () => {
    const s = index.stamp.scope as unknown as { substrate: "aws"; scopeId: string; locations: string[]; types: string[] };
    expect(cloudScopeKey({ substrate: s.substrate, scopeId: s.scopeId, locations: s.locations, types: s.types })).toBe(index.stamp.scopeKey);
  });
});

describe("mixed substrate", () => {
  const all = () => {
    const rows = emptyRows();
    rowsFromChantIr(chantIr, { member: "web", readAt, from: "x" }, rows);
    rowsFromEngineGraph(choudoufu, { readAt, from: "x" }, rows);
    rowsFromEngineGraph(plunge, { readAt, from: "x" }, rows);
    rowsFromIndex(index, { version: "v", readAt, from: "x" }, rows);
    rowsFromListing(listing, { readAt, from: "x" }, rows);
    return finishRows(rows);
  };

  it("one CloudId per value, so the same bucket in chant, choudoufu and the index is one value three nodes are known as", () => {
    const rows = all();
    expect(rows.cloudIds.filter((c) => c.value === "web-logs")).toHaveLength(1);
    expect(rows.knownAs.filter((k) => k.value === "web-logs").map((k) => k.key).sort()).toEqual(
      ["engine/choudoufu/web/aws_s3_bucket.logs", `${index.stamp.scopeKey}/aws/000000000000/us-east-1/AWS::S3::Bucket/web-logs`, "web/aws_s3_bucket.logs"].sort(),
    );
  });

  it("derives identity edges across sources only, labelled derived with their rule", () => {
    const rows = all();
    const derived = rows.refs.filter((e) => e.origin === "derived");
    expect(derived.length).toBeGreaterThan(0);
    for (const e of derived) {
      expect(e.rule).toMatch(/^identity:/);
      expect(e.grain).toBe("property");
      const from = rows.resources.find((r) => r.key === e.from)!;
      const to = rows.resources.find((r) => r.key === e.to)!;
      expect(from.scopeKey).not.toBe(to.scopeKey);
    }
    // The chant instance's attribute names the bucket's ARN, which choudoufu's bucket is known as.
    expect(derived).toContainEqual(expect.objectContaining({ from: "web/aws_instance.web", to: "engine/choudoufu/web/aws_s3_bucket.logs", viaAttr: "logs_bucket", rule: "identity:arn" }));
  });

  it("never matches a value shorter than the floor", () => {
    const rows = emptyRows();
    rowsFromChantIr({ version: 1, nodes: [{ id: "a", kind: "k", lexicon: "x", attrs: { ref: "short" } }], edges: [], groups: {} }, { member: "m1", readAt, from: "x" }, rows);
    rowsFromChantIr({ version: 1, nodes: [{ id: "b", kind: "k", lexicon: "x", attrs: {}, physicalId: "short" }], edges: [], groups: {} }, { member: "m2", readAt, from: "x" }, rows);
    expect("short".length).toBeLessThan(IDENTITY_MIN_LENGTH);
    expect(finishRows(rows).refs).toEqual([]);
  });
});
