import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import { catalogLegend, drawCatalog, isPlaceholder, stampCatalogSvg } from "./catalog-draw.ts";
import { REFERENCE_CATALOG_CHANT_FLOOR } from "./chant-floors.ts";
import { addClusterAnchorEdges } from "./cluster-anchor.ts";
import { danglingNote } from "./zoom-notes.ts";
import { applyReferenceCatalog, readReferenceCatalog, referenceCatalogOf, type CatalogIr } from "./reference-catalog.ts";
import { renderGraph } from "./render.ts";
import { shapeEstate } from "./graph-view.ts";

// behold#1080. The documents are `chant workspace graph --discover --json`
// recorded from a chant checkout at the reference catalog (chant#5097) and its
// rules (chant#5098 to chant#5102), with the workspace root made generic. Each
// is one workspace read, the shape behold reads from a chant at
// REFERENCE_CATALOG_CHANT_FLOOR. The estate they compose into is built here the
// way composeEstate does it: the document's nodes, boxed by member.
const FIXTURES = join(import.meta.dirname, "..", "e2e", "fixtures", "reference-catalog");
const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, `${name}.graph.json`), "utf8"));

/** The composed estate of a recorded document: its nodes boxed by member, with no edges of their own. */
function estateOf(doc: Record<string, unknown>): GraphIR {
  const nodes = (doc.nodes as Array<{ id: string; member: string }>).map(({ member: _m, ...n }) => n);
  const byStack: Record<string, string[]> = {};
  for (const n of doc.nodes as Array<{ id: string; member: string }>) (byStack[n.member] ??= []).push(n.id);
  return { version: 1, nodes, edges: [], groups: { byStack, byLexicon: {}, byComposite: {} }, exports: [], imports: [] } as unknown as GraphIR;
}

function drawn(name: string): { ir: GraphIR; svg: string } {
  const doc = load(name);
  const ir = estateOf(doc);
  applyReferenceCatalog(ir, referenceCatalogOf(doc as never)!);
  const shaped = drawCatalog(shapeEstate(ir, { alike: false }).ir);
  const { svg } = renderGraph(shaped, { boxes: "byStack" });
  // renderGraph stamps the catalog's marks and appends the key itself.
  return { ir: shaped, svg };
}

const count = (svg: string, re: RegExp): number => (svg.match(re) ?? []).length;

