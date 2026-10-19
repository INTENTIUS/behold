/**
 * A cone plan, as terragucci's report states it (report minor 34): a
 * choudoufu root under a `live` block that a pull request planned with
 * `plan -cone=<base>` carries `roots[].cone`, `base` and either the cone's
 * size (`blocks` of `of`, and `targets`, how many addresses it targets) or,
 * when choudoufu's guard planned the whole estate, `fallback` with the guard's
 * `kind` and `reason`. Every other plan has no `cone`, and then nothing here
 * says anything.
 *
 * The report keeps the counts, never the addresses (terragucci's
 * src/cone.ts reportCone). Which resources a cone planned is read from the
 * root's own plan.json beside the report (its `resource_changes`, data
 * sources left out): a cone plan holds only the cone's blocks. A root whose
 * plan.json is not there keeps its counts, and the page lights its box.
 *
 * Whether the estates sit on one live backend with no state files is said
 * only from the reports: every root of the estate ran choudoufu (`binary`,
 * minor 18), and no tf-apply report read records a state file for any of them
 * (`roots[].state`, minor 20, which a root with a backend's state has).
 */
import type { TerragucciSource } from "./terragucci-source.ts";

/** A report root's `cone`, as read: anything else is left out. */
export interface ReportCone {
  base: string;
  blocks?: number;
  of?: number;
  targets?: number;
  fallback?: { kind: string; reason: string };
}

/** One root of the estate, as the cone view tells it. */
export interface ConeRoot {
  root: string;
  /**
   * `cone`: planned as a cone; `full`: choudoufu's guard planned the whole
   * estate (`fallback`); `planned`: the pull request planned it with no cone
   * (another binary, or a root with no `live` block); `not-planned`: the
   * pull request's plan holds no such root.
   */
  kind: "cone" | "full" | "planned" | "not-planned";
  base?: string;
  blocks?: number;
  of?: number;
  targets?: number;
  fallback?: { kind: string; reason: string };
  /** With a cone: the resource instances its plan.json planned, and whether the plan changes each. Absent when no plan.json was read. */
  planned?: { address: string; changed: boolean }[];
}

/** The pull request's plan as a cone view: absent when no root of it carries a `cone`. */
export interface PlanConeView {
  roots: ConeRoot[];
  /** The estates on one live backend with no state files, when the reports say so; absent otherwise. */
  backend?: { estates: number };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/** A report root's `cone`, or undefined when it has none or it is not one. */
export function readCone(v: unknown): ReportCone | undefined {
  if (!isRecord(v) || !str(v.base)) return undefined;
  const fb = isRecord(v.fallback) ? v.fallback : null;
  if (fb) return { base: v.base, fallback: { kind: str(fb.kind) ? fb.kind : "unknown", reason: str(fb.reason) ? fb.reason : "" } };
  const blocks = count(v.blocks);
  const of = count(v.of);
  const targets = count(v.targets);
  return { base: v.base, ...(blocks !== undefined && of !== undefined ? { blocks, of } : {}), ...(targets !== undefined ? { targets } : {}) };
}

/** A plan.json's managed resource instances, each with whether its plan changes it. */
export function plannedInstances(plan: unknown): { address: string; changed: boolean }[] {
  if (!isRecord(plan) || !Array.isArray(plan.resource_changes)) return [];
  const out: { address: string; changed: boolean }[] = [];
  for (const rc of plan.resource_changes) {
    if (!isRecord(rc) || !str(rc.address) || rc.mode === "data") continue;
    const acts = isRecord(rc.change) && Array.isArray(rc.change.actions) ? rc.change.actions.filter(str) : [];
    out.push({ address: rc.address, changed: !acts.every((a) => a === "no-op" || a === "read") });
  }
  return out;
}

/** What the reports say of a root besides the pull request: the binary it ran, and whether an apply recorded a state file for it. */
export interface RootFacts {
  binary?: string;
  state?: boolean;
}

/**
 * The cone view of a pull request's report. `roots`: every root of the
 * estate the read knows (the checkout's and the reports'), so a root the pull
 * request did not plan is named as not planned; `planned`: each cone root's
 * plan.json instances, by root; `facts`: each root's binary and state, from
 * the reports read. Undefined when no root of the report carries a `cone`:
 * then the view is as it was. Pure.
 */
export function coneView(
  doc: { roots: readonly { path: string; cone?: unknown; binary?: unknown }[] },
  { roots = [], planned = {}, facts = {} }: { roots?: readonly string[]; planned?: Readonly<Record<string, { address: string; changed: boolean }[]>>; facts?: Readonly<Record<string, RootFacts>> } = {},
): PlanConeView | undefined {
  const cones = new Map<string, ReportCone>();
  for (const r of doc.roots) {
    const c = readCone(r.cone);
    if (c) cones.set(r.path, c);
  }
  if (!cones.size) return undefined;
  const out: ConeRoot[] = [];
  const inPlan = new Set(doc.roots.map((r) => r.path));
  for (const r of doc.roots) {
    const c = cones.get(r.path);
    if (!c) {
      out.push({ root: r.path, kind: "planned" });
      continue;
    }
    if (c.fallback) {
      out.push({ root: r.path, kind: "full", base: c.base, fallback: c.fallback });
      continue;
    }
    const p = planned[r.path];
    out.push({ root: r.path, kind: "cone", base: c.base, ...(c.blocks !== undefined ? { blocks: c.blocks, of: c.of } : {}), ...(c.targets !== undefined ? { targets: c.targets } : {}), ...(p ? { planned: p } : {}) });
  }
  const others = [...new Set(roots)].filter((p) => !inPlan.has(p)).sort();
  for (const p of others) out.push({ root: p, kind: "not-planned" });
  // One live backend, no state files: every root of the estate ran choudoufu by the reports, and none has a state file recorded.
  const all = out.map((r) => r.root);
  const binaryOf = (p: string): string | undefined => {
    const own = doc.roots.find((r) => r.path === p);
    const b = own && isRecord(own.binary) && str(own.binary.name) ? own.binary.name : undefined;
    return b ?? facts[p]?.binary;
  };
  const live = all.length > 0 && all.every((p) => binaryOf(p) === "choudoufu" && facts[p]?.state !== true);
  return { roots: out, ...(live ? { backend: { estates: all.length } } : {}) };
}

/** Each cone root's plan.json instances, read from beside its report (`<run>/<plan.json key>`). Never throws: a plan that is not there is left out. */
export async function readConePlans(source: TerragucciSource, runPath: string, doc: { roots: readonly { path: string; cone?: unknown; plan?: unknown }[] }): Promise<Record<string, { address: string; changed: boolean }[]>> {
  const out: Record<string, { address: string; changed: boolean }[]> = {};
  for (const r of doc.roots) {
    const c = readCone(r.cone);
    if (!c || c.fallback) continue;
    const key = isRecord(r.plan) && str(r.plan.json) ? r.plan.json : null;
    if (!key || key.split("/").some((s) => s === ".." || s === ".")) continue;
    let text: string | undefined;
    try {
      text = await source.read([runPath, key].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"));
    } catch {
      continue;
    }
    if (text === undefined) continue;
    try {
      const list = plannedInstances(JSON.parse(text));
      if (list.length) out[r.path] = list;
    } catch {
      /* not JSON: the root keeps its counts */
    }
  }
  return out;
}
