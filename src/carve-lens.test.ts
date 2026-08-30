import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCarveReport,
  readCarveReport,
  carveReportToIr,
  carveNote,
  statusForBand,
  tfTypeOf,
  scoreArithmetic,
  carveCardFields,
  type CarveReport,
} from "./carve-lens.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "carve-sample-estate.json");

/**
 * The fixture is a REAL report: `chant carve advise --from sample-estate --json`
 * run against chant's own `packages/core/src/terraform/__fixtures__/sample-estate`
 * (copied to a scratch dir so nothing in the chant checkout was touched), on a
 * chant that carries chant#1636 (chant PR #1639): a top-level `version: 1` and
 * per-resource `boundary: {inbound, outbound}` edge lists. Every cut in the
 * estate is reported twice across the file — once as an `inbound` edge on the
 * depended-on resource, once as an `outbound` edge on the resource that depends
 * on it — which is why `carveReportToIr`'s dedup below matters.
 *
 * Regenerated on chant 0.52.1, which added chant#1638's `breakdown.outputs`
 * and `breakdown.penalties.outputs` (inbound edges from `output` blocks). The
 * fixture had gone stale on that field alone. Both read 0 for every resource
 * here — sample-estate declares no `output` blocks — so this exercises the
 * shape, not the penalty; `carveReportToIr` reads it defensively (`?? 0`)
 * either way.
 */
const report = JSON.parse(readFileSync(FIXTURE, "utf8")) as CarveReport;

describe("the real chant carve advise --json fixture", () => {
  it("is the shape the lens claims it is", () => {
    const parsed = parseCarveReport(report);
    expect(parsed.ok).toBe(true);
    expect(report.count).toBe(8);
    expect(report.resources).toHaveLength(8);
    expect(report.bands).toEqual({ "clean leaf": 6, "carvable w/ edits": 1, "leave in Terraform": 1 });
  });

  it("declares schema version 1 (chant#1636) — which the lens accepts", () => {
    expect(report.version).toBe(1);
    expect(parseCarveReport(report).ok).toBe(true);
  });

  it("carries boundary edge LISTS whose lengths equal the breakdown COUNTS (chant#1636)", () => {
    for (const r of report.resources) {
      expect(typeof r.breakdown?.inbound).toBe("number");
      expect(typeof r.breakdown?.outbound).toBe("number");
      expect(r.boundary).toBeDefined();
      const b = r.boundary as { inbound?: unknown[]; outbound?: unknown[] };
      expect(b.inbound).toHaveLength(r.breakdown?.inbound ?? 0);
      expect(b.outbound).toHaveLength(r.breakdown?.outbound ?? 0);
    }
    // The counts are real work: 4 inbound and 4 outbound list entries across
    // the estate — reporting the SAME 4 cuts from both endpoints, not 8 cuts.
    const inbound = report.resources.reduce((s, r) => s + (r.breakdown?.inbound ?? 0), 0);
    const outbound = report.resources.reduce((s, r) => s + (r.breakdown?.outbound ?? 0), 0);
    expect([inbound, outbound]).toEqual([4, 4]);
  });
});

