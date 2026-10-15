/**
 * A Terragrunt repo's units, read from their `terragrunt.hcl` files
 * (behold#571, the demo's Terragrunt repo).
 *
 * A Terragrunt repo keeps its `.tf` in modules and its roots in units: a
 * directory with a `terragrunt.hcl` that names its module in `terraform {
 * source = ... }` and the units it reads in `dependency "<name>" {
 * config_path = ... }` blocks. src/terraform-member.ts finds no root in such a
 * repo (the units hold no `.tf`, and the module sits under `modules/`), so
 * this reads the units and hands the terraform member what it needs to draw
 * each unit as a root box:
 *
 * - a unit whose source is a local directory in the repo holding `.tf` files
 *   is read by chant's terraform lexicon from that directory, under the
 *   unit's name, so its box holds the module's resources;
 * - a unit whose source is not resolvable here (a remote source, a path out
 *   of the repo, a directory with no `.tf`) is drawn as one card saying so;
 * - each `dependency` block is a card in the reading unit's box with an edge
 *   to the unit it reads.
 *
 * behold evaluates no Terragrunt: no include is followed, no function is
 * called and no input is computed. It reads two block shapes from each
 * file, with string literals only; a source or config_path that is an
 * expression is reported as not resolvable rather than guessed at.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { GraphIR, IRNode } from "@intentius/chant";
import type { TerragucciComponents } from "./terragucci-components.ts";

export const TERRAGRUNT_FILE = "terragrunt.hcl";

/** How deep the walk goes for units: `live/<env>/<region>/<unit>` is four. */
export const UNIT_SCAN_DEPTH = 4;

const SKIP_DIRS = new Set([".terragrunt-cache", ".terraform", "node_modules", ".git", "dist", ".chant", "modules"]);

export interface TerragruntDependency {
  /** The block's label: `dependency "ledger"`. */
  name: string;
  /** `config_path` as written, or undefined when it is not a string literal. */
  configPath?: string;
  /** The unit it names, relative to the repo, when that is a unit here. */
  unit?: string;
  /** The line of the block in terragrunt.hcl. */
  line: number;
}

export interface TerragruntUnit {
  /** The unit's directory relative to the repo, POSIX: also its name, as terragucci names it. */
  dir: string;
  /** `terraform { source }` as written, when it is a string literal. */
  source?: string;
  /** The module directory the source resolves to, relative to the repo, when it holds `.tf` files. */
  module?: string;
  /** Why the module was not resolved, when it was not. */
  unresolved?: string;
  dependencies: TerragruntDependency[];
}

/** Line comments (`#`, `//`) and block comments blanked, strings kept, so a
 * brace or a `#` inside a string is never read as structure. Newlines stay, so
 * line numbers hold. */
export function stripHclComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The body of the block whose opening brace is at `open`, by brace count outside strings. */
function blockBody(text: string, open: number): string {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** A top-level `name = "literal"` attribute in a block body; undefined when it is absent or not a plain string. */
function stringAttr(body: string, name: string): string | undefined {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*"([^"\\\\$]*)"\\s*$`, "m").exec(body);
  return m ? m[1] : undefined;
}

/** What one terragrunt.hcl declares: its module source and its dependency blocks. */
export function parseTerragrunt(text: string): { source?: string; sourceStated: boolean; dependencies: Omit<TerragruntDependency, "unit">[] } {
  const src = stripHclComments(text);
  const lineAt = (i: number): number => src.slice(0, i).split("\n").length;
  let source: string | undefined;
  let sourceStated = false;
  const tf = /^\s*terraform\s*\{/m.exec(src);
  if (tf) {
    const body = blockBody(src, tf.index + tf[0].length - 1);
    sourceStated = /^\s*source\s*=/m.test(body);
    source = stringAttr(body, "source");
  }
  const dependencies: Omit<TerragruntDependency, "unit">[] = [];
  const dep = /^\s*dependency\s+"([^"]+)"\s*\{/gm;
  for (let m = dep.exec(src); m; m = dep.exec(src)) {
    const body = blockBody(src, m.index + m[0].length - 1);
    const configPath = stringAttr(body, "config_path");
    dependencies.push({ name: m[1]!, ...(configPath !== undefined ? { configPath } : {}), line: lineAt(m.index + m[0].length - m[0].trimStart().length) });
  }
  return { ...(source !== undefined ? { source } : {}), sourceStated, dependencies };
}

