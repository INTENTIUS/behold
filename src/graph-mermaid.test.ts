import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GRAPH_DOCUMENT_SCHEMA, type GraphDocument, type GraphDocumentNode } from "./graph-document.ts";
import { escapeLabel, forgeComment, mermaidDiagram, rootTable, toMermaid } from "./graph-mermaid.ts";
import { FORGE_BUDGETS, type ForgeBudget } from "./mermaid-budgets.ts";
import { cutDocument } from "./graph-cut.ts";
import { toDocument, type GraphSnapshot } from "./to-document.ts";

// behold#1060: the Mermaid writer and its per-forge budgets.

const node = (id: string, extra: Partial<GraphDocumentNode> = {}): GraphDocumentNode => ({ id, title: id, subtitle: "terraform", kind: "aws_x", lexicon: "terraform", attrs: {}, ...extra });

/** 40 cards in four roots of ten, a chain in each, and a few edges across. */
function fortyCards(): GraphDocument {
  const nodes: GraphDocumentNode[] = [];
  const edges: GraphDocument["edges"] = [];
  const groups: GraphDocument["groups"] = [];
  for (let r = 0; r < 4; r++) {
    groups.push({ id: `stack:root${r}`, title: `root-${r}`, kind: "stack" });
    for (let i = 0; i < 10; i++) {
      nodes.push(node(`root${r}/aws_security_group_rule.ingress_${i}`, { title: `aws_security_group_rule.ingress_${i}`, box: `stack:root${r}`, detail__root: `root-${r}` }));
      if (i > 0) edges.push({ id: `e${r}-${i}`, source: `root${r}/aws_security_group_rule.ingress_${i}`, target: `root${r}/aws_security_group_rule.ingress_${i - 1}`, kind: "ref", inferred: i % 3 === 0 });
    }
  }
  edges.push({ id: "x1", source: "root1/aws_security_group_rule.ingress_0", target: "root0/aws_security_group_rule.ingress_9", kind: "ref", inferred: true });
  return { schema: GRAPH_DOCUMENT_SCHEMA, generator: { behold: "0.0.0" }, origin: { dir: "." }, cut: { kind: "whole" }, nodes, edges, groups, notes: [] };
}

const changed = (): GraphDocument => {
  const doc = fortyCards();
  const set = (id: string, change: string) => void (doc.nodes.find((n) => n.id === id)!.change = change);
  set("root0/aws_security_group_rule.ingress_1", "create");
  set("root0/aws_security_group_rule.ingress_2", "update");
  set("root2/aws_security_group_rule.ingress_3", "replace");
  set("root2/aws_security_group_rule.ingress_4", "delete");
  return doc;
};

