import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphIR, IREdge } from "@intentius/chant";
import { liveCheckToIr, parseLiveCheck, type LiveCheckDocument } from "./choudoufu-member.ts";
import {
  addIntraEstateEdges,
  choudoufuLexiconNote,
  decomposeAddress,
  indexRoster,
  joinLexiconEdges,
  lexiconPath,
  lexiconStamp,
} from "./choudoufu-refs.ts";
import type { TerraformReaderState } from "./terraform-member.ts";

// ---------------------------------------------------------------------------
// PROVENANCE. Both documents were recorded on the `terralith-4` workbench entry
// (AGENTS.md, "The workbench catalog") on 2026-09-09 — choudoufu v0.16.0,
// @intentius/chant-lexicon-terraform 0.61.0, @cdktf/hcl2json 0.21.0, over the
// estate `tools/terralith-gen` renders at scale 4:
//
//  - choudoufu-lexicon-terralith.json — `chant graph --format ir` through the
//    generated reader config (src/terraform-member.ts's scratch project) with
//    the estate directory as the single root `estate`. The full read is 186
//    nodes and 175 edges; this keeps the 20 nodes that make every rule in
//    src/choudoufu-refs.ts's header visible, and the 20 edges among them.
//    `attrs.source` is dropped from each node — the lexicon carries the whole
//    FILE a block came from, ~60KB of HCL per node here, and the join reads
//    none of it.
//  - choudoufu-live-check-terralith.json — `choudoufu live-check -json .` in
//    the same directory, cut to the instances of those same blocks. The estate
//    declares 301; this keeps 67. `aws_route53_record.record` really has 40
//    instances and is cut to 4, which is what makes it the case where two ends
//    expand over key sets that do not correspond. `references` is emptied: the
//    real document's is already empty (a terralith reads no other estate), and
//    that emptiness is the whole reason this feature exists.
//
// What each half is here to show, block by block:
//
//   team_0000_*          five 1:1 references, nothing expanded
//   count_team*          two blocks over `count = 8`, joined key to key
//   record → zone        4 keys against 1, so the scope's full product
//   module.team_pod/*    two module INSTANCES of two `count`-expanded blocks
//   module.team_pod      the module CALL, whose only edges go to `locals~2`
//   var.* / locals*      the ends the roster declares no card for
// ---------------------------------------------------------------------------
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8")) as T;
const lexicon = (): GraphIR => fixture<GraphIR>("choudoufu-lexicon-terralith.json");
const roster = (): LiveCheckDocument => {
  const parsed = parseLiveCheck(fixture("choudoufu-live-check-terralith.json"));
  if (!parsed.ok) throw new Error(parsed.refusal.error);
  return parsed.doc;
};
const join2 = (): IREdge[] => joinLexiconEdges(lexicon().edges, indexRoster(roster().instances.map((i) => i.address)));
const between = (edges: readonly IREdge[], from: string, to: string): IREdge | undefined => edges.find((e) => e.from === from && e.to === to);

describe("decomposeAddress — a roster address as the lexicon addresses it (#393)", () => {
  it("splits a module-nested, count-expanded address into path, scope and key", () => {
    expect(decomposeAddress('module.team_pod["pod-a"].aws_iam_role.pod_role[0]')).toEqual({
      address: 'module.team_pod["pod-a"].aws_iam_role.pod_role[0]',
      blockPath: "module.team_pod/aws_iam_role.pod_role",
      scope: 'module.team_pod["pod-a"]',
      key: "[0]",
    });
  });

  it("leaves a root-module address in the root scope with no key", () => {
    expect(decomposeAddress("aws_ecs_cluster.main")).toMatchObject({ blockPath: "aws_ecs_cluster.main", scope: "", key: "" });
  });

  it("keeps a for_each key verbatim, quotes and all", () => {
    expect(decomposeAddress('aws_route53_record.record["host-0007"]')).toMatchObject({ blockPath: "aws_route53_record.record", key: '["host-0007"]' });
  });

  it("nests: only the outermost call keys the scope's first segment, and both are in the path", () => {
    expect(decomposeAddress('module.a["x"].module.b[0].aws_s3_bucket.c')).toMatchObject({
      blockPath: "module.a/module.b/aws_s3_bucket.c",
      scope: 'module.a["x"].module.b[0]',
      key: "",
    });
  });

  it("reads a data source as its own block", () => {
    expect(decomposeAddress("data.aws_vpc.network")).toMatchObject({ blockPath: "data.aws_vpc.network", scope: "" });
  });
});

