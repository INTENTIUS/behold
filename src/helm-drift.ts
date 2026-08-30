/**
 * The helm release's DRIFT axis (#146's deferred half).
 *
 * behold#146 shipped the helm lens as artifact presence and closed saying so:
 * `listArtifacts` was helm's only lifecycle hook, so "installed / not
 * installed / installed but unhealthy" was the entire verdict the surface
 * could support. src/helm-artifacts.ts still answers exactly that question,
 * unchanged — this module adds the second one it could not answer:
 *
 *   is the release the cluster is running still what the chart RENDERS?
 *
 * chant 0.49 (chant#1249 offline, chant#1250 live; epic chant#1228 Phase 6)
 * made that reachable, and behold's pinned chant ^0.52.1 carries it. The read
 * is two ordinary shell-outs (src/chant.ts): `chant helm renders --json` for
 * the project's declared renders, then `chant helm diff <content-digest>
 * <env> --live --json` per PINNED render. The second returns core's own
 * `DeepDiffResult` — the same property-drift rows, with the same
 * declared/live vocabulary, that the k8s deep read produces — so a release's
 * drift and a Deployment's drift are the same kind of fact, reported the same
 * way, and this module paints them the same colour.
 *
 * ## The palette
 *
 * The k8s side's precedent is src/component-status.ts: a `drifted`
 * reconciliation paints `warn`. So does a drifted render here, and the panel
 * word is "drifted" — the same word web/app.js's `FIELD_KIND_LABEL` already
 * uses for a changed property and `DIFF_LABEL` for a drifted entity.
 *
 * ## Why the verdict only ever DOWNGRADES the presence colour
 *
 * Presence and render-drift answer different questions, and the render diff
 * is not entitled to overrule presence in the flattering direction. A release
 * whose helm status is `failed` is `warn` whatever its manifests say —
 * matching bytes do not make a failed install healthy — so `in-sync` never
 * repaints a node `good`. Drift, being strictly bad news, does downgrade:
 * a `good` release whose live objects have moved off the pinned render reads
 * `warn`. The verdict is always recorded on `_renderDrift` regardless, so the
 * inspect panel tells the whole story even when the colour did not move.
 *
 * ## Why absence is never clean
 *
 * Every way this read can come back empty is a hole, not a clean bill:
 *
 *   render declares no capabilityProfile   -> "unpinned": an unpinned render's
 *                                             bytes are a function of the local
 *                                             helm binary's defaults, so it has
 *                                             no content identity to diff.
 *   digest not in the render store         -> "no-stored-render": chant refuses
 *                                             this diff (exit 1) rather than
 *                                             report it clean, and so do we.
 *   diff came back with no rows at all     -> "nothing-observed".
 *   some documents read, some not          -> "partly-observed": what was read
 *                                             matched, but "the release is in
 *                                             sync" is more than we know.
 *
 * All four are `unobserved`, none of them paints, and none of them is
 * `in-sync`. `chant helm` missing entirely (a project that does not install
 * the helm lexicon) produces no reports at all and leaves the lens exactly
 * where #146 left it.
 *
 * ## What is deliberately NOT wired
 *
 * The offline half, `chant helm diff <from-digest> <to-digest> --json`, is the
 * provenance comparison #234 asked for ("is prod running what staging
 * tested"). It is reachable and its JSON is good, but it takes TWO digests and
 * a consumer can only obtain a digest for a render it can DECLARE — the live
 * read reports no render identity at all, so there is no digest for "what prod
 * is actually running" to pass as the other side. That is chant#2031, filed
 * out of this work; src/helm-artifacts.test.ts pins the current attribute set
 * so the day it lands, the test fails at the join.
 *
 * The per-render provenance record such a comparison would read (`inputDigest`,
 * `valuesDigest`, `contentDigest`, `capabilityProfile`, `helmVersion`,
 * `chantVersion`, `renderedAt`, `sourceRef`) IS carried through to the panel
 * below, so the build-side half of the answer is on the node today.
 */
import type { GraphIR } from "@intentius/chant";
import type { GraphOptions, HelmRenderLiveDiff, HelmRenderRecord, HelmPropertyDrift } from "./chant.ts";
import { helmRenderDiffLive, helmRenders } from "./chant.ts";
import { estateReadPool, mapPool } from "./estate.ts";

/** The three answers this axis can give. `in-sync` and `unobserved` never
 * paint; only `drifted` does. */
export type HelmRenderVerdict = "drifted" | "in-sync" | "unobserved";

