import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import {
  CARD_BLOCKS,
  NEVER_CARDS,
  cardBlocksAt,
  filterTerraformCards,
  groupTerraformByRoot,
  hasTerraformEntities,
  isTerraformEntity,
  normalizeTerraformNodes,
  terraformCardFields,
  terraformElisionNote,
} from "./terraform-lens.ts";
import { projectTerraformLogical, rootBoxTitle } from "./logical-terraform.ts";

// Fixture provenance (#379, #380, #382). Both are real `chant graph --format ir`
// output from `@intentius/chant-lexicon-terraform` 0.59.0, which reads an
// estate's own HCL and emits one entity per block. Nothing hand-edited.
//
//  - terraform-ir-legacy-tf.json: behold's own bundled `example-carve/legacy-tf`
//    as one root named `app`, at chant's default detail. 29 nodes covering all
//    seven entity kinds — 14 resources, 5 outputs, 4 variables, 3 data sources,
//    a module, a provider and a terraform block. No `body` at this detail.
//  - terraform-ir-two-roots.json: water park's `access/baseline` and its
//    `waterpark-runner` satellite as two roots, at `--detail 3` (which is where
//    chant starts carrying the parsed `body`). 30 nodes, and the pair carries
//    the cross-root read #381 measured: the satellite's data source reads a
//    policy the baseline root declares, by name, through an interpolation.
//
// Both have ZERO edges, which is the estate's true state today: chant emits none
// for terraform entities (chant#2265).
const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name: string): GraphIR => JSON.parse(readFileSync(join(HERE, "__fixtures__", name), "utf8")) as GraphIR;
const legacy = (): GraphIR => load("terraform-ir-legacy-tf.json");
const twoRoots = (): GraphIR => load("terraform-ir-two-roots.json");
const byId = (ir: GraphIR, id: string) => ir.nodes.find((n) => n.id === id)!;

describe("what arrives (#378)", () => {
  it("is one kind per block class, no edges, and one box for the whole lexicon", () => {
    const ir = legacy();
    expect(ir.edges).toEqual([]);
    expect(new Set(ir.nodes.map((n) => n.kind))).toEqual(
      new Set(["Terraform::Resource", "Terraform::Data", "Terraform::Module", "Terraform::Output", "Terraform::Variable", "Terraform::Provider", "Terraform::Terraform"]),
    );
    expect(Object.keys(ir.groups.byStack ?? {})).toEqual(["terraform"]);
    expect(hasTerraformEntities(ir)).toBe(true);
    expect(isTerraformEntity({ kind: "AWS::S3::Bucket", lexicon: "aws" })).toBe(false);
    // A carve node shares the lexicon and is not one of these.
    expect(isTerraformEntity({ kind: "aws_s3_bucket", lexicon: "terraform" })).toBe(false);
  });
});

describe("normalizeTerraformNodes — the type becomes the kind (#379)", () => {
  it("titles a card by its resource type and keeps the block class", () => {
    const ir = normalizeTerraformNodes(legacy());
    const bucket = ir.nodes.find((n) => n.id.endsWith("aws_s3_bucket.assets"))!;
    expect(bucket.kind).toBe("aws_s3_bucket");
    expect(bucket.attrs.block).toBe("resource");
    expect(bucket.attrs.address).toBe("aws_s3_bucket.assets");
    // Every entity kind is gone; nothing still says Terraform::*.
    expect(ir.nodes.filter((n) => n.kind.startsWith("Terraform::"))).toEqual([]);
  });

  it("names a data source by the type it reads, a module `module`, and the rest by their block", () => {
    const ir = normalizeTerraformNodes(twoRoots());
    expect(byId(ir, "runner/data.aws_iam_policy.boundary").kind).toBe("aws_iam_policy");
    expect(byId(ir, "runner/data.aws_iam_policy.boundary").attrs.block).toBe("data");
    expect(byId(ir, "runner/module.runner_builder").kind).toBe("module");
    const variable = ir.nodes.find((n) => n.attrs.block === "variable")!;
    expect(variable.kind).toBe("variable");
  });

  it("says what a data source reads, with the interpolation left unresolved (#381)", () => {
    const ir = normalizeTerraformNodes(twoRoots());
    // #381 measured this pair and refused to infer an edge from it: both ends
    // carry the same unresolved interpolation. It is a row instead.
    expect(byId(ir, "runner/data.aws_iam_policy.boundary").attrs.reads).toBe("name ${var.boundary_name}");
    expect(ir.edges).toEqual([]);
  });

  it("is idempotent, and leaves an entity kind it does not know exactly as it arrived", () => {
    const once = normalizeTerraformNodes(twoRoots());
    const twice = normalizeTerraformNodes(JSON.parse(JSON.stringify(once)) as GraphIR);
    expect(twice.nodes.map((n) => [n.id, n.kind])).toEqual(once.nodes.map((n) => [n.id, n.kind]));
    const future: GraphIR = { nodes: [{ id: "r/x", kind: "Terraform::Check", lexicon: "terraform", attrs: { address: "check.x" } }], edges: [], groups: {} };
    expect(normalizeTerraformNodes(future).nodes[0]).toEqual({ id: "r/x", kind: "Terraform::Check", lexicon: "terraform", attrs: { address: "check.x" } });
  });

  it("leaves a non-terraform estate byte-identical", () => {
    const ir: GraphIR = { nodes: [{ id: "web", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} }], edges: [], groups: { byStack: { app: ["web"] } } };
    const before = JSON.stringify(ir);
    expect(hasTerraformEntities(ir)).toBe(false);
    normalizeTerraformNodes(ir);
    groupTerraformByRoot(ir);
    expect(JSON.stringify(ir)).toBe(before);
  });
});

