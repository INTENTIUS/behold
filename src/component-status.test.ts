import { describe, it, expect } from "vitest";
import { componentStatusColor, joinComponentStatus } from "./component-status.ts";
import type { GraphIR, ComponentStatusRow } from "@intentius/chant";

// Fixture rows mirror the actual `chant components status local --live --json`
// output verified against loomster on Floci (chant 0.18.27, M1.1 spike Q2) —
// 5 infra components live-but-unrecorded (no image digest to record), 2
// app components (frontend/backend) reconciled.
const RECONCILED: ComponentStatusRow = {
  component: "loom-backend",
  env: "local",
  reconciliation: "reconciled",
  detail: "recorded 2026-07-19T03:08:35.076Z (digest sha256:86bf5e3c…), live and consistent",
};
const UNRECORDED_LIVE: ComponentStatusRow = {
  component: "shared-foundation",
  env: "local",
  reconciliation: "unrecorded",
  detail: "live and chant-owned, but no release record exists — deployed outside the recorded path",
};
const UNRECORDED_NO_LIVE: ComponentStatusRow = {
  component: "loom-agents",
  env: "local",
  reconciliation: "unrecorded",
  detail: "no release record and nothing observed live",
};
const STALE: ComponentStatusRow = {
  component: "loom-db",
  env: "local",
  reconciliation: "stale",
  detail: "recorded 2026-07-18T00:00:00.000Z (digest sha256:aaa…), but nothing observed live now",
};
const DRIFTED: ComponentStatusRow = {
  component: "loom-cognito",
  env: "local",
  reconciliation: "drifted",
  detail: "recorded 2026-07-18T00:00:00.000Z (digest sha256:bbb…), but live configuration has drifted since",
};
const UNKNOWN: ComponentStatusRow = {
  component: "downstream-stub",
  env: "local",
  reconciliation: "unknown",
  detail: "recorded; live status not queried (pass --live to reconcile)",
};

describe("componentStatusColor", () => {
  it("paints reconciled good — recorded and live, consistent", () => {
    expect(componentStatusColor(RECONCILED)).toBe("good");
  });

  it("paints unrecorded-but-live good — deployed outside the release ledger", () => {
    expect(componentStatusColor(UNRECORDED_LIVE)).toBe("good");
  });

  it("paints unrecorded-and-not-live neutral — genuinely not deployed", () => {
    expect(componentStatusColor(UNRECORDED_NO_LIVE)).toBe("neutral");
  });

  it("paints stale warn — was recorded, now gone", () => {
    expect(componentStatusColor(STALE)).toBe("warn");
  });

  it("paints drifted warn — recorded, but live config changed", () => {
    expect(componentStatusColor(DRIFTED)).toBe("warn");
  });

  it("paints unknown neutral — defensive default (componentStatus always passes --live)", () => {
    expect(componentStatusColor(UNKNOWN)).toBe("neutral");
  });
});

describe("joinComponentStatus", () => {
  const ir: GraphIR = {
    nodes: [
      { id: "shared-foundation", kind: "Component", lexicon: "chant", attrs: { wave: 1 } },
      { id: "loom-backend", kind: "Component", lexicon: "chant", attrs: { wave: 3 } },
      { id: "no-status-row", kind: "Component", lexicon: "chant", attrs: { wave: 1 } },
    ],
    edges: [],
    groups: {},
  };

  it("tags a matched node with _status and _liveStatus (reconciliation + detail)", () => {
    const out = joinComponentStatus(ir, [RECONCILED, UNRECORDED_LIVE]);
    const backend = out.nodes.find((n) => n.id === "loom-backend")!;
    expect(backend.attrs._status).toBe("good");
    expect(backend.attrs._liveStatus).toEqual({ reconciliation: "reconciled", detail: RECONCILED.detail });
    // Existing attrs (e.g. wave, M1.0) survive the join.
    expect(backend.attrs.wave).toBe(3);

    const foundation = out.nodes.find((n) => n.id === "shared-foundation")!;
    expect(foundation.attrs._status).toBe("good");
    expect((foundation.attrs._liveStatus as { reconciliation: string }).reconciliation).toBe("unrecorded");
  });

  it("nests reconciliation + detail in an object attr, not flat scalars — pinhole's node-card renderer only picks up scalar attrs (isScalar), so a flat `_reconciliation` string would crowd out `wave` on the card; an object attr is skipped", () => {
    const out = joinComponentStatus(ir, [RECONCILED]);
    const backend = out.nodes.find((n) => n.id === "loom-backend")!;
    expect(typeof backend.attrs._liveStatus).toBe("object");
    expect(backend.attrs._reconciliation).toBeUndefined();
    expect(backend.attrs._statusDetail).toBeUndefined();
  });

  it("leaves a node with no matching row untouched — no colour, no guessing", () => {
    const out = joinComponentStatus(ir, [RECONCILED]);
    const untouched = out.nodes.find((n) => n.id === "no-status-row")!;
    expect(untouched.attrs._status).toBeUndefined();
    expect(untouched.attrs).toEqual({ wave: 1 });
  });

  it("is pure — does not mutate the input IR", () => {
    const before = JSON.stringify(ir);
    joinComponentStatus(ir, [RECONCILED, UNRECORDED_LIVE]);
    expect(JSON.stringify(ir)).toBe(before);
  });

  it("carries edges and other IR fields through unchanged", () => {
    const withEdges: GraphIR = { ...ir, edges: [{ from: "loom-backend", to: "shared-foundation", kind: "ref" }] };
    const out = joinComponentStatus(withEdges, [RECONCILED]);
    expect(out.edges).toEqual(withEdges.edges);
  });
});