describe("lexiconPath — the root prefix off a lexicon id", () => {
  it("strips the single root this reader names", () => {
    expect(lexiconPath("estate/module.team_pod/aws_iam_role.pod_role")).toBe("module.team_pod/aws_iam_role.pod_role");
  });
  it("leaves an id under no root alone, so it matches nothing", () => {
    expect(lexiconPath("aws_iam_role.x")).toBe("aws_iam_role.x");
  });
});

describe("joinLexiconEdges — the lexicon's blocks joined to the roster's instances (#393)", () => {
  it("joins the recorded terralith documents to 49 edges over 67 cards", () => {
    const edges = join2();
    expect(edges).toHaveLength(49);
    // Every end is a card the roster really declares — the whole point of the
    // join, and the assertion that catches a mapping that invented an address.
    const declared = new Set(roster().instances.map((i) => i.address));
    for (const e of edges) expect(declared.has(e.from) && declared.has(e.to), `${e.from} -> ${e.to}`).toBe(true);
  });

  it("carries the attribute the lexicon named, and is flagged inferred", () => {
    const e = between(join2(), "aws_iam_instance_profile.team_0000_profile", "aws_iam_role.team_0000_role")!;
    expect(e).toMatchObject({ kind: "ref", viaAttr: "role", inferred: true });
  });

  it("draws an unexpanded reference once", () => {
    const team0000 = join2().filter((e) => e.from.includes("team_0000") || e.to.includes("team_0000"));
    expect(team0000).toHaveLength(5);
  });

  it("joins two count-expanded blocks key to key — 8 edges, not the 64 of the full product", () => {
    const attach = join2().filter((e) => e.from.startsWith("aws_iam_role_policy_attachment.count_team_custom_attach") && e.to.startsWith("aws_iam_role.count_team"));
    expect(attach).toHaveLength(8);
    for (let i = 0; i < 8; i++) {
      expect(between(attach, `aws_iam_role_policy_attachment.count_team_custom_attach[${i}]`, `aws_iam_role.count_team[${i}]`)).toBeDefined();
    }
  });

  it("falls back to the scope's full product when the two key sets do not correspond", () => {
    // 4 recorded `for_each` records against one zone: there is no key on the
    // zone to match, so every record reads it.
    const dns = join2().filter((e) => e.to === "aws_route53_zone.main");
    expect(dns).toHaveLength(4);
    expect(dns.every((e) => e.from.startsWith("aws_route53_record.record["))).toBe(true);
  });

  it("keeps a module instance's references inside that instance", () => {
    const edges = join2();
    const pods = edges.filter((e) => e.from.startsWith("module."));
    expect(pods).toHaveLength(16); // two calls x two blocks referenced x four count instances
    for (const e of pods) {
      const scope = (a: string): string => a.slice(0, a.indexOf("]") + 1);
      expect(scope(e.from), `${e.from} -> ${e.to}`).toBe(scope(e.to));
    }
    expect(between(edges, 'module.team_pod["pod-a"].aws_iam_role_policy_attachment.pod_custom_attach[1]', 'module.team_pod["pod-a"].aws_iam_role.pod_role[1]')).toBeDefined();
    expect(between(edges, 'module.team_pod["pod-a"].aws_iam_role_policy_attachment.pod_custom_attach[1]', 'module.team_pod["pod-b"].aws_iam_role.pod_role[1]')).toBeUndefined();
  });

  it("drops an end the roster declares no card for — variables, locals, the module call itself", () => {
    const edges = join2();
    for (const e of edges) {
      expect(e.from.includes("var.") || e.to.includes("var."), `${e.from} -> ${e.to}`).toBe(false);
      expect(e.from.includes("locals") || e.to.includes("locals"), `${e.from} -> ${e.to}`).toBe(false);
    }
    // Eight of the recorded twenty lexicon edges end on one of those.
    expect(lexicon().edges.filter((e) => /var\.|locals/.test(`${e.from}${e.to}`))).toHaveLength(8);
  });

  it("collapses two attributes between the same pair to one edge, keeping the first", () => {
    // The recorded lexicon states `record -> zone` twice, through `name` and
    // through `zone_id`. One card pair is one edge on the canvas.
    expect(lexicon().edges.filter((e) => e.from.endsWith("record") && e.to.endsWith("zone.main"))).toHaveLength(2);
    expect(join2().filter((e) => e.from.startsWith("aws_route53_record") && e.to === "aws_route53_zone.main").map((e) => e.viaAttr)).toEqual(["name", "name", "name", "name"]);
  });

  it("maps an edge that ENDS on a module call onto every roster address inside it", () => {
    // Synthetic, because lexicon 0.61 descends into called modules and this
    // estate's only module-call edges go to `locals~2`. It is the shape a root
    // block reading `module.team_pod[…].some_output` produces, and the rule has
    // to exist before the reader that emits one does.
    const index = indexRoster(roster().instances.map((i) => i.address));
    const edges = joinLexiconEdges([{ from: "estate/aws_iam_role.team_0000_role", to: "estate/module.team_pod", kind: "ref", viaAttr: "assume_role_policy" }], index);
    const inside = roster().instances.filter((i) => i.address.startsWith("module.team_pod")).length;
    expect(edges).toHaveLength(inside);
    expect(edges.every((e) => e.from === "aws_iam_role.team_0000_role" && e.to.startsWith("module.team_pod"))).toBe(true);
  });

  it("never draws a card to itself", () => {
    const index = indexRoster(["aws_iam_role.solo"]);
    expect(joinLexiconEdges([{ from: "estate/aws_iam_role.solo", to: "estate/aws_iam_role.solo", kind: "ref", viaAttr: "name" }], index)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

const present: TerraformReaderState = {
  lexicon: { pkg: "@intentius/chant-lexicon-terraform", range: "^0.61.0", version: "0.61.0" },
  parser: { pkg: "@cdktf/hcl2json", range: "^0.21.0", version: "0.21.0" },
  from: "/behold/src",
};
const absent: TerraformReaderState = {
  lexicon: { pkg: "@intentius/chant-lexicon-terraform", range: "^0.61.0" },
  parser: { pkg: "@cdktf/hcl2json", range: "^0.21.0" },
  from: "/behold/src",
  refusal: {
    error: "Reading a Terraform estate needs chant's terraform lexicon, which behold does not install: … are not resolvable from /behold/src.",
    code: "terraform-lexicon",
    remedy: "Install @intentius/chant-lexicon-terraform@^0.61.0 @cdktf/hcl2json@^0.21.0 beside behold, then reload.",
  },
};

describe("addIntraEstateEdges — the member's read (#393)", () => {
  it("adds the join to the roster's own IR, on the member's own ids", async () => {
    const ir = liveCheckToIr(roster());
    expect(ir.edges).toHaveLength(0);
    const out = await addIntraEstateEdges(ir, "/estate", present, async () => lexicon());
    expect(out).toBe(ir);
    expect(out.edges).toHaveLength(49);
    const ids = new Set(out.nodes.map((n) => n.id));
    for (const e of out.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });

  it("adds nothing at all when the lexicon is not resolvable — and never reads", async () => {
    const ir = liveCheckToIr(roster());
    let read = 0;
    const out = await addIntraEstateEdges(ir, "/estate", absent, async () => {
      read++;
      return lexicon();
    });
    expect(read).toBe(0);
    expect(out.edges).toHaveLength(0);
  });

  it("keeps the roster when the reader throws — an unparseable estate is not a reason to lose the cards", async () => {
    const ir = liveCheckToIr(roster());
    const out = await addIntraEstateEdges(ir, "/estate", present, async () => {
      throw new Error("hcl2json: unexpected token");
    });
    expect(out.nodes).toHaveLength(67);
    expect(out.edges).toHaveLength(0);
  });

  it("does not duplicate an edge the member already stated", async () => {
    const ir = liveCheckToIr(roster());
    ir.edges.push({ from: "aws_iam_instance_profile.team_0000_profile", to: "aws_iam_role.team_0000_role", kind: "ref", viaAttr: "reads" });
    const out = await addIntraEstateEdges(ir, "/estate", present, async () => lexicon());
    expect(out.edges.filter((e) => e.from === "aws_iam_instance_profile.team_0000_profile" && e.to === "aws_iam_role.team_0000_role")).toHaveLength(1);
    expect(out.edges).toHaveLength(49);
  });
});

describe("the absent-lexicon note and the cache stamp (#393)", () => {
  it("says what is missing and carries the terraform kind's own install line", () => {
    const note = choudoufuLexiconNote(absent)!;
    expect(note).toContain("no edges");
    expect(note).toContain("chant's terraform lexicon beside behold");
    expect(note).toContain(absent.refusal!.remedy);
    // …and never the sentence it replaces.
    expect(note).not.toContain("nothing in this estate references anything else");
  });

  it("is silent when the lexicon is there — an estate with edges needs no caption", () => {
    expect(choudoufuLexiconNote(present)).toBeUndefined();
  });

  it("stamps the two peers, so installing them is a different cache key", () => {
    expect(lexiconStamp(present)).not.toBe(lexiconStamp(absent));
    expect(lexiconStamp(absent)).toContain("absent");
    expect(lexiconStamp(present)).toContain("0.61.0");
  });
});
