import { describe, it, expect } from "vitest";
import type { GraphIR } from "@intentius/chant";
import { renderGraph } from "./render.ts";

// The kiosk's held small stage (the cone scenario): a terragucci repo's waves laid in a row, wave 1 on the left,
// so the graph is wide like the stage and the held framing zooms in as far as the width allows (`waves=row`).
const cone: GraphIR = {
  nodes: [
    { id: "network", kind: "Component", lexicon: "chant", attrs: { archetype: "infra", wave: 1 } },
    { id: "service-a", kind: "Component", lexicon: "chant", attrs: { archetype: "infra", wave: 2 } },
    { id: "service-b", kind: "Component", lexicon: "chant", attrs: { archetype: "infra", wave: 2 } },
  ],
  edges: [
    { from: "service-a", to: "network", kind: "ref" },
    { from: "service-b", to: "network", kind: "ref" },
  ],
  groups: { byWave: { "wave-1": ["network"], "wave-2": ["service-a", "service-b"] } } as GraphIR["groups"],
};

/** Each wave box's rect, from the painted SVG: `data-group-id="wave-N"` with its x, y, width, height. */
function boxes(svg: string): Record<string, { x: number; y: number; w: number; h: number }> {
  const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const m of svg.matchAll(/<rect\b[^>]*>/g)) {
    const tag = m[0];
    const id = /data-group-id="(wave-\d+)"/.exec(tag)?.[1];
    if (!id) continue;
    const n = (k: string) => Number(new RegExp(`\\b${k}="(-?[\\d.]+)"`).exec(tag)?.[1] ?? NaN);
    out[id] = { x: n("x"), y: n("y"), w: n("width"), h: n("height") };
  }
  return out;
}

describe("renderGraph: a terragucci repo's waves in a row", () => {
  it("lays wave 1 left of wave 2, side by side, when asked (rankdir RL)", () => {
    const b = boxes(renderGraph(cone, { rankdir: "RL" }).svg);
    expect(b["wave-1"] && b["wave-2"]).toBeTruthy();
    expect(b["wave-1"]!.x + b["wave-1"]!.w).toBeLessThanOrEqual(b["wave-2"]!.x + 0.5);
    // Side by side: the two boxes share their vertical span.
    expect(b["wave-1"]!.y).toBeLessThan(b["wave-2"]!.y + b["wave-2"]!.h);
    expect(b["wave-2"]!.y).toBeLessThan(b["wave-1"]!.y + b["wave-1"]!.h);
  });

  it("keeps the stacked layout when not asked", () => {
    const b = boxes(renderGraph(cone).svg);
    // One above the other: wave 2's box ends above wave 1's, or the other way round.
    const stacked = b["wave-1"]!.y >= b["wave-2"]!.y + b["wave-2"]!.h - 0.5 || b["wave-2"]!.y >= b["wave-1"]!.y + b["wave-1"]!.h - 0.5;
    expect(stacked).toBe(true);
  });
});
