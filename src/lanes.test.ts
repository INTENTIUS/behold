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
    const LF = JSON.parse(html.match(/const LF = (\[[\s\S]*?\]);/)![1].replace(/\\u003c/g, "<"));
    expect(LF).toHaveLength(2);
    expect(LF[0].byLexicon).toEqual({ aws: 2 });
    // per-frame node status + substrate maps (for focus + frame-pair diff)
    expect(LF[0].status).toHaveProperty("sg");
    expect(LF[1].status).not.toHaveProperty("sg"); // sg gone at t1
    expect(LF[0].lexicon.sg).toBe("aws");
    expect(html).toContain("window.applyView"); // playhead drives the morph
  });

  it("wires the #6 coupling: focus, frame-pair diff, graph-inert offset", () => {
    expect(html).toContain("[data-node-id]"); // graph node → focus (graph→lanes)
    expect(html).toContain("function showDiff"); // shift-click two frames → delta
    expect(html).toContain('id="behold-diff"');
    expect(html).toContain("offset"); // per-lane offset
    expect(html).toContain("graph shows real time"); // offset is graph-inert marker
  });

  it("is one self-contained document", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("</body>");
    expect(html).not.toContain("src=");
  });
});

// #198: lanes rides the same theme tokens as the SPA — CSS vars in the strip
// styles, the theme engine booted from /theme.js, canvas colors read per draw.
describe("renderLanes — themed (#198)", () => {
  const html = renderLanes(frames, summaries);

  it("styles the strip from the shared CSS custom properties, not hexes", () => {
    expect(html).toContain("var(--bg,");
    expect(html).toContain("var(--panel,");
    expect(html).toContain("var(--managed,");
  });

  it("boots the SPA's theme engine and repaints the canvas on a theme change", () => {
    expect(html).toContain('from "/theme.js"');
    expect(html).toContain("initTheme()");
    expect(html).toContain('addEventListener("behold-theme", draw)');
  });

  // #229: the fallbacks are the DEFAULT theme's own derivation (Catppuccin
  // Mocha through tokensFor), so the instant before /theme.js runs matches what
  // it lands on — they are not a second, GitHub-flavoured palette any more.
  it("reads canvas colors from the live tokens, falling back to the default theme", () => {
    expect(html).toContain('css("--managed", "#a6e3a1")');
    expect(html).toContain('css("--pending", "#89b4fa")');
    expect(html).not.toContain("#3fb950"); // no Primer left on this surface
  });

  it("links back to the graph and mounts the theme picker", () => {
    expect(html).toContain('<a href="/">← graph</a>');
    expect(html).toContain('id="behold-lanes-pickers"');
  });
});
