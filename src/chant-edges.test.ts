import { describe, it, expect, vi } from "vitest";
import type { GraphIR, IREdge, IRNode } from "@intentius/chant";
import {
  addChantEdges,
  chantEdgePasses,
  deriveGraphEdges,
  deriveGraphEdgesWithSource,
  graphCarriesChantEdges,
  type ChantEdgePasses,
  type DerivedEdge,
  type EdgeLexicon,
} from "./chant-edges.ts";

// behold#1030: the inferred edges of a declared graph come from chant
// (chant#4522's catalog pass, #4523's identity pass) when chant can draw them,
// and from src/value-match.ts while it cannot. Both paths are pinned here.

const GROUP_NAME = "loom-local-a-loom-db-subnet-group";

const rds = (): GraphIR =>
  ({
    nodes: [
      { id: "db", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: { DBSubnetGroupName: GROUP_NAME, Engine: "postgres" } },
      { id: "group", kind: "AWS::RDS::DBSubnetGroup", lexicon: "aws", attrs: { DBSubnetGroupName: GROUP_NAME } },
    ],
    edges: [],
    groups: {},
  }) as unknown as GraphIR;

/** The aws catalog's two rows this graph needs (lexicons/aws/src/reference-catalog.ts). */
const AWS_CATALOG = {
  identities: [{ kind: "AWS::RDS::DBSubnetGroup", ids: ["DBSubnetGroupName"] }],
  refs: [{ from: "AWS::RDS::DBInstance", path: "DBSubnetGroupName", indexedTargetKind: "AWS::RDS::DBSubnetGroup", relation: "reference", label: "subnets" }],
};
const awsLexicon: EdgeLexicon = { name: "aws", referenceCatalog: AWS_CATALOG };

const derived = (from: string, to: string, rule = `aws:AWS::RDS::DBInstance:DBSubnetGroupName`): DerivedEdge =>
  ({ from, to, kind: "ref", viaAttr: "DBSubnetGroupName", grain: "property", origin: "derived", rule, relation: "reference" }) as DerivedEdge;

/** Passes that answer what they are told to, and record how they were called. */
function fakePasses(catalogEdges: DerivedEdge[], identityEdges: DerivedEdge[] = []) {
  const passes = {
    reconstructIndexedEdges: vi.fn(() => ({ edges: catalogEdges })),
    reconstructIdentityEdges: vi.fn(() => ({ edges: identityEdges })),
  };
  return passes as typeof passes & ChantEdgePasses;
}

const matcherEdge = { from: "db", to: "group", kind: "ref", viaAttr: "DBSubnetGroupName", inferred: true };

describe("deriveGraphEdges: value-match fallback (chant has no passes)", () => {
  it("runs today's matcher when the chant beside behold has no reconstructIndexedEdges", async () => {
    const { ir, source } = await deriveGraphEdgesWithSource(rds(), { passes: async () => undefined });
    expect(source.source).toBe("value-match");
    expect(ir.edges).toEqual([matcherEdge]);
  });

  it("runs today's matcher when a lexicon of the graph has no catalog beside behold, and runs no chant pass", async () => {
    const passes = fakePasses([derived("db", "group")]);
    const ir = rds();
    (ir.nodes as IRNode[]).push({ id: "deploy", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} } as unknown as IRNode);
    const { source } = await deriveGraphEdgesWithSource(ir, {
      passes: async () => passes,
      lexicon: async (name) => (name === "aws" ? awsLexicon : undefined),
    });
    expect(source).toEqual({ source: "value-match", reason: expect.stringContaining("k8s") });
    expect(passes.reconstructIndexedEdges).not.toHaveBeenCalled();
    expect(ir.edges).toEqual([matcherEdge]);
  });

  it("treats a plugin with no referenceCatalog as no catalog", async () => {
    const passes = fakePasses([]);
    const { source, ir } = await deriveGraphEdgesWithSource(rds(), { passes: async () => passes, lexicon: async () => ({ name: "aws" }) });
    expect(source.source).toBe("value-match");
    expect(ir.edges).toEqual([matcherEdge]);
  });

  it("keeps addValueMatchEdges' contract: mutates and returns the same graph", async () => {
    const ir = rds();
    expect(await deriveGraphEdges(ir, { passes: async () => undefined })).toBe(ir);
  });
});