describe("groupTerraformByRoot — the roots are the boxes (#380)", () => {
  it("replaces the one lexicon-wide bucket with one box per root", () => {
    const ir = groupTerraformByRoot(normalizeTerraformNodes(twoRoots()));
    const boxes = ir.groups.byStack as Record<string, string[]>;
    expect(Object.keys(boxes).sort()).toEqual(["baseline", "runner"]);
    expect(boxes.terraform).toBeUndefined();
    expect(boxes.baseline.every((id) => id.startsWith("baseline/"))).toBe(true);
    expect(boxes.baseline.length + boxes.runner.length).toBe(ir.nodes.length);
  });

  it("falls back to the id prefix when attrs.root is absent", () => {
    const ir: GraphIR = {
      nodes: [{ id: "prod/aws_vpc.main", kind: "Terraform::Resource", lexicon: "terraform", attrs: { address: "aws_vpc.main" } }],
      edges: [],
      groups: { byStack: { terraform: ["prod/aws_vpc.main"] } },
    };
    expect((groupTerraformByRoot(ir).groups.byStack as Record<string, string[]>).prod).toEqual(["prod/aws_vpc.main"]);
  });

  it("leaves an IR alone once something upstream groups by root — chant#2266 retires this pass", () => {
    const ir = groupTerraformByRoot(normalizeTerraformNodes(twoRoots()));
    const after = JSON.stringify(ir.groups);
    groupTerraformByRoot(ir);
    expect(JSON.stringify(ir.groups)).toBe(after);
  });
});

