import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR, IRNode } from "@intentius/chant";
import { applyHelmRenderDrift, helmRenderReport, renderIdentity, observedReleaseFor } from "./helm-drift.ts";
import type { HelmRenderRecord, HelmRenderLiveDiff } from "./chant.ts";
import type { LiveArtifactObservation } from "./chant.ts";

/**
 * The helm render-drift axis (#146's deferred half; chant#1249/#1250, epic
 * chant#1228 Phase 6).
 *
 * ## Fixture provenance
 *
 * `__fixtures__/helm-render-live-diff.json` is REAL output, not a hand-written
 * shape. Every layer of it was produced by the real thing:
 *
 *   1. A four-document chart (Deployment, ConfigMap, hook Job, ClusterRole)
 *      rendered by the actual helm binary, v4.1.1, invoked the way chant's
 *      pinned render path invokes it:
 *        helm template web ./tiny --namespace shop --kube-version 1.33.0
 *   2. Those bytes persisted through chant 0.52.2's own `persistHelmRender`
 *      (lexicons/helm/src/render-store.ts), so the content digest, the
 *      per-document digests and the byte-span index are exactly what the
 *      render store holds.
 *   3. Diffed by chant 0.52.2's own `diffRenderLive`
 *      (lexicons/helm/src/render-diff.ts) against a `fakeCluster` at the k8s
 *      API edge — the same seam chant's own render-diff.test.ts and
 *      deep-observe.test.ts use, and the only synthetic layer, because the
 *      alternative is a real cluster in CI.
 *   4. Serialized in exactly the envelope `chant helm diff <content-digest>
 *      <environment> --live --json` prints (commands.ts `diffHandler`):
 *      `{ contentDigest, environment, manifest, diff }`.
 *
 * The file carries four cases under those keys: `drifted` (live moved off the
 * render), `clean` (live matches it), `empty` (the live read came back with
 * nothing), and `missing` — chant's real `{ found: false }` refusal for a
 * digest the store has never seen, which the CLI turns into exit 1.
 *
 * The one shape NOT taken from a run is `HelmRenderRecord`: producing a real
 * one needs the chant Composite runtime evaluating a project's source, so the
 * records below are built to chant 0.52.2's `HelmRenderRecord` interface
 * (lexicons/helm/src/render.ts:138) by hand.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, "__fixtures__", "helm-render-live-diff.json"), "utf8")) as {
  drifted: HelmRenderLiveDiff;
  clean: HelmRenderLiveDiff;
  empty: HelmRenderLiveDiff;
  missing: { found: false; contentDigest: string };
};

/** A pinned render: `contentDigest` present, so it reached the store. */
const pinned: HelmRenderRecord = {
  name: "web",
  chart: "tiny",
  version: "0.1.0",
  capabilityProfile: { name: "prod-1-33", kubeVersion: "1.33.0", apiVersions: [] },
  inputDigest: FIXTURE.drifted.manifest.inputDigest,
  contentDigest: FIXTURE.drifted.manifest.contentDigest,
};

/** An unpinned render: no capability profile, so chant recorded no digests. */
const unpinned: HelmRenderRecord = { name: "web", chart: "tiny", version: "0.1.0" };

const chartNode = (id: string, name: string, status?: string): IRNode => ({
  id,
  kind: "Helm::Chart",
  lexicon: "helm",
  attrs: { name, ...(status ? { _status: status } : {}) },
});

const irOf = (nodes: IRNode[]): GraphIR => ({ nodes, edges: [], groups: {} });

