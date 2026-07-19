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

describe("componentStatusColor — pre-0.18.29 fallback (no live/stack at all)", () => {
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

// M2 (#54): chant 0.18.29 machine-readable palette. Fixtures below mirror the
// REAL `chant components status local --live --json` output verified live
// against the running loomster/Floci — `loom-db` is genuinely
// `UPDATE_ROLLBACK_COMPLETE` / `healthy: false` right now, which is exactly
// the M2 deliverable's proof case: it must read `warn` (red), not `good`.
const HEALTHY_STACK: ComponentStatusRow = {
  component: "loom-backend",
  env: "local",
  reconciliation: "reconciled",
  detail: "recorded 2026-07-19T03:08:35.076Z (digest sha256:86bf5e3c…), live and consistent",
  live: true,
  stack: { name: "loom-local-a-loom-backend", status: "CREATE_COMPLETE", healthy: true },
};
const LOOM_DB_ROLLBACK: ComponentStatusRow = {
  component: "loom-db",
  env: "local",
  reconciliation: "unrecorded",
  detail: "live and chant-owned, but no release record exists — deployed outside the recorded path",
  live: true,
  stack: { name: "loom-local-a-loom-db", status: "UPDATE_ROLLBACK_COMPLETE", healthy: false },
};
const CREATE_FAILED_STACK: ComponentStatusRow = {
  component: "loom-cognito",
  env: "local",
  reconciliation: "unrecorded",
  detail: "live and chant-owned, but no release record exists — deployed outside the recorded path",
  live: true,
  stack: { name: "loom-local-a-loom-cognito", status: "CREATE_FAILED", healthy: false },
};
const MID_DEPLOY_STACK: ComponentStatusRow = {
  component: "loom-frontend",
  env: "local",
  reconciliation: "unrecorded",
  detail: "live and chant-owned, but no release record exists — deployed outside the recorded path",
  live: true,
  stack: { name: "loom-local-a-loom-frontend", status: "UPDATE_IN_PROGRESS", healthy: false },
};
const LIVE_NO_STACK: ComponentStatusRow = {
  component: "shared-foundation",
  env: "local",
  reconciliation: "unrecorded",
  detail: "live and chant-owned, but no release record exists — deployed outside the recorded path",
  live: true,
  // No `stack` — a lexicon with no describeStackStatus, or a non-AWS component.
};
const NOT_LIVE_NO_STACK: ComponentStatusRow = {
  component: "loom-agents",
  env: "local",
  reconciliation: "unrecorded",
  detail: "no release record and nothing observed live",
  live: false,
};

describe("componentStatusColor — M2 (#54) machine-readable live/stack palette", () => {
  it("paints a healthy stack good, regardless of the reconciliation verdict", () => {
    expect(componentStatusColor(HEALTHY_STACK)).toBe("good");
  });

  it("paints a rollback stack warn — pinhole paints `warn` red (its theme's warnFill/warnStroke/warnBar are red-toned), NOT green — the M2 proof case (loom-db)", () => {
    expect(componentStatusColor(LOOM_DB_ROLLBACK)).toBe("warn");
  });

  it("paints a *_FAILED stack warn too", () => {
    expect(componentStatusColor(CREATE_FAILED_STACK)).toBe("warn");
  });

  it("paints a present-but-unhealthy, non-rollback/failed stack (e.g. *_IN_PROGRESS) accent — pinhole's blue 'in flux' paint, since it has no separate amber token", () => {
    expect(componentStatusColor(MID_DEPLOY_STACK)).toBe("accent");
  });

  it("falls back to the coarse `live` boolean when there's no `stack` — good when live", () => {
    expect(componentStatusColor(LIVE_NO_STACK)).toBe("good");
  });

  it("falls back to the coarse `live` boolean when there's no `stack` — neutral when not live", () => {
    expect(componentStatusColor(NOT_LIVE_NO_STACK)).toBe("neutral");
  });

  it("prefers `stack`/`live` over `reconciliation` — a stale/drifted verdict with a healthy stack still paints good", () => {
    expect(componentStatusColor({ ...STALE, live: true, stack: { name: "x", status: "CREATE_COMPLETE", healthy: true } })).toBe(
      "good",
    );
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

  it("M2 (#54): carries live/stack onto _liveStatus and paints from them — loom-db's real rollback stack", () => {
    const dbIr: GraphIR = {
      nodes: [{ id: "loom-db", kind: "Component", lexicon: "chant", attrs: { wave: 2 } }],
      edges: [],
      groups: {},
    };
    const out = joinComponentStatus(dbIr, [LOOM_DB_ROLLBACK]);
    const db = out.nodes.find((n) => n.id === "loom-db")!;
    expect(db.attrs._status).toBe("warn");
    expect(db.attrs._liveStatus).toEqual({
      reconciliation: "unrecorded",
      detail: LOOM_DB_ROLLBACK.detail,
      live: true,
      stack: { name: "loom-local-a-loom-db", status: "UPDATE_ROLLBACK_COMPLETE", healthy: false },
    });
  });

  it("omits `live`/`stack` from _liveStatus when the row doesn't carry them (pre-0.18.29 shape)", () => {
    const out = joinComponentStatus(ir, [RECONCILED]);
    const backend = out.nodes.find((n) => n.id === "loom-backend")!;
    expect(backend.attrs._liveStatus).toEqual({ reconciliation: "reconciled", detail: RECONCILED.detail });
    expect(backend.attrs._liveStatus).not.toHaveProperty("live");
    expect(backend.attrs._liveStatus).not.toHaveProperty("stack");
  });
});
