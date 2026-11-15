import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boxBadges } from "../collapse-lens.ts";
import type { GraphDocument } from "../graph-document.ts";
import { iconOrFallthrough, loadIcon, recordIcons, supplyIcons } from "../icon-packs.ts";
import { renderGraph } from "../render.ts";
import { toDocument, type GraphSnapshot } from "../to-document.ts";
import { documentToIr } from "./document-ir.ts";
import { documentIcons, graphScript, scriptJson } from "./graph-script.ts";
import { FLAT_LIMIT, paintDocument } from "./paint.ts";

const FIX = join(import.meta.dirname, "..", "__fixtures__", "graph-document");
// The export of example-terraform-estate (#1066's fixture): prod and platform roots, 23 cards.
const snapshot = (): GraphSnapshot => JSON.parse(readFileSync(join(FIX, "terraform-estate-detail-2.json"), "utf8")) as GraphSnapshot;
const estate = (): GraphDocument => toDocument(snapshot(), { generator: { behold: "0.31.0" }, origin: { dir: "example-terraform-estate" } });
const cards = (svg: string): string[] => [...new Set([...svg.matchAll(/data-node-id="([^"]+)"/g)].map((m) => m[1]!))].sort();
const sorted = (g: Record<string, string[]> | undefined) => Object.fromEntries(Object.entries(g ?? {}).map(([k, v]) => [k, [...v].sort()]));

describe("a behold-graph/1 document back into the IR (behold#1070)", () => {
  it("puts every card back in the stack it was read in", () => {
    const { ir, boxes, flat } = documentToIr(estate());
    expect(boxes).toBe("byStack");
    expect(flat).toBe(false);
    expect(sorted(ir.groups.byStack as Record<string, string[]>)).toEqual(sorted(snapshot().ir.groups.byStack as Record<string, string[]>));
    expect(ir.nodes.map((n) => n.id)).toEqual(snapshot().ir.nodes.map((n) => n.id));
    expect(ir.edges).toHaveLength(snapshot().ir.edges.length);
  });

  it("walks a card's box up to its pipeline, its stack and its live container", () => {
    const doc: GraphDocument = {
      ...estate(),
      nodes: [
        { id: "web/build", title: "build", subtitle: "github", kind: "Job", lexicon: "github", box: "pipeline:web/ci", attrs: {} },
        { id: "vpc", title: "vpc", subtitle: "aws", kind: "AWS::EC2::VPC", lexicon: "aws", box: "stack:net", attrs: {} },
        { id: "subnet", title: "subnet", subtitle: "aws", kind: "AWS::EC2::Subnet", lexicon: "aws", box: "container:vpc", attrs: {} },
        { id: "task", title: "task", subtitle: "aws", kind: "AWS::ECS::Task", lexicon: "aws", box: "container:subnet", attrs: {} },
      ],
      edges: [],
      groups: [
        { id: "stack:web", title: "web", kind: "stack" },
        { id: "pipeline:web/ci", title: "web/ci", kind: "pipeline", parent: "stack:web" },
        { id: "stack:net", title: "net", kind: "stack" },
        { id: "container:vpc", title: "vpc", kind: "container", parent: "stack:net" },
        { id: "container:subnet", title: "subnet", kind: "container", parent: "container:vpc" },
      ],
    };
    const { ir, boxes } = documentToIr(doc);
    expect(boxes).toBe("byContainer");
    expect(ir.groups.byPipeline).toEqual({ "web/ci": ["web/build"] });
    expect(sorted(ir.groups.byStack as Record<string, string[]>)).toEqual({ web: ["web/build"], net: ["subnet", "task", "vpc"] });
    expect(sorted(ir.groups.byContainer as Record<string, string[]>)).toEqual({ vpc: ["subnet"], subnet: ["task"] });
  });
});

describe("paintDocument (behold#1070)", () => {
  it("draws the cards the server's renderGraph draws for the same estate", () => {
    const r = paintDocument(estate());
    if (!r.ok) throw new Error(r.error);
    const ir = snapshot().ir;
    expect(cards(r.svg)).toEqual(cards(renderGraph(ir, { boxes: "byStack", groupBadges: boxBadges(ir) }).svg));
    expect(r.cards).toBe(23);
  });

  it("refuses a flat document above the limit, and a version it does not read", () => {
    const doc = estate();
    const flat: GraphDocument = { ...doc, groups: [], nodes: doc.nodes.map(({ box: _box, ...n }) => n) };
    expect(paintDocument(flat, { flatLimit: 10 })).toMatchObject({ ok: false, code: "too-flat" });
    expect(paintDocument(flat, { flatLimit: 23 })).toMatchObject({ ok: true, cards: 23 });
    expect(FLAT_LIMIT).toBeGreaterThan(23);
    expect(paintDocument({ ...doc, schema: "behold-graph/2" })).toMatchObject({ ok: false, code: "not-a-document" });
  });
});

describe("the icons a host hands the viewer (behold#1070)", () => {
  it("records the vendored icons a document's cards wear, and only those", () => {
    const icons = documentIcons(estate());
    expect(Object.keys(icons).length).toBeGreaterThan(0);
    expect(Object.keys(icons).every((k) => k.startsWith("aws/"))).toBe(true);
    expect(Object.keys(icons).length).toBeLessThan(20);
    const again = recordIcons(() => paintDocument(estate()));
    expect(again.icons).toEqual(icons);
  });

  it("writes graph.js as the two globals, with nothing that closes a script element", () => {
    const doc = { ...estate(), notes: [{ kind: "view", text: "</script><script>alert(1)</script>\u2028" }] };
    const js = graphScript(doc, {});
    expect(js).not.toMatch(/<\/script/i);
    expect(js).not.toMatch(/\u2028/);
    expect(js.startsWith("window.__BEHOLD_ICONS__ = {};\nwindow.__BEHOLD_GRAPH__ = ")).toBe(true);
    expect(JSON.parse(scriptJson(doc))).toEqual(doc);
  });

  it("once a host supplies icons, one it did not supply falls through instead of throwing", () => {
    expect(() => loadIcon("aws/not-an-icon")).toThrow(/no vendored icon/);
    supplyIcons({ "aws/handed-over": { body: "<path d='M0 0'/>", viewBox: "0 0 1 1" } });
    expect(iconOrFallthrough("aws/not-an-icon")).toBeUndefined();
    expect(iconOrFallthrough("aws/handed-over")).toMatchObject({ body: "<path d='M0 0'/>", viewBox: "0 0 1 1", colored: true });
  });
});
