/**
 * behold#1005: the files that follow {@link CHANT_RELEASE}, and what each
 * should hold for its value. scripts/chant-release.ts writes them;
 * src/chant-release.test.ts checks that none disagrees with the switch.
 *
 * A JSON file is compared by value, so a file whose formatting differs but
 * says the same thing is left alone. Only the fields the switch decides are
 * touched; everything else in the file is kept as it is.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANT_RELEASE, PUBLISHED_CHANT } from "./chant-release.ts";

const TERRAFORM = "@intentius/chant-lexicon-terraform";
const PULUMI = "@intentius/chant-lexicon-pulumi";

export interface ChantRelease {
  version: string;
  released: boolean;
}

/** One file the switch decides. `want` is the whole text it should hold. */
export interface ReleaseFile {
  file: string;
  want: string;
  differs: boolean;
}

type Json = Record<string, unknown>;
type Pin = { package?: string; version?: string; path?: string };

const json = (text: string): Json => JSON.parse(text) as Json;
const stringify = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** The range a dependency on chant is given: the release once it is out, the newest published chant until then. */
export function chantRange(r: ChantRelease): string {
  return `^${r.released ? r.version : PUBLISHED_CHANT}`;
}

function setDeps(deps: Json | undefined, names: readonly string[], range: string): Json {
  const out: Json = { ...(deps ?? {}) };
  for (const n of names) if (n in out) out[n] = range;
  return out;
}

/** An exact lexicon pin moved to `version`, every other pin kept. */
function pinAt(pins: Pin[] | undefined, pkg: string, version: string): Pin[] {
  return (pins ?? []).map((p) => (p.package === pkg ? { ...p, version } : p));
}

type Edit = (doc: Json, r: ChantRelease) => Json;

const EDITS: { file: string; edit: Edit }[] = [
  // The three-cloud workspace: by path while the pulumi lexicon is on no
  // release (the pin then reads whichever build node_modules holds), by
  // package and version once it is.
  {
    file: "example-three-cloud/chant.workspace.json",
    edit: (d, r) => ({
      ...d,
      pins: r.released
        ? [{ package: TERRAFORM, version: r.version }, { package: PULUMI, version: r.version }]
        : [{ path: `node_modules/${TERRAFORM}` }, { path: `node_modules/${PULUMI}` }],
    }),
  },
  // Its dependencies: the pulumi lexicon is listed only once it is on npm,
  // since a plain `npm ci` could not resolve it before (scripts/front-door.ts
  // loads it only for the aws plan).
  {
    file: "example-three-cloud/package.json",
    edit: (d, r) => {
      const deps = setDeps(d.dependencies as Json, ["@intentius/chant", "@intentius/chant-lexicon-aws", "@intentius/chant-lexicon-gcp", TERRAFORM], chantRange(r));
      if (r.released) deps[PULUMI] = chantRange(r);
      else delete deps[PULUMI];
      const sorted = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]));
      return { ...d, dependencies: sorted };
    },
  },
  // Exact pins, which chant enforces against the installed lexicon: at the
  // release's number in both modes, the number a local build is stamped at.
  { file: "example-terraform-estate/chant.workspace.json", edit: (d, r) => ({ ...d, pins: pinAt(d.pins as Pin[], TERRAFORM, r.version) }) },
  { file: "example-choudoufu-estate/chant.workspace.json", edit: (d, r) => ({ ...d, pins: pinAt(d.pins as Pin[], TERRAFORM, r.version) }) },
  { file: "e2e/fixtures/pulumi-workspace/chant.workspace.json", edit: (d, r) => ({ ...d, pins: pinAt(d.pins as Pin[], PULUMI, r.version) }) },
  // behold's own chant dependencies.
  {
    file: "package.json",
    edit: (d, r) => ({
      ...d,
      dependencies: setDeps(d.dependencies as Json, ["@intentius/chant", "@intentius/chant-k8s-client", TERRAFORM], chantRange(r)),
      devDependencies: setDeps(d.devDependencies as Json, ["@intentius/chant-lexicon-sql"], chantRange(r)),
    }),
  },
];

const DRIFT_MODULE_HEAD = `/**
 * Written by scripts/chant-release.ts from CHANT_RELEASE (src/chant-release.ts,
 * behold#1005). Edit the switch and run the script, not this file.
 *
 * chant's drift record module, \`@intentius/chant/drift-record\`
 * (INTENTIUS/chant#4451), or undefined when the chant beside behold has none.
 * src/drift-line.ts decodes with it when it is here.
 */

/** What src/drift-line.ts uses of chant's module. */
export interface ChantDriftModule {
  decodeDriftLine(text: string): unknown;
  DRIFT_STATUSES: readonly string[];
}
`;

/** src/chant-drift-record.ts for a value of the switch. */
export function driftModuleSource(r: ChantRelease): string {
  if (r.released) {
    return `${DRIFT_MODULE_HEAD}
// chant ${r.version} is released and behold depends on it, so the module is a
// static import and the bundle carries it.
import * as chant from "@intentius/chant/drift-record";

export const chantDriftModule: ChantDriftModule | undefined = chant;
`;
  }
  return `${DRIFT_MODULE_HEAD}
// chant ${r.version} is not released: the published chant behold depends on has
// no drift-record module, and a static import would fail to resolve. So it is
// looked for at run time, under a specifier the type checker and the bundler
// leave alone. A local build of chant's integration branch installed beside
// behold has it, under tsx and vitest. The bundled dist/cli.js under plain node
// does not load chant's TypeScript source from node_modules and gets
// undefined, as does a chant without the module: src/drift-line.ts then
// decodes with its own copy.
const SPECIFIER: string = "@intentius/chant/drift-record";

export const chantDriftModule: ChantDriftModule | undefined = await import(/* @vite-ignore */ SPECIFIER).then(
  (m: Partial<ChantDriftModule>) => (typeof m.decodeDriftLine === "function" && Array.isArray(m.DRIFT_STATUSES) ? (m as ChantDriftModule) : undefined),
  () => undefined,
);
`;
}

/** Every file the switch decides, read from `repo`, with what it should hold. */
export function chantReleaseFiles(repo: string, r: ChantRelease = CHANT_RELEASE): ReleaseFile[] {
  const out: ReleaseFile[] = EDITS.map(({ file, edit }) => {
    const have = json(readFileSync(join(repo, file), "utf8"));
    const want = edit(have, r);
    return { file, want: stringify(want), differs: JSON.stringify(want) !== JSON.stringify(have) };
  });
  const drift = "src/chant-drift-record.ts";
  const want = driftModuleSource(r);
  let have = "";
  try {
    have = readFileSync(join(repo, drift), "utf8");
  } catch {
    /* not written yet */
  }
  out.push({ file: drift, want, differs: have !== want });
  return out;
}

/** Write every file that disagrees with the switch. Returns the files written. */
export function writeChantRelease(repo: string, r: ChantRelease = CHANT_RELEASE): string[] {
  const written: string[] = [];
  for (const f of chantReleaseFiles(repo, r)) {
    if (!f.differs) continue;
    writeFileSync(join(repo, f.file), f.want);
    written.push(f.file);
  }
  return written;
}