describe("carveReportToIr — the sample estate", () => {
  const ir = carveReportToIr(report);

  it("makes one node per ranked resource, kinded by Terraform type on the terraform lexicon", () => {
    expect(ir.nodes).toHaveLength(8);
    expect(ir.nodes.every((n) => n.lexicon === "terraform")).toBe(true);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    expect(byId.get("aws_s3_bucket.assets")!.kind).toBe("aws_s3_bucket");
    expect(byId.get("random_pet.suffix")!.kind).toBe("random_pet");
    // The folded sub-resource carves WITH its parent, so chant never ranks it
    // and it must not appear as a card of its own.
    expect(byId.has("aws_s3_bucket_versioning.assets")).toBe(false);
  });

  it("paints the bands on the drift palette via attrs._status", () => {
    const status = (id: string) => ir.nodes.find((n) => n.id === id)!.attrs._status;
    expect(status("aws_cloudwatch_log_group.api")).toBe("good"); // 100, clean leaf
    expect(status("aws_vpc.main")).toBe("warn"); // 64, carvable w/ edits
    expect(status("random_pet.suffix")).toBe("neutral"); // 0, leave in Terraform
  });

  it("puts the score arithmetic in attrs, where the inspect pane already renders it", () => {
    const vpc = ir.nodes.find((n) => n.id === "aws_vpc.main")!;
    expect(vpc.attrs.score).toBe(64);
    expect(vpc.attrs.inbound).toBe(3);
    expect(vpc.attrs.arithmetic).toBe("100 - 12x3 inbound = 64");
    expect(vpc.attrs.boundaryWork).toBe("3 inbound (a data-source patch each)");
    expect(vpc.attrs.mapsTo).toBe("AWS::EC2::VPC");
    expect(vpc.attrs.tier).toBe(1);

    const lambda = ir.nodes.find((n) => n.id === "aws_lambda_function.api")!;
    expect(lambda.attrs.arithmetic).toBe("100 - 4x1 outbound - 15x1 tier2 = 81");

    // A clean 1:1 map with no boundary edges has no penalty terms to print.
    const logs = ir.nodes.find((n) => n.id === "aws_cloudwatch_log_group.api")!;
    expect(logs.attrs.arithmetic).toBe("100 (no penalties) = 100");
    expect(logs.attrs.boundaryWork).toBe("clean 1:1 native map, no boundary edges");

    // No native mapping is not a penalty sum — chant awards no partial credit.
    const pet = ir.nodes.find((n) => n.id === "random_pet.suffix")!;
    expect(pet.attrs.tier).toBe("none");
    expect(pet.attrs.arithmetic).toBe("0 (no known native mapping — nothing to carve into)");
  });

  it("boxes the ranking by band, carve-now first", () => {
    expect(ir.groups.byStack).toEqual({
      "carve now": [
        "aws_cloudwatch_log_group.api",
        "aws_subnet.a",
        "aws_subnet.b",
        "aws_subnet.c",
        "aws_s3_bucket.assets",
        "aws_lambda_function.api",
      ],
      "boundary work": ["aws_vpc.main"],
      "leave in Terraform": ["random_pet.suffix"],
    });
  });

  it("draws the 4 real cuts once each, not 8 — the dedup chant#1636 required", () => {
    // The sample estate has 4 real cuts (3 subnets -> the VPC, the lambda ->
    // the bucket), each reported twice in the file (once inbound, once
    // outbound). `carveReportToIr` must collapse both views of one cut into a
    // single edge; keying the dedup on `direction` (the pre-fix behaviour)
    // would draw all 8 list entries as 8 separate edges instead.
    expect(ir.edges).toHaveLength(4);
    expect(ir.edges).toEqual([
      { from: "aws_subnet.a", to: "aws_vpc.main", kind: "ref", viaAttr: "outbound", toAttr: "id" },
      { from: "aws_subnet.b", to: "aws_vpc.main", kind: "ref", viaAttr: "outbound", toAttr: "id" },
      { from: "aws_subnet.c", to: "aws_vpc.main", kind: "ref", viaAttr: "outbound", toAttr: "id" },
      { from: "aws_lambda_function.api", to: "aws_s3_bucket.assets", kind: "ref", viaAttr: "inbound", toAttr: "arn, bucket" },
    ]);
    // The star bucket's cut — the one the example-carve walkthrough narrates —
    // appears exactly once, not once per endpoint.
    const bucketCuts = ir.edges.filter((e) => e.from === "aws_s3_bucket.assets" || e.to === "aws_s3_bucket.assets");
    expect(bucketCuts).toHaveLength(1);
  });

  it("names the predicted diff on every resource with a boundary list", () => {
    const vpc = ir.nodes.find((n) => n.id === "aws_vpc.main")!;
    expect(vpc.attrs.patchOnCarve).toBe("aws_subnet.a, aws_subnet.b, aws_subnet.c");
    expect(vpc.attrs.deferredInputs).toBeUndefined();

    const bucket = ir.nodes.find((n) => n.id === "aws_s3_bucket.assets")!;
    expect(bucket.attrs.patchOnCarve).toBe("aws_lambda_function.api");
    expect(bucket.attrs.deferredInputs).toBeUndefined();

    const lambda = ir.nodes.find((n) => n.id === "aws_lambda_function.api")!;
    expect(lambda.attrs.deferredInputs).toBe("aws_s3_bucket.assets");
    expect(lambda.attrs.patchOnCarve).toBeUndefined();

    // A resource whose boundary lists are both empty gets neither key — "no
    // boundary work" and "not reported" stay distinguishable claims.
    const logs = ir.nodes.find((n) => n.id === "aws_cloudwatch_log_group.api")!;
    expect(logs.attrs.patchOnCarve).toBeUndefined();
    expect(logs.attrs.deferredInputs).toBeUndefined();
  });

  it("drops the chant#1636 caveat from the note now the fixture carries edge lists", () => {
    const note = carveNote(report, ir);
    expect(note).toContain("6 clean leaf");
    expect(note).toContain("sample-estate");
    expect(note).not.toContain("chant#1636");
    expect(note).toContain("Read-only: nothing is emitted, patched, or applied.");
  });
});

