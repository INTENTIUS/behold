import { describe, it, expect } from "vitest";
import { componentStatusColor, joinComponentStatus, joinTickVerdicts } from "./component-status.ts";
import { TICK_VERDICT_TTL_MS, type TickComponentVerdicts } from "./operator.ts";
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

// behold#98 (chant#1300) — the substrate-neutral tier. `stack` only exists
// where a substrate has a deploy object to read, which is AWS and nowhere
// else, so before this every floci-az / floci-gcp component fell to the coarse
// `live` boolean and painted green-or-grey with nothing behind it.
describe("componentStatusColor — resource rollup (behold#98)", () => {
  const withRollup = (
    resources: { total: number; present: number; absent: number; unobserved: number },
    over: Partial<ComponentStatusRow> = {},
  ) =>
    ({
      component: "az-api",
      env: "local",
      reconciliation: "unrecorded" as const,
      detail: "no release record and nothing observed live",
      ...over,
      resources,
    });

  it("every resource present paints good", () => {
    expect(componentStatusColor(withRollup({ total: 3, present: 3, absent: 0, unobserved: 0 }))).toBe("good");
  });

  it("none present paints neutral", () => {
    expect(componentStatusColor(withRollup({ total: 3, present: 0, absent: 3, unobserved: 0 }))).toBe("neutral");
  });

  it("partly there paints warn — the boolean rounded this up to live", () => {
    expect(componentStatusColor(withRollup({ total: 3, present: 2, absent: 1, unobserved: 0 }))).toBe("warn");
  });

  it("a hole paints accent — never good, never neutral", () => {
    // chant could not read part of this component, so neither "deployed" nor
    // "not deployed" is a claim behold holds. This is the #1089 distinction:
    // painting it grey would render "did not look" as "not there".
    expect(componentStatusColor(withRollup({ total: 3, present: 2, absent: 0, unobserved: 1 }))).toBe("accent");
  });

  it("a hole outranks a green majority", () => {
    expect(componentStatusColor(withRollup({ total: 4, present: 3, absent: 0, unobserved: 1 }))).toBe("accent");
  });

  it("the rollup outranks the coarse live boolean", () => {
    // `live: true` because something under the component was seen; the rollup
    // knows two of its three resources are gone.
    const row = withRollup({ total: 3, present: 1, absent: 2, unobserved: 0 }, { live: true });
    expect(componentStatusColor(row)).toBe("warn");
  });

  it("an empty rollup falls through rather than claiming anything", () => {
    const row = withRollup({ total: 0, present: 0, absent: 0, unobserved: 0 }, { live: true });
    expect(componentStatusColor(row)).toBe("good"); // the `live` tier
  });

  it("carries the counts onto the node so the panel can say why", () => {
    const ir: GraphIR = {
      nodes: [{ id: "az-api", kind: "component", lexicon: "azure" }],
      edges: [],
      groups: {},
    } as unknown as GraphIR;
    const rows = [withRollup({ total: 4, present: 3, absent: 0, unobserved: 1 })] as unknown as ComponentStatusRow[];
    const out = joinComponentStatus(ir, rows);
    const attrs = out.nodes[0].attrs as Record<string, unknown>;
    expect(attrs._status).toBe("accent");
    expect((attrs._liveStatus as { resources?: unknown }).resources).toEqual({
      total: 4,
      present: 3,
      absent: 0,
      unobserved: 1,
    });
  });
});