describe("toMermaid (#1060)", () => {
  it("draws a small graph with boxes, a dotted inferred edge and short ids", () => {
    const doc = fortyCards();
    doc.nodes = doc.nodes.slice(0, 3);
    doc.edges = doc.edges.filter((e) => doc.nodes.some((n) => n.id === e.source) && doc.nodes.some((n) => n.id === e.target));
    expect(toMermaid(doc)).toBe(
      ['flowchart TD', 'subgraph g0["root-0"]', 'n0["aws_security_group_rule.ingress_0"]', 'n1["aws_security_group_rule.ingress_1"]', 'n2["aws_security_group_rule.ingress_2"]', 'end', 'n1 --> n0', 'n2 --> n1', ''].join("\n"),
    );
  });

  it("is the same on two runs and whatever order the document lists its cards in", () => {
    const doc = fortyCards();
    const shuffled = { ...doc, nodes: [...doc.nodes].reverse(), edges: [...doc.edges].reverse(), groups: [...doc.groups].reverse() };
    expect(toMermaid(doc)).toBe(toMermaid(doc));
    expect(toMermaid(shuffled)).toBe(toMermaid(doc));
    expect(toMermaid(doc, { forge: "gitlab" })).toBe(toMermaid(shuffled, { forge: "gitlab" }));
  });

  it("fits gitlab's 2,000 characters on a 40-card graph and says what it left out", () => {
    const r = mermaidDiagram(fortyCards(), { forge: "gitlab" });
    expect(r.text.length).toBeLessThanOrEqual(2_000);
    expect(r.hidden).toBeGreaterThan(0);
    expect(r.shown + r.hidden).toBe(40);
    expect(r.text).toContain(`more["${r.hidden} cards not shown"]`);
    // Whole boxes go, so no half-drawn root is left and every drawn edge has both ends.
    const ids = new Set([...r.text.matchAll(/^(n\d+)\[/gm)].map((m) => m[1]));
    for (const m of r.text.matchAll(/^(n\d+) -\.?-> (n\d+)$/gm)) {
      expect(ids.has(m[1]!)).toBe(true);
      expect(ids.has(m[2]!)).toBe(true);
    }
    expect(r.text).not.toContain("&");
  });

  it("draws all 40 on github and forgejo, with nothing hidden", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const r = mermaidDiagram(fortyCards(), { forge });
      expect(r.hidden).toBe(0);
      expect(r.text).not.toContain("not shown");
      expect(r.edges).toBe(37);
    }
  });

  it("never returns text over a budget, however small", () => {
    const doc = changed();
    for (const blockChars of [0, 10, 40, 120, 300, 700, 2_000, 6_000]) {
      for (const maxEdges of [undefined, 0, 5, 20]) {
        const budget: ForgeBudget = { ...FORGE_BUDGETS.gitlab, blockChars, ...(maxEdges !== undefined ? { maxEdges } : {}) };
        const r = mermaidDiagram(doc, { budget });
        expect(r.text.length).toBeLessThanOrEqual(blockChars);
        if (maxEdges !== undefined) expect(r.edges).toBeLessThanOrEqual(maxEdges);
      }
    }
  });

  it("holds the edge budget as well as the character one", () => {
    const budget: ForgeBudget = { ...FORGE_BUDGETS.github, maxEdges: 10 };
    const r = mermaidDiagram(fortyCards(), { budget });
    expect(r.edges).toBeLessThanOrEqual(10);
    expect(r.hidden).toBeGreaterThan(0);
  });

  it("has no classDef on a plain graph and all four on a changed one, with the classes on the cards", () => {
    expect(toMermaid(fortyCards())).not.toContain("classDef");
    const text = toMermaid(changed());
    for (const c of ["added", "changed", "removed", "neighbour"]) expect(text).toMatch(new RegExp(`^classDef ${c} `, "m"));
    expect(text).toContain('["aws_security_group_rule.ingress_1"]:::added');
    expect(text).toContain('["aws_security_group_rule.ingress_2"]:::changed');
    expect(text).toContain('["aws_security_group_rule.ingress_3"]:::changed');
    expect(text).toContain('["aws_security_group_rule.ingress_4"]:::removed');
    expect(text).toContain('["aws_security_group_rule.ingress_5"]:::neighbour');
  });

  it("drops neighbours before changed cards and whole boxes last", () => {
    const doc = changed();
    const all = mermaidDiagram(doc, { forge: "github" });
    expect(all.hidden).toBe(0);
    const tight = mermaidDiagram(doc, { budget: { ...FORGE_BUDGETS.github, blockChars: 1_400 } });
    expect(tight.hidden).toBeGreaterThan(0);
    for (const t of ["ingress_1", "ingress_2", "ingress_3", "ingress_4"]) expect(tight.text).toContain(`"aws_security_group_rule.${t}"]:::`);
    expect(tight.text).toContain("neighbour");
    const tighter = mermaidDiagram(doc, { budget: { ...FORGE_BUDGETS.github, blockChars: 1_000 } });
    expect(tighter.text.length).toBeLessThanOrEqual(1_000);
    // The roots with changes stay while the two without go first.
    expect(tighter.text).toContain('"root-0"');
    expect(tighter.text).toContain('"root-2"');
    expect(tighter.text).not.toContain('"root-1"');
    expect(tighter.text).not.toContain('"root-3"');
  });

  it("paints a cut's neighbours and leaves its seed plain", () => {
    const r = cutDocument(fortyCards(), ["root0/aws_security_group_rule.ingress_5"], { depth: 1 });
    if (!r.ok) throw new Error(r.error);
    const text = toMermaid(r.document);
    expect(text).toContain('["aws_security_group_rule.ingress_5"]\n');
    expect(text).toMatch(/\["aws_security_group_rule\.ingress_4"\]:::neighbour/);
  });

  it("escapes labels so none can open a tag, a link or a string", () => {
    expect(escapeLabel('a"b<c>d&e`f#g%h\\i')).toBe("a#quot;b#lt;c#gt;d#amp;e#96;f#35;g#37;h#92;i");
    expect(escapeLabel("two\nlines\u0000")).toBe("two lines");
    expect(escapeLabel("x".repeat(100))).toHaveLength(48);
    const doc = fortyCards();
    doc.nodes = [node("a", { title: '"]\n  click n0 call alert()\n  n9["<img src=x onerror=alert(1)>' })];
    doc.edges = [];
    doc.groups = [];
    const text = toMermaid(doc);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^n0\["[^"<>&]*"\]$/);
  });

  it("draws an empty document", () => {
    const doc = { ...fortyCards(), nodes: [], edges: [], groups: [] };
    expect(toMermaid(doc)).toBe('flowchart TD\nempty["no cards"]\n');
  });

  it("reads the terraform-estate fixture", () => {
    const snap = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "graph-document", "terraform-estate-detail-2.json"), "utf8")) as GraphSnapshot;
    const doc = toDocument(snap, { generator: { behold: "0.0.0" }, origin: { dir: "example-terraform-estate" } });
    const r = mermaidDiagram(doc, { forge: "github" });
    expect(r.hidden).toBe(0);
    expect(r.shown).toBe(doc.nodes.length);
    expect(r.text).toContain("subgraph");
    expect(mermaidDiagram(doc, { forge: "gitlab" }).text.length).toBeLessThanOrEqual(2_000);
  });
});