describe("helmRenderReport — the verdict (#146's deferred half)", () => {
  test("live moved off the pinned render: drifted, carrying every changed property", () => {
    const r = helmRenderReport(pinned, FIXTURE.drifted);

    expect(r.verdict).toBe("drifted");
    expect(r.reason).toBeUndefined();
    // Two documents moved: the Deployment (scaled AND re-imaged) and the
    // pre-install hook Job. A hook is just another rendered document to the
    // render store's index, which is why it shows up here at all (chant#1250).
    expect(r.counts).toEqual({ drifted: 2, changes: 3, unchanged: 2, unobserved: 0, undeclared: 0 });
    expect(r.drifted?.map((d) => d.name)).toEqual(["Deployment/shop/web", "Job/shop/web-migrate"]);
    expect(r.drifted?.[0].changes).toContainEqual({ path: "spec.replicas", kind: "changed", declared: 2, live: 3 });
    expect(r.drifted?.[1].name).toBe("Job/shop/web-migrate");
  });

  test("live matches the pinned render: in-sync, and no drifted documents", () => {
    const r = helmRenderReport(pinned, FIXTURE.clean);

    expect(r.verdict).toBe("in-sync");
    expect(r.drifted).toBeUndefined();
    expect(r.counts).toEqual({ drifted: 0, changes: 0, unchanged: 4, unobserved: 0, undeclared: 0 });
  });

  test("a diff with no rows at all is a hole, never a clean bill", () => {
    // chant's real output for a render whose documents the live read returned
    // nothing for: every bucket empty. A stored render HAS documents by
    // definition, so zero rows is a failed read wearing a clean diff's clothes
    // — the exact mistake #1089's tri-state exists to prevent.
    expect(FIXTURE.empty.diff.unchanged).toEqual([]);

    const r = helmRenderReport(pinned, FIXTURE.empty);
    expect(r.verdict).toBe("unobserved");
    expect(r.reason).toBe("nothing-observed");
    expect(r.verdict).not.toBe("in-sync");
  });

  test("a digest the store has never seen is unobserved, not clean — chant refuses it and so do we", () => {
    // `chant helm diff` exits 1 on this, which `helmRenderDiffLive` turns into
    // `undefined` rather than a partial object.
    expect(FIXTURE.missing.found).toBe(false);

    const r = helmRenderReport(pinned, undefined);
    expect(r.verdict).toBe("unobserved");
    expect(r.reason).toBe("no-stored-render");
  });

  test("an unpinned render has no content identity to diff — its own reason, not the store's", () => {
    const r = helmRenderReport(unpinned, undefined);
    expect(r.verdict).toBe("unobserved");
    // Distinct from "no-stored-render": "you never opted in" and "the store
    // lost it" are different things to go fix.
    expect(r.reason).toBe("unpinned");
    expect(r.provenance).toBeUndefined();
  });

  test("holes never un-observe real drift: a diff with both is drifted", () => {
    const live: HelmRenderLiveDiff = {
      ...FIXTURE.drifted,
      diff: { ...FIXTURE.drifted.diff, unobserved: [{ name: "ConfigMap/shop/web-config", reason: "read-failed" }] },
    };
    const r = helmRenderReport(pinned, live);
    expect(r.verdict).toBe("drifted");
    expect(r.counts?.unobserved).toBe(1);
  });

  test("some documents read and some not is unobserved — 'in sync' would be more than we know", () => {
    const live: HelmRenderLiveDiff = {
      ...FIXTURE.clean,
      diff: {
        ...FIXTURE.clean.diff,
        unchanged: ["ConfigMap/shop/web-config"],
        unobserved: [{ name: "Deployment/shop/web", reason: "read-failed", detail: "connection refused" }],
      },
    };
    const r = helmRenderReport(pinned, live);
    expect(r.verdict).toBe("unobserved");
    expect(r.reason).toBe("partly-observed");
  });

  test("the provenance record rides along — the pinned-render facts #234 asked about", () => {
    const p = helmRenderReport(pinned, FIXTURE.drifted).provenance!;

    expect(p.contentDigest).toBe(FIXTURE.drifted.manifest.contentDigest);
    expect(p.inputDigest).toBe(FIXTURE.drifted.manifest.inputDigest);
    expect(p.valuesDigest).toBe(FIXTURE.drifted.manifest.valuesDigest);
    expect(p.chart).toBe("tiny");
    expect(p.releaseName).toBe("web");
    expect(p.namespace).toBe("shop");
    // The cluster profile the bytes were pinned against, and the two binaries
    // that produced them — the fields that explain a digest mismatch between
    // two machines (RenderManifest.helmVersion's own doc comment).
    expect(p.profile).toBe("prod-1-33");
    expect(p.kubeVersion).toBe("1.33.0");
    expect(p.helmVersion).toBe("v4.1.1");
    expect(p.chantVersion).toBe("0.52.2");
    expect(p.sourceRef).toBe("a2710ad");
  });
});