const posix = (p: string): string => p.split(sep).join("/") || ".";

const hasTf = (dir: string): boolean => {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".tf"));
  } catch {
    return false;
  }
};

/**
 * Where a unit's source points, relative to the repo, or why it doesn't
 * resolve here. Only a local path is followed: Terragrunt's `//` (the module
 * inside the source) is joined, a `?ref=` is dropped, and anything with a
 * scheme or a getter prefix (`git::`, `tfr://`, `https://`) is remote.
 */
export function resolveSource(repo: string, unitDir: string, source: string | undefined, stated: boolean): { module: string } | { why: string } {
  if (source === undefined) return { why: stated ? "its terraform source is an expression, which behold does not evaluate" : "it names no terraform source" };
  if (/^[a-z0-9+.-]+::/i.test(source) || /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^./][^:]*:/.test(source)) return { why: `its source ${source} is not in this repo` };
  const path = source.split("?")[0]!.replace(/\/\/+/g, "/");
  const root = resolve(repo);
  const abs = resolve(root, unitDir, path);
  if (abs !== root && !abs.startsWith(root + sep)) return { why: `its source ${source} points outside the repo` };
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { why: `its source ${source} is not a directory here` };
  if (!hasTf(abs)) return { why: `its source ${source} holds no .tf file` };
  return { module: posix(relative(root, abs)) };
}

