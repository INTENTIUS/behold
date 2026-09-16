import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { sanitizeStackGraph, stackGraphArgs, type StackGraph } from "./chant.ts";
import { CYCLE_BOX, STACK_LEXICON, stackOrderNote, stackOrderNoteShort, stackOrderToIr } from "./stack-order.ts";
import { labelRead } from "./read-stats.ts";

/** chant's own answer for `gitlab-cells-single-region-gke`, recorded by running
 * `chant graph <dir> --stacks --json` against that example. The estate whose
 * entity IR carries 211 nodes and zero edges — which is why this read exists. */
const gitlabCells: StackGraph = {
  nodes: ["gcp", "gitlab", "helm", "k3d", "k8s"],
  edges: [{ from: "helm", to: "k8s" }],
  order: ["gcp", "gitlab", "k3d", "k8s", "helm"],
  waves: [["gcp", "gitlab", "k3d", "k8s"], ["helm"]],
  cycles: [],
};

/** `example-writes`, recorded the same way: two independent stacks, one wave.
 * Every example bundled with behold looks like this. */
const exampleWrites: StackGraph = {
  nodes: ["aws", "temporal"],
  edges: [],
  order: ["aws", "temporal"],
  waves: [["aws", "temporal"]],
  cycles: [],
};

describe("the apply-order read (#426)", () => {
  it("asks chant for the project ROOT, never the source dir", () => {
    // `runStackGraph` does not call `mergeGraphOps`, so it only sees
    // `ops/*.op.ts` from the root. Measured on example-writes, whose config
    // sets `sourceDir: "src"`: `. ` answers [aws, temporal] and `src` answers
    // [aws]. Every other read here wants graphPath; this one must not.
    expect(stackGraphArgs("/work/proj")).toEqual(["graph", "/work/proj", "--stacks", "--json"]);
  });

  it("files under its own name, not the entity graph's", () => {
    // Same verb, no --live: without the check it would be indistinguishable
    // from the entity read in the ledger.
    expect(labelRead(["graph", "/d", "--stacks", "--json"], "/d")).toEqual({ dir: "/d", what: "graph --stacks", live: false });
    expect(labelRead(["graph", "/d", "--format", "ir"], "/d").what).toBe("graph");
  });

  it("drops what chant named nowhere — the malformed payload it emits today", () => {
    // Reproducible on chant's own fan-out-estate and bedrock-agentcore-agent:
    // an edge with no `from`, a null in `order`, and a wave whose only member
    // is that null. `nodes` is the roster; everything else is checked against it.
    const clean = sanitizeStackGraph({
      nodes: ["aws"],
      edges: [{ to: "aws" } as never],
      order: ["aws", null as never],
      waves: [["aws"], [null as never]],
      cycles: [],
    });
    expect(clean).toEqual({ nodes: ["aws"], edges: [], order: ["aws"], waves: [["aws"]], cycles: [] });
  });

  it("survives a payload missing every field", () => {
    expect(sanitizeStackGraph({})).toEqual({ nodes: [], edges: [], order: [], waves: [], cycles: [] });
    expect(sanitizeStackGraph(null)).toEqual({ nodes: [], edges: [], order: [], waves: [], cycles: [] });
  });
});

describe("the apply order as a picture (#426)", () => {
  it("draws one card per stack, boxed by wave, with chant's own edge direction", () => {
    const ir = stackOrderToIr(gitlabCells);
    expect(ir.nodes.map((n) => n.id)).toEqual(["gcp", "gitlab", "helm", "k3d", "k8s"]);
    // The kind is the lexicon name, so pinhole's keyword heuristic resolves it.
    expect(ir.nodes.every((n) => n.kind === n.id)).toBe(true);
    expect(ir.nodes.every((n) => n.lexicon === STACK_LEXICON)).toBe(true);
    expect((ir.groups as { byStack: Record<string, string[]> }).byStack).toEqual({
      "wave 1": ["gcp", "gitlab", "k3d", "k8s"],
      "wave 2": ["helm"],
    });
    expect(ir.edges).toEqual([{ from: "helm", to: "k8s", kind: "ref", viaAttr: "applies-after" }]);
  });

  it("puts the wave on the card, which is the one thing the lens exists to say", () => {
    const byId = new Map(stackOrderToIr(gitlabCells).nodes.map((n) => [n.id, n.attrs as Record<string, unknown>]));
    expect(byId.get("helm")).toMatchObject({ wave: "wave 2", position: 5 });
    expect(byId.get("gcp")).toMatchObject({ wave: "wave 1", position: 1 });
  });

  it("says plainly when every stack is independent, which is every bundled example", () => {
    const note = stackOrderNote(exampleWrites);
    expect(note).toContain("2 stacks in 1 wave");
    expect(note).toContain("no cross-lexicon references");
    expect(stackOrderNoteShort(exampleWrites)).toBe("2 stacks · 1 wave");
  });

  it("draws a cycle unwaved and never invents an order for it", () => {
    const cyclic: StackGraph = {
      nodes: ["a", "b", "c"],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
      order: ["c"],
      waves: [["c"]],
      cycles: [["a", "b"]],
    };
    const ir = stackOrderToIr(cyclic);
    const boxes = (ir.groups as { byStack: Record<string, string[]> }).byStack;
    expect(boxes[CYCLE_BOX]).toEqual(["a", "b"]);
    expect(boxes["wave 1"]).toEqual(["c"]);
    // No wave number is fabricated for a stack chant could not order.
    const a = ir.nodes.find((n) => n.id === "a")!.attrs as Record<string, unknown>;
    expect(a.wave).toBe("unordered");
    expect(a.position).toBeUndefined();
    expect(stackOrderNote(cyclic)).toContain("cycle chant could not order (a, b)");
  });

  it("is a legitimate one-card picture for a single-lexicon project", () => {
    const one: StackGraph = { nodes: ["aws"], edges: [], order: ["aws"], waves: [["aws"]], cycles: [] };
    expect(stackOrderToIr(one).nodes).toHaveLength(1);
    expect(stackOrderNote(one)).toContain("1 stack — nothing to order against");
  });
});

describe("GET /api/graph?stacks=1 (#426)", () => {
  const made: string[] = [];
  afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "behold-stacks-route-"));
    made.push(root);
    writeFileSync(join(root, "chant.config.ts"), "export default {};\n");
    return root;
  }

  it("refuses an estate rather than merging two members' stacks into one", async () => {
    const dir = project();
    const app = createApp({ projectDir: dir, projectDirs: [dir, project()], port: 0 } as never);
    const res = await app.request("/api/graph?stacks=1");
    expect(res.status).toBe(422);
    // The structured shape every other precondition failure uses, so an agent
    // branches on `code` instead of parsing prose.
    const body = (await res.json()) as { code: string; remedy: string };
    expect(body.code).toBe("stacks-estate");
    expect(body.remedy).toContain("serve one project");
  });
});
