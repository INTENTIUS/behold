import { describe, it, expect } from "vitest";
import { renderGraph, renderBanded, renderCarveEstate } from "./render.ts";
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

// #86, chant#1180/#1077: the runtime tier's containment — src/overlay.ts's
// `attachRuntimeContainment` populates `groups.byContainer` (owner entity id
// -> its live, undeclared runtime children); `renderGraph`'s `boxes:
// "byContainer"` opt-in draws it as a titled boundary box, the same
// grouped/compound layout `byStack`/`byWave` already use.
const containerIr: GraphIR = {
  nodes: [
    { id: "appDeployment", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { _status: "good" } },
    { id: "appDeployment-pod-1", kind: "K8s::Core::Pod", lexicon: "k8s", attrs: { _status: "runtime" }, runtimeOwner: "appDeployment" },
  ],
  edges: [],
  groups: { byContainer: { appDeployment: ["appDeployment-pod-1"] } },
};

describe("renderGraph — runtime-tier boundary boxes (#86)", () => {
  it("does NOT box groups.byContainer by default — same opt-in discipline as byStack", () => {
    const { svg } = renderGraph(containerIr);
    expect(svg).not.toContain(BOX_MARKER);
  });

  it("boxes groups.byContainer when the caller opts in, titled by the declared owner's id", () => {
    const { svg } = renderGraph(containerIr, { boxes: "byContainer" });
    expect(svg).toContain(BOX_MARKER);
    expect(svg).toContain("appDeployment");
  });

  it("passing boxes: \"byContainer\" is a no-op when the IR carries no groups.byContainer at all", () => {
    const { svg } = renderGraph(twoProjectIr, { boxes: "byContainer" });
    expect(svg).not.toContain(BOX_MARKER);
  });
});

// #227: src/render.ts registers the icon packs with pinhole at module load, so
// importing renderGraph is all it takes for a k8s/helm node to paint its real
// mark. These assert the server-side flow end to end — pack registration,
// pinhole's resolution chain, and the painter emitting a `colored` glyph — by
// looking for the per-file id/class prefix scripts/vendor-icons.mjs stamps into
// every vendored body. That prefix is the one thing only the vendored artwork
// can put in the document.
const iconIr: GraphIR = {
  nodes: [
    { id: "web", kind: "K8s::Core::Pod", lexicon: "k8s", attrs: {} },
    { id: "gitops", kind: "K8s::Flux::Kustomization", lexicon: "k8s", attrs: {} },
    { id: "chart", kind: "Helm::Release", lexicon: "helm", attrs: {} },
    { id: "vm", kind: "Floci::MicroVMReplicaSet", lexicon: "floci", attrs: {} },
  ],
  edges: [],
  groups: {},
};

describe("renderGraph — lexicon-native icons (#227)", () => {
  it("paints the Kubernetes community mark for a k8s kind the pack maps", () => {
    expect(renderGraph(iconIr).svg).toContain("k8s-pod-");
  });

  it("paints the project mark for a whole kind family — every K8s::Flux::* gets the Flux logo", () => {
    expect(renderGraph(iconIr).svg).toContain("cncf-flux-");
  });

  it("paints the Helm mark for the helm lexicon, which has no k8s icon to borrow", () => {
    expect(renderGraph(iconIr).svg).toContain("cncf-helm-");
  });

  // #246: the plate reaches the painted document, and it reaches it BEHIND the
  // mark — a ground painted after its ink is not a ground. The exported SVG is
  // where this matters most: no recolour pass runs on it, so the card under the
  // mark is pinhole's own near-black `--pin-<status>Fill`.
  it("paints the Helm mark on its own ground, before the ink", () => {
    const svg = renderGraph(iconIr).svg;
    const plate = svg.indexOf(`<rect x="0" y="0" width="500" height="500" rx="90" fill="#ffffff"/>`);
    expect(plate).toBeGreaterThan(-1);
    expect(svg.indexOf("cncf-helm-cls-1")).toBeGreaterThan(plate);
  });

  it("leaves an unmapped lexicon to pinhole's own chain — no pack geometry, no crash", () => {
    const svg = renderGraph(iconIr).svg;
    expect(svg).toContain('data-node-id="vm"');
    expect(svg).not.toContain("floci-");
  });

  it("emits well-formed XML — the vendored bodies' editor namespaces are dropped, so an exported .svg still parses", () => {
    const svg = renderGraph(iconIr).svg;
    // `xmlns:inkscape` and friends are declared on each vendored file's root
    // <svg>, which never survives into the painted document (src/icon-packs.ts
    // `unprefix`). A surviving `inkscape:label` would be an unbound prefix and
    // every `image/svg+xml` consumer — the SPA's `↓ SVG` download, a snapshot
    // opened directly — would fail to parse the file.
    expect(svg).not.toMatch(/\s(?:inkscape|sodipodi|xlink):/);
  });
});

