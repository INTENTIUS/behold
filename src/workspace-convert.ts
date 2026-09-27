/**
 * `behold doctor --fix` (#464, ws-015): turn an estate behold serves from a
 * member list into a chant workspace declaration.
 *
 * ws-015 deprecates the member list in `.behold.json` in favour of
 * `chant.workspace.json`, and chose a conversion the user runs over one behold
 * runs by itself, because behold does not write into a directory it serves
 * unasked. This is that conversion. It writes two files and nothing else:
 *
 *   - `chant.workspace.json` in the estate root, only when none exists.
 *   - `.behold/layout.json` in the estate root, carrying the hand layout that
 *     was saved while the estate was served as `behold serve a b c`. That file
 *     lived in the FIRST member (a loose estate's `projectDir` is `dirs[0]`),
 *     and its node ids are rewritten to the ids the declared workspace reads
 *     as. The old file is left where it is.
 *
 * NAMES. A member is named what `composeStacks` already called it
 * (`shortStackNames` over the member dirs), so a chant member's ids do not move
 * at all. A name the declaration can't hold (`[a-z0-9-]`, 40 characters) is
 * folded into one it can, and the layout follows it.
 *
 * TERRAFORM. A behold terraform member is a directory of roots (#384); a chant
 * `terraform` member is one root (its probe is a `.tf` file directly in the
 * directory, #2545). So a terraform member splits into one member per root.
 * chant reads a terraform member as a root named after the member
 * (INTENTIUS/chant#2874), which makes its ids `<member>/<member>/<address>`
 * where behold's were `<estate member>/<root>/<address>`; the layout map
 * rewrites one into the other.
 *
 * PINS. A workspace with terraform or choudoufu members pins
 * `@intentius/chant-lexicon-terraform`, which supplies both kinds; without the
 * pin `chant workspace check` fails them as an unknown kind (WSP002/WSP003).
 * The pin is the version installed where chant will look for it, walking up
 * from the root as Node does. A root with its own chant pins that too
 * (ws-021: the root's chant reads the declaration).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { shortStackNames } from "@intentius/pinhole";
import { resolveChant } from "./chant.ts";
import { LAYOUT_DIR, layoutPath, readLayoutFile, type LayoutFile } from "./layout.ts";
import { detectProjectShape } from "./project.ts";
import { discoverTerraformRoots } from "./terraform-member.ts";
import { DECLARATION_FILES } from "./workspace.ts";

export const TERRAFORM_LEXICON = "@intentius/chant-lexicon-terraform";

export interface DeclaredMember {
  name: string;
  dir: string;
  kind: string;
}

export interface Declaration {
  name: string;
  schema: 1;
  pins?: { package: string; version: string }[];
  members: DeclaredMember[];
}

/** One node-id prefix the layout moves from, and where to. */
export interface IdMove {
  from: string;
  to: string;
}

export interface ConversionPlan {
  root: string;
  /** Where the member list came from: `.behold.json`, or npm workspaces. */
  from: "behold-config" | "workspaces";
  declaration: Declaration;
  /** Id prefixes to rewrite in the saved layout, longest first. */
  moves: IdMove[];
  /** The layout file a loose serve wrote, when there is one. */
  layoutFrom?: string;
  /** Things the user should know, one line each. */
  notes: string[];
}

export type ConversionResult = { ok: true; plan: ConversionPlan } | { ok: false; error: string };

/** A declaration name: lowercase letters, digits and hyphens, starting with one of the first two, 40 at most. */
export function declarationName(raw: string): string {
  const folded = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return folded || "member";
}

/** Make `name` unique among `taken`, adding `-2`, `-3`... */
function unique(name: string, taken: Set<string>): string {
  let out = name;
  for (let i = 2; taken.has(out); i++) out = `${name.slice(0, 40 - String(i).length - 1)}-${i}`;
  taken.add(out);
  return out;
}

const posix = (p: string): string => p.split(sep).join("/");

/** The installed version of `pkg` Node would find from `dir`, walking up. */
export function installedVersion(pkg: string, dir: string): string | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const manifest = join(at, "node_modules", ...pkg.split("/"), "package.json");
    if (existsSync(manifest)) {
      try {
        const v = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version;
        return typeof v === "string" ? v : undefined;
      } catch {
        return undefined;
      }
    }
    if (dirname(at) === at) return undefined;
  }
}

