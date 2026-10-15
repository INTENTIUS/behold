/**
 * A terragucci repo's roots as chant components (#571).
 *
 * `terragucci init` writes `terragucci.components.json` (schema
 * `terragucci.components/v1`) beside the workflow it renders: the repo's roots,
 * one portable chant component per root with its `dependsOn` from terragucci's
 * own ordering, and the pipeline jobs that apply them. behold already serves a
 * directory of `.tf` files through a generated chant project outside the repo
 * (src/terraform-member.ts); when this file is present, that project is keyed
 * by the declaration's root names and gains a `terragucci.component.ts`, so
 * `chant graph --components` draws the roots grouped by wave. The wave boxes
 * are titled with the jobs that apply them, and a component's CI facet is the
 * declared job rather than a chant-generated pipeline.
 *
 * Read-only and parse-only: nothing here runs terragucci or writes under the
 * repo. A file that is absent, unreadable or not this schema is no
 * declaration, and the directory is drawn as it was before.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphIR } from "@intentius/chant";
import type { TerraformRootScan } from "./terraform-member.ts";

export const TERRAGUCCI_COMPONENTS_FILE = "terragucci.components.json";
export const TERRAGUCCI_COMPONENTS_SCHEMA = "terragucci.components/v1";
/** The module behold writes into the scratch project. chant discovers
 * `*.component.ts` files exporting `{ name, dependsOn, deploy }`. */
export const TERRAGUCCI_COMPONENT_MODULE = "terragucci.component.ts";

