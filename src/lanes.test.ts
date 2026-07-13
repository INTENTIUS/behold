import { describe, it, expect } from "vitest";
import { renderLanes } from "./lanes.ts";
import type { Frame, FrameSummary } from "./frames.ts";
import type { GraphIR } from "@intentius/chant";

const ir = (ids: string[]): GraphIR =>
  ({ nodes: ids.map((id) => ({ id, kind: "K", lexicon: "aws", attrs: {} })), edges: [], groups: {} }) as unknown as GraphIR;

// Two keyframes: "sg" is present at t0, gone at t1.
const frames: Frame[] = [
  { id: "0", t: 1000, digest: "a", ir: ir(["vpc", "sg"]) },
  { id: "1", t: 2000, digest: "b", ir: ir(["vpc"]) },
];
const summaries: FrameSummary[] = [
  { id: "0", t: 1000, nodes: 2, edges: 0, byLexicon: { aws: 2 } },
  { id: "1", t: 2000, nodes: 1, edges: 0, byLexicon: { aws: 1 } },
];

describe("renderLanes (#5)", () => {
  const html = renderLanes(frames, summaries);

  it("embeds a pinhole morph over the keyframes (the graph half)", () => {
    const VIEWS = JSON.parse(html.match(/const VIEWS = (\[[\s\S]*?\]);\n/)![1].replace(/\\u003c/g, "<"));
    expect(VIEWS).toHaveLength(2);
    // identity preserved: "sg" appears once across both frames
    expect((html.match(/data-node-id="sg"/g) || []).length).toBe(1);
    expect(html).toContain("function applyView"); // the morph engine
  });

  it("injects the lanes filmstrip + playhead wired to applyView", () => {
    expect(html).toContain('id="behold-lanes-canvas"');
    const FRAMES = JSON.parse(html.match(/const FRAMES = (\[[\s\S]*?\]);/)![1].replace(/\\u003c/g, "<"));
    expect(FRAMES).toHaveLength(2);
    expect(FRAMES[0].byLexicon).toEqual({ aws: 2 });
    expect(html).toContain("window.applyView"); // playhead drives the morph
  });

  it("is one self-contained document", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("</body>");
    expect(html).not.toContain("src=");
  });
});