describe("applyHelmRenderDrift — the paint", () => {
  test("a drifted render repaints its chart warn, the colour a drifted component gets", () => {
    // Presence (#146) said `good`: the release IS installed and deployed. The
    // render diff says its live objects have moved off the pinned bytes.
    const ir = irOf([chartNode("tinyChart", "tiny", "good")]);
    const counts = applyHelmRenderDrift(ir, [helmRenderReport(pinned, FIXTURE.drifted)]);

    expect(counts).toEqual({ charts: 1, drifted: 1 });
    expect(ir.nodes[0].attrs!._status).toBe("warn");
    expect((ir.nodes[0].attrs!._renderDrift as { verdict: string }).verdict).toBe("drifted");
  });

  test("in-sync records the verdict but never repaints — matching bytes don't heal a failed release", () => {
    // A `warn` release (helm status `failed`) whose manifests match live is
    // still a failed release. The render axis is not entitled to say otherwise.
    const ir = irOf([chartNode("tinyChart", "tiny", "warn")]);
    const counts = applyHelmRenderDrift(ir, [helmRenderReport(pinned, FIXTURE.clean)]);

    expect(counts).toEqual({ charts: 1, drifted: 0 });
    expect(ir.nodes[0].attrs!._status).toBe("warn");
    expect((ir.nodes[0].attrs!._renderDrift as { verdict: string }).verdict).toBe("in-sync");
  });

  test("unobserved leaves the presence colour exactly where #146 put it", () => {
    const ir = irOf([chartNode("tinyChart", "tiny", "good")]);
    applyHelmRenderDrift(ir, [helmRenderReport(unpinned, undefined)]);

    // Presence was genuinely observed — the release IS installed. Only the
    // render comparison is missing, so painting `neutral` here would throw
    // away a fact we have.
    expect(ir.nodes[0].attrs!._status).toBe("good");
    expect(ir.nodes[0].attrs!._renderDrift).toMatchObject({ verdict: "unobserved", reason: "unpinned" });
  });

  test("a chart no render mentions is untouched — not every declared chart is rendered", () => {
    const ir = irOf([chartNode("otherChart", "somebody-else", "accent")]);
    const counts = applyHelmRenderDrift(ir, [helmRenderReport(pinned, FIXTURE.drifted)]);

    expect(counts).toEqual({ charts: 0, drifted: 0 });
    expect(ir.nodes[0].attrs!._status).toBe("accent");
    expect(ir.nodes[0].attrs!._renderDrift).toBeUndefined();
  });

  test("no reports at all is a no-op — a project without `chant helm` stays at #146", () => {
    const ir = irOf([chartNode("tinyChart", "tiny", "good")]);
    expect(applyHelmRenderDrift(ir, [])).toEqual({ charts: 0, drifted: 0 });
    expect(ir.nodes[0].attrs!._renderDrift).toBeUndefined();
  });

  test("one chart rendered twice reports its worst news, and keeps both renders", () => {
    const ir = irOf([chartNode("tinyChart", "tiny", "good")]);
    const clean = helmRenderReport({ ...pinned, name: "web-staging" }, FIXTURE.clean);
    const drifted = helmRenderReport({ ...pinned, name: "web-prod" }, FIXTURE.drifted);
    applyHelmRenderDrift(ir, [clean, drifted]);

    expect(ir.nodes[0].attrs!._status).toBe("warn");
    const rd = ir.nodes[0].attrs!._renderDrift as { verdict: string; renders: { render: string }[] };
    expect(rd.verdict).toBe("drifted");
    expect(rd.renders.map((r) => r.render)).toEqual(["web-staging", "web-prod"]);
  });

  test("non-chart nodes are never touched", () => {
    const ir = irOf([
      { id: "dep", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { name: "tiny", _status: "good" } },
      { id: "rel", kind: "Helm::Release", lexicon: "helm", attrs: { name: "tiny", _status: "good" } },
    ]);
    applyHelmRenderDrift(ir, [helmRenderReport(pinned, FIXTURE.drifted)]);

    for (const n of ir.nodes) {
      expect(n.attrs!._status).toBe("good");
      expect(n.attrs!._renderDrift).toBeUndefined();
    }
  });
});


// ── The identity axis (chant#2031, chant ≥ 0.54.0) ───────────────────────────

const release = (attributes: Record<string, unknown>, status = "deployed"): LiveArtifactObservation => ({
  type: "Helm::Release",
  status,
  attributes: { chart: "tiny-0.1.0", revision: "2", ...attributes },
});

describe("renderIdentity — was the running release deployed from this render", () => {
  const CONTENT = pinned.contentDigest!;
  const INPUT = pinned.inputDigest!;

  test("pinned deploy of this render: content digests equal — byte for byte", () => {
    const obs = { key: "release/shop/web", observation: release({ inputDigest: INPUT, contentDigest: CONTENT }) };
    expect(renderIdentity(pinned, obs)).toEqual({
      match: "content",
      declared: { inputDigest: INPUT, contentDigest: CONTENT },
      observed: { release: "shop/web", inputDigest: INPUT, contentDigest: CONTENT },
    });
  });

  test("unpinned deploy of the same inputs: input digests equal — the same chart, values and profile", () => {
    const obs = { key: "release/shop/web", observation: release({ inputDigest: INPUT }) };
    expect(renderIdentity(pinned, obs).match).toBe("input");
  });

  test("a release deployed from something else is a mismatch, on whichever digest kind both sides have", () => {
    expect(renderIdentity(pinned, { key: "release/shop/web", observation: release({ inputDigest: INPUT, contentDigest: "sha256:elsewhere" }) }).match).toBe("mismatch");
    expect(renderIdentity(pinned, { key: "release/shop/web", observation: release({ inputDigest: "sha256:elsewhere" }) }).match).toBe("mismatch");
  });

  test("a release no ledger record names is unrecorded, never a mismatch — absence is not disagreement", () => {
    const i = renderIdentity(pinned, { key: "release/shop/web", observation: release({}) });
    expect(i.match).toBe("unrecorded");
    expect(i.observed).toEqual({ release: "shop/web" });
    expect(renderIdentity(pinned, undefined).match).toBe("unrecorded");
  });

  test("an unpinned declared render has nothing to compare, whatever the release records", () => {
    const i = renderIdentity(unpinned, { key: "release/shop/web", observation: release({ inputDigest: INPUT }) });
    expect(i.match).toBe("unpinned");
    expect(i.declared).toEqual({});
  });
});