/**
 * CDK compat (#230, chant#2019): `chant carve advise --from ./cdk.out` ranks
 * CDK constructs through the same scoring model, bands and report shape the
 * Terraform path uses — a `source: "cdk"` discriminator plus per-resource
 * `notes`/`members` and `crossStack` on a boundary edge are the only new
 * fields, all additive within schema version 1.
 *
 * Fixture provenance: `src/__fixtures__/carve-cdk-sample.json` is the real
 * `carveJson()` payload chant#2019's own `packages/core/src/cdk/advise.test.ts`
 * asserts against (the `AppStack`/`DataStack` cloud-assembly fixture),
 * captured by running chant's test suite against commit 103cbb04
 * (`feat(carve): CDK cloud-assembly carve advisor (read-only) (#2019)`) on
 * chant main and writing the payload chant already builds internally —
 * unreleased at time of writing (merged after the 0.52.2 version commit; no
 * npm dependency bump). This is not a synthetic shape drawn from reading the
 * code — it is chant's own advisor output, verbatim.
 */
describe("carveReportToIr — a real CDK report (chant#2019, unreleased)", () => {
  const cdkFixture = join(HERE, "__fixtures__", "carve-cdk-sample.json");
  const cdkReport = JSON.parse(readFileSync(cdkFixture, "utf8")) as CarveReport;

  it("is the same report shape the lens already reads — version 1, an untouched `resources` contract", () => {
    const parsed = parseCarveReport(cdkReport);
    expect(parsed.ok).toBe(true);
    expect(cdkReport.version).toBe(1);
    expect(cdkReport.count).toBe(6);
    expect(cdkReport.resources).toHaveLength(6);
    expect(cdkReport.bands).toEqual({ "clean leaf": 3, "carvable w/ edits": 2, "leave in Terraform": 1 });
  });

  it("the CDK-only additions (source, notes, members, crossStack) are additive — the lens never keys on them", () => {
    // `source` is new at the top level; every field the lens's shallow
    // validator checks (address/score/band) is untouched.
    expect((cdkReport as unknown as { source: string }).source).toBe("cdk");
    const handler = cdkReport.resources.find((r) => r.address === "AppStack/Handler")!;
    expect((handler as unknown as { notes: string[] }).notes.join(" ")).toContain("Asset-backed");
    expect((handler as unknown as { members: unknown[] }).members).toHaveLength(3);
    const crossStackEdge = (handler.boundary as unknown as { outbound: Array<Record<string, unknown>> }).outbound.find(
      (e) => e.crossStack,
    );
    expect(crossStackEdge?.survivor).toBe("DataStack/Assets");
  });

  const ir = carveReportToIr(cdkReport);

  it("renders unchanged: one card per construct, kinded from the address the same way a Terraform address is", () => {
    expect(ir.nodes).toHaveLength(6);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    // A construct path has no dot, so tfTypeOf's split falls through to the
    // whole address — same behavior as any other opaque address the lens
    // doesn't recognize the internal shape of.
    expect(byId.get("AppStack/Handler")!.kind).toBe("AppStack/Handler");
    expect(byId.get("AppStack/Handler")!.attrs.mapsTo).toBe("AWS::Lambda::Function");
  });

  it("a `kind: \"module\"` construct (the L3 subtree) paints and reads exactly like a Terraform module", () => {
    const api = ir.nodes.find((n) => n.id === "AppStack/Api")!;
    expect(api.attrs.mapsTo).toBeUndefined();
    expect(api.attrs._status).toBe("warn"); // 69, carvable w/ edits
    expect(api.attrs.arithmetic).toBe("100 - 12x1 inbound - 4x1 output - 15x1 tier2 = 69");
  });

  it("draws the cross-stack boundary edge like any other — crossStack rides along unread, not required", () => {
    // DataStack/Assets reports this cut as `inbound` and is processed first
    // (it precedes AppStack/Handler in `resources`), so the dedup keeps that
    // view; Handler's `outbound` mirror of the same cut is the one dropped.
    // `crossStack` itself never has to be read for the edge to draw right.
    expect(ir.edges).toContainEqual({
      from: "AppStack/Handler",
      to: "DataStack/Assets",
      kind: "ref",
      viaAttr: "inbound",
      toAttr: "Export",
    });
  });

  it("boxes the ranking by band, carve-now first — the same grouping a Terraform report gets", () => {
    expect(ir.groups.byStack).toEqual({
      "carve now": ["AppStack/Legacy", "DataStack/Assets", "DataStack/Table"],
      "boundary work": ["AppStack/Api", "AppStack/Handler"],
      "leave in Terraform": ["AppStack/Reports.NestedStack"],
    });
  });

  it("the note reads as a normal advisory — no chant#1636 caveat, since the edge lists are present", () => {
    const note = carveNote(cdkReport, ir);
    expect(note).toContain("3 clean leaf");
    expect(note).not.toContain("chant#1636");
  });
});

