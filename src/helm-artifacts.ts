/**
 * The helm artifact-presence join (behold#146).
 *
 * A Helm release is an artifact in chant's vocabulary, not a resource — it
 * has no declared axis, so the overlay's managed/foreign/pending
 * classification never touches it and every declared `Helm::Chart` node
 * arrives `_status`-less from the source graph. This joins the live release
 * observations (`lifecycle diff --live --json`'s `observedArtifacts`,
 * chant#1516) onto those chart nodes by chart name:
 *
 *   release found, status "deployed"  → good    (legend: installed)
 *   release found, any other status   → warn    (failed / pending-*)
 *   no matching release               → accent  (declared, not installed)
 *   observation unavailable           → neutral (unobserved ≠ absent)
 *
 * The 2-way artifact vocabulary stays distinct from managed/foreign: a chart
 * is "installed", never "managed", and a live release matching no declared
 * chart is NOT invented as a node — it stays in the diff/inspect surface
 * where chant reports it.
 *
 * Since chant 0.54.0 (chant#2031) an observed release also carries the render
 * identity its deploy recorded — `inputDigest`, and `contentDigest` for a
 * pinned deploy — read back from the env's release ledger. Presence still
 * joins by chart name (a chart is installed or it is not, whichever bytes were
 * deployed); the digests are carried onto the match so the inspect pane can
 * show them, and src/helm-drift.ts compares them to the declared render.
 */
import type { GraphIR } from "@intentius/chant";
import type { LiveArtifactObservation } from "./chant.ts";

/** What the join found for one chart, carried on the node for inspect. */
export interface HelmArtifactMatch {
  release: string;
  status?: string;
  revision?: string;
  chart?: string;
  /** The deploy's recorded render identity (chant#2031, chant ≥ 0.54.0) —
   * absent when the ledger had no record for this release. */
  inputDigest?: string;
  contentDigest?: string;
}

/** The chart name a `Helm::Chart` node declares (its Chart.yaml `name`). */
function chartNameOf(node: { attrs?: Record<string, unknown> }): string | undefined {
  const name = node.attrs?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * `helm list` reports `chart` as `<name>-<version>` — match a declared chart
 * name against that without a version to compare (the declared Chart.yaml
 * version and the installed revision's chart version may legitimately
 * differ; presence is the axis here, not version drift).
 */
function releaseMatchesChart(observed: LiveArtifactObservation, chartName: string): boolean {
  const chart = observed.attributes?.chart;
  if (typeof chart !== "string") return false;
  return chart === chartName || chart.startsWith(`${chartName}-`);
}

/**
 * Paint artifact presence onto every `Helm::Chart` node in `ir`, in place.
 * `observed` is the helm lexicon's `observedArtifacts` map (keys
 * `release/<ns>/<name>`), or undefined when the observation was unavailable
 * — a chant predating #1516, a failed read — in which case charts read
 * `neutral` with an `_unobserved` reason, never `accent` (unobserved is not
 * absent).
 */
export function applyHelmArtifacts(
  ir: GraphIR,
  observed: Record<string, LiveArtifactObservation> | undefined,
): { charts: number; installed: number } {
  let charts = 0;
  let installed = 0;
  for (const node of ir.nodes) {
    if (node.lexicon !== "helm" || node.kind !== "Helm::Chart") continue;
    charts++;
    const attrs = (node.attrs ??= {});

    if (observed === undefined) {
      attrs._status = "neutral";
      attrs._unobserved = "artifact-observation-unavailable";
      continue;
    }

    const chartName = chartNameOf(node);
    const entry = chartName
      ? Object.entries(observed).find(([key, o]) => key.startsWith("release/") && releaseMatchesChart(o, chartName))
      : undefined;

    if (!entry) {
      // Declared, no release installed — the pre-first-install state.
      attrs._status = "accent";
      continue;
    }

    const [key, o] = entry;
    const match: HelmArtifactMatch = {
      release: key.replace(/^release\//, ""),
      ...(o.status ? { status: o.status } : {}),
      ...(typeof o.attributes?.revision === "string" ? { revision: o.attributes.revision } : {}),
      ...(typeof o.attributes?.chart === "string" ? { chart: o.attributes.chart } : {}),
      ...(typeof o.attributes?.inputDigest === "string" ? { inputDigest: o.attributes.inputDigest } : {}),
      ...(typeof o.attributes?.contentDigest === "string" ? { contentDigest: o.attributes.contentDigest } : {}),
    };
    attrs._artifact = match;
    attrs._status = o.status === "deployed" ? "good" : "warn";
    if (o.status === "deployed") installed++;
  }
  return { charts, installed };
}
