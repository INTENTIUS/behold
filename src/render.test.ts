import { describe, it, expect } from "vitest";
import { renderGraph } from "./render.ts";
import type { GraphIR } from "@intentius/chant";

// M4: renderGraph gained an explicit `boxes: "byStack"` opt-in for the
// multi-estate view (#31) — see the module doc comment for why it's opt-in
// rather than auto-detected the way `byWave` (component DAG) is: a single,
// non-composed project's own `chant graph` IR also carries `groups.byStack`,
// but there it's a lexicon partition (src/resources.ts), not a project
// boundary. These are the unit-level complement to src/estate-route.test.ts's
// HTTP-level check.
const twoProjectIr: GraphIR = {
  nodes: [
    { id: "loomster/loomDb", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: {} },
    { id: "gke/appDeployment", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: {} },
  ],
  edges: [],
  groups: { byStack: { loomster: ["loomster/loomDb"], gke: ["gke/appDeployment"] } },
};

const waveIr: GraphIR = {
  nodes: [
    { id: "shared-foundation", kind: "Component", lexicon: "chant", attrs: {} },
    { id: "loom-db", kind: "Component", lexicon: "chant", attrs: {} },
  ],
  edges: [],
  groups: { byWave: { "wave-1": ["shared-foundation"], "wave-2": ["loom-db"] } } as GraphIR["groups"],
};

// pinhole's `groupBox()` (Canvas class) is the only place that emits `rx="16"`
// (node cards use `rx="12"`) — a precise, implementation-grounded way to assert
// "a boundary box was drawn" without depending on node-label text, which can
// coincidentally contain a group's name too (e.g. a node id "loomster/loomDb"
// already contains the substring "loomster").
const BOX_MARKER = 'rx="16"';

describe("renderGraph — boundary boxes (#31/M4)", () => {
  it("does NOT box groups.byStack by default — a single project's byStack is a lexicon partition, not a boundary", () => {
    const { svg } = renderGraph(twoProjectIr);
    expect(svg).not.toContain(BOX_MARKER);
  });

  it("boxes groups.byStack when the caller opts in (the multi-estate render path), with a titled box per project", () => {
    const { svg } = renderGraph(twoProjectIr, { boxes: "byStack" });
    expect(svg).toContain(BOX_MARKER);
    expect(svg).toContain("loomster");
    expect(svg).toContain("gke");
  });

  it("still auto-boxes groups.byWave (component DAG, unchanged M1 behaviour) even with no opt-in", () => {
    const { svg } = renderGraph(waveIr);
    expect(svg).toContain(BOX_MARKER);
    expect(svg).toContain("wave-1");
    expect(svg).toContain("wave-2");
  });

  it("byWave wins over an explicit byStack opt-in if an IR somehow carried both (shouldn't happen in practice)", () => {
    const both: GraphIR = { ...waveIr, groups: { ...waveIr.groups, byStack: { x: ["shared-foundation"] } } };
    const { svg } = renderGraph(both, { boxes: "byStack" });
    expect(svg).toContain("wave-1");
    expect(svg).not.toContain(">x<");
  });
});