describe("carveReportToIr — boundary edges, synthetic shapes (#1636)", () => {
  // chant's own `BoundaryEdge` shape (packages/core/src/terraform/carve.ts),
  // attached per resource. The real fixture above already exercises this on a
  // real report; these synthetic cases pin the edge cases a real estate may
  // never hit in one place: the flat-list shape alongside the split shape, an
  // edge whose other end isn't a ranked node, and a directionless edge.
  const withEdges: CarveReport = {
    version: 1,
    from: "sample-estate",
    count: 3,
    bands: { "clean leaf": 2, "carvable w/ edits": 1 },
    resources: [
      {
        address: "aws_vpc.main",
        kind: "resource",
        score: 64,
        band: "carvable w/ edits",
        mapsTo: "AWS::EC2::VPC",
        breakdown: { inbound: 1, outbound: 0, tier: 1, hasDynamic: false, instances: 1, penalties: { inbound: -12, outbound: 0, tier: 0, dynamic: 0, instances: 0 } },
        boundary: {
          inbound: [
            {
              direction: "inbound",
              survivor: "aws_subnet.a",
              carved: "aws_vpc.main",
              attrs: ["id"],
              via: ["vpc_id"],
              bridge: "tf-data-source",
              required: "immediately",
            },
          ],
        },
      },
      {
        address: "aws_subnet.a",
        kind: "resource",
        score: 96,
        band: "clean leaf",
        mapsTo: "AWS::EC2::Subnet",
        breakdown: { inbound: 0, outbound: 1, tier: 1, hasDynamic: false, instances: 1, penalties: { inbound: 0, outbound: -4, tier: 0, dynamic: 0, instances: 0 } },
        // The SAME edge, reported from the other end — it must not draw twice.
        boundary: [
          {
            direction: "inbound",
            survivor: "aws_subnet.a",
            carved: "aws_vpc.main",
            attrs: ["id"],
            via: ["vpc_id"],
          },
          {
            direction: "outbound",
            survivor: "aws_iam_role.gone",
            carved: "aws_subnet.a",
            attrs: ["arn"],
          },
        ],
      },
      {
        address: "aws_cloudwatch_log_group.api",
        kind: "resource",
        score: 100,
        band: "clean leaf",
        breakdown: { inbound: 0, outbound: 0, tier: 1, hasDynamic: false, instances: 1, penalties: {} },
      },
    ],
  };

  const ir = carveReportToIr(withEdges);

  it("draws each boundary edge once, in dependency direction, tagged inbound/outbound", () => {
    expect(ir.edges).toEqual([
      { from: "aws_subnet.a", to: "aws_vpc.main", kind: "ref", viaAttr: "inbound", toAttr: "id" },
    ]);
  });

  it("drops an edge whose other end isn't a ranked node, rather than minting a phantom card", () => {
    // `aws_iam_role.gone` is a survivor chant never ranked (it's not carvable),
    // so there is no card to draw the edge to.
    expect(ir.nodes.map((n) => n.id)).not.toContain("aws_iam_role.gone");
    expect(ir.edges.some((e) => e.from.includes("gone") || e.to.includes("gone"))).toBe(false);
  });

  it("names the predicted diff in attrs: who needs a data-source patch on carve", () => {
    const vpc = ir.nodes.find((n) => n.id === "aws_vpc.main")!;
    expect(vpc.attrs.patchOnCarve).toBe("aws_subnet.a");
    const subnet = ir.nodes.find((n) => n.id === "aws_subnet.a")!;
    expect(subnet.attrs.deferredInputs).toBe("aws_iam_role.gone");
    // "not reported" and "none" are different claims — a resource with no
    // boundary list carries neither key.
    expect(ir.nodes.find((n) => n.id === "aws_cloudwatch_log_group.api")!.attrs.patchOnCarve).toBeUndefined();
  });

  it("drops the chant#1636 caveat from the note once edges are actually drawn", () => {
    expect(carveNote(withEdges, ir)).not.toContain("chant#1636");
  });

  it("reads a directionless edge as inbound — the same way in the edge and in the attrs", () => {
    // Nothing in the edge itself distinguishes the two directions (both name
    // the same carve-set side), so the conservative reading wins: a survivor
    // that needs an immediate data-source patch. The graph and the inspect
    // pane must not disagree about which it chose.
    const bare = carveReportToIr({
      resources: [
        {
          address: "aws_vpc.main",
          score: 64,
          band: "carvable w/ edits",
          boundary: [{ survivor: "aws_subnet.a", carved: "aws_vpc.main" }],
        },
        { address: "aws_subnet.a", score: 96, band: "clean leaf" },
      ],
    });
    expect(bare.edges).toEqual([{ from: "aws_subnet.a", to: "aws_vpc.main", kind: "ref", viaAttr: "inbound" }]);
    const vpc = bare.nodes.find((n) => n.id === "aws_vpc.main")!;
    expect(vpc.attrs.patchOnCarve).toBe("aws_subnet.a");
    expect(vpc.attrs.deferredInputs).toBeUndefined();
  });
});