// behold#100 — AWS is the reference lane, so it has to actually RUN on the
// rollup. Until now a present `stack` returned before the rollup was read, and
// AWS is the only substrate with a stack: the substrate #98 was verified
// against was the one substrate that never used it. The split now is that the
// rollup answers "is it there" and the stack answers "did the deploy go wrong",
// so a HEALTHY stack no longer overrules the resources and an UNHEALTHY one
// still decides (M2's loom-db case, unchanged).
describe("componentStatusColor — AWS reads the rollup too (behold#100)", () => {
  const aws = (
    resources: { total: number; present: number; absent: number; unobserved: number },
    stack: { name: string; status?: string; healthy?: boolean },
  ) =>
    ({
      component: "loom-backend",
      env: "local",
      reconciliation: "reconciled" as const,
      detail: "recorded 2026-07-19T03:08:35.076Z (digest sha256:86bf5e3c…), live and consistent",
      live: true,
      stack,
      resources,
    }) as unknown as ComponentStatusRow;

  const HEALTHY = { name: "loom-local-a-loom-backend", status: "CREATE_COMPLETE", healthy: true };
  const ROLLBACK = { name: "loom-local-a-loom-db", status: "UPDATE_ROLLBACK_COMPLETE", healthy: false };
  const IN_PROGRESS = { name: "loom-local-a-loom-frontend", status: "UPDATE_IN_PROGRESS", healthy: false };

  it("healthy stack + every resource present -> good (unchanged)", () => {
    expect(componentStatusColor(aws({ total: 3, present: 3, absent: 0, unobserved: 0 }, HEALTHY))).toBe("good");
  });

  it("healthy stack + nothing present -> neutral, NOT good", () => {
    // A stack whose last operation succeeded but whose resources did not come
    // back is not a green component. (On AWS today the rollup reads
    // CloudFormation's own inventory, so the two rarely disagree this hard —
    // see the #100 note in component-status.ts on what the colour does and
    // does not claim.)
    expect(componentStatusColor(aws({ total: 3, present: 0, absent: 3, unobserved: 0 }, HEALTHY))).toBe("neutral");
  });

  it("healthy stack + partly present -> warn, NOT good", () => {
    expect(componentStatusColor(aws({ total: 3, present: 2, absent: 1, unobserved: 0 }, HEALTHY))).toBe("warn");
  });

  it("healthy stack + a hole -> accent, NOT good — chant could not read part of it", () => {
    expect(componentStatusColor(aws({ total: 3, present: 2, absent: 0, unobserved: 1 }, HEALTHY))).toBe("accent");
  });

  it("a rollback stack still wins over a fully-present rollup — M2's loom-db proof case survives", () => {
    expect(componentStatusColor(aws({ total: 3, present: 3, absent: 0, unobserved: 0 }, ROLLBACK))).toBe("warn");
  });

  it("a mid-deploy stack still wins over a fully-present rollup — in-flight explains any rollup shape under it", () => {
    expect(componentStatusColor(aws({ total: 3, present: 3, absent: 0, unobserved: 0 }, IN_PROGRESS))).toBe("accent");
  });

  it("a mid-deploy stack outranks a half-built rollup rather than calling it drift", () => {
    // Partial presence during a deploy is expected, not a broken component.
    expect(componentStatusColor(aws({ total: 3, present: 1, absent: 2, unobserved: 0 }, IN_PROGRESS))).toBe("accent");
  });

  it("a healthy stack with no rollup still paints from the live boolean — an older chant is unaffected", () => {
    const row = {
      component: "loom-backend",
      env: "local",
      reconciliation: "reconciled" as const,
      detail: "live and consistent",
      live: true,
      stack: HEALTHY,
    } as unknown as ComponentStatusRow;
    expect(componentStatusColor(row)).toBe("good");
  });
});

