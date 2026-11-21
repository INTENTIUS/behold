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
const K8S = "@intentius/chant-lexicon-k8s";
const AWS = "@intentius/chant-lexicon-aws";
/** The k8s lexicon and the two it depends on, held at the release exactly: their peer ranges on chant move with every release, so a range here would let a fresh resolve pull a newer lexicon and a newer chant with it (behold#1056). */
const K8S_SET = [K8S, "@intentius/chant-lexicon-otel", "@intentius/chant-lexicon-prometheus"];

export interface ChantRelease {
  version: string;
  released: boolean;
  /**
   * The release the lexicons and chant-k8s-client are on, when it is older than `version`: a train publishes only the members that
   * changed, so core can move ahead of them. One version for all of them, or one per package name; a package the map leaves out, and
   * every package when this is absent, takes `version`.
   */
  lexicons?: string | Readonly<Record<string, string>>;
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

/** The chant a dependency or an exact pin names: the release once it is out, the newest published chant until then. */
export function chantVersion(r: ChantRelease): string {
  return r.released ? r.version : PUBLISHED_CHANT;
}

/** The range a dependency on chant is given: the release once it is out, the newest published chant until then. */
export function chantRange(r: ChantRelease): string {
  return `^${chantVersion(r)}`;
}

/** The release `pkg`'s dependency or exact pin names: its entry in `lexicons` when core moved ahead of it, else as {@link chantVersion}. */
export function lexiconVersion(r: ChantRelease, pkg: string): string {
  if (!r.released) return PUBLISHED_CHANT;
  const l = r.lexicons;
  return (typeof l === "string" ? l : l?.[pkg]) ?? r.version;
}

/** The range `pkg`'s dependency is given. */
export function lexiconRange(r: ChantRelease, pkg: string): string {
  return `^${lexiconVersion(r, pkg)}`;
}

function setDeps(deps: Json | undefined, names: readonly string[], range: string | ((name: string) => string)): Json {
  const out: Json = { ...(deps ?? {}) };
  for (const n of names) if (n in out) out[n] = typeof range === "string" ? range : range(n);
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
        ? [{ package: TERRAFORM, version: lexiconVersion(r, TERRAFORM) }, { package: PULUMI, version: lexiconVersion(r, PULUMI) }]
        : [{ path: `node_modules/${TERRAFORM}` }, { path: `node_modules/${PULUMI}` }],
    }),
  },
  // Its dependencies: the pulumi lexicon is listed only once it is on npm,
  // since a plain `npm ci` could not resolve it before (scripts/front-door.ts
  // loads it only for the aws plan).
  {
    file: "example-three-cloud/package.json",
    edit: (d, r) => {
      const deps = setDeps(setDeps(d.dependencies as Json, ["@intentius/chant"], chantRange(r)), [AWS, "@intentius/chant-lexicon-gcp", TERRAFORM], (n) => lexiconRange(r, n));
      if (r.released) deps[PULUMI] = lexiconRange(r, PULUMI);
      else delete deps[PULUMI];
      const sorted = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]));
      return { ...d, dependencies: sorted };
    },
  },
  // Exact pins, which chant enforces against the installed lexicon (behold#1015):
  // the published chant while unreleased, so a plain `npm ci` meets them, and
  // the release once it is out, when they move with the floors. A demo copy
  // and the e2e scripts re-pin a copy at whatever lexicon is installed
  // (src/demo-pins.ts), so a local build stamped at the release still serves.
  { file: "example-terraform-estate/chant.workspace.json", edit: (d, r) => ({ ...d, pins: pinAt(d.pins as Pin[], TERRAFORM, lexiconVersion(r, TERRAFORM)) }) },
  { file: "example-choudoufu-estate/chant.workspace.json", edit: (d, r) => ({ ...d, pins: pinAt(d.pins as Pin[], TERRAFORM, lexiconVersion(r, TERRAFORM)) }) },
  { file: "e2e/fixtures/pulumi-workspace/chant.workspace.json", edit: (d, r) => ({ ...d, pins: pinAt(d.pins as Pin[], PULUMI, lexiconVersion(r, PULUMI)) }) },
  { file: "e2e/fixtures/pulumi-stacks/chant.workspace.json", edit: (d, r) => ({ ...d, pins: pinAt(d.pins as Pin[], PULUMI, lexiconVersion(r, PULUMI)) }) },
  { file: "e2e/fixtures/k8s-workspace/chant.workspace.json", edit: (d, r) => ({ ...d, pins: pinAt(d.pins as Pin[], K8S, lexiconVersion(r, K8S)) }) },
  // behold's own chant dependencies.
  {
    file: "package.json",
    edit: (d, r) => ({
      ...d,
      // The lexicons a plain install draws with are dependencies; each name takes the same rule in either map.
      dependencies: behold(d.dependencies as Json, r),
      devDependencies: behold(d.devDependencies as Json, r),
    }),
  },
];

/** behold's own chant dependencies in one map: chant at the release's range, the ranged lexicons and the k8s client at their range, the k8s set at their release exactly. */
function behold(deps: Json | undefined, r: ChantRelease): Json {
  const ranged = setDeps(setDeps(deps, ["@intentius/chant"], chantRange(r)), ["@intentius/chant-k8s-client", TERRAFORM, "@intentius/chant-lexicon-sql", PULUMI, AWS], (n) => lexiconRange(r, n));
  return setDeps(ranged, K8S_SET, (n) => lexiconVersion(r, n));
}

/** Every file the switch decides, read from `repo`, with what it should hold. */
export function chantReleaseFiles(repo: string, r: ChantRelease = CHANT_RELEASE): ReleaseFile[] {
  return EDITS.map(({ file, edit }) => {
    const have = json(readFileSync(join(repo, file), "utf8"));
    const want = edit(have, r);
    return { file, want: stringify(want), differs: JSON.stringify(want) !== JSON.stringify(have) };
  });
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