// #252: the carve lens paints a RANKING, not a topology, so it gets its own
// layout. These pin the reason renderBanded exists (dagre lays an edgeless
// graph out along a single row) and the invariants the carve view depends on.
const bandedIr: GraphIR = {
  nodes: Array.from({ length: 30 }, (_, i) => ({
    id: `aws_s3_bucket.b${i}`,
    kind: "aws_s3_bucket",
    lexicon: "terraform",
    attrs: { _status: i < 20 ? "good" : "neutral", score: 100 - i, carve: i < 20 ? "carve now" : "leave in Terraform" },
  })),
  edges: [],
  groups: {
    byStack: {
      "carve now": Array.from({ length: 20 }, (_, i) => `aws_s3_bucket.b${i}`),
      "leave in Terraform": Array.from({ length: 10 }, (_, i) => `aws_s3_bucket.b${i + 20}`),
    },
  },
};

describe("renderBanded — the banded ranking layout (#252)", () => {
  const viewBox = (svg: string) => (svg.match(/viewBox="0 0 (\d+) (\d+)"/) ?? []).slice(1).map(Number);

  it("grid-wraps instead of stringing an edgeless graph out along one row", () => {
    const [wide] = viewBox(renderGraph(bandedIr, { boxes: "byStack" }).svg);
    const [w, h] = viewBox(renderBanded(bandedIr).svg);
    // dagre puts all 30 cards in rank 0 — one very long row.
    expect(wide).toBeGreaterThan(6000);
    expect(w).toBeLessThan(2000);
    // Near a screen's shape, not a strip: no worse than 3:1 either way.
    expect(w / h).toBeLessThan(3);
    expect(h / w).toBeLessThan(3);
  });

  it("titles a panel per band and tints it with the status its members agree on", () => {
    const svg = renderBanded(bandedIr).svg;
    expect(svg).toContain(BOX_MARKER);
    expect(svg).toContain("carve now");
    expect(svg).toContain("leave in Terraform");
    expect(svg).toContain("goodStroke"); // the carve-now panel's own border
  });

  it("draws every node, including one no band claims", () => {
    const orphaned: GraphIR = {
      ...bandedIr,
      nodes: [...bandedIr.nodes, { id: "aws_vpc.stray", kind: "aws_vpc", lexicon: "terraform", attrs: {} }],
    };
    const svg = renderBanded(orphaned).svg;
    expect(svg).toContain('data-node-id="aws_vpc.stray"');
    expect(svg).toContain("unbanded");
    for (const n of bandedIr.nodes) expect(svg).toContain(`data-node-id="${n.id}"`);
  });

  it("survives an empty graph without a degenerate canvas", () => {
    const [w, h] = viewBox(renderBanded({ nodes: [], edges: [], groups: {} }).svg);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
  });
});

// #254: the estate frame — the banded ranking inside a Terraform member box,
// the demo's chant project boxed beside it. These pin the composition rules:
// TF addresses keep their ids (the morph's identity continuity), app ids are
// namespaced, and nothing either side owns is dropped.
describe("renderCarveEstate — the carve estate frame (#254)", () => {
  const viewBox = (svg: string) => (svg.match(/viewBox="0 0 (\d+) (\d+)"/) ?? []).slice(1).map(Number);
  const appIr: GraphIR = {
    nodes: [
      { id: "apiLogs", kind: "LogGroup", lexicon: "aws", attrs: {} },
      { id: "assetsCdnDomain", kind: "SsmParameter", lexicon: "aws", attrs: {} },
    ],
    edges: [],
    groups: { byStack: { aws: ["apiLogs", "assetsCdnDomain"] } },
  };
  const estate = () => renderCarveEstate(bandedIr, appIr, { tfTitle: "legacy-tf — terraform", appTitle: "app — chant" });

  it("boxes both members and keeps the band panels inside the TF side", () => {
    const svg = estate().svg;
    expect(svg).toContain("legacy-tf — terraform");
    expect(svg).toContain("app — chant");
    expect(svg).toContain("carve now");
    expect(svg).toContain("leave in Terraform");
  });

  it("keeps TF ids untouched and namespaces app ids past collision reach", () => {
    const { svg, ir } = estate();
    for (const n of bandedIr.nodes) expect(svg).toContain(`data-node-id="${n.id}"`);
    expect(svg).toContain('data-node-id="app/apiLogs"');
    expect(svg).toContain('data-node-id="app/assetsCdnDomain"');
    const byStack = ir.groups.byStack as Record<string, string[]>;
    expect(byStack["app — chant"]).toEqual(["app/apiLogs", "app/assetsCdnDomain"]);
    expect(byStack["carve now"]).toHaveLength(20);
  });

  it("stays near a screen's shape with both members side by side", () => {
    const [w, h] = viewBox(estate().svg);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(w / h).toBeLessThan(4);
  });
});