/** Why nothing was compared — the honest holes, never folded into "clean".
 * Mirrors src/chant.ts's `UnobservedReason` idiom for the k8s side. */
export type HelmRenderUnobservedReason = "unpinned" | "no-stored-render" | "nothing-observed" | "partly-observed";

/** One document whose live state has moved off the pinned render. */
export interface HelmDriftedDocument {
  /** chant's row key: `<Kind>/<namespace>/<name>`, or `cluster:<Kind>/<name>`. */
  name: string;
  /** The chant entity type the k8s reader resolved, e.g. `K8s::Apps::Deployment`. */
  type: string;
  changes: HelmPropertyDrift[];
}

/** The render's provenance, straight off the stored `RenderManifest` — the
 * pinned-render record chant#1228 introduced. Carried onto the node so the
 * panel can say WHICH bytes were compared and where they came from, not just
 * that they disagreed. */
export interface HelmRenderProvenance {
  contentDigest: string;
  inputDigest: string;
  valuesDigest: string;
  chart: string;
  chartVersion: string | null;
  repo: string | null;
  releaseName: string;
  namespace: string | null;
  /** The cluster profile the render was pinned against. */
  profile: string;
  kubeVersion: string;
  renderedAt: string;
  helmVersion: string;
  chantVersion: string;
  /** The source ref the render was produced from, when one was recorded. */
  sourceRef: string | null;
}

/** What this axis found for one declared render. */
export interface HelmRenderReport {
  /** The render's declared name — also the helm release name in the bytes. */
  render: string;
  /** The chart, the join key onto a declared `Helm::Chart` node. */
  chart: string;
  verdict: HelmRenderVerdict;
  /** Only on `unobserved`. */
  reason?: HelmRenderUnobservedReason;
  /** Only when a diff actually ran. */
  counts?: { drifted: number; changes: number; unchanged: number; unobserved: number; undeclared: number };
  /** Only on `drifted`. */
  drifted?: HelmDriftedDocument[];
  /** Only when a stored render was resolved. */
  provenance?: HelmRenderProvenance;
}

/** Total property changes across every drifted document. */
function countChanges(docs: { changes: HelmPropertyDrift[] }[]): number {
  return docs.reduce((n, d) => n + d.changes.length, 0);
}

function provenanceOf(live: HelmRenderLiveDiff): HelmRenderProvenance {
  const m = live.manifest;
  return {
    contentDigest: m.contentDigest,
    inputDigest: m.inputDigest,
    valuesDigest: m.valuesDigest,
    chart: m.chart,
    chartVersion: m.chartVersion,
    repo: m.repo,
    releaseName: m.releaseName,
    namespace: m.namespace,
    profile: m.capabilityProfile?.cluster ?? "",
    kubeVersion: m.capabilityProfile?.kubeVersion ?? "",
    renderedAt: m.renderedAt,
    helmVersion: m.helmVersion,
    chantVersion: m.chantVersion,
    sourceRef: m.sourceRef,
  };
}

/**
 * The verdict for one declared render, from its record and whatever
 * `chant helm diff --live --json` returned (`undefined` when chant refused
 * the diff or the read failed — see `helmRenderDiffLive`).
 *
 * Order matters: drift is decided FIRST. A diff that found real drift and
 * also had holes is drift — the holes cannot un-observe what was observed.
 * Only after that does an empty read become a hole rather than a clean bill.
 *
 * Pure; exported for testing.
 */
export function helmRenderReport(record: HelmRenderRecord, live: HelmRenderLiveDiff | undefined): HelmRenderReport {
  const base = { render: record.name, chart: record.chart };

  if (!live) {
    // An unpinned render never reached the store, so chant had nothing to
    // resolve; a pinned one that is missing was pruned or rendered elsewhere.
    // Distinguishing the two is the difference between "you have not opted in"
    // and "the store lost it", which are different things to go fix.
    return { ...base, verdict: "unobserved", reason: record.contentDigest ? "no-stored-render" : "unpinned" };
  }

  const d = live.diff;
  const counts = {
    drifted: d.drifted.length,
    changes: countChanges(d.drifted),
    unchanged: d.unchanged.length,
    unobserved: d.unobserved.length,
    undeclared: d.undeclaredEntities.length,
  };
  const provenance = provenanceOf(live);

  if (d.drifted.length > 0) {
    return { ...base, verdict: "drifted", counts, provenance, drifted: d.drifted };
  }
  // Nothing came back at all. The render has documents (that is what a stored
  // render IS), so zero rows is a failed read wearing a clean diff's clothes.
  if (d.drifted.length + d.accepted.length + d.unchanged.length === 0) {
    return { ...base, verdict: "unobserved", reason: "nothing-observed", counts, provenance };
  }
  if (d.unobserved.length > 0) {
    return { ...base, verdict: "unobserved", reason: "partly-observed", counts, provenance };
  }
  return { ...base, verdict: "in-sync", counts, provenance };
}