describe("forge budgets (#1060, #1065)", () => {
  it("holds the provisional figures in one table, none confirmed yet", () => {
    expect(FORGE_BUDGETS.gitlab).toMatchObject({ blockChars: 2_000, maxChains: 30, maxBlocks: 50 });
    expect(FORGE_BUDGETS.github).toMatchObject({ blockChars: 20_000, maxEdges: 250 });
    expect(FORGE_BUDGETS.forgejo).toMatchObject({ blockChars: 20_000, maxEdges: 250 });
    for (const b of Object.values(FORGE_BUDGETS)) {
      expect(b.commentChars).toBe(60_000);
      expect(b.confirmed).toBe(false);
    }
  });
});

describe("rootTable and forgeComment (#1060)", () => {
  it("counts cards per root, and changes when there are some", () => {
    expect(rootTable(fortyCards())).toBe("| Root | Cards |\n| --- | ---: |\n| root-0 | 10 |\n| root-1 | 10 |\n| root-2 | 10 |\n| root-3 | 10 |\n");
    const t = rootTable(changed());
    expect(t).toContain("| Root | Cards | Added | Changed | Removed |");
    expect(t.split("\n")[2]).toBe("| root-0 | 10 | 1 | 1 | 0 |");
    expect(t.split("\n")[3]).toBe("| root-2 | 10 | 0 | 1 | 1 |");
    expect(t).toContain("| root-1 | 10 | 0 | 0 | 0 |");
  });

  it("cuts the table's rows to its limit and says how many are left", () => {
    const t = rootTable(fortyCards(), 100);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t).toMatch(/\d more roots not listed\./);
  });

  it("escapes a root name in a cell", () => {
    const doc = fortyCards();
    doc.nodes = [node("a", { detail__root: "a|b <c>" })];
    expect(rootTable(doc)).toContain("| a\\|b &lt;c&gt; | 1 |");
  });

  it("is a diagram under a marker and a count line when the graph fits", () => {
    const c = forgeComment(fortyCards(), { forge: "github", marker: "behold-graph" });
    expect(c.kind).toBe("diagram");
    expect(c.text.startsWith("<!-- behold-graph -->\n40 cards, 37 edges\n\n```mermaid\nflowchart TD\n")).toBe(true);
    expect(c.text.endsWith("```\n")).toBe(true);
    expect(c.text.length).toBeLessThan(60_000);
  });

  it("is the per-root table when the diagram would leave cards out", () => {
    const c = forgeComment(fortyCards(), { forge: "gitlab", marker: "behold-graph" });
    expect(c.kind).toBe("table");
    expect(c.hidden).toBeGreaterThan(0);
    expect(c.text).not.toContain("```");
    expect(c.text).toContain("| root-0 | 10 |");
  });

  it("stays under the comment limit, table included", () => {
    const doc = fortyCards();
    const budget: ForgeBudget = { ...FORGE_BUDGETS.github, commentChars: 300 };
    const c = forgeComment(doc, { budget, marker: "behold-graph" });
    expect(c.kind).toBe("table");
    expect(c.text.length).toBeLessThan(300);
  });
});