describe("polite refusal on an unrecognized shape (#193's standard)", () => {
  const refusalOf = (v: unknown) => {
    const p = parseCarveReport(v);
    expect(p.ok).toBe(false);
    return p.ok ? null : p.refusal;
  };

  it("refuses a non-object", () => {
    expect(refusalOf([1, 2, 3])!.code).toBe("carve-report");
    expect(refusalOf("nope")!.error).toContain("isn't a JSON object");
  });

  it("refuses JSON with no resources array, and says where a real report comes from", () => {
    const r = refusalOf({ from: "./tf", count: 2 })!;
    expect(r.error).toContain("no `resources` array");
    expect(r.remedy).toContain("chant carve advise");
  });

  it("names the entry that isn't a scored resource", () => {
    const r = refusalOf({ resources: [{ address: "aws_vpc.main", score: 1, band: "clean leaf" }, { address: "x" }] })!;
    expect(r.error).toContain("entry 1");
  });

  it("accepts an absent version (every chant to date) and a known major", () => {
    expect(parseCarveReport({ resources: [] }).ok).toBe(true);
    expect(parseCarveReport({ version: 1, resources: [] }).ok).toBe(true);
    expect(parseCarveReport({ version: "1.2.0", resources: [] }).ok).toBe(true);
  });

  it("refuses a schema major it doesn't speak, instead of half-reading it", () => {
    const r = refusalOf({ version: 2, resources: [] })!;
    expect(r.error).toContain("version 2");
    expect(r.remedy).toContain("Upgrade behold");
  });

  it("blames the shape, not the version, for JSON that was never a report", () => {
    // A package.json carries a `version` and nothing else this lens wants;
    // "behold reads version 1" would be a baffling thing to say about it.
    const r = refusalOf({ name: "@intentius/behold", version: "0.8.0" })!;
    expect(r.error).toContain("no `resources` array");
    expect(r.error).not.toContain("schema version");
  });

  it("refuses an unreadable path and a non-JSON file by the same route", () => {
    const missing = readCarveReport("/no/such/report.json", () => {
      throw new Error("ENOENT: no such file or directory");
    });
    expect(missing.ok).toBe(false);
    expect(missing.ok ? "" : missing.refusal.error).toContain("ENOENT");

    const notJson = readCarveReport("/x.json", () => "resource \"aws_s3_bucket\" \"assets\" {}");
    expect(notJson.ok).toBe(false);
    expect(notJson.ok ? "" : notJson.refusal.error).toContain("isn't valid JSON");
  });
});

