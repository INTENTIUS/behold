/**
 * Serving a bare Terraform directory (#384, the last behold-side piece of
 * #378's lane).
 *
 * #379/#380/#382 made a Terraform estate legible, but only for a project that
 * already declares the lexicon. Point behold at the thing this exists to draw —
 * a directory of `.tf` files and nothing else — and it refused, correctly:
 * there is no `chant.config.ts` there, and #378 chose not to ask an estate for
 * one (INTENTIUS/waterpark#88 was withdrawn — the estate is more useful
 * untouched). So behold generates the reader config itself, in a scratch
 * directory of its own, and points chant at that. Nothing is written under the
 * served directory; the Invariant's one in-project write stays
 * `.behold/layout.json`.
 *
 * Three decisions shape this, and each was a real trade (#384's own three open
 * questions).
 *
 * **The reader ships with behold, and is still probed.** chant resolves
 * `@intentius/chant-lexicon-terraform` from the config file's own location, so
 * the generated project has to see it, and chant core (not the lexicon) does
 * `import("@cdktn/hcl2json")` from its own real path when it parses HCL. The
 * lexicon declares no dependency on the parser; neither does chant. #384 made
 * both optional peers to keep a ~1.8 MB wasm blob out of chant-only installs.
 * #909 reversed that: both are DEPENDENCIES in behold's package.json (the
 * versions this reader was built against, and the only place they are named),
 * so `npx @intentius/behold serve .` in a folder of `.tf` files draws with no
 * other command. The maintainer accepted the cost on #909 (+8.3 MB on a 195 MB
 * install, six packages). behold still runs no `terraform` binary
 * (`src/carve-lens.ts`). The probe stays: an install that skipped or pruned
 * them (`--omit`, a hand-trimmed image) would otherwise reach chant, which
 * warns, exits 0 and prints an empty graph when the parser is missing. So both
 * are resolved here and refused with the one install line when absent, the way
 * `behold demo` gates on binaries it does not ship. The refusal names where
 * behold looked, because "install it" is only useful beside "here".
 *
 * **Roots are discovered, not declared.** `chant carve advise --from <parent>`
 * over the parent of six roots returns zero resources: the parse is one root at
 * a time and the lexicon's config names roots explicitly. #384 proposed the
 * cheap probe — a directory with a `.tf` declaring a `terraform {}` or
 * `provider` block, "which is what a root has and a called module does not" —
 * and the real estate says otherwise: water park's `access/modules/persona` is
 * a shared module called by three roots and its `versions.tf` opens with
 * `terraform {` and `required_providers`, byte-for-byte the shape
 * `access/baseline` has. So the probe stands and two exclusions stand beside
 * it, both measured on that estate and both reported rather than silent:
 * a directory under a `modules/` segment is a called module (Terraform's own
 * standard module structure, and what waterpark's README says of it), and a
 * directory with no `resource`, `data` or `module` block has nothing to draw
 * (`access/backends` is two backend fragments, one of which is copied into a
 * root). behold parses no HCL: this is the same regex-depth probe the
 * choudoufu member uses for its `live {` block, per candidate directory.
 *
 * **A member kind, not a serve-time special case.** #378 said there is no
 * `terraform` member kind and meant it about READING: behold parses no HCL and
 * the render goes through chant. A kind whose `read` shells `chant graph`
 * against a generated config does not contradict that — it is a scaffold, not
 * a second reader — and it inherits the probe, the cache stamp, the doctor line
 * and estate composition (#368) for free. A Terraform root can therefore sit in
 * a composed estate beside a chant project and a choudoufu estate.
 *
 * ---------------------------------------------------------------------------
 * THE SCRATCH PROJECT. `<tmpdir>/behold-tf-<hash of the estate path>`: named
 * `behold-*` and cleared through `assertScratch` like everything else behold
 * creates (src/scratch.ts), deterministic per estate path so a reload reuses it
 * instead of littering, and asserted to be outside the estate before a byte is
 * written. It holds three things:
 *
 *   - `chant.config.ts` — `lexicons: ["terraform"]` and one `terraform.roots`
 *     entry per discovered root.
 *   - `node_modules` — a symlink to behold's OWN `node_modules`. Node
 *     resolution from the config's location then finds the lexicon, chant and
 *     zod exactly as it would inside behold's install. It is the directory
 *     chant resolves into (`beholdNodeModules`): under npx or a global prefix
 *     that is the tree behold itself sits in, where npm hoists behold's
 *     dependencies, so the lexicon and the parser land beside chant. That is
 *     also where chant's own `import("@cdktn/hcl2json")` looks. The lexicon's
 *     range in package.json starts at behold's chant floor, so the lexicon's
 *     `@intentius/chant` peer is met by behold's chant instead of a second
 *     copy. The alternative (place
 *     the scratch project under behold's tree so resolution walks up into it)
 *     was refused: behold's install is often a global npm prefix or an npx
 *     cache, both of which may be read-only, and a scratch directory that
 *     lives beside the operator's other scratch state is easier to find and to
 *     delete. One symlink buys the same resolution with none of that.
 *   - `estate` — a symlink to the served directory, which is what each root's
 *     `dir` goes through. Not decoration: the lexicon's `hcl/descend.ts` sets a
 *     root's module boundary to the root's OWN directory when the root's `dir`
 *     resolves outside the project root, so absolute `dir`s cost every
 *     `../modules/x` call the estate makes. Measured on water park: 72 nodes
 *     and 6 resources with absolute dirs, 247 nodes and 43 resources through
 *     the symlink — the same 247 #378 measured with a config committed inside
 *     the estate. Nothing about the answer mentions the scratch path: a
 *     terraform entity carries `attrs.file` relative to its root and no
 *     `sourceLoc`.
 * ---------------------------------------------------------------------------
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import type { GraphOptions } from "./chant.ts";
import type { MemberVia } from "./member-ir.ts";
import type { MemberKindSpec, MemberPasses } from "./member-kind.ts";
// The three passes themselves do not move (#427) — only their caller does.
// src/terraform-lens.ts imports chant types and src/carve-lens.ts's `tfTypeOf`
// and nothing from the read path, so this adds no cycle.
import {
  filterTerraformCards,
  groupTerraformByRoot,
  hasTerraformEntities,
  normalizeTerraformNodes,
  terraformElisionNote,
  terraformElisionNoteShort,
} from "./terraform-lens.ts";
import { SCRATCH_PREFIX, assertScratch } from "./scratch.ts";
import { attachLintFindings, terraformLintNote } from "./terraform-lint.ts";
import { redactSensitiveSources } from "./terraform-redact.ts";
import { GRAPH_LINT_REPORT_CHANT_FLOOR } from "./chant-floors.ts";
import { meetsFloor } from "./floor.ts";
import {
  TERRAGUCCI_COMPONENT_MODULE,
  declaredRootScan,
  readTerragucciComponents,
  terragucciComponentModule,
  type TerragucciComponents,
} from "./terragucci-components.ts";
import { addTerragruntUnits, discoverTerragruntUnits, terragruntNote, terragruntPicture, type TerragruntPicture } from "./terragrunt-units.ts";

/** The reader chant loads for a Terraform root, and the HCL parser chant
 * lazily loads underneath. Both are dependencies of behold (#909, see the
 * header); the ranges live in behold's package.json and are read from it, so
 * the install line and the manifest cannot drift apart. */