export interface TerragucciStep {
  kind: string;
  root?: string;
  [k: string]: unknown;
}
export interface TerragucciComponent {
  name: string;
  dependsOn: string[];
  deploy: { phase: string; steps: TerragucciStep[] }[];
}
export interface TerragucciJob {
  name: string;
  needs: string[];
  wave?: number;
  applies: string[];
}
export interface TerragucciComponents {
  schema: typeof TERRAGUCCI_COMPONENTS_SCHEMA;
  generated_by?: string;
  roots: Record<string, { dir: string }>;
  components: TerragucciComponent[];
  pipeline: { path?: string; forge?: string; jobs: TerragucciJob[] };
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Is `v` a v1 declaration whose shape behold can draw? Every field this
 * module reads is checked; anything extra is ignored. */
export function isTerragucciComponents(v: unknown): v is TerragucciComponents {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  if (d.schema !== TERRAGUCCI_COMPONENTS_SCHEMA) return false;
  const roots = d.roots as Record<string, unknown> | undefined;
  if (typeof roots !== "object" || roots === null || Array.isArray(roots)) return false;
  for (const r of Object.values(roots)) {
    if (typeof r !== "object" || r === null || typeof (r as { dir?: unknown }).dir !== "string") return false;
  }
  if (!Array.isArray(d.components)) return false;
  for (const c of d.components as unknown[]) {
    const comp = c as Record<string, unknown>;
    if (typeof comp?.name !== "string" || !isStrings(comp.dependsOn) || !Array.isArray(comp.deploy)) return false;
    for (const p of comp.deploy as unknown[]) {
      const phase = p as Record<string, unknown>;
      if (typeof phase?.phase !== "string" || !Array.isArray(phase.steps)) return false;
      if (!(phase.steps as unknown[]).every((s) => typeof (s as { kind?: unknown })?.kind === "string")) return false;
    }
  }
  const pipeline = d.pipeline as Record<string, unknown> | undefined;
  if (typeof pipeline !== "object" || pipeline === null || !Array.isArray(pipeline.jobs)) return false;
  for (const j of pipeline.jobs as unknown[]) {
    const job = j as Record<string, unknown>;
    if (typeof job?.name !== "string" || !isStrings(job.needs) || !isStrings(job.applies)) return false;
    if (job.wave !== undefined && typeof job.wave !== "number") return false;
  }
  return true;
}

/** The declaration at the root of `dir`, or undefined when there is none
 * behold can read (absent, unreadable, malformed JSON, another schema). */
export function readTerragucciComponents(dir: string): TerragucciComponents | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, TERRAGUCCI_COMPONENTS_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isTerragucciComponents(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The declared roots as the scan the scratch config is written from: the
 * names terragucci uses everywhere, so a card's `attrs.root` is the name a
 * component's `terraform-apply` step names. Dirs are POSIX and relative to
 * the repo, as the format states; a leading `./` and trailing `/` are dropped. */
export function declaredRootScan(decl: TerragucciComponents): TerraformRootScan {
  const norm = (d: string): string => d.replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
  return { roots: Object.entries(decl.roots).map(([name, r]) => ({ name, dir: norm(r.dir) })), skipped: [] };
}

/** Why each generated step carries `noRollback`: chant's COMP003 lint refuses a
 * mutating step with no rollback story, and `chant graph` refuses to draw a
 * project with lint errors. The scaffold is for drawing; terragucci's pipeline
 * is what applies these roots. */
export const SCAFFOLD_NO_ROLLBACK = "applied by terragucci's pipeline; behold only draws this";

/**
 * The `terragucci.component.ts` behold writes into the scratch project: one
 * export per declared component, the declaration's own fields as JSON. Pure
 * and deterministic, so a reload rewrites nothing. A `terraform-apply` step
 * gains `noRollback` (see {@link SCAFFOLD_NO_ROLLBACK}) unless it states one.
 */
export function terragucciComponentModule(decl: TerragucciComponents): string {
  const lines = [
    "// Generated by behold (#571) from terragucci.components.json, so chant can",
    "// draw this repo's roots as components. Written OUTSIDE the repo and",
    "// rewritten on each read; the repo is untouched.",
    "",
  ];
  decl.components.forEach((c, i) => {
    const component = {
      name: c.name,
      dependsOn: c.dependsOn,
      deploy: c.deploy.map((p) => ({
        phase: p.phase,
        steps: p.steps.map((s) => (s.kind === "terraform-apply" && s.noRollback === undefined ? { ...s, noRollback: SCAFFOLD_NO_ROLLBACK } : s)),
      })),
    };
    lines.push(`export const component${i} = ${JSON.stringify(component)};`);
  });
  lines.push("");
  return lines.join("\n");
}

/** One component's job, as the inspect pane's CI facet shows it. */
export interface ComponentJob {
  component: string;
  jobName: string;
  needs: string[];
  wave?: number;
  /** Every declared job that applies this component, when more than one does
   * (an `apply-comment` job under `apply.when: pull-request` lists every root). */
  alsoIn?: string[];
}

/** The roots a component's `terraform-apply` steps name. */
export function componentRoots(c: TerragucciComponent): string[] {
  return c.deploy.flatMap((p) => p.steps.filter((s) => s.kind === "terraform-apply" && typeof s.root === "string").map((s) => s.root as string));
}

/**
 * component -> the job that applies it. A job applies a component when its
 * `applies` names the component or a root the component's step applies. When
 * several do, the one with a `wave` wins (the wave job, not a share job's or an
 * `apply-comment` job's catch-all list), then the first declared; the others
 * are named in `alsoIn`.
 */
export function componentJobs(decl: TerragucciComponents): Record<string, ComponentJob> {
  const out: Record<string, ComponentJob> = {};
  for (const c of decl.components) {
    const keys = new Set([c.name, ...componentRoots(c)]);
    const jobs = decl.pipeline.jobs.filter((j) => j.applies.some((a) => keys.has(a)));
    if (!jobs.length) continue;
    const primary = jobs.find((j) => j.wave !== undefined) ?? jobs[0]!;
    const others = jobs.filter((j) => j !== primary).map((j) => j.name);
    out[c.name] = {
      component: c.name,
      jobName: primary.name,
      needs: primary.needs,
      ...(primary.wave !== undefined ? { wave: primary.wave } : {}),
      ...(others.length ? { alsoIn: others } : {}),
    };
  }
  return out;
}

/**
 * Each `groups.byWave` box's title: the job(s) that apply its members, joined
 * with " + " in declaration order. Keyed by chant's wave key (`wave-1`), so a
 * box whose members map to no job keeps chant's own title.
 */
export function waveTitles(ir: GraphIR, decl: TerragucciComponents): Record<string, string> {
  const byWave = (ir.groups as { byWave?: Record<string, string[]> } | undefined)?.byWave ?? {};
  const jobs = componentJobs(decl);
  const order = decl.pipeline.jobs.map((j) => j.name);
  const out: Record<string, string> = {};
  for (const [key, members] of Object.entries(byWave)) {
    const names = new Set(members.map((m) => jobs[m]?.jobName).filter((n): n is string => !!n));
    if (names.size) out[key] = order.filter((n) => names.has(n)).join(" + ");
  }
  return out;
}

/** component -> the root its first `terraform-apply` step names, for the
 * resources facet's join onto the entity graph's `attrs.root`. */
export function componentRootMap(decl: TerragucciComponents): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of decl.components) {
    const root = componentRoots(c)[0];
    if (root) out[c.name] = root;
  }
  return out;
}
