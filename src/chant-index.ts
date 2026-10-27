/**
 * behold#1026: the chant functions `behold index` runs, found at run time.
 *
 * The pipeline is behold#1025's: the lister's `ListingResult` goes through
 * chant's `typeListing` (INTENTIUS/chant#4521) and `deriveEdges`
 * (INTENTIUS/chant#4522), and the stamped `IndexDocument` goes into chant's
 * index store (INTENTIUS/chant#4519). All three are on chant's
 * integration/consolidation-graph and in no published chant yet
 * (src/chant-release.ts says `released: false`), so a static import would not
 * resolve against the chant behold's own `npm ci` installs.
 *
 * So, as src/chant-drift-record.ts does for the drift record, each module is
 * looked for under a specifier the type checker and the bundler leave alone.
 * A local build of chant's integration branch installed beside behold has
 * them (under tsx and vitest). A chant without them gives `undefined` and the
 * list of what is missing, and `behold index` stops before it lists anything
 * (src/behold-index.ts).
 *
 * TODO(behold#1026, behold#1005): once the chant release that carries
 * #4519, #4521 and #4522 is out and src/chant-release.ts says
 * `released: true`, replace these lazy imports with static imports from
 * `@intentius/chant` and drop the fallback.
 *
 * The lexicons that type a substrate's listed types are looked for the same
 * way. They are optional: without one, `typeListing` keeps every object as a
 * node of unknown kind (#4521's rule) and `deriveEdges` names the lexicon
 * with no catalog in a note, so the index is still written.
 */
import type { ListingResult, Substrate } from "./cloud-lister/types.ts";
import type { IndexDocument } from "./graph-db/types.ts";

/** What a write to chant's index store answered (chant#4519 `StoreWrite`). */
export interface IndexStoreWrite {
  written: boolean;
  version?: string;
  path?: string;
  reason?: string;
}

/** The part of chant#4519's `SnapshotStore` that `behold index` uses. */
export interface IndexStore {
  readonly kind: string;
  readonly where: string;
  readonly writable: boolean;
  writeIndex(doc: IndexDocument): Promise<IndexStoreWrite | undefined | void>;
  listIndex(scopeKey: string): Promise<string[]>;
  publish?(): Promise<{ status: string; detail?: string }>;
}

/** A chant lexicon plugin, as far as `typeListing` and `deriveEdges` read it. */
export type IndexLexicon = { name: string } & Record<string, unknown>;

/** chant#4519's store configuration, held loosely (`SnapshotStoreConfig`). */
export type IndexStoreConfig = { store: string } & Record<string, unknown>;

export interface ChantIndexApi {
  typeListing(listing: ListingResult, lexicons: readonly IndexLexicon[]): IndexDocument;
  deriveEdges(doc: IndexDocument, lexicons: readonly IndexLexicon[]): IndexDocument;
  /** chant#4519 `snapshotStoreConfig(configured, env)`. */
  storeConfig(configured: unknown, env: Record<string, string | undefined>): IndexStoreConfig;
  /** chant#4519 `createSnapshotStore(config, { cwd })`. */
  createStore(config: IndexStoreConfig, opts: { cwd: string }): IndexStore;
  /** chant#4519 `resolveSnapshotStore({ cwd })`: a project's configured store. */
  projectStore(cwd: string): Promise<IndexStore>;
}

export type ChantIndexLookup = { api: ChantIndexApi; missing: [] } | { api: undefined; missing: string[] };

/** The modules and the export each must have. */
export const CHANT_INDEX_MODULES = [
  { specifier: "@intentius/chant/lifecycle/type-listing", exports: ["typeListing"], issue: "chant#4521" },
  { specifier: "@intentius/chant/lifecycle/derive-edges", exports: ["deriveEdges"], issue: "chant#4522" },
  { specifier: "@intentius/chant/lifecycle/snapshot-store", exports: ["createSnapshotStore", "snapshotStoreConfig", "resolveSnapshotStore"], issue: "chant#4519" },
] as const;

type AnyFn = (...args: unknown[]) => unknown;

/** Imports a module by a name the bundler and the type checker do not follow. */
async function lazy(specifier: string): Promise<Record<string, unknown> | undefined> {
  const name: string = specifier;
  try {
    return (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

let cached: Promise<ChantIndexLookup> | undefined;

/** chant's index functions, or what is missing. Looked up once per process. */
export function chantIndexApi(): Promise<ChantIndexLookup> {
  cached ??= lookUp();
  return cached;
}

async function lookUp(): Promise<ChantIndexLookup> {
  const mods: Record<string, Record<string, unknown>> = {};
  const missing: string[] = [];
  for (const m of CHANT_INDEX_MODULES) {
    const mod = await lazy(m.specifier);
    const absent = m.exports.filter((e) => typeof mod?.[e] !== "function");
    if (!mod || absent.length > 0) missing.push(`${absent.join(", ")} (${m.issue}, ${m.specifier})`);
    else mods[m.specifier] = mod;
  }
  if (missing.length > 0) return { api: undefined, missing };
  const tl = mods["@intentius/chant/lifecycle/type-listing"];
  const de = mods["@intentius/chant/lifecycle/derive-edges"];
  const ss = mods["@intentius/chant/lifecycle/snapshot-store"];
  const api: ChantIndexApi = {
    typeListing: (listing, lexicons) => (tl.typeListing as AnyFn)(listing, lexicons) as IndexDocument,
    deriveEdges: (doc, lexicons) => (de.deriveEdges as AnyFn)(doc, lexicons) as IndexDocument,
    storeConfig: (configured, env) => (ss.snapshotStoreConfig as AnyFn)(configured, env) as IndexStoreConfig,
    createStore: (config, opts) => (ss.createSnapshotStore as AnyFn)(config, opts) as IndexStore,
    projectStore: async (cwd) => (await (ss.resolveSnapshotStore as AnyFn)({ cwd })) as IndexStore,
  };
  return { api, missing: [] };
}

/** The chant lexicon package and plugin export that types each substrate's listed types. */
export const SUBSTRATE_LEXICONS: Readonly<Record<Substrate, { pkg: string; plugin: string }>> = {
  aws: { pkg: "@intentius/chant-lexicon-aws", plugin: "awsPlugin" },
  azure: { pkg: "@intentius/chant-lexicon-azure", plugin: "azurePlugin" },
  gcp: { pkg: "@intentius/chant-lexicon-gcp", plugin: "gcpPlugin" },
  kubernetes: { pkg: "@intentius/chant-lexicon-k8s", plugin: "k8sPlugin" },
};

/** The substrate's lexicon plugin, or a note saying why there is none. */
export async function substrateLexicons(substrate: Substrate): Promise<{ lexicons: IndexLexicon[]; note?: string }> {
  const { pkg, plugin } = SUBSTRATE_LEXICONS[substrate];
  const mod = await lazy(pkg);
  const p = mod?.[plugin] as IndexLexicon | undefined;
  if (!p || typeof p.name !== "string") {
    return {
      lexicons: [],
      note: `${pkg} is not installed beside behold (or has no ${plugin}), so ${substrate} objects are kept as nodes of unknown kind and get no derived edges; install it to type them`,
    };
  }
  if (!p.listedTypes) {
    return { lexicons: [p], note: `${pkg} has no listedTypes (chant#4521), so ${substrate} objects are kept as nodes of unknown kind` };
  }
  return { lexicons: [p] };
}