export const TERRAFORM_LEXICON_PKG = "@intentius/chant-lexicon-terraform";
/** The HCL parser chant core imports when it reads a Terraform root, by this
 * name since 0.77.0 (chant#2483): the CDK Terrain continuation of
 * `@cdktf/hcl2json`, whose repo HashiCorp archived on 2025-12-10. Neither
 * chant nor the lexicon declares it (both list it as a devDependency only), so
 * behold's package.json is what puts it beside chant. The two are installed
 * and refused together. */
export const HCL_PARSER_PKG = "@cdktn/hcl2json";

/** How far below the served directory a root may sit. water park's roots are
 * two levels down (`envs/prod`, `satellites/waterpark-runner`); three is one
 * more than the estate this was measured against needs, and it bounds the walk
 * on a repository that is mostly not Terraform. */
export const ROOT_SCAN_DEPTH = 3;

/** Directories the walk never enters: build output, installed packages, and
 * Terraform's own working directory (`.terraform` holds a copy of every module
 * it fetched, which would read as a tree of roots). */
const SKIP_DIRS = new Set([".terraform", "node_modules", ".git", "dist", ".chant", "cdk.out"]);

/** What a root states about itself: the providers it requires, its backend, or
 * a provider configuration. Line-anchored, like the choudoufu probe's `live {`
 * — a regex over the file, never a parse. */