/** Work out the declaration and the layout moves, without writing anything. */
export function planConversion(rootArg: string): ConversionResult {
  const root = resolve(rootArg);
  const existing = DECLARATION_FILES.find((f) => existsSync(join(root, f)));
  if (existing) return { ok: false, error: `${root} already has ${existing}; there is nothing to convert.` };
  const shape = detectProjectShape(root);
  if (shape.kind !== "estate" || !shape.members?.length || shape.membersFrom === "itself") {
    return { ok: false, error: `${root} is not an estate root with a member list, so there is no member list to convert.` };
  }

  const abs = shape.members.map((m) => resolve(root, m.dir));
  const shorts = shortStackNames(abs);
  const taken = new Set<string>();
  const members: DeclaredMember[] = [];
  const moves: IdMove[] = [];
  const notes: string[] = [];
  let needsLexicon = false;

  shape.members.forEach((m, i) => {
    const short = shorts[i];
    const dir = posix(relative(root, abs[i])) || ".";
    if (m.kind === "terraform") {
      needsLexicon = true;
      const scan = discoverTerraformRoots(abs[i]);
      for (const r of scan.roots) {
        const name = unique(declarationName(r.name), taken);
        members.push({ name, dir: r.dir === "." ? dir : posix(join(dir, r.dir)), kind: "terraform" });
        moves.push({ from: `${short}/${r.name}/`, to: `${name}/${name}/` });
      }
      for (const s of scan.skipped) notes.push(`${posix(join(dir, s.dir))} is not declared: ${s.why}.`);
      if (scan.roots.length > 1) notes.push(`${dir} held ${scan.roots.length} Terraform roots; each is its own member now, since a chant terraform member is one root.`);
      return;
    }
    if (m.kind === "choudoufu") needsLexicon = true;
    const name = unique(declarationName(short), taken);
    members.push({ name, dir, kind: m.kind });
    if (name !== short) {
      moves.push({ from: `${short}/`, to: `${name}/` });
      notes.push(`member ${short} is declared as ${name}: a declared name is lowercase letters, digits and hyphens.`);
    }
  });

  const pins: { package: string; version: string }[] = [];
  const chant = resolveChant(root);
  if (chant.source === "project" && chant.version) pins.push({ package: "@intentius/chant", version: chant.version });
  if (needsLexicon) {
    const version = installedVersion(TERRAFORM_LEXICON, root);
    if (version) pins.push({ package: TERRAFORM_LEXICON, version });
    else notes.push(`${TERRAFORM_LEXICON} is not installed where chant looks from ${root}; install it there and add it to "pins", or chant cannot read the terraform and choudoufu members.`);
  }

  const declaration: Declaration = {
    name: declarationName(basename(root)),
    schema: 1,
    ...(pins.length ? { pins } : {}),
    members,
  };
  const firstLayout = layoutPath(abs[0]);
  moves.sort((a, b) => b.from.length - a.from.length);
  return { ok: true, plan: { root, from: shape.membersFrom === "behold-config" ? "behold-config" : "workspaces", declaration, moves, ...(existsSync(firstLayout) ? { layoutFrom: firstLayout } : {}), notes } };
}

/** Rewrite every node id in a layout by the first move whose prefix it starts with. */
export function moveLayoutIds(file: LayoutFile, moves: readonly IdMove[]): LayoutFile {
  const lenses: LayoutFile["lenses"] = {};
  for (const [lens, deltas] of Object.entries(file.lenses)) {
    const out: typeof deltas = {};
    for (const [id, d] of Object.entries(deltas)) {
      const move = moves.find((m) => id.startsWith(m.from));
      out[move ? move.to + id.slice(move.from.length) : id] = d;
    }
    lenses[lens] = out;
  }
  return { version: 1, lenses };
}

export interface ConversionWrite {
  declaration: string;
  /** The layout written, or why none was. */
  layout: { wrote: string; ids: number } | { skipped: string };
}

/** Write the declaration, and move the saved layout. Refuses to overwrite either file. */
export function applyConversion(plan: ConversionPlan): ConversionWrite {
  const declarationFile = join(plan.root, DECLARATION_FILES[0]);
  if (existsSync(declarationFile)) throw new Error(`${declarationFile} appeared while converting; nothing was written`);
  writeFileSync(declarationFile, `${JSON.stringify(plan.declaration, null, 2)}\n`);

  let layout: ConversionWrite["layout"];
  const target = layoutPath(plan.root);
  if (!plan.layoutFrom) layout = { skipped: "no saved layout to move" };
  else if (resolve(plan.layoutFrom) === resolve(target)) layout = { skipped: "the saved layout is already in the root" };
  else if (existsSync(target)) layout = { skipped: `${target} already exists; the layout in ${plan.layoutFrom} was left alone` };
  else {
    const moved = moveLayoutIds(readLayoutFile(dirname(dirname(plan.layoutFrom))), plan.moves);
    mkdirSync(join(plan.root, LAYOUT_DIR), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(moved, null, 2)}\n`);
    renameSync(tmp, target);
    layout = { wrote: target, ids: Object.values(moved.lenses).reduce((n, l) => n + Object.keys(l).length, 0) };
  }
  return { declaration: declarationFile, layout };
}