describe("filterTerraformCards — what is a card (#382)", () => {
  it("the estate by default: resources, data sources and modules", () => {
    expect(CARD_BLOCKS.estate).toEqual(["resource", "data", "module"]);
    expect(CARD_BLOCKS.interface).toEqual(["output", "variable"]);
    expect(NEVER_CARDS).toEqual(["terraform", "provider", "locals"]);
    expect([...cardBlocksAt(undefined)].sort()).toEqual(["data", "module", "resource"]);
    expect([...cardBlocksAt(2)].sort()).toEqual(["data", "module", "resource"]);
    expect([...cardBlocksAt(3)].sort()).toEqual(["data", "module", "output", "resource", "variable"]);
  });

  it("drops four fifths of a real estate at the default detail, and says what went", () => {
    const ir = groupTerraformByRoot(normalizeTerraformNodes(twoRoots()));
    const before = ir.nodes.length;
    const elision = filterTerraformCards(ir, 2);
    expect(before).toBe(30);
    expect(ir.nodes).toHaveLength(4);
    expect(elision.total).toBe(26);
    expect(elision.dropped).toEqual({ variable: 11, output: 9, terraform: 3, locals: 2, provider: 1 });
    expect(terraformElisionNote(elision, 2)).toBe(
      "showing the estate — 11 variables, 9 outputs, 3 terraform blocks, 2 locals blocks, 1 provider not drawn (outputs and variables appear at detail 3 — ⌘K → attributes)",
    );
  });

  it("keeps the interface at detail 3, and never the settings", () => {
    const ir = groupTerraformByRoot(normalizeTerraformNodes(twoRoots()));
    const elision = filterTerraformCards(ir, 3);
    expect(ir.nodes).toHaveLength(24);
    expect(elision.dropped).toEqual({ terraform: 3, locals: 2, provider: 1 });
    expect(new Set(ir.nodes.map((n) => n.attrs.block))).toEqual(new Set(["resource", "data", "module", "output", "variable"]));
    // No "appears at detail 3" hint when it already is detail 3.
    expect(terraformElisionNote(elision, 3)).toBe("showing the estate — 3 terraform blocks, 2 locals blocks, 1 provider not drawn");
  });

  it("empties a box rather than leaving it holding ids that are gone, and drops an edge that lost an end", () => {
    const ir = groupTerraformByRoot(normalizeTerraformNodes(twoRoots()));
    ir.edges.push({ from: "runner/aws_ecr_repository.waterpark_runner", to: "runner/var.boundary_name", kind: "ref" });
    filterTerraformCards(ir, 2);
    const boxes = ir.groups.byStack as Record<string, string[]>;
    const ids = new Set(ir.nodes.map((n) => n.id));
    for (const [box, members] of Object.entries(boxes)) {
      expect(members.length, box).toBeGreaterThan(0);
      for (const id of members) expect(ids.has(id), `${box} holds ${id}`).toBe(true);
    }
    expect(ir.edges).toEqual([]);
  });

  it("says nothing when nothing was dropped", () => {
    expect(terraformElisionNote({ dropped: {}, total: 0 }, 2)).toBeUndefined();
    expect(terraformElisionNote({ dropped: { module: 1 }, total: 1 }, 3)).toBe("showing the estate — 1 module not drawn");
  });
});

describe("terraformCardFields — the pack (#379)", () => {
  it("leads with what a data source reads, then its root", () => {
    expect(terraformCardFields({ attrs: { block: "data", reads: "name ${var.boundary_name}", root: "runner" } })).toEqual([
      { label: "reads", value: "name ${var.boundary_name}" },
      { label: "root", value: "runner" },
    ]);
    expect(terraformCardFields({ attrs: { block: "resource", root: "baseline" } })).toEqual([{ label: "root", value: "baseline" }]);
    expect(terraformCardFields({ attrs: { block: "resource" } })).toEqual([{ label: "block", value: "resource" }]);
  });

  it("declines a carve node and a non-terraform node, so one pack serves both producers", () => {
    expect(terraformCardFields({ attrs: { score: 100, band: "clean leaf", block: "resource" } })).toBeUndefined();
    expect(terraformCardFields({ attrs: { replicas: 2 } })).toBeUndefined();
  });
});

describe("projectTerraformLogical — one box per root (#380)", () => {
  it("boxes the cards by root and carries only the edges the graph states", () => {
    const ir = filterAndProject();
    expect(Object.keys(ir.byContainer).sort()).toEqual([rootBoxTitle("baseline"), rootBoxTitle("runner")]);
    expect(ir.byContainer[rootBoxTitle("baseline")]).toEqual(["baseline/aws_iam_policy.boundary"]);
    expect(ir.ir.edges).toEqual([]);
  });

  it("ignores every other lexicon, so a mixed estate merges unchanged", () => {
    const mixed = filterAndProjectWith({ id: "web", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} });
    expect(mixed.ir.nodes.map((n) => n.id)).not.toContain("web");
    expect(projectTerraformLogical({ nodes: [], edges: [], groups: {} })).toEqual({ ir: { nodes: [], edges: [], groups: {} }, byContainer: {} });
  });

  function filterAndProject() {
    const ir = groupTerraformByRoot(normalizeTerraformNodes(twoRoots()));
    filterTerraformCards(ir, 2);
    return projectTerraformLogical(ir);
  }
  function filterAndProjectWith(extra: GraphIR["nodes"][number]) {
    const ir = groupTerraformByRoot(normalizeTerraformNodes(twoRoots()));
    filterTerraformCards(ir, 2);
    ir.nodes.push(extra);
    return projectTerraformLogical(ir);
  }
});