/** Every unit under `repo`: each directory holding a terragrunt.hcl, read. Sorted by directory. */
export function discoverTerragruntUnits(repo: string): TerragruntUnit[] {
  const root = resolve(repo);
  const found: { dir: string; text: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    const file = join(dir, TERRAGRUNT_FILE);
    if (dir !== root && existsSync(file)) {
      try {
        found.push({ dir: posix(relative(root, dir)), text: readFileSync(file, "utf8") });
      } catch {
        // unreadable: not evidence either way
      }
    }
    if (depth >= UNIT_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  const dirs = new Set(found.map((f) => f.dir));
  return found
    .map(({ dir, text }) => {
      const p = parseTerragrunt(text);
      const r = resolveSource(root, dir, p.source, p.sourceStated);
      return {
        dir,
        ...(p.source !== undefined ? { source: p.source } : {}),
        ...("module" in r ? { module: r.module } : { unresolved: r.why }),
        dependencies: p.dependencies.map((d) => {
          const target = d.configPath !== undefined ? posix(relative(root, resolve(root, dir, d.configPath))) : undefined;
          return { ...d, ...(target && dirs.has(target) ? { unit: target } : {}) };
        }),
      };
    })
    .sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/** Does `dir` hold at least one Terragrunt unit? */
export function hasTerragruntUnits(dir: string): boolean {
  return discoverTerragruntUnits(dir).length > 0;
}

/** What a Terragrunt repo draws: its units, and the roots terragucci.components.json declares that no unit on disk is. */
export interface TerragruntPicture {
  units: TerragruntUnit[];
  /** Declared roots with no terragrunt.hcl here, with the roots their component depends on. */
  declaredOnly: { name: string; dir: string; dependsOn: string[] }[];
}

export function terragruntPicture(repo: string, units: TerragruntUnit[], decl?: TerragucciComponents): TerragruntPicture {
  const onDisk = new Set(units.map((u) => u.dir));
  const declaredOnly: TerragruntPicture["declaredOnly"] = [];
  if (decl) {
    for (const [name, r] of Object.entries(decl.roots)) {
      const dir = r.dir.replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
      if (onDisk.has(dir) || onDisk.has(name)) continue;
      if (hasTf(join(repo, dir))) continue;
      const comp = decl.components.find((c) => c.name === name);
      declaredOnly.push({ name, dir, dependsOn: comp ? [...comp.dependsOn] : [] });
    }
  }
  return { units, declaredOnly };
}

const LEXICON = "terraform";

/**
 * Add the units to what chant read of their modules: a card for each
 * `dependency` block, with an edge to the unit it reads, and one card for
 * each unit (or declared root) whose resources behold cannot read, saying
 * why. Mutates and returns `ir`, chant's raw shape (`Terraform::*` kinds),
 * before the terraform member's passes name and box the cards.
 */
export function addTerragruntUnits(ir: GraphIR, picture: TerragruntPicture): GraphIR {
  const byStack = { ...((ir.groups as { byStack?: Record<string, string[]> } | undefined)?.byStack ?? {}) };
  const add = (n: IRNode): void => {
    ir.nodes.push(n);
    const root = n.attrs.root as string;
    (byStack[root] ??= []).push(n.id);
  };
  const placeholder = (root: string, file: string | undefined, why: string): void => {
    add({
      id: `${root}/module.not_read`,
      kind: "Terraform::Module",
      lexicon: LEXICON,
      attrs: { address: "module.not_read", root, ...(file ? { file, line: 1 } : {}), unread: why },
    } as IRNode);
  };
  for (const u of picture.units) if (!u.module) placeholder(u.dir, TERRAGRUNT_FILE, `Drawn from terragrunt.hcl alone, with no resources: ${u.unresolved ?? "its module was not read"}.`);
  for (const d of picture.declaredOnly) placeholder(d.name, undefined, "Drawn from terragucci.components.json alone, with no resources: no terragrunt.hcl or .tf file for it is in this checkout.");

  // The cards a read lands on: a unit's resources, data and modules, else whatever it has.
  const targets = (root: string): string[] => {
    const own = ir.nodes.filter((n) => n.attrs.root === root && n.kind !== "Terraform::Data");
    const estate = own.filter((n) => n.kind === "Terraform::Resource" || n.kind === "Terraform::Module");
    return (estate.length ? estate : own).map((n) => n.id);
  };
  const edges: { from: string; to: string; kind: string }[] = [];
  const read = (root: string, label: string, upstream: string | undefined, file: string | undefined, line: number | undefined, extra: Record<string, unknown>): void => {
    const id = `${root}/data.terragrunt_dependency.${label}`;
    add({
      id,
      kind: "Terraform::Data",
      lexicon: LEXICON,
      attrs: { address: `data.terragrunt_dependency.${label}`, root, ...(file ? { file } : {}), ...(line ? { line } : {}), ...(upstream ? { reads: `unit ${upstream}` } : {}), ...extra },
    } as IRNode);
    if (upstream) for (const to of targets(upstream)) edges.push({ from: id, to, kind: "ref" });
  };
  for (const u of picture.units) {
    for (const d of u.dependencies) read(u.dir, d.name, d.unit, TERRAGRUNT_FILE, d.line, { ...(d.configPath !== undefined ? { config_path: d.configPath } : {}), ...(d.unit ? {} : { unread: `config_path ${d.configPath ?? "(an expression)"} names no unit in this checkout` }) });
  }
  const names = new Set([...picture.units.map((u) => u.dir), ...picture.declaredOnly.map((d) => d.name)]);
  for (const d of picture.declaredOnly) {
    for (const up of d.dependsOn) read(d.name, up.replace(/\//g, "_"), names.has(up) ? up : undefined, undefined, undefined, { declared: "terragucci.components.json dependsOn" });
  }
  ir.edges.push(...(edges as GraphIR["edges"]));
  ir.groups = { ...(ir.groups ?? {}), byStack } as GraphIR["groups"];
  return ir;
}

/** The units as one clause for the graph's note. */
export function terragruntNote(picture: TerragruntPicture): string | undefined {
  const n = picture.units.length;
  if (!n && !picture.declaredOnly.length) return undefined;
  const read = picture.units.filter((u) => u.module);
  const modules = [...new Set(read.map((u) => u.module!))];
  const parts = [`${n} Terragrunt unit${n === 1 ? "" : "s"} — ${picture.units.map((u) => u.dir).join(", ")}`];
  if (modules.length) parts.push(`resources from ${modules.join(", ")}`);
  const unread = picture.units.filter((u) => !u.module);
  if (unread.length) parts.push(`${unread.map((u) => u.dir).join(", ")} drawn from terragrunt.hcl alone (${unread[0]!.unresolved})`);
  if (picture.declaredOnly.length) parts.push(`${picture.declaredOnly.map((d) => d.name).join(", ")} declared in terragucci.components.json with no unit here`);
  return parts.join("; ");
}