describe("observedReleaseFor — the release a render produced", () => {
  const map = {
    "release/shop/web": release({ inputDigest: "sha256:shop" }),
    "release/staging/web": release({ inputDigest: "sha256:staging" }),
    "release/shop/other": release({}),
  };

  test("matches on the release name, narrowed by the manifest's namespace when given", () => {
    expect(observedReleaseFor(pinned, map, "staging")?.key).toBe("release/staging/web");
    expect(observedReleaseFor(pinned, map, "shop")?.key).toBe("release/shop/web");
  });

  test("with no namespace the first candidate wins; a name nothing matches is undefined; no map is undefined", () => {
    expect(observedReleaseFor(pinned, map)?.key).toBe("release/shop/web");
    expect(observedReleaseFor({ ...pinned, name: "api" }, map)).toBeUndefined();
    expect(observedReleaseFor(pinned, undefined)).toBeUndefined();
  });
});

describe("the identity axis on the report and the paint", () => {
  const observedMismatch = { "release/shop/web": release({ inputDigest: "sha256:elsewhere", contentDigest: "sha256:elsewhere" }) };
  const observedMatch = { "release/shop/web": release({ inputDigest: pinned.inputDigest!, contentDigest: pinned.contentDigest! }) };

  test("the report carries identity only when an observation map was given — no map, no invented verdict", () => {
    expect(helmRenderReport(pinned, FIXTURE.clean).identity).toBeUndefined();
    const r = helmRenderReport(pinned, FIXTURE.clean, observedMatch);
    expect(r.verdict).toBe("in-sync");
    expect(r.identity?.match).toBe("content");
  });

  test("the namespace the resolved manifest names picks the release when the map has several", () => {
    const two = { "release/other/web": release({ inputDigest: "sha256:x" }), ...observedMatch };
    // FIXTURE.clean's manifest names namespace "shop".
    expect(helmRenderReport(pinned, FIXTURE.clean, two).identity?.observed.release).toBe("shop/web");
  });

  test("a mismatch repaints the chart warn even when the live diff is clean — what runs was not deployed from this render", () => {
    const ir = irOf([chartNode("c", "tiny", "good")]);
    const r = helmRenderReport(pinned, FIXTURE.clean, observedMismatch);
    expect(r.verdict).toBe("in-sync");
    const out = applyHelmRenderDrift(ir, [r]);
    expect(out).toEqual({ charts: 1, drifted: 1 });
    expect(ir.nodes[0].attrs!._status).toBe("warn");
  });

  test("a match never repaints — identity agreeing does not heal anything", () => {
    const ir = irOf([chartNode("c", "tiny", "warn")]);
    applyHelmRenderDrift(ir, [helmRenderReport(pinned, FIXTURE.clean, observedMatch)]);
    expect(ir.nodes[0].attrs!._status).toBe("warn");
    const ir2 = irOf([chartNode("c", "tiny", "good")]);
    applyHelmRenderDrift(ir2, [helmRenderReport(pinned, FIXTURE.clean, observedMatch)]);
    expect(ir2.nodes[0].attrs!._status).toBe("good");
  });

  test("worst-of across two renders: a mismatch outranks a hole, and drift outranks a mismatch", () => {
    const hole = helmRenderReport({ ...pinned, name: "web-b" }, undefined, observedMatch);
    const mismatch = helmRenderReport(pinned, FIXTURE.clean, observedMismatch);
    const drifted = helmRenderReport({ ...pinned, name: "web-c" }, FIXTURE.drifted, observedMatch);
    const ir = irOf([chartNode("c", "tiny", "good")]);
    applyHelmRenderDrift(ir, [hole, mismatch]);
    expect((ir.nodes[0].attrs!._renderDrift as { identity?: { match: string } }).identity?.match).toBe("mismatch");
    const ir2 = irOf([chartNode("c", "tiny", "good")]);
    applyHelmRenderDrift(ir2, [mismatch, drifted]);
    expect((ir2.nodes[0].attrs!._renderDrift as { verdict: string }).verdict).toBe("drifted");
  });
});
