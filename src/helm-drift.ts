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
 * ## The identity axis (chant#2031, chant ≥ 0.54.0)
 *
 * The live diff above answers "have the objects moved since the deploy". It
 * cannot answer the question that comes BEFORE it: was the release the cluster
 * is running deployed from this project's render at all? Until 0.53.1 the
 * observed release reported no render identity, so the only join was the
 * chart name and that question had no digest on the observed side. 0.54.0's
 * `listArtifacts` reads the env's release ledger and hangs the deploy's
 * recorded `inputDigest` — and `contentDigest` for a pinned deploy — on the
 * observation. `renderIdentity` compares those to the declared render's:
 *
 *   both content digests present, equal   -> "content": the exact bytes
 *   else both input digests present, equal -> "input": the same chart, version,
 *                                             values and profile (bytes may
 *                                             legitimately differ per cluster)
 *   a common kind present, unequal         -> "mismatch": what runs was deployed
 *                                             from something other than what
 *                                             this project declares
 *   the release carries no identity        -> "unrecorded": no ledger record
 *                                             names it (deployed outside the
 *                                             recorded path, or the ledger
 *                                             could not be read)
 *   the declared render carries none       -> "unpinned": nothing to compare to
 *
 * Only `mismatch` paints, and like drift it only ever downgrades: a release
 * running someone else's render is bad news whatever its status. The other
 * four are recorded on the node and shown in words.
 *
 * ## What is deliberately NOT wired
 *
 * The offline half, `chant helm diff <from-digest> <to-digest> --json`, the
 * render-to-render comparison across two environments ("is prod running what
 * staging tested"). Both sides of that now have digests — the observed release
 * carries its own — but behold renders one environment at a time, so the
 * cross-environment surface is its own view. The identity axis answers the
 * one-environment half: is THIS env running what THIS project renders.
 */
import type { GraphIR } from "@intentius/chant";
import type { GraphOptions, HelmRenderLiveDiff, HelmRenderRecord, HelmPropertyDrift, LiveArtifactObservation } from "./chant.ts";
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
  /** Whether the observed release was deployed from this declared render
   * (chant#2031). Present whenever the observation map was available. */
  identity?: HelmRenderIdentity;
}

/** How the observed release's recorded render identity compares to the
 * declared render's — see the module header for what each word claims. */
export type HelmRenderIdentityMatch = "content" | "input" | "mismatch" | "unrecorded" | "unpinned";

export interface HelmRenderIdentity {
  match: HelmRenderIdentityMatch;
  /** The declared render's digests, from `chant helm renders`. */
  declared: { inputDigest?: string; contentDigest?: string };
  /** The observed release's recorded digests, off the ledger via
   * `listArtifacts`, and which release they were read from. */
  observed: { release?: string; inputDigest?: string; contentDigest?: string };
}

/** One observed release, with the `release/<ns>/<name>` key it was found under. */
export interface ObservedRelease {
  key: string;
  observation: LiveArtifactObservation;
}

