/**
 * Which forge runs a terragucci repo's pipeline, and which tools its jobs run
 * (behold#571), for the marks on each wave box of the Components view
 * (web/forge-mark.js, web/tool-mark.js). Read from what the repo already says,
 * with nothing demo-only:
 *
 * - the forge: terragucci.components.json's `pipeline.forge`, then
 *   terragucci.yml's `forge:`, then the shape of `pipeline.path`, then the one
 *   workflow directory the repo has (`.forgejo/workflows`, `.github/workflows`,
 *   `.gitlab-ci.yml`);
 * - the tools: an orchestrator from the repo's files (Terragrunt units,
 *   `cdktf.json`, `atmos.yaml` or Atmos's stacks layout, a chant workspace
 *   with members, SQL Yodeler's yodel.config.ts or migrations/), then the engine
 *   terragucci.yml's `binary:` names.
 *
 * Read-only and parse-only. Whatever is unknown is left out, and the page then
 * draws no mark for it.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import type { TerragucciComponents } from "./terragucci-components.ts";
import { hasTerragruntUnits } from "./terragrunt-units.ts";

export const PIPELINE_FORGES = ["forgejo", "github", "gitlab"] as const;
export type PipelineForge = (typeof PIPELINE_FORGES)[number];
export type ForgeFrom = "declared" | "config" | "pipeline-path" | "workflow-dir";

/** The tools a job mark can name. Keep in step with TOOLS in web/tool-mark.js. */
export const PIPELINE_TOOLS = ["terragrunt", "cdk-terrain", "atmos", "chant", "sql-yodeler", "opentofu", "terraform", "choudoufu"] as const;
export type PipelineTool = (typeof PIPELINE_TOOLS)[number];

const WORKFLOW_PLACES: [PipelineForge, string][] = [
  ["forgejo", ".forgejo/workflows"],
  ["github", ".github/workflows"],
  ["gitlab", ".gitlab-ci.yml"],
];

/** A forge named outright ("forgejo", "GitHub Actions"), or undefined. */
export function forgeOfName(name: unknown): PipelineForge | undefined {
  const s = typeof name === "string" ? name.trim().toLowerCase() : "";
  return PIPELINE_FORGES.find((f) => s === f || s.startsWith(`${f} `) || s.startsWith(`${f}-`));
}

/** The forge a pipeline file's path belongs to, or undefined. */
export function forgeOfPipelinePath(path: string): PipelineForge | undefined {
  const p = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (/(^|\/)\.forgejo\/workflows(\/|$)/.test(p)) return "forgejo";
  if (/(^|\/)\.github\/workflows(\/|$)/.test(p)) return "github";
  if (/(^|\/)\.gitlab-ci\.ya?ml$/.test(p)) return "gitlab";
  return undefined;
}

/** The engine a terragucci.yml `binary:` names, or undefined. */
export function toolOfBinary(binary: unknown): PipelineTool | undefined {
  const b = typeof binary === "string" ? binary.trim().toLowerCase().split("/").pop() ?? "" : "";
  if (b === "tofu" || b === "opentofu") return "opentofu";
  if (b === "terraform") return "terraform";
  if (b === "choudoufu") return "choudoufu";
  return undefined;
}

/** The `forge:` and `binary:` of a terragucci config, as far as behold reads it. A terragucci.ts is read by regex; behold runs no config code. */
export function configKeys(file: string | undefined): { forge?: string; binary?: string } {
  if (!file) return {};
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  if (extname(file) === ".ts") {
    const pick = (k: string) => new RegExp(`(^|[\\s,{])${k}\\s*:\\s*["']([^"']+)["']`).exec(text)?.[2];
    const out: { forge?: string; binary?: string } = {};
    const forge = pick("forge");
    const binary = pick("binary");
    if (forge) out.forge = forge;
    if (binary) out.binary = binary;
    return out;
  }
  let doc: unknown;
  try {
    doc = parseYAMLDocument(text);
  } catch {
    return {};
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
  const d = doc as Record<string, unknown>;
  return {
    ...(typeof d.forge === "string" ? { forge: d.forge } : {}),
    ...(typeof d.binary === "string" ? { binary: d.binary } : {}),
  };
}

/** The forge that runs the pipeline, and what said so; undefined when nothing does, or the repo has several workflow places. */
export function pipelineForge(decl: TerragucciComponents | undefined, dir: string, config?: string): { forge: PipelineForge; from: ForgeFrom } | undefined {
  const declared = forgeOfName(decl?.pipeline.forge);
  if (declared) return { forge: declared, from: "declared" };
  const configured = forgeOfName(configKeys(config).forge);
  if (configured) return { forge: configured, from: "config" };
  const byPath = decl?.pipeline.path ? forgeOfPipelinePath(decl.pipeline.path) : undefined;
  if (byPath) return { forge: byPath, from: "pipeline-path" };
  const present = WORKFLOW_PLACES.filter(([, p]) => existsSync(join(dir, p))).map(([f]) => f);
  return present.length === 1 ? { forge: present[0]!, from: "workflow-dir" } : undefined;
}

/** Whether `dir` holds a chant workspace that declares members (terragucci's own declaration for its gates has none). */
function chantWorkspaceWithMembers(dir: string): boolean {
  try {
    const doc = JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf8")) as { members?: unknown };
    return Array.isArray(doc.members) && doc.members.length > 0;
  } catch {
    return false;
  }
}

/** Whether `dir` is an Atmos repo: an `atmos.yaml`, or Atmos's layout of `stacks/` beside `components/terraform/`. */
export function atmosRepo(dir: string): boolean {
  if (existsSync(join(dir, "atmos.yaml")) || existsSync(join(dir, "atmos.yml"))) return true;
  return existsSync(join(dir, "stacks")) && existsSync(join(dir, "components", "terraform"));
}

/** Whether `dir` is a SQL Yodeler project: its `yodel.config.ts`, or a `migrations/` directory in a package that depends on it. */
export function sqlYodelerRepo(dir: string): boolean {
  if (existsSync(join(dir, "yodel.config.ts"))) return true;
  if (!existsSync(join(dir, "migrations"))) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    return ["dependencies", "devDependencies"].some((k) => !!pkg[k]?.["@intentius/sql-yodeler"]);
  } catch {
    return false;
  }
}

/** The tools the repo's jobs run, an orchestrator first, then the engine; empty when nothing says. */
export function repoTools(dir: string, config?: string, has: { terragrunt?: (d: string) => boolean } = {}): PipelineTool[] {
  const out: PipelineTool[] = [];
  if ((has.terragrunt ?? hasTerragruntUnits)(dir)) out.push("terragrunt");
  else if (existsSync(join(dir, "cdktf.json")) || existsSync(join(dir, "cdktn.json"))) out.push("cdk-terrain");
  else if (atmosRepo(dir)) out.push("atmos");
  else if (chantWorkspaceWithMembers(dir)) out.push("chant");
  if (sqlYodelerRepo(dir)) out.push("sql-yodeler");
  const engine = toolOfBinary(configKeys(config).binary);
  if (engine) out.push(engine);
  return out;
}
