/**
 * Observed helm releases as graph nodes — the half of "render helm" that
 * behold#146 deliberately left out, and the half the estates actually need.
 *
 * #146's join (src/helm-artifacts.ts) paints *declared `Helm::Chart` nodes*
 * from the observed releases, and never invents a node for a release matching
 * no declared chart. That is right for a chart-authoring project — but the
 * deploy-step estates (kubemicrovm-ops) declare NO chart nodes at all: their
 * releases exist as a component's `helm-upgrade` deploy units (cert-manager,
 * kube-microvm-operator), named in the component IR's `liveNames`
 * (chant#1491). On those estates the overlay observed the releases and then
 * had nothing to hang them on, so helm was invisible on every zoom.
 *
 * So the rule gains a second clause. A release is synthesized as a
 * `Helm::Release` node when it matches no declared chart, and:
 *
 *   named by a component's deploy units  → good/warn by helm status (owned —
 *                                          the estate declared the intent,
 *                                          the release is its receipt)
 *   named by nobody                      → warn (foreign — present in the
 *                                          cluster this estate renders, not
 *                                          declared by it; the same verdict
 *                                          the entity overlay gives a foreign
 *                                          resource)
 *
 * A release that DOES match a declared chart stays chart-only: the chart card
 * already carries the artifact join, and a second node would say it twice.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GraphIR, IRNode } from "@intentius/chant";
import type { LiveArtifactObservation } from "./chant.ts";

/** `observedArtifacts` keys are `release/<ns>/<name>` (chant#1516). */
const RELEASE_KEY = /^release\/([^/]+)\/(.+)$/;

/** The chart names the estate's `Helm::Chart` nodes declare. */
function declaredChartNames(ir: GraphIR): Set<string> {
  const names = new Set<string>();
  for (const n of ir.nodes) {
    if (n.lexicon !== "helm" || n.kind !== "Helm::Chart") continue;
    const name = n.attrs?.name;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return names;
}

/** `helm list` reports `chart` as `<name>-<version>` — the version separator
 * is a hyphen but so are name-internal ones, so match a declared name as an
 * exact value or a `<name>-` prefix, the same rule helm-artifacts.ts applies
 * the other way round. */
function matchesDeclaredChart(chart: unknown, declared: Set<string>): boolean {
  if (typeof chart !== "string" || chart.length === 0) return false;
  for (const name of declared) {
    if (chart === name || chart.startsWith(`${name}-`)) return true;
  }
  return false;
}

/**
 * release name → owning component name, scraped from the project's
 * `*.component.ts` sources.
 *
 * The component IR's `liveNames` carries *declared resource* names, not
 * deploy-unit release names (verified on kubemicrovm-ops: operator's is
 * `["operator"]`, its releases are `cert-manager`/`kube-microvm-operator`),
 * and no chant read surfaces the units by name — so this reads the declared
 * source the same way src/ops.ts discovers Ops: scraped text, literal values
 * only. A release computed from a param is invisible to this and simply
 * stays "foreign", which under-claims rather than guesses.
 */
export function discoverReleaseUnits(projectDir: string): Map<string, string> {
  const owners = new Map<string, string>();
  const roots = [join(projectDir, "src"), join(projectDir, "ops")];
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p, depth + 1);
      else if (f.endsWith(".component.ts")) files.push(p);
    }
  };
  for (const root of roots) walk(root, 0);

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const component = content.match(/name:\s*["'`]([^"'`]+)["'`]/)?.[1];
    if (!component) continue;
    for (const m of content.matchAll(/helmUpgrade\(\s*\{[^}]*?\brelease:\s*["'`]([^"'`]+)["'`]/gs)) {
      if (!owners.has(m[1])) owners.set(m[1], component);
    }
  }
  return owners;
}

/**
 * Synthesize `Helm::Release` nodes for observed releases matching no declared
 * chart. In place; returns the number of nodes added. `owners` comes from
 * `releaseOwners` (empty map = nothing owned, every release foreign).
 */
export function synthesizeHelmReleases(
  ir: GraphIR,
  observed: Record<string, LiveArtifactObservation> | undefined,
  owners: Map<string, string>,
): number {
  if (!observed) return 0;
  const declared = declaredChartNames(ir);
  const have = new Set(ir.nodes.map((n) => n.id));
  let added = 0;

  for (const [key, o] of Object.entries(observed)) {
    const m = RELEASE_KEY.exec(key);
    if (!m || have.has(key)) continue;
    const [, namespace, name] = m;
    if (matchesDeclaredChart(o.attributes?.chart, declared)) continue; // the declared chart card says it
    const component = owners.get(name);
    const deployed = o.status === "deployed";
    const node: IRNode = {
      id: key,
      kind: "Helm::Release",
      lexicon: "helm",
      attrs: {
        name,
        namespace,
        ...(typeof o.attributes?.chart === "string" ? { chart: o.attributes.chart } : {}),
        ...(typeof o.attributes?.revision === "string" ? { revision: o.attributes.revision } : {}),
        ...(component ? { component } : {}),
        _status: deployed && component ? "good" : "warn",
        _artifact: {
          release: `${namespace}/${name}`,
          ...(o.status ? { status: o.status } : {}),
          ...(typeof o.attributes?.revision === "string" ? { revision: o.attributes.revision } : {}),
          ...(typeof o.attributes?.chart === "string" ? { chart: o.attributes.chart } : {}),
        },
        ...(component ? {} : { _foreignRelease: true }),
      },
    } as IRNode;
    ir.nodes.push(node);
    have.add(key);
    added++;
  }
  return added;
}