// An ABSENT deploy unit comes back as `stack: {name}` alone — no `status`, no
// `healthy`. That is what chant reports for every kubectl-apply/helm-upgrade
// unit whose selector matched nothing, and for a CFN stack that does not
// exist. Absence is not unhealthiness: reading `healthy: undefined` as "in
// flux" painted five of kubemicrovm-ops's seven components accent on a fully
// deployed estate, because the accent branch returned before their all-present
// rollups were ever consulted.
describe("componentStatusColor — an absent stack ({name} only) asserts nothing", () => {
  const ABSENT = { name: "kmv-workload" };

  it("absent stack + every resource present -> good, from the rollup (the kubemicrovm workload case)", () => {
    const row = {
      component: "workload",
      env: "dev",
      reconciliation: "unrecorded" as const,
      detail: "no release record and nothing observed live",
      live: false,
      stack: ABSENT,
      resources: { total: 6, present: 6, absent: 0, unobserved: 0 },
    } as unknown as ComponentStatusRow;
    expect(componentStatusColor(row)).toBe("good");
  });

  it("absent stack + no rollup -> neutral, from the live boolean (an omitted plane)", () => {
    const row = {
      component: "ci-plane",
      env: "dev",
      reconciliation: "unrecorded" as const,
      detail: "no release record and nothing observed live",
      live: false,
      stack: ABSENT,
    } as unknown as ComponentStatusRow;
    expect(componentStatusColor(row)).toBe("neutral");
  });

  it("healthy: false still decides even without a status string", () => {
    const row = {
      component: "operator",
      env: "dev",
      reconciliation: "unrecorded" as const,
      detail: "release found unhealthy",
      live: false,
      stack: { name: "cert-manager", healthy: false },
    } as unknown as ComponentStatusRow;
    expect(componentStatusColor(row)).toBe("accent");
  });
});

// ── The converge tick as a second source for the last tier (chant#2027) ──────
//
// The verdicts here are chant's own, from chant PR #2042's
// `packages/core/src/lifecycle/converge-ledger.test.ts` ("round-trips on a
// record, naming the component that tripped the tick's aggregate unknown") —
// the same values src/__fixtures__/operator-status/verdicts.status.json carries
// and src/operator.test.ts pins the wire shape of. The `op`/`env`/`at` frame is
// that same file's `makeInput()`.