/** Compare a declared render's identity to the observed release's. Pure. */
export function renderIdentity(record: HelmRenderRecord, observed: ObservedRelease | undefined): HelmRenderIdentity {
  const declared = {
    ...(record.inputDigest ? { inputDigest: record.inputDigest } : {}),
    ...(record.contentDigest ? { contentDigest: record.contentDigest } : {}),
  };
  const a = observed?.observation.attributes ?? {};
  const obs = {
    ...(observed ? { release: observed.key.replace(/^release\//, "") } : {}),
    ...(typeof a.inputDigest === "string" ? { inputDigest: a.inputDigest } : {}),
    ...(typeof a.contentDigest === "string" ? { contentDigest: a.contentDigest } : {}),
  };
  const base = { declared, observed: obs };
  if (!declared.inputDigest && !declared.contentDigest) return { match: "unpinned", ...base };
  if (!obs.inputDigest && !obs.contentDigest) return { match: "unrecorded", ...base };
  if (declared.contentDigest && obs.contentDigest) {
    return { match: declared.contentDigest === obs.contentDigest ? "content" : "mismatch", ...base };
  }
  if (declared.inputDigest && obs.inputDigest) {
    return { match: declared.inputDigest === obs.inputDigest ? "input" : "mismatch", ...base };
  }
  // Each side has identity of a kind the other lacks. chant's writer never
  // produces this (a pinned record carries both; a deploy record always has
  // an input digest), so it is reported as unrecorded rather than guessed at.
  return { match: "unrecorded", ...base };
}

/**
 * The observed release a declared render produced, out of the
 * `observedArtifacts` map: the entry whose release name is the render's
 * (chant bakes the render name in as the release name), narrowed by namespace
 * when the resolved render manifest names one and the map has several.
 */
export function observedReleaseFor(
  record: HelmRenderRecord,
  observed: Record<string, LiveArtifactObservation> | undefined,
  namespace?: string | null,
): ObservedRelease | undefined {
  if (!observed) return undefined;
  const candidates = Object.entries(observed).filter(([key]) => key.startsWith("release/") && key.split("/").pop() === record.name);
  if (candidates.length === 0) return undefined;
  const scoped = namespace ? candidates.find(([key]) => key === `release/${namespace}/${record.name}`) : undefined;
  const [key, observation] = scoped ?? candidates[0];
  return { key, observation };
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
export function helmRenderReport(
  record: HelmRenderRecord,
  live: HelmRenderLiveDiff | undefined,
  observed?: Record<string, LiveArtifactObservation>,
): HelmRenderReport {
  // The identity axis needs no live diff — it compares two recorded digests —
  // so it is decided from the observation map alone, and only when the caller
  // had one: with no map there is no observed side, and no verdict is invented.
  const identity = observed
    ? { identity: renderIdentity(record, observedReleaseFor(record, observed, live?.manifest.namespace)) }
    : {};
  const base = { render: record.name, chart: record.chart, ...identity };

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
  observed?: Record<string, LiveArtifactObservation>,
): Promise<HelmRenderReport[]> {
  const report = await helmRenders(projectDir, opts).catch(() => undefined);
  const records = report?.records ?? [];
  if (records.length === 0) return [];

  return mapPool(records, estateReadPool(records.length), async (record) => {
    if (!record.contentDigest) return helmRenderReport(record, undefined, observed);
    const live = await helmRenderDiffLive(projectDir, record.contentDigest, env, opts).catch(() => undefined);
    return helmRenderReport(record, live, observed);
  });
}

/** The chart name a `Helm::Chart` node declares (its Chart.yaml `name`) —
 * the same accessor src/helm-artifacts.ts joins presence on. */
function chartNameOf(node: { attrs?: Record<string, unknown> }): string | undefined {
  const name = node.attrs?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Rank the reports so a chart rendered more than once reports its worst
 * news, not its last: any drift makes the chart drifted; otherwise an
 * identity mismatch; otherwise any hole makes it unobserved; only an
 * all-clean set reads in-sync.
 */
const SEVERITY: Record<HelmRenderVerdict, number> = { drifted: 3, unobserved: 1, "in-sync": 0 };
function severityOf(r: HelmRenderReport): number {
  return Math.max(SEVERITY[r.verdict], r.identity?.match === "mismatch" ? 2 : 0);
}

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

    const worst = matched.reduce((a, b) => (severityOf(b) > severityOf(a) ? b : a));
    const attrs = (node.attrs ??= {});
    attrs._renderDrift = matched.length === 1 ? worst : { ...worst, renders: matched };
    charts++;

    if (worst.verdict === "drifted" || matched.some((r) => r.identity?.match === "mismatch")) {
      // The same colour src/component-status.ts gives a drifted component, and
      // the same one the entity overlay gives a resource that disagrees with
      // its declaration. Presence may have said `good`; live has moved — or
      // (chant#2031) what runs was never deployed from this render at all.
      attrs._status = "warn";
      drifted++;
    }
    // `in-sync` and `unobserved` deliberately leave `_status` alone — see the
    // module header. Neither is entitled to repaint a presence verdict, and
    // neither may be mistaken for one.
  }
  return { charts, drifted };
}