/**
 * Read the render-drift axis for `env`: the project's declared renders, then
 * one live diff per PINNED one.
 *
 * Returns `[]` — not a set of holes — when the project has no `chant helm` at
 * all (it does not install the helm lexicon, so the command group was never
 * mounted) or declares no renders. That is the difference between "this axis
 * does not apply here" and "this axis applies and could not be read": the
 * first must leave the lens exactly at #146's presence verdict, and inventing
 * an `unobserved` report for a project that has no renders would paint a hole
 * where there is no question.
 *
 * An unpinned render DOES get a report, because it is a declared render this
 * axis genuinely could not compare — the "unpinned" hole, which is actionable
 * (declare a capabilityProfile) in a way a missing lexicon is not.
 *
 * The per-render diffs fan out through the same bounded pool the estate reads
 * use (#295): each one is a whole chant process doing a TypeScript evaluation
 * before it even reaches the cluster, so the host constraint is identical.
 */
export async function readHelmRenderDrift(
  projectDir: string,
  env: string,
  opts: GraphOptions = {},
): Promise<HelmRenderReport[]> {
  const report = await helmRenders(projectDir, opts).catch(() => undefined);
  const records = report?.records ?? [];
  if (records.length === 0) return [];

  return mapPool(records, estateReadPool(records.length), async (record) => {
    if (!record.contentDigest) return helmRenderReport(record, undefined);
    const live = await helmRenderDiffLive(projectDir, record.contentDigest, env, opts).catch(() => undefined);
    return helmRenderReport(record, live);
  });
}

/** The chart name a `Helm::Chart` node declares (its Chart.yaml `name`) —
 * the same accessor src/helm-artifacts.ts joins presence on. */
function chartNameOf(node: { attrs?: Record<string, unknown> }): string | undefined {
  const name = node.attrs?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Rank the verdicts so a chart rendered more than once reports its worst
 * news, not its last: any drift makes the chart drifted; otherwise any hole
 * makes it unobserved; only an all-clean set reads in-sync.
 */
const SEVERITY: Record<HelmRenderVerdict, number> = { drifted: 2, unobserved: 1, "in-sync": 0 };

/**
 * Paint the render-drift axis onto every `Helm::Chart` node in `ir`, in place.
 * Run AFTER `applyHelmArtifacts` — this refines the presence verdict, it does
 * not replace it.
 *
 * A chart with no matching render is untouched: not every declared chart is
 * rendered through a `HelmRender`, and a chart this read says nothing about
 * must keep exactly the presence colour #146 gave it.
 *
 * Returns how many charts were painted `warn` for drift and how many carry a
 * report at all — the counts the caller logs and the tests assert on.
 */
export function applyHelmRenderDrift(
  ir: GraphIR,
  reports: readonly HelmRenderReport[],
): { charts: number; drifted: number } {
  if (reports.length === 0) return { charts: 0, drifted: 0 };

  // Worst verdict per chart, so one chart rendered twice reports both.
  const byChart = new Map<string, HelmRenderReport[]>();
  for (const r of reports) {
    const list = byChart.get(r.chart);
    if (list) list.push(r);
    else byChart.set(r.chart, [r]);
  }

  let charts = 0;
  let drifted = 0;
  for (const node of ir.nodes) {
    if (node.lexicon !== "helm" || node.kind !== "Helm::Chart") continue;
    const chartName = chartNameOf(node);
    const matched = chartName ? byChart.get(chartName) : undefined;
    if (!matched || matched.length === 0) continue;

    const worst = matched.reduce((a, b) => (SEVERITY[b.verdict] > SEVERITY[a.verdict] ? b : a));
    const attrs = (node.attrs ??= {});
    attrs._renderDrift = matched.length === 1 ? worst : { ...worst, renders: matched };
    charts++;

    if (worst.verdict === "drifted") {
      // The same colour src/component-status.ts gives a drifted component, and
      // the same one the entity overlay gives a resource that disagrees with
      // its declaration. Presence may have said `good`; live has moved.
      attrs._status = "warn";
      drifted++;
    }
    // `in-sync` and `unobserved` deliberately leave `_status` alone — see the
    // module header. Neither is entitled to repaint a presence verdict, and
    // neither may be mistaken for one.
  }
  return { charts, drifted };
}