describe("deriveGraphEdges: chant's edges", () => {
  it("leaves a graph that already carries chant's derived edges alone", async () => {
    const ir = rds();
    ir.edges.push(derived("db", "group") as IREdge);
    const passes = fakePasses([]);
    const { source } = await deriveGraphEdgesWithSource(ir, { passes: async () => passes, lexicon: async () => awsLexicon });
    expect(source).toEqual({ source: "graph", edges: 1 });
    expect(passes.reconstructIndexedEdges).not.toHaveBeenCalled();
    expect(ir.edges).toHaveLength(1);
    expect(ir.edges.some((e) => (e as { inferred?: boolean }).inferred)).toBe(false);
  });

  it("draws chant's edges in place of the matcher's when every lexicon has a catalog", async () => {
    const passes = fakePasses([derived("db", "group")]);
    const { ir, source } = await deriveGraphEdgesWithSource(rds(), { passes: async () => passes, lexicon: async () => awsLexicon });
    expect(source).toEqual({ source: "chant", edges: 1, lexicons: ["aws"] });
    expect(ir.edges).toEqual([derived("db", "group")]);
    expect(graphCarriesChantEdges(ir)).toBe(true);
  });

  it("draws nothing chant did not draw: an empty chant answer is not filled in by the matcher", async () => {
    const passes = fakePasses([]);
    const { ir, source } = await deriveGraphEdgesWithSource(rds(), { passes: async () => passes, lexicon: async () => awsLexicon });
    expect(source).toEqual({ source: "chant", edges: 0, lexicons: ["aws"] });
    expect(ir.edges).toEqual([]);
  });

  it("runs both passes over one declared scope, the identity pass after the catalog pass", () => {
    const catalogEdge = derived("db", "group");
    const identityEdge = derived("db", "other", "identity-match:aws:AWS::S3::Bucket:native-id");
    const passes = fakePasses([catalogEdge], [identityEdge]);
    const nodeIdentities = (n: IRNode) => [{ kind: "native-id", value: n.id }];
    const ir = rds();
    const added = addChantEdges(ir, passes, [{ ...awsLexicon, indexIdentity: { nodeIdentities } }]);
    expect(added).toBe(2);

    const [nodes, catalogs, scopeOf] = passes.reconstructIndexedEdges.mock.calls[0] as unknown as [IRNode[], unknown[], (n: IRNode) => unknown];
    expect(nodes).toBe(ir.nodes);
    expect(catalogs).toEqual([{ lexicon: "aws", catalog: AWS_CATALOG }]);
    expect(scopeOf(ir.nodes[0])).toEqual({ account: "declared" });
    expect(scopeOf(ir.nodes[1])).toEqual(scopeOf(ir.nodes[0]));

    const [, owners, , existing] = passes.reconstructIdentityEdges.mock.calls[0] as unknown as [IRNode[], Array<{ lexicon: string; identities?: (n: IRNode) => unknown }>, unknown, DerivedEdge[]];
    expect(owners.map((o) => o.lexicon)).toEqual(["aws"]);
    expect(owners[0].identities?.(ir.nodes[0])).toEqual([{ kind: "native-id", value: "db" }]);
    expect(existing).toEqual([catalogEdge]);
  });

  it("skips the identity pass when no lexicon declares an indexIdentity", () => {
    const passes = fakePasses([]);
    addChantEdges(rds(), passes, [awsLexicon]);
    expect(passes.reconstructIdentityEdges).not.toHaveBeenCalled();
  });

  it("does not draw a second edge between a pair the graph already joins", () => {
    const ir = rds();
    ir.edges.push({ from: "db", to: "group", kind: "ref", viaAttr: "DBSubnetGroupName" });
    const added = addChantEdges(ir, fakePasses([derived("db", "group")]), [awsLexicon]);
    expect(added).toBe(0);
    expect(ir.edges).toHaveLength(1);
  });
});

// With a local build of chant's integration branch beside behold the real
// passes are found, and these run them. Against the published chant (no
// reconstructIndexedEdges) they are skipped and the fallback tests above are
// the ones that speak.
const real = await chantEdgePasses();

describe.skipIf(!real)("deriveGraphEdges over chant's own passes (local chant build)", () => {
  const withRealPasses = { passes: async () => real, lexicon: async () => awsLexicon };

  it("draws the RDS instance to its subnet group with the catalog rule that matched", async () => {
    const { ir, source } = await deriveGraphEdgesWithSource(rds(), withRealPasses);
    expect(source.source).toBe("chant");
    expect(ir.edges).toEqual([
      expect.objectContaining({ from: "db", to: "group", kind: "ref", origin: "derived", rule: "aws:AWS::RDS::DBInstance:DBSubnetGroupName", relation: "reference" }),
    ]);
  });

  it("draws no edge when the name is claimed by two subnet groups (behold#1023 Q3)", async () => {
    const ir = rds();
    (ir.nodes as IRNode[]).push({ id: "group2", kind: "AWS::RDS::DBSubnetGroup", lexicon: "aws", attrs: { DBSubnetGroupName: GROUP_NAME } } as unknown as IRNode);
    const { source } = await deriveGraphEdgesWithSource(ir, withRealPasses);
    expect(source.source).toBe("chant");
    expect(ir.edges).toEqual([]);
  });
});