describe("the small pure helpers", () => {
  it("maps chant's band names, and falls back to the documented score thresholds", () => {
    expect(statusForBand("clean leaf", 88)).toBe("good");
    expect(statusForBand("carvable w/ edits", 64)).toBe("warn");
    expect(statusForBand("leave in Terraform", 0)).toBe("neutral");
    // A band chant renames or adds still colours honestly.
    expect(statusForBand("brand new band", 90)).toBe("good");
    expect(statusForBand("brand new band", 60)).toBe("warn");
    expect(statusForBand("brand new band", 10)).toBe("neutral");
  });

  it("reads the Terraform type out of an address", () => {
    expect(tfTypeOf("aws_s3_bucket.assets")).toBe("aws_s3_bucket");
    expect(tfTypeOf("module.cdn")).toBe("module");
    expect(tfTypeOf("module.cdn", "module")).toBe("module");
    expect(tfTypeOf("weird")).toBe("weird");
  });

  it("says when the score was clamped rather than printing arithmetic that doesn't add up", () => {
    const clamped = scoreArithmetic({
      address: "aws_vpc.busy",
      score: 0,
      band: "leave in Terraform",
      breakdown: { inbound: 10, outbound: 0, tier: 1, instances: 1, penalties: { inbound: -120 } },
    });
    expect(clamped).toBe("100 - 12x10 inbound = 0 (clamped from -20)");
  });

  it("pins the card to score + verdict, whatever the attrs' alphabetical order", () => {
    const ir = carveReportToIr(report);
    const bucket = ir.nodes.find((n) => n.id === "aws_s3_bucket.assets")!;
    expect(carveCardFields(bucket)).toEqual([
      { label: "score", value: "88" },
      { label: "carve", value: "carve now" },
    ]);
    // A node that isn't a carve node falls through to pinhole's default.
    expect(carveCardFields({ attrs: { name: "x" } })).toBeUndefined();
  });
});