describe("joinTickVerdicts (chant#2027)", () => {
  const AT = "2026-01-01T00:00:00.000Z";
  const T = Date.parse(AT);
  const FRESH = T + 60_000;
  const STALE_NOW = T + TICK_VERDICT_TTL_MS + 1;

  const TICK: TickComponentVerdicts = {
    op: "fountain-converge",
    env: "staging",
    at: AT,
    tickId: "9f1c7a52-3b64-4d0e-8a71-2e5c6d90b4af",
    verdicts: [
      { component: "api", reconciliation: "drifted", detail: "live digest differs", live: true },
      { component: "worker", reconciliation: "unknown", detail: "unreadable", unobserved: { reason: "no-credentials" } },
    ],
  };

  const dag = (): GraphIR => ({
    nodes: [
      { id: "api", kind: "Component", lexicon: "chant", attrs: { wave: 1 } },
      { id: "worker", kind: "Component", lexicon: "chant", attrs: { wave: 2 } },
      { id: "web", kind: "Component", lexicon: "chant", attrs: { wave: 3 } },
    ],
    edges: [],
    groups: {},
  });

  it("joins by component name — the same key joinComponentStatus uses", () => {
    const out = joinTickVerdicts(dag(), TICK, FRESH);
    const api = out.nodes.find((n) => n.id === "api")!;
    // `drifted` is componentStatusColor's reconciliation tier, and `warn` is
    // what that tier paints it — the tick reaches the same function, not a new
    // palette of its own.
    expect(api.attrs._status).toBe("warn");
    expect(api.attrs._tickStatus).toEqual({
      reconciliation: "drifted",
      detail: "live digest differs",
      live: true,
      op: "fountain-converge",
      env: "staging",
      at: AT,
      tickId: "9f1c7a52-3b64-4d0e-8a71-2e5c6d90b4af",
      stale: false,
    });
    expect(api.attrs.wave).toBe(1);
  });

  it("paints the unobserved component neutral and names why", () => {
    const worker = joinTickVerdicts(dag(), TICK, FRESH).nodes.find((n) => n.id === "worker")!;
    expect(worker.attrs._status).toBe("neutral");
    expect(worker.attrs._tickStatus).toMatchObject({ unobserved: { reason: "no-credentials" } });
  });

  it("NEVER overrides a live read — a node the live join already painted keeps its colour", () => {
    // The whole tiering: a stack, a rollup or a `live` boolean is what chant
    // sees now; a tick is what the operator saw at a stated instant.
    const painted = joinComponentStatus(dag(), [
      { component: "api", env: "staging", reconciliation: "reconciled", detail: "consistent", live: true } as ComponentStatusRow,
    ]);
    const api = joinTickVerdicts(painted, TICK, FRESH).nodes.find((n) => n.id === "api")!;
    expect(api.attrs._status).toBe("good"); // the live read's verdict, not the tick's `warn`
    // …and the tick is still carried, so the panel can show that the two differ.
    expect(api.attrs._tickStatus).toMatchObject({ reconciliation: "drifted", stale: false });
    expect(api.attrs._liveStatus).toMatchObject({ reconciliation: "reconciled" });
  });

  it("reaches only the reconciliation tier — the tick's own `live` boolean paints nothing", () => {
    // `api`'s verdict carries `live: true`, which as a live-read row would be
    // tier 3 and paint `good`. Through the tick it must land on `drifted`'s
    // `warn` instead.
    expect(joinTickVerdicts(dag(), TICK, FRESH).nodes.find((n) => n.id === "api")!.attrs._status).toBe("warn");
  });

  it("paints NOTHING once the tick is stale, but still names the verdict and its date", () => {
    const api = joinTickVerdicts(dag(), TICK, STALE_NOW).nodes.find((n) => n.id === "api")!;
    expect(api.attrs._status).toBeUndefined();
    expect(api.attrs._tickStatus).toMatchObject({ reconciliation: "drifted", at: AT, stale: true });
  });

  it("calls an undatable tick stale rather than painting from it", () => {
    const api = joinTickVerdicts(dag(), { ...TICK, at: "not-a-date" }, FRESH).nodes.find((n) => n.id === "api")!;
    expect(api.attrs._status).toBeUndefined();
    expect(api.attrs._tickStatus).toMatchObject({ stale: true });
  });

  it("leaves a component the tick didn't name untouched", () => {
    expect(joinTickVerdicts(dag(), TICK, FRESH).nodes.find((n) => n.id === "web")!.attrs).toEqual({ wave: 3 });
  });

  it("drops a verdict naming an entity this IR doesn't have — no invented node", () => {
    const tick = { ...TICK, verdicts: [{ component: "not-in-this-dag", reconciliation: "drifted" as const, detail: "d" }] };
    const out = joinTickVerdicts(dag(), tick, FRESH);
    expect(out.nodes.map((n) => n.id)).toEqual(["api", "worker", "web"]);
    for (const n of out.nodes) expect(n.attrs._tickStatus).toBeUndefined();
  });

  it("returns the input IR untouched when there is nothing to join", () => {
    const ir = dag();
    expect(joinTickVerdicts(ir, null, FRESH)).toBe(ir);
    expect(joinTickVerdicts(ir, undefined, FRESH)).toBe(ir);
    expect(joinTickVerdicts(ir, { ...TICK, verdicts: [] }, FRESH)).toBe(ir);
    expect(joinTickVerdicts(ir, { ...TICK, verdicts: [{ component: "nope", reconciliation: "drifted", detail: "d" }] }, FRESH)).toBe(ir);
  });

  it("omits the tick id when this chant recorded none (pre-0.53.1)", () => {
    const api = joinTickVerdicts(dag(), { ...TICK, tickId: null }, FRESH).nodes.find((n) => n.id === "api")!;
    expect(api.attrs._tickStatus).not.toHaveProperty("tickId");
  });

  it("is pure — does not mutate the input IR", () => {
    const ir = dag();
    const before = JSON.stringify(ir);
    joinTickVerdicts(ir, TICK, FRESH);
    expect(JSON.stringify(ir)).toBe(before);
  });

  it("carries edges and other IR fields through unchanged", () => {
    const withEdges: GraphIR = { ...dag(), edges: [{ from: "api", to: "worker", kind: "ref" }] };
    expect(joinTickVerdicts(withEdges, TICK, FRESH).edges).toEqual(withEdges.edges);
  });
});