const ROOT_BLOCK = /^(terraform\s*\{|provider\s+")/m;

/** Something to draw: #382's estate tier, in HCL. A directory of backend
 * fragments has none. */
const ESTATE_BLOCK = /^(resource|data|module)\s+"/m;

/** Terraform's standard module structure puts called modules here. */
const MODULES_SEGMENT = "modules";

// ---------------------------------------------------------------------------
// Root discovery.
// ---------------------------------------------------------------------------

/** One discovered root: the name it is keyed and boxed under, and its path
 * relative to the served directory (`.` when the served directory is itself a
 * root). */
export interface TerraformRoot {
  name: string;
  /** Relative to the estate, POSIX-separated. `.` for the estate itself. */
  dir: string;
  /** behold#571: a Terragrunt unit's own directory, when `dir` is the module
   * its source names (the directory chant reads its resources from). */
  unit?: string;
}

/** A directory holding `.tf` files that is not a root, and why — so a missing
 * root is visible rather than silently absent (#384). */
export interface TerraformSkip {
  dir: string;
  why: string;
}

export interface TerraformRootScan {
  roots: TerraformRoot[];
  skipped: TerraformSkip[];
}

/** Why this directory of `.tf` files is not a root, or undefined when it is. */
function notARoot(rel: string, sources: string[]): string | undefined {
  if (rel.split("/").slice(0, -1).includes(MODULES_SEGMENT)) return "called as a module, never applied on its own";
  if (!sources.some((s) => ROOT_BLOCK.test(s))) return "no `terraform` or `provider` block — a root states the providers it needs";
  if (!sources.some((s) => ESTATE_BLOCK.test(s))) return "no resource, data or module block — nothing to draw";
  return undefined;
}

/** A directory's own `*.tf` files, read whole. Unreadable files are not
 * evidence either way, exactly as `hasLiveBlock` treats them. */
function tfSources(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".tf")).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    try {
      out.push(readFileSync(join(dir, name), "utf8"));
    } catch {
      // unreadable: skip it
    }
  }
  return out;
}

/**
 * The roots under `estate`, and every other directory of `.tf` files with the
 * reason it is not one. Sync, read-only, no HCL parsed and no code run — the
 * contract a member kind's probe is held to (AGENTS.md, "Adding a member
 * kind").
 *
 * Names are the root directory's own basename (`envs/prod` → `prod`), which is
 * what an operator calls it and what the box is titled. Two roots whose
 * basenames collide both take their full relative path with `/` → `-`, so a
 * name is never quietly given to one of them.
 */
export function discoverTerraformRoots(estate: string): TerraformRootScan {
  const root = resolve(estate);
  const found: { rel: string; skip?: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    const rel = relative(root, dir).split(sep).join("/") || ".";
    const sources = tfSources(dir);
    if (sources.length) found.push({ rel, skip: notARoot(rel, sources) });
    if (depth >= ROOT_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);

  const rootRels = found.filter((f) => !f.skip).map((f) => f.rel);
  const shortOf = (rel: string): string => (rel === "." ? basename(root) : rel.slice(rel.lastIndexOf("/") + 1));
  const counts = new Map<string, number>();
  for (const rel of rootRels) counts.set(shortOf(rel), (counts.get(shortOf(rel)) ?? 0) + 1);
  return {
    roots: rootRels.map((rel) => ({ name: counts.get(shortOf(rel))! > 1 ? rel.split("/").join("-") : shortOf(rel), dir: rel })),
    skipped: found.filter((f) => !!f.skip).map((f) => ({ dir: f.rel, why: f.skip! })),
  };
}

/** Does `dir` hold at least one Terraform root? */
export function hasTerraformRoots(dir: string): boolean {
  return discoverTerraformRoots(dir).roots.length > 0;
}

/**
 * The kind's probe: a directory of Terraform roots, or (behold#571) a
 * Terragrunt repo, whose units hold no `.tf` of their own, or a terragucci
 * repo whose terragucci.components.json declares its roots.
 */
export function isTerraformMember(dir: string): boolean {
  return hasTerraformRoots(dir) || discoverTerragruntUnits(dir).length > 0 || readTerragucciComponents(dir) !== undefined;
}

/** behold#571: the Terragrunt picture of `dir`, when it is a Terragrunt repo
 * (units on disk, or a declaration whose roots hold no `.tf`); undefined for a
 * directory of Terraform roots. */
export function terragruntOf(dir: string, components: TerragucciComponents | undefined = readTerragucciComponents(dir)): TerragruntPicture | undefined {
  const units = discoverTerragruntUnits(dir);
  if (!units.length && (!components || hasTerraformRoots(dir))) return undefined;
  const picture = terragruntPicture(dir, units, components);
  return picture.units.length || picture.declaredOnly.length ? picture : undefined;
}

/** behold#571: each unit whose module resolved, as a root chant reads: keyed by the unit's directory, read from the module's. */
export function terragruntRootScan(picture: TerragruntPicture): TerraformRootScan {
  return {
    roots: picture.units.filter((u) => u.module).map((u) => ({ name: u.dir, dir: u.module!, unit: u.dir })),
    skipped: [],
  };
}

/** The roots a repo's reports name, with the directory each is at (relative to `dir`): its Terraform roots, or its Terragrunt units. */
export function checkoutRootDirs(dir: string): { name: string; dir: string }[] {
  const tg = terragruntOf(dir);
  if (tg) return [...tg.units.map((u) => ({ name: u.dir, dir: u.dir })), ...tg.declaredOnly.map((d) => ({ name: d.name, dir: d.dir }))];
  return discoverTerraformRoots(dir).roots.map((r) => ({ name: r.name, dir: r.dir }));
}

/**
 * What discovery found, as one clause for the graph's note — the roots drawn
 * and the directories that hold `.tf` and are not roots, the way
 * `terraformElisionNote` says what a zoom left out. At most three skips are
 * named; the rest are counted, because a note is a line and not a report.
 */
export function terraformRootsNote(scan: TerraformRootScan): string | undefined {
  if (!scan.roots.length) return undefined;
  const roots = `${scan.roots.length} root${scan.roots.length === 1 ? "" : "s"} — ${scan.roots.map((r) => r.name).join(", ")}`;
  if (!scan.skipped.length) return roots;
  const named = scan.skipped.slice(0, 3).map((s) => `${s.dir} (${s.why})`);
  const more = scan.skipped.length > 3 ? `, +${scan.skipped.length - 3} more` : "";
  return `${roots}; skipped ${named.join(", ")}${more}`;
}

/** The same scan as a chip (#393) — `5 roots · 2 skipped`. The statusbar note
 * sits in a 260px panel and the sentence above is ~60 words of it, repeated at
 * every zoom; the full text stays on the strip's tooltip and in the Model tab,
 * and this is what the strip itself carries. */
export function terraformRootsNoteShort(scan: TerraformRootScan): string | undefined {
  if (!scan.roots.length) return undefined;
  const roots = `${scan.roots.length} root${scan.roots.length === 1 ? "" : "s"}`;
  return scan.skipped.length ? `${roots} · ${scan.skipped.length} skipped` : roots;
}

// ---------------------------------------------------------------------------
// The reader: is the lexicon here at all?
// ---------------------------------------------------------------------------

/** One reader package: the range behold's package.json declares, and the
 * version installed beside it (undefined when it is not there at all). */
export interface ReaderPackage {
  pkg: string;
  range?: string;
  version?: string;
}

/** behold's own directory — where its `node_modules` is resolved from, and the
 * directory whose package.json declares the reader packages. `dist/` in a build, `src/`
 * under tsx; both sit one level under the package root. */
const beholdDir = (): string => dirname(fileURLToPath(import.meta.url));

/** The range behold's own manifest declares for a reader package, so the
 * install line quotes what the package actually asks for (the same reading
 * `chantFloor` does for the chant floor). */
export function declaredRange(pkg: string, manifestDir = join(beholdDir(), "..")): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(manifestDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    return manifest.dependencies?.[pkg];
  } catch {
    return undefined;
  }
}