describe("the catalog's edges, dangling and ambiguous references, drawn (behold#1080)", () => {
  const { ir, svg } = drawn("three-kinds");

  it("draws one joined edge, with its rule in the tooltip", () => {
    expect(count(svg, /<g data-edge-from="[^"]*" data-edge-to="[^"]*"[^>]*data-edge-weight="joined"/g)).toBe(2); // the line and its chip
    const joined = (ir.edges as unknown as Array<Record<string, unknown>>).filter((e) => e.origin === "derived");
    expect(joined).toHaveLength(1);
    expect(svg).toContain("runs as: joined by rule k8s:K8s::Apps::Deployment:spec.template.spec.serviceAccountName");
  });

  it("draws one dashed placeholder card for the reference that names nothing", () => {
    expect(ir.nodes.filter(isPlaceholder)).toHaveLength(1);
    expect(count(svg, /data-node-dangling="true"/g)).toBe(1);
    expect(svg).toContain("ghost@proj.iam.gserviceaccount.com");
    expect(svg).toContain("stroke-dasharray=\"6 4\"");
    expect(count(svg, /data-edge-weight="dangling"/g)).toBe(2);
  });

  it("draws one dotted edge to each of the two candidates, labelled one of 2", () => {
    const dotted = (ir.edges as unknown as Array<Record<string, unknown>>).filter((e) => e.ambiguous);
    expect(dotted.map((e) => e.to).sort()).toEqual(["a/a/google_service_account.runner", "b/b/google_service_account.runner"]);
    expect(count(svg, /data-edge-weight="ambiguous"/g)).toBe(4); // two lines and two chips
    expect(svg).toContain(">one of 2<");
  });

  it("gives each its legend row, in the picture and in the answer's key", () => {
    expect(catalogLegend(ir).map((r) => [r.weight, r.count])).toEqual([["joined", 1], ["dangling", 1], ["ambiguous", 2]]);
    expect(count(svg, /data-legend-row="/g)).toBe(3);
  });

  it("leaves a containment reference with no declared namespace to the note", () => {
    expect(ir.nodes.filter(isPlaceholder).map((n) => n.attrs._placeholder)).toEqual(["ghost@proj.iam.gserviceaccount.com"]);
    expect(danglingNote(ir as never)).toBe("3 references to targets not declared here, such as another repo's workflow or a local action: listed on their cards, not drawn");
  });

  it("is not drawn twice, and an estate with no catalog comes back as it was", () => {
    expect(drawCatalog(ir)).toBe(ir);
    const plain = estateOf(load("three-kinds"));
    expect(drawCatalog(plain)).toBe(plain);
    const { svg: bare } = renderGraph(plain, { boxes: "byStack" });
    expect(stampCatalogSvg(bare, plain)).toBe(bare);
  });
});

describe("the cluster anchor over the cluster join (behold#1080, chant#5101)", () => {
  const runsOn = (ir: GraphIR): string[] => (ir.edges as Array<{ from: string; to: string; viaAttr?: string }>).filter((e) => e.viaAttr === "runs-on").map((e) => `${e.from} > ${e.to}`);
  const anchored = (name: string): CatalogIr => {
    const doc = load(name);
    const ir = estateOf(doc);
    applyReferenceCatalog(ir, referenceCatalogOf(doc as never)!);
    return addClusterAnchorEdges(ir) as CatalogIr;
  };

  it("anchors the Kubernetes nodes to prod only when two clusters are declared", () => {
    const ir = anchored("cluster-two-declared");
    expect(runsOn(ir)).toEqual(["tf/tf/google_container_cluster.prod > argo/argo/applicationWeb"]);
    expect(ir.anchorNotes).toBeUndefined();
  });

  it("anchors nothing when the Terraform cluster was renamed, and says why", () => {
    const ir = anchored("cluster-renamed");
    expect(runsOn(ir)).toEqual([]);
    expect(ir.anchorNotes).toEqual(['argo: cluster Secret argo/argo/secretClusterProd registers cluster "prod", which no cluster resource names (k8s:K8s::Core::Secret:argoCluster.name); its objects are anchored to no cluster']);
  });

  it("anchors nothing when two clusters of that name are declared, and names them", () => {
    const ir = anchored("cluster-ambiguous");
    expect(runsOn(ir)).toEqual([]);
    expect(ir.anchorNotes?.[0]).toContain("which 2 cluster resources name (a/a/google_container_cluster.main, b/b/google_container_cluster.main)");
  });

  it("keeps the guess for an estate read without the catalog", () => {
    const doc = load("cluster-renamed");
    const ir = addClusterAnchorEdges(estateOf(doc));
    // No managed cluster kinds are on the cards, as before: the guess finds none.
    expect(runsOn(ir)).toEqual([]);
    expect((ir as CatalogIr).anchorNotes).toBeUndefined();
  });

  it("draws the Secret's unmatched cluster name as a placeholder beside it", () => {
    const doc = load("cluster-renamed");
    const ir = estateOf(doc);
    applyReferenceCatalog(ir, referenceCatalogOf(doc as never)!);
    const out = drawCatalog(ir);
    expect(out.nodes.filter(isPlaceholder).map((n) => n.attrs._placeholder)).toEqual(["prod"]);
  });
});

describe("the reference catalog read is behind its chant floor (behold#1080)", () => {
  it("names 0.124.98, the release that carries chant#5097", () => {
    expect(REFERENCE_CATALOG_CHANT_FLOOR).toBe("0.124.98");
  });

  it("sends no read to a chant below the floor", async () => {
    const read = vi.fn(async () => load("three-kinds") as never);
    expect(await readReferenceCatalog("/work/estate", { chant: "0.124.97" }, { read })).toEqual({ ok: false, reason: "floor" });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the whole workspace at the member tier once the chant is at the floor", async () => {
    const read = vi.fn(async () => load("three-kinds") as never);
    const got = await readReferenceCatalog("/work/estate", { chant: REFERENCE_CATALOG_CHANT_FLOOR, detail: 3 }, { read });
    expect(got.ok).toBe(true);
    expect(read).toHaveBeenCalledWith("/work/estate", ["/work/estate", "--detail", "3"], undefined);
  });

  it("says so when a chant at the floor prints no catalog, and when the read fails", async () => {
    const none = await readReferenceCatalog("/work/estate", { chant: "0.124.98" }, { read: async () => ({ contract: 1, nodes: [], edges: [] }) });
    expect(none).toEqual({ ok: false, reason: "none" });
    const err = await readReferenceCatalog("/work/estate", { chant: "0.124.98" }, { read: async () => { throw new Error("chant exited 1: boom\nmore"); } });
    expect(err).toEqual({ ok: false, reason: "error", message: "chant exited 1: boom" });
  });

  it("reads a rule table given as a list as well as chant's object keyed by id", () => {
    const doc = load("three-kinds") as { catalog: { rules: Record<string, Record<string, unknown>> } };
    const asList = { ...doc, catalog: { ...doc.catalog, rules: Object.entries(doc.catalog.rules).map(([id, r]) => ({ id, ...r })) } };
    expect(Object.keys(referenceCatalogOf(asList as never)!.rules)).toEqual(Object.keys(referenceCatalogOf(doc as never)!.rules));
  });
});
