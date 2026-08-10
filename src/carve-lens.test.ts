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
 * (copied to a scratch dir so nothing in the chant checkout was touched). It is
 * the contract as chant emits it today — no `version` field, and per-resource
 * boundary COUNTS with no edge lists. Both facts are asserted below, so this
 * test tells us the day chant#1636 changes either one.
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

  it("carries no schema version yet (chant#1636) — which the lens accepts", () => {
    expect(report.version).toBeUndefined();
    expect(parseCarveReport(report).ok).toBe(true);
  });

  it("carries boundary COUNTS but no boundary edge LISTS — the gap chant#1636 closes", () => {
    for (const r of report.resources) {
      expect(typeof r.breakdown?.inbound).toBe("number");
      expect(typeof r.breakdown?.outbound).toBe("number");
      expect(r.boundary).toBeUndefined();
    }
    // The counts are real work: 4 inbound and 4 outbound across the estate.
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

  it("draws no boundary edges from a report that carries none — no phantom pairings", () => {
    // The counts alone cannot be paired into edges (4 inbound and 4 outbound
    // admit several matchings), and inventing one would be a lie about which
    // survivors need patching. Nothing drawn is the honest answer until
    // chant#1636 publishes the lists.
    expect(ir.edges).toEqual([]);
  });

  it("says so on the note, rather than leaving an edgeless graph unexplained", () => {
    const note = carveNote(report, ir);
    expect(note).toContain("6 clean leaf");
    expect(note).toContain("sample-estate");
    expect(note).toContain("chant#1636");
  });
});

describe("carveReportToIr — boundary edges, once chant publishes them (#1636)", () => {
  // chant's own `BoundaryEdge` shape (packages/core/src/terraform/carve.ts),
  // attached per resource. This is the forward half of the contract: the lens
  // must already draw it, so the day chant emits the lists behold needs no
  // change to light them up.
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