/** The version of `pkg` as resolved from `from`, or undefined when it does not
 * resolve. Walks up from the resolved entry to the manifest, because chant's
 * packages ship raw TypeScript with an `exports` map that rewrites
 * `./package.json` to a file that does not exist (src/chant.ts says the same
 * of its own resolution). */
export function resolvedVersion(pkg: string, from = beholdDir()): string | undefined {
  return resolvedPackage(pkg, from)?.version;
}

/** Where `pkg` resolves from `from`, and its version: the directory holding
 * its manifest. Undefined when it does not resolve. */
export function resolvedPackage(pkg: string, from = beholdDir()): { dir: string; version: string } | undefined {
  const req = createRequire(join(resolve(from), "noop.js"));
  let entry: string;
  try {
    entry = req.resolve(pkg);
  } catch {
    return undefined;
  }
  let dir = dirname(entry);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name === pkg) return { dir, version: manifest.version ?? "" };
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** #193's structured refusal, in this reader's own words: what is missing and
 * the one command that fixes it. */
export interface TerraformRefusal {
  error: string;
  code: "terraform-lexicon";
  remedy: string;
}

/** What behold can see of the reader: both packages, and the refusal when either
 * is absent. */
export interface TerraformReaderState {
  lexicon: ReaderPackage;
  parser: ReaderPackage;
  /** Where behold looked — named in the refusal, since "install it" is only
   * useful beside "here". */
  from: string;
  refusal?: TerraformRefusal;
}

const spec = (peer: ReaderPackage): string => `${peer.pkg}@${peer.range ?? "latest"}`;

/**
 * Probe the reader. Read-only and cheap (two module resolutions), so the graph
 * route, the doctor line and the member's `read` all ask the same question and
 * get the same answer.
 */
export function terraformReaderState(from = beholdDir()): TerraformReaderState {
  const peer = (pkg: string): ReaderPackage => ({ pkg, ...(declaredRange(pkg) ? { range: declaredRange(pkg) } : {}), ...(resolvedVersion(pkg, from) !== undefined ? { version: resolvedVersion(pkg, from) } : {}) });
  const lexicon = peer(TERRAFORM_LEXICON_PKG);
  const parser = peer(HCL_PARSER_PKG);
  const missing = [lexicon, parser].filter((p) => p.version === undefined);
  if (!missing.length) return { lexicon, parser, from };
  return {
    lexicon,
    parser,
    from,
    refusal: {
      error:
        `Reading a Terraform estate needs chant's terraform lexicon and its HCL parser, which behold installs as dependencies: ` +
        `${missing.map((p) => p.pkg).join(" and ")} ${missing.length === 1 ? "is" : "are"} not resolvable from ${from}, so this install skipped or pruned ${missing.length === 1 ? "it" : "them"}.`,
      code: "terraform-lexicon",
      remedy: `Install ${missing.map(spec).join(" ")} beside behold, then reload.`,
    },
  };
}

/** A refusal, thrown where a read cannot answer. `firstLine` in src/estate.ts
 * reads the part after "exited N: ", so the message is shaped that way —
 * the same shape `ChoudoufuReadError` takes. */
export class TerraformReadError extends Error {
  constructor(
    readonly refusal: TerraformRefusal,
    dir: string,
  ) {
    super(`terraform reader ${dir} exited 1: ${refusal.error}`);
  }
}

// ---------------------------------------------------------------------------
// The scratch project.
// ---------------------------------------------------------------------------

/** behold's own `node_modules` — the directory the scratch project's symlink
 * points at. Derived from the chant install behold itself resolves, so it is
 * the same tree the rest of behold reads from. */
export function beholdNodeModules(from = beholdDir()): string | undefined {
  const req = createRequire(join(resolve(from), "noop.js"));
  let entry: string;
  try {
    entry = req.resolve("@intentius/chant");
  } catch {
    return undefined;
  }
  for (let dir = dirname(entry); ; ) {
    if (basename(dir) === "node_modules") return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The scratch project for one estate: `behold-tf-<hash>` under the OS temp
 * directory. Deterministic (one directory per estate path, reused across
 * runs), `behold-*` (src/scratch.ts, asserted here rather than at the write),
 * and never inside the estate — which is checked rather than assumed, because
 * that check is the whole write boundary this feature has to hold. */
export function terraformScratchDir(estate: string, tmp = tmpdir(), flavour: ScratchFlavour = "tf"): string {
  const target = resolve(estate);
  const name = `${SCRATCH_PREFIX}${flavour}-${createHash("sha1").update(target).digest("hex").slice(0, 12)}`;
  assertScratch(name);
  // realpath first: on macOS `tmpdir()` is a symlink (/var → /private/var), and
  // an unresolved path makes the containment check below compare two different
  // spellings of the same directory.
  let root = resolve(tmp);
  try {
    root = realpathSync(root);
  } catch {
    // no such temp dir: the join below fails loudly at write time instead
  }
  const dir = join(root, name);
  if (dir === target || dir.startsWith(target + sep)) {
    throw new Error(`scratch discipline: the generated reader config for ${target} would land inside the estate (${dir})`);
  }
  return dir;
}

/** Which generated project a scratch directory holds: the Terraform member's
 * reader (`tf`, #384), or the choudoufu member's predictor (`chdf`, #402),
 * whose config names `binary: "choudoufu"` so the lexicon reads the root live.
 * Two names, so one directory served as each kind in turn never rewrites the
 * other's config. `tfws` is the one-member workspace a bare folder is searched
 * through (behold#925), which holds a declaration and no config. */
export type ScratchFlavour = "tf" | "chdf" | "tfws";

/** The `chant.config.ts` a scan generates. Pure and deterministic: the same
 * estate and the same roots produce the same bytes, so a reload rewrites
 * nothing. Exported for testing. */
export function terraformScratchConfig(scan: TerraformRootScan, estateLink: string, flavour: ScratchFlavour = "tf"): string {
  const roots = [...scan.roots].sort((a, b) => (a.name < b.name ? -1 : 1));
  const entries = roots.map((r) => `      ${JSON.stringify(r.name)}: { dir: ${JSON.stringify(r.dir === "." ? estateLink : `${estateLink}/${r.dir}`)} },`);
  return [
    "// Generated by behold (#384) — the reader config for a Terraform estate that",
    "// has none of its own. behold writes this OUTSIDE the estate and rewrites it",
    "// on each read; nothing here is yours to edit, and the estate itself is",
    `// untouched. \`${estateLink}\` is a symlink to the served directory.`,
    'import type { ChantConfig } from "@intentius/chant/config";',
    `import ${JSON.stringify(TERRAFORM_LEXICON_PKG)};`,
    "",
    "export default {",
    '  lexicons: ["terraform"],',
    "  terraform: {",
    ...(flavour === "chdf" ? ['    binary: "choudoufu",'] : []),
    "    roots: {",
    ...entries,
    "    },",
    "  },",
    // #919: draw the estate when lint finds errors, with the findings on
    // meta.lint. A chant older than GRAPH_LINT_REPORT_CHANT_FLOOR ignores it.
    '  graph: { lint: "report" },',
    "} satisfies ChantConfig;",
    "",
  ].join("\n");
}

/** The symlink name the estate is reached through inside the scratch project. */
export const ESTATE_LINK = "estate";

/** Point `path` at `target`, replacing whatever is there when it is not
 * already that link. Nothing else in the scratch directory is ever removed. */
function relink(path: string, target: string): void {
  try {
    if (lstatSync(path).isSymbolicLink() && readlinkSync(path) === target) return;
    unlinkSync(path);
  } catch {
    // absent, or not a link we can read: fall through to creating it
  }
  symlinkSync(target, path);
}

/**
 * Write (or refresh) the scratch project for `estate` and return its directory.
 * The only writes this feature performs, all of them under the OS temp
 * directory: the config, its `package.json`, and the two symlinks the header
 * explains.
 */
export function writeTerraformScratchProject(
  estate: string,
  scan: TerraformRootScan,
  tmp = tmpdir(),
  flavour: ScratchFlavour = "tf",
  components?: TerragucciComponents,
): string {
  const target = resolve(estate);
  const dir = terraformScratchDir(target, tmp, flavour);
  mkdirSync(dir, { recursive: true });
  relink(join(dir, ESTATE_LINK), target);
  const modules = beholdNodeModules();
  if (modules) relink(join(dir, "node_modules"), modules);
  // Rewritten only when it changed: the file's mtime is what chant's own
  // caching and a watcher would key on, and a reload that changed nothing
  // should look like nothing changed.
  const write = (path: string, text: string) => {
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
  };
  // The config is an ES module, and says so. Without a package.json declaring
  // it, tsx compiles it as CommonJS, and chant's compiled CLI (0.124.14 on,
  // INTENTIUS/chant#3897) reads that as `{ default: config }`: no lexicons,
  // "No lexicon detected", and an empty graph for every loose estate.
  write(join(dir, "package.json"), SCRATCH_PACKAGE_JSON);
  write(join(dir, "chant.config.ts"), terraformScratchConfig(scan, ESTATE_LINK, flavour));
  // #571: a terragucci repo's declared components, for `chant graph
  // --components`. A repo that stopped declaring them gets the module emptied
  // rather than removed (nothing here is ever deleted), so chant finds no
  // components where there are none.
  const module = join(dir, TERRAGUCCI_COMPONENT_MODULE);
  if (components) write(module, terragucciComponentModule(components));
  else if (existsSync(module)) write(module, "// terragucci.components.json is gone; no components.\nexport {};\n");
  return dir;
}

/**
 * #571: the scan a terraform member's scratch project is written from. A
 * terragucci repo that carries `terragucci.components.json` names its own
 * roots, so the config is keyed by those names and dirs (the names its
 * components' `terraform-apply` steps use); any other directory is discovered.
 */
export function terraformMemberScan(dir: string): { scan: TerraformRootScan; components?: TerragucciComponents; terragrunt?: TerragruntPicture } {
  const components = readTerragucciComponents(dir);
  // behold#571: a Terragrunt repo's roots are its units, read from their modules.
  const terragrunt = terragruntOf(dir, components);
  if (terragrunt) return { scan: terragruntRootScan(terragrunt), terragrunt, ...(components ? { components } : {}) };
  return components ? { scan: declaredRootScan(components), components } : { scan: discoverTerraformRoots(dir) };
}

/** #571: write the scratch project for a terraform member and return it, with
 * the declaration when there is one. What the components zoom reads. */
export function terraformMemberProject(dir: string): { project: string; components?: TerragucciComponents } {
  const { scan, components } = terraformMemberScan(dir);
  return { project: writeTerraformScratchProject(dir, scan, undefined, "tf", components), ...(components ? { components } : {}) };
}

// ---------------------------------------------------------------------------
// The scratch workspace (behold#925).
//
// A bare folder is drawn as a one-member estate whose cards are
// `<member>/<id>` (#389), and chant's scratch project knows nothing of that
// member. So the folder is declared to chant as a workspace of one member,
// named what behold names it, and `chant workspace search` composes the ids
// itself: behold does no id prefixing (the read-contract ruling on #908).
//
// The member is of kind `chant` and its directory is a link to the scratch
// project above, not a member of kind `terraform` over the folder. chant's
// terraform kind reads one root named for the member at the member's
// directory, so a folder of several roots (`envs/prod` and `platform`)
// fails its probe, and a lone root's ids would be `<member>/<member>/...`
// rather than `<member>/<root>/...`. The scratch project already names every
// root the way the graph does, a Terragrunt unit or a terragucci component
// included, so the ids chant composes are the ids behold draws.
//
// `<tmpdir>/behold-tfws-<hash of the estate path>` holds three things and
// nothing else: `chant.workspace.json`, a `node_modules` link to behold's own
// (the workspace root's chant, ws-021), and a link named for the member to the
// scratch project. Not a git repository: chant then reads the working tree,
// and `at` is null.
// ---------------------------------------------------------------------------

/** The name grammar chant's declaration gives a workspace and its members. */
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The declaration the scratch workspace holds. Pure and deterministic. Exported for testing. */
export function terraformScratchDeclaration(member: string): string {
  return `${JSON.stringify(
    {
      $comment: "Generated by behold (#925): a bare Terraform folder, declared as a workspace of one member so chant composes its ids. Written outside the folder; nothing here is yours to edit.",
      name: member,
      schema: 1,
      members: [{ name: member, dir: member, kind: "chant" }],
    },
    null,
    2,
  )}\n`;
}

/**
 * Write (or refresh) the scratch workspace for `estate`, whose one member is
 * `member` at the scratch project `project`, and return its root. Every write
 * is under the OS temp directory, and nothing is ever removed. Throws when
 * `member` is not a name chant's declaration accepts.
 */
export function writeTerraformScratchWorkspace(estate: string, member: string, project: string, tmp = tmpdir()): string {
  if (!WORKSPACE_NAME.test(member)) throw new Error(`${JSON.stringify(member)} is not a workspace member name chant accepts (${WORKSPACE_NAME.source})`);
  const dir = terraformScratchDir(resolve(estate), tmp, "tfws");
  mkdirSync(dir, { recursive: true });
  const modules = beholdNodeModules();
  if (modules) relink(join(dir, "node_modules"), modules);
  relink(join(dir, member), resolve(project));
  const file = join(dir, "chant.workspace.json");
  const text = terraformScratchDeclaration(member);
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
  return dir;
}

/** behold#925: the scratch project and the one-member workspace over it, for a bare folder served as `member`. */
export function terraformMemberWorkspace(dir: string, member: string): { root: string; project: string } {
  const { project } = terraformMemberProject(dir);
  return { root: writeTerraformScratchWorkspace(dir, member, project), project };
}

/** The scratch project's package.json: private, and an ES module (INTENTIUS/chant#3897). */
export const SCRATCH_PACKAGE_JSON = `${JSON.stringify({ name: "behold-scratch", private: true, type: "module" }, null, 2)}\n`;

// ---------------------------------------------------------------------------
// The kind.
// ---------------------------------------------------------------------------

/** How a terraform member is read: behold's own chant over the generated
 * config, which is the version half of the cache key, plus the lexicon that
 * will actually answer — an upgraded reader is a different key, not a stale
 * hit. */
export const terraformVia: MemberVia = {
  tool: () => {
    // The reader, not the estate: behold's own chant is fixed for the life of
    // the process, and the lexicon is what turns the same HCL into a different
    // answer. An absent one stamps as absent rather than throwing — `read` is
    // where a missing reader is refused, with the install line.
    const state = terraformReaderState();
    return `${TERRAFORM_LEXICON_PKG}\0${state.lexicon.version ?? "absent"}\0${state.parser.version ?? "absent"}`;
  },
  read: (dir: string, opts: GraphOptions): Promise<GraphIR> => readTerraformMember(dir, opts),
};

/**
 * The tier this member is read at, whatever the caller asked for (#396
 * finding 3): never below 2.
 *
 * The lexicon thins its attrs by tier, and `address` and `root` go first — but
 * those two are not attributes of a Terraform block. They are its NAME and the
 * root it is declared in, which is what `normalizeTerraformNodes` titles a card
 * from and what `groupTerraformByRoot` boxes by. Read at detail 1 (the
 * `composites` zoom) waterpark came back as ONE box named `access` — the id's
 * first segment, taken by the fallback for a missing `root` — with all 73 cards
 * titled `access/baseline/aws_iam_policy.boundary` and every `kind` the same
 * mangled string: the whole resources picture undone by a zoom whose subject is
 * component ownership a Terraform estate does not have.
 *
 * What a zoom DRAWS is untouched — that is `filterTerraformCards` at the
 * caller's own detail, so 3 still adds the outputs and variables and 0-2 still
 * show the estate alone. This is only about what the reader is asked to carry.
 */
export function terraformReadDetail(detail: number | undefined): number {
  return Math.max(detail ?? 2, 2);
}

/**
 * The uncached read: discover the roots, write the scratch project, and let
 * chant graph it. The reader state is an argument with a default, the way
 * `readLiveCheck`'s spawn is, so a test can ask what an install without the
 * lexicon answers without uninstalling anything.
 */
export async function readTerraformMember(dir: string, opts: GraphOptions, state: TerraformReaderState = terraformReaderState()): Promise<GraphIR> {
  if (state.refusal) throw new TerraformReadError(state.refusal, dir);
  const { scan, components, terragrunt } = terraformMemberScan(dir);
  // behold#571: a Terragrunt repo with no module behold can read is drawn from its units alone.
  if (terragrunt && !scan.roots.length) return addTerragruntUnits({ version: 1, nodes: [], edges: [], groups: {} } as unknown as GraphIR, terragrunt);
  if (!scan.roots.length) {
    throw new TerraformReadError(
      {
        error: `${dir} holds no Terraform root — no directory under it declares a \`terraform\` or \`provider\` block beside a resource, data or module block.`,
        code: "terraform-lexicon",
        remedy: "Point behold at the directory that holds the roots (or at one root), then reload.",
      },
      dir,
    );
  }
  const project = writeTerraformScratchProject(dir, scan, undefined, "tf", components);
  // Source only. A Terraform estate has no live half here: what the cloud
  // holds is choudoufu's question (#366) or an Op's, and `--live` against a
  // reader lexicon would ask chant to observe entities it never applied.
  const { live: _live, overlay: _overlay, env: _env, ...source } = opts;
  const detail = terraformReadDetail(source.detail);
  // Imported here, not at module load: src/member-kind.ts registers this spec,
  // src/chant.ts imports src/project.ts which imports that table, and a
  // load-time edge back into src/chant.ts from here is the cycle that module's
  // header refuses. A dynamic import inside the read is not one, and a test's
  // mock of ./chant.ts still answers it.
  const { graphIr, ChantCliError } = await import("./chant.ts");
  let ir: GraphIR;
  try {
    ir = await graphIr(project, { ...source, detail });
  } catch (err) {
    // #919: a chant below the floor ignores `graph.lint` and still refuses an
    // estate lint finds errors in. Say which chant draws it.
    const chant = resolvedVersion("@intentius/chant");
    if (err instanceof ChantCliError && err.failure.code === "lint" && !meetsFloor(chant, GRAPH_LINT_REPORT_CHANT_FLOOR)) {
      err.failure.remedy = `chant ${GRAPH_LINT_REPORT_CHANT_FLOOR} draws a Terraform estate that lint finds errors in, and lists the findings. behold resolves chant ${chant ?? "(unknown version)"}: upgrade @intentius/chant beside behold, then reload.`;
    }
    throw err;
  }
  // Before composition, which keeps nodes and nothing above them.
  attachLintFindings(ir);
  // #920: a sensitive variable's literal default, in the file text each card carries and in its parsed body.
  redactSensitiveSources(ir);
  return terragrunt ? addTerragruntUnits(ir, terragrunt) : ir;
}

/**
 * The three passes that turn what chant read into a picture (#379, #380, #382),
 * in the one order they make sense: name the cards, box them by root, then drop
 * what is not estate at this detail. Lived at six call sites in src/server.ts
 * until #427 gave a kind somewhere to put them.
 *
 * Guarded on the IR carrying terraform entities, so every chant, k8s and helm
 * estate gets the identical object back. The guard is deliberately content and
 * not `lexicon === "terraform"`: a carve report's scored resources carry that
 * lexicon too (src/carve-lens.ts) and are not estate blocks.
 */
const terraformPasses: MemberPasses = {
  apply(ir, { detail }) {
    // #919: before the elision, so a finding on a block this zoom does not draw is still named.
    attachLintFindings(ir);
    const lint = terraformLintNote(ir);
    const elision = hasTerraformEntities(ir)
      ? (groupTerraformByRoot(normalizeTerraformNodes(ir)), filterTerraformCards(ir, detail))
      : { dropped: {}, total: 0 };
    return {
      // The roots half is membership-driven and survives an empty elision: a
      // served member says which roots it found and which directories of `.tf`
      // it skipped even when the zoom elided nothing. Ahead of the elision
      // note, which is about the same estate's zoom — what is drawn, then what
      // is not.
      note(dirs) {
        const scans = dirs.map((d) => discoverTerraformRoots(d));
        // behold#571: a Terragrunt repo says which units it drew, and from what.
        const units = dirs.map((d) => terragruntOf(d)).filter((p): p is TerragruntPicture => !!p);
        const unitShort = (p: TerragruntPicture) => `${p.units.length} unit${p.units.length === 1 ? "" : "s"}`;
        const note = [...scans.map(terraformRootsNote), ...units.map(terragruntNote), terraformElisionNote(elision, detail), lint.note].filter(Boolean).join("; ");
        const short = [...scans.map(terraformRootsNoteShort), ...units.map(unitShort), terraformElisionNoteShort(elision), lint.noteShort].filter(Boolean).join(" · ");
        return note ? { note, ...(short && short !== note ? { noteShort: short } : {}) } : {};
      },
    };
  },
};

/** The terraform member (#384): a directory of `.tf` files, read through a
 * generated chant config. Registered after chant and choudoufu, so a directory
 * that is also a chant project or a choudoufu estate is read as one of those. */
export const terraformSpec: MemberKindSpec = {
  kind: "terraform",
  probe: isTerraformMember,
  expects: "Terraform root under it — a `terraform` or `provider` block beside a resource, data or module block — or a Terragrunt unit (a terragrunt.hcl)",
  via: terraformVia,
  passes: terraformPasses,
};
