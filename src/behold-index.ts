/**
 * behold#1026: `behold index <substrate>`, tier 1 of behold#1025. It fills an
 * index from a cloud with no project, and keeps it in the index store.
 *
 * The pipeline is the one behold#1025's design fixes and its ruling (Q1-Q6,
 * 2026-10-26) settles:
 *
 *     listCloud(scope)                 behold#1029, src/cloud-lister/
 *       -> ListingResult
 *       -> typeListing                 chant#4521
 *       -> deriveEdges                 chant#4522
 *       -> IndexDocument
 *       -> store.writeIndex            chant#4519
 *
 * One run writes one version (Q6): one substrate and one account,
 * subscription, project or cluster, with every location and type the flags
 * name. The version is one immutable file (Q3),
 * `index/cloud/<substrate>/<scopeId>/<scope digest>/<observedAt>-<digest12>.json`
 * relative to the store's root, next to the `scope.json` that says what the
 * digest means. A second run writes a second version; the first stays.
 *
 * Where it writes:
 *
 *  - `--store <spec>`: chant#4519's store, from its spec (see
 *    {@link planIndexStore});
 *  - else, inside a chant project (a `chant.config.ts` or `chant.config.json`
 *    in the working directory or above it): that project's configured store;
 *  - else (Q4): a `local` store in behold's per-user data directory,
 *    `$XDG_DATA_HOME/behold`, else `~/.local/share/behold`, so the versions
 *    land under `.../behold/index/`, the directory src/graph-db/sources.ts's
 *    `userIndexDir` loads (behold#1027). `BEHOLD_INDEX_DIR`, when set, names
 *    that `index/` directory for both.
 *
 * Read-only:
 *
 *  - the lister sends only its allowlisted reads (src/cloud-lister/guard.ts),
 *    pins every call to an explicit endpoint, and with an endpoint takes
 *    static credentials only, never an SDK's default chain;
 *  - `behold index` refuses to start with any action flag ({@link ACTION_FLAGS})
 *    and starts no server, so behold's action side (Deploy, apply, Ops,
 *    rollbacks) is not reachable from it;
 *  - nothing is written but the one index version (and its `scope.json`) in
 *    the store, and the store is never published to a remote by this command;
 *  - for GCP nothing is enabled: when the Cloud Asset API is off, the
 *    lister's note carries the `gcloud services enable` command for the
 *    person to run.
 *
 * The index is never consulted for a decision. Deleting it loses history and
 * nothing else.
 *
 * Environment the command reads (and nothing else):
 *
 *  - aws: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
 *    (static credentials, when the first two are set), `AWS_ENDPOINT_URL`
 *    (the endpoint when `--endpoint` is absent), `AWS_REGION` then
 *    `AWS_DEFAULT_REGION` (the region when `--regions` is absent);
 *  - azure: `BEHOLD_AZURE_TOKEN` (an ARM bearer token);
 *  - gcp: `BEHOLD_GCP_TOKEN` (an OAuth access token);
 *  - kubernetes: `KUBECONFIG` (its first path) when `--kubeconfig` is absent;
 *  - the store: `BEHOLD_INDEX_DIR`, `XDG_DATA_HOME`, and for `--store`
 *    chant's own `CHANT_SNAPSHOT_*` variables.
 *
 * The maintainer's emulator run (behold#1026 done-when 1; never run by an
 * agent), against the pinned floci on 4566 with a scratch data dir:
 *
 *     env -u AWS_PROFILE -u AWS_SESSION_TOKEN \
 *       AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
 *       XDG_DATA_HOME=$(mktemp -d) \
 *       npx tsx src/cli.ts index aws --endpoint http://localhost:4566 \
 *         --account 000000000000 --regions us-east-1 \
 *         --types AWS::S3::Bucket,AWS::IAM::Role,AWS::SQS::Queue
 *
 * with a local build of chant's integration/consolidation-graph (and its aws
 * lexicon) installed beside behold. Its last line is the verdict, `behold
 * index: wrote <version> ...`; run it twice and both versions are listed
 * under `$XDG_DATA_HOME/behold/index/cloud/aws/000000000000/<digest>/`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  kubeTargetFromKubeconfig,
  listCloud,
  ListerConfigError,
  MutatingCallRefused,
  OriginRefused,
  type CloudScope,
  type ListingResult,
  type ListOptions,
  type SubstrateTarget,
  type Substrate,
} from "./cloud-lister/index.ts";
import type { TlsOptions } from "./cloud-lister/transport.ts";
import { chantIndexApi, substrateLexicons, type ChantIndexApi, type ChantIndexLookup, type IndexLexicon, type IndexStore } from "./chant-index.ts";
import { CHANT_RELEASE } from "./chant-release.ts";
import { userIndexDir } from "./graph-db/sources.ts";
import type { IndexDocument } from "./graph-db/types.ts";

export const INDEX_USAGE = `behold index <aws|azure|gcp|kubernetes> [scope] [target] [--store <spec>] [--json]

  Read one account, subscription, project or cluster through its inventory
  API, type it through chant, add derived edges, and write one stamped index
  version to the index store. Read-only: it lists, and writes nothing but the
  index version. Every run writes a new version; the old ones stay.

Scope:
  --account <id> | --subscription <id> | --project <id> | --cluster <name> | --scope-id <id>
                      The AWS account, Azure subscription, GCP project or
                      cluster name the run reads (required, except for
                      kubernetes, which defaults to the kubeconfig's cluster).
  --regions <r,...>   Regions or locations (kubernetes: namespaces). AWS needs
                      them named (default AWS_REGION); others default to all.
  --locations <l,...> Same as --regions.
  --types <t,...>     Types as the inventory API names them (default: all,
                      or a fixed default set for AWS).
  --tag <k=v>         Only objects with this tag or label. Repeatable.

Target:
  --endpoint <url>    An emulator's endpoint. With one, credentials must be
                      static: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY,
                      BEHOLD_AZURE_TOKEN, BEHOLD_GCP_TOKEN or --anonymous.
                      No SDK default credential chain is used. AWS also reads
                      AWS_ENDPOINT_URL.
  --anonymous         gcp with --endpoint: send no token (floci-gcp).
  --ca <file>         A CA bundle for the endpoint's TLS.
  --insecure-skip-verify
                      Skip TLS verification; only for a loopback endpoint.
  --kubeconfig <file> kubernetes: the kubeconfig (default KUBECONFIG, then
                      ~/.kube/config). Token or client certificate only.
  --context <name>    kubernetes: the kubeconfig context.

Store:
  --store <spec>      chant's index store: local, local:<dir>, git-ref,
                      git-ref:<ref>, s3, s3://<bucket>[/<prefix>], or none.
                      Default: the chant project's store when run inside one,
                      else a local store in behold's per-user data directory
                      ($XDG_DATA_HOME/behold, else ~/.local/share/behold).
  --json              Print the result as one JSON object.

Refused: any action flag (--apply, --deploy, --destroy, --rollback, --op and the
rest of ACTION_FLAGS in src/behold-index.ts). It starts no server.
`;

/** Flags that would reach behold's action side. `behold index` refuses every one. */
export const ACTION_FLAGS: readonly string[] = [
  "--apply",
  "--approve",
  "--approver",
  "--auto-approve",
  "--adopt",
  "--create",
  "--delete",
  "--deploy",
  "--destroy",
  "--enable",
  "--enable-api",
  "--fix",
  "--import",
  "--live",
  "--op",
  "--ops",
  "--promote",
  "--rollback",
  "--run-op",
  "--write",
  "--yes",
];

const SUBSTRATES: Readonly<Record<string, Substrate>> = { aws: "aws", azure: "azure", gcp: "gcp", kubernetes: "kubernetes", k8s: "kubernetes" };

export interface IndexArgs {
  substrate: Substrate;
  scopeId?: string;
  locations?: string[];
  types?: string[];
  tags: Record<string, string>;
  endpoint?: string;
  anonymous: boolean;
  ca?: string;
  insecureSkipVerify: boolean;
  kubeconfig?: string;
  context?: string;
  store?: string;
  json: boolean;
}

export class IndexUsageError extends Error {
  constructor(
    message: string,
    readonly actionFlag?: string,
  ) {
    super(message);
    this.name = "IndexUsageError";
  }
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `behold index`'s arguments. Throws {@link IndexUsageError}; an action flag is named in `actionFlag`. */
export function parseIndexArgs(argv: readonly string[]): IndexArgs {
  // An action flag is refused before anything else is read, wherever it sits.
  for (const a of argv) {
    const flag = a.startsWith("--") ? a.split("=")[0] : undefined;
    if (flag && ACTION_FLAGS.includes(flag)) {
      throw new IndexUsageError(
        `behold index is read-only and refuses ${flag}: it lists and writes one index version, and behold's action side (Deploy, apply, Ops, rollbacks) is not reachable from it. Nothing was listed and nothing was written.`,
        flag,
      );
    }
  }
  const [first, ...rest] = argv;
  if (!first || first.startsWith("-")) throw new IndexUsageError("behold index needs a substrate: aws, azure, gcp or kubernetes");
  const substrate = SUBSTRATES[first];
  if (!substrate) throw new IndexUsageError(`behold index: unknown substrate '${first}' (aws, azure, gcp or kubernetes)`);
  const out: IndexArgs = { substrate, tags: {}, anonymous: false, insecureSkipVerify: false, json: false };
  const scopeFlags = ["--account", "--subscription", "--project", "--cluster", "--scope-id"];
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new IndexUsageError(`behold index: ${flag} needs a value`);
      i++;
      return v;
    };
    if (scopeFlags.includes(flag)) {
      const v = value();
      if (out.scopeId !== undefined && out.scopeId !== v) throw new IndexUsageError(`behold index reads one account, subscription, project or cluster per run; got ${out.scopeId} and ${v}`);
      out.scopeId = v;
    } else if (flag === "--regions" || flag === "--locations" || flag === "--namespaces") {
      out.locations = [...(out.locations ?? []), ...list(value())];
    } else if (flag === "--types") {
      out.types = [...(out.types ?? []), ...list(value())];
    } else if (flag === "--tag") {
      const v = value();
      const at = v.indexOf("=");
      if (at <= 0) throw new IndexUsageError(`behold index: --tag takes key=value, got '${v}'`);
      out.tags[v.slice(0, at)] = v.slice(at + 1);
    } else if (flag === "--endpoint") {
      out.endpoint = value();
    } else if (flag === "--anonymous") {
      out.anonymous = true;
    } else if (flag === "--ca") {
      out.ca = value();
    } else if (flag === "--insecure-skip-verify") {
      out.insecureSkipVerify = true;
    } else if (flag === "--kubeconfig") {
      out.kubeconfig = value();
    } else if (flag === "--context") {
      out.context = value();
    } else if (flag === "--store") {
      out.store = value();
    } else if (flag === "--json") {
      out.json = true;
    } else {
      throw new IndexUsageError(`behold index: unknown argument '${raw}'`);
    }
  }
  if (out.anonymous && out.substrate !== "gcp") throw new IndexUsageError("behold index: --anonymous is for gcp against an emulator");
  if (out.anonymous && out.endpoint === undefined) throw new IndexUsageError("behold index: --anonymous needs --endpoint (an emulator); a real project always takes a token");
  return out;
}

export type Env = Readonly<Record<string, string | undefined>>;

function isLoopback(endpoint: string): boolean {
  try {
    const h = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\./.test(h);
  } catch {
    return false;
  }
}

export interface TargetDeps {
  env: Env;
  cwd: string;
  home: string;
  readFile?: (path: string) => string;
}

/** The run's scope and target, from the flags and the variables the module comment lists. */
export function scopeAndTarget(args: IndexArgs, deps: TargetDeps): { scope: CloudScope; target: SubstrateTarget } {
  const { env } = deps;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const endpoint = args.endpoint ?? (args.substrate === "aws" ? env.AWS_ENDPOINT_URL || undefined : undefined);
  if (args.insecureSkipVerify && (endpoint === undefined || !isLoopback(endpoint))) {
    throw new ListerConfigError("--insecure-skip-verify is only for an emulator on a loopback endpoint");
  }
  const tls: TlsOptions | undefined =
    args.ca || args.insecureSkipVerify ? { ...(args.ca ? { ca: read(resolve(deps.cwd, args.ca)) } : {}), ...(args.insecureSkipVerify ? { insecureSkipVerify: true } : {}) } : undefined;
  const base = {
    locations: args.locations && args.locations.length > 0 ? args.locations : ("*" as const),
    types: args.types && args.types.length > 0 ? args.types : ("*" as const),
    ...(Object.keys(args.tags).length > 0 ? { tagFilter: args.tags } : {}),
  };
  const needScope = (what: string): string => {
    if (!args.scopeId) throw new ListerConfigError(`behold index ${args.substrate} needs ${what}`);
    return args.scopeId;
  };
  switch (args.substrate) {
    case "aws": {
      const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
      const locations = base.locations === "*" && region ? [region] : base.locations;
      const credentials =
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) }
          : undefined;
      return {
        scope: { substrate: "aws", scopeId: needScope("--account <id>"), ...base, locations },
        target: { substrate: "aws", aws: { ...(endpoint !== undefined ? { endpoint } : {}), ...(credentials ? { credentials } : {}), ...(tls ? { tls } : {}) } },
      };
    }
    case "azure": {
      const token = env.BEHOLD_AZURE_TOKEN || undefined;
      return {
        scope: { substrate: "azure", scopeId: needScope("--subscription <id>"), ...base },
        target: { substrate: "azure", azure: { ...(endpoint !== undefined ? { endpoint } : {}), ...(token !== undefined ? { token } : {}), ...(tls ? { tls } : {}) } },
      };
    }
    case "gcp": {
      const token = args.anonymous ? null : env.BEHOLD_GCP_TOKEN || undefined;
      return {
        scope: { substrate: "gcp", scopeId: needScope("--project <id>"), ...base },
        target: { substrate: "gcp", gcp: { ...(endpoint !== undefined ? { endpoint } : {}), ...(token !== undefined ? { token } : {}), ...(tls ? { tls } : {}) } },
      };
    }
    case "kubernetes": {
      const path = args.kubeconfig
        ? resolve(deps.cwd, args.kubeconfig)
        : env.KUBECONFIG
          ? env.KUBECONFIG.split(delimiter).filter(Boolean)[0]
          : join(deps.home, ".kube", "config");
      if (!path) throw new ListerConfigError("behold index kubernetes needs a kubeconfig (--kubeconfig or KUBECONFIG)");
      let text: string;
      try {
        text = read(path);
      } catch (e) {
        throw new ListerConfigError(`behold index kubernetes could not read the kubeconfig ${path}: ${(e as Error).message}`);
      }
      const kube = kubeTargetFromKubeconfig(text, { ...(args.context ? { context: args.context } : {}), baseDir: dirname(path) });
      const server = endpoint ?? kube.server;
      const kubeTls = tls ? { ...kube.tls, ...tls } : kube.tls;
      return {
        scope: { substrate: "kubernetes", scopeId: args.scopeId ?? kube.clusterName, ...base },
        target: { substrate: "kubernetes", kubernetes: { server, ...(kube.token ? { token: kube.token } : {}), ...(kubeTls ? { tls: kubeTls } : {}) } },
      };
    }
  }
}

/** Where the run writes, before any store is built (so it can be tested without chant). */
export type StorePlan =
  | { kind: "user"; dir: string }
  | { kind: "project"; projectDir: string }
  | { kind: "spec"; spec: string; configured: Record<string, unknown> & { store: string }; env: Record<string, string | undefined> };

/** behold#1025 Q4: the per-user store's root. Its `index/` is what src/graph-db/sources.ts `userIndexDir` loads. */
export function defaultIndexStoreDir(env: Env = process.env, home: string = homedir()): string {
  const indexDir = userIndexDir(env as NodeJS.ProcessEnv, home);
  if (basename(indexDir) !== "index") {
    throw new IndexUsageError(`BEHOLD_INDEX_DIR (${indexDir}) must end in /index: chant's local store keeps index versions under <store>/index`);
  }
  return dirname(indexDir);
}

const PROJECT_FILES = ["chant.config.ts", "chant.config.json"];

/** The chant project the working directory is in, if any: the nearest directory with a chant config. */
export function findChantProject(cwd: string, exists: (p: string) => boolean = existsSync): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (PROJECT_FILES.some((f) => exists(join(dir, f)))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * The store a run writes to. `--store` takes chant#4519's kinds as a spec:
 * `local` (chant's `.chant/store`, or `CHANT_SNAPSHOT_STORE_DIR`),
 * `local:<dir>`, `git-ref`, `git-ref:<ref>`, `s3` (from `CHANT_SNAPSHOT_S3_*`),
 * `s3://<bucket>[/<prefix>]`, `none`. The read-only `orphan-branch` store is
 * refused.
 */
export function planIndexStore(o: { store?: string; cwd: string; env: Env; home: string; exists?: (p: string) => boolean }): StorePlan {
  const env: Record<string, string | undefined> = { ...o.env };
  if (o.store === undefined) {
    const project = findChantProject(o.cwd, o.exists);
    if (project) return { kind: "project", projectDir: project };
    return { kind: "user", dir: defaultIndexStoreDir(o.env, o.home) };
  }
  const spec = o.store.trim();
  const colon = spec.indexOf(":");
  const head = spec.startsWith("s3://") ? "s3" : colon > 0 ? spec.slice(0, colon) : spec;
  const tail = spec.startsWith("s3://") ? spec.slice("s3://".length) : colon > 0 ? spec.slice(colon + 1) : undefined;
  env.CHANT_SNAPSHOT_STORE = head;
  switch (head) {
    case "local": {
      if (tail !== undefined) {
        if (!tail) throw new IndexUsageError("behold index: --store local:<dir> needs a directory");
        env.CHANT_SNAPSHOT_STORE_DIR = isAbsolute(tail) ? tail : resolve(o.cwd, tail);
      }
      return { kind: "spec", spec, configured: { store: "local" }, env };
    }
    case "git-ref":
      return { kind: "spec", spec, configured: { store: "git-ref", readOrphanBranch: false, ...(tail ? { ref: tail } : {}) }, env };
    case "s3": {
      if (tail !== undefined) {
        const [bucket, ...prefix] = tail.split("/");
        if (!bucket) throw new IndexUsageError("behold index: --store s3://<bucket>[/<prefix>] needs a bucket");
        env.CHANT_SNAPSHOT_S3_BUCKET = bucket;
        const p = prefix.join("/").replace(/\/+$/, "");
        if (p) env.CHANT_SNAPSHOT_S3_PREFIX = p;
        else delete env.CHANT_SNAPSHOT_S3_PREFIX;
      }
      return { kind: "spec", spec, configured: { store: "s3" }, env };
    }
    case "none":
      return { kind: "spec", spec, configured: { store: "none" }, env };
    case "orphan-branch":
      throw new IndexUsageError("behold index: the orphan-branch store is read-only; pass local, git-ref, s3 or none");
    default:
      throw new IndexUsageError(`behold index: --store '${spec}' is not a store spec (local, local:<dir>, git-ref, git-ref:<ref>, s3, s3://<bucket>[/<prefix>], none)`);
  }
}

/** Build the planned store through chant#4519. */
export async function openIndexStore(plan: StorePlan, api: ChantIndexApi, cwd: string): Promise<IndexStore> {
  switch (plan.kind) {
    case "user":
      return api.createStore({ store: "local", dir: plan.dir }, { cwd });
    case "project":
      return api.projectStore(plan.projectDir);
    case "spec":
      return api.createStore(api.storeConfig(plan.configured, plan.env), { cwd });
  }
}

export interface IndexSummary {
  substrate: Substrate;
  scopeId: string;
  scopeKey: string;
  observedAt: string;
  digest: string;
  store: { kind: string; where: string };
  written: boolean;
  version?: string;
  path?: string;
  reason?: string;
  nodes: number;
  typed: number;
  unmapped: number;
  derivedEdges: number;
  coverage: { listed: number; notObserved: number };
  notes: string[];
}

export interface IndexDeps {
  cwd?: string;
  env?: Env;
  home?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** The lister; tests pass a fake. */
  list?: (scope: CloudScope, target: SubstrateTarget, options: ListOptions) => Promise<ListingResult>;
  /** chant's index functions; tests pass a fake. */
  chant?: () => Promise<ChantIndexLookup>;
  /** The substrate's lexicons; tests pass a table. */
  lexicons?: (substrate: Substrate) => Promise<{ lexicons: IndexLexicon[]; note?: string }>;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  /** behold's version, for the stamp's `source.version`. */
  version?: string;
}

function summarize(doc: IndexDocument): Pick<IndexSummary, "nodes" | "typed" | "unmapped" | "derivedEdges" | "coverage"> {
  const nodes = doc.graph.nodes;
  const unmapped = nodes.filter((n) => (n as { unmappedKind?: boolean }).unmappedKind === true).length;
  const listed = doc.coverage.filter((c) => c.verdict === "listed").length;
  return {
    nodes: nodes.length,
    typed: nodes.length - unmapped,
    unmapped,
    derivedEdges: doc.graph.edges.filter((e) => e.origin === "derived").length,
    coverage: { listed, notObserved: doc.coverage.length - listed },
  };
}

/** `behold index <substrate> …`. Returns the exit code: 0 written, 1 a read or write failed, 2 refused. */
export async function runIndex(argv: readonly string[], deps: IndexDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));

  if (argv.includes("-h") || argv.includes("--help")) {
    out(INDEX_USAGE);
    return 0;
  }

  let args: IndexArgs;
  let plan: StorePlan;
  try {
    args = parseIndexArgs(argv);
    plan = planIndexStore({ store: args.store, cwd, env, home, ...(deps.exists ? { exists: deps.exists } : {}) });
  } catch (e) {
    if (e instanceof IndexUsageError) {
      err(`${e.message}\n`);
      if (!e.actionFlag) err(`\n${INDEX_USAGE}`);
      return 2;
    }
    throw e;
  }

  // chant's typing, edges and store first: without them nothing is listed.
  const lookup = await (deps.chant ?? chantIndexApi)();
  if (!lookup.api) {
    err(
      `behold index needs chant's index pipeline, and the chant beside behold lacks ${lookup.missing.join("; ")}. ` +
        `It ships in chant ${CHANT_RELEASE.version} (src/chant-release.ts says released: ${CHANT_RELEASE.released}); until then install a local build of chant's integration/consolidation-graph beside behold. ` +
        `Nothing was listed and nothing was written.\n`,
    );
    return 2;
  }
  const api = lookup.api;

  let scope: CloudScope;
  let target: SubstrateTarget;
  try {
    ({ scope, target } = scopeAndTarget(args, { env, cwd, home, ...(deps.readFile ? { readFile: deps.readFile } : {}) }));
  } catch (e) {
    if (e instanceof ListerConfigError) {
      err(`${e.message}. Nothing was listed and nothing was written.\n`);
      return 2;
    }
    throw e;
  }

  let store: IndexStore;
  try {
    store = await openIndexStore(plan, api, cwd);
  } catch (e) {
    err(`behold index: the index store could not be opened: ${(e as Error).message}. Nothing was listed and nothing was written.\n`);
    return 2;
  }
  if (!store.writable && store.kind !== "none") {
    err(`behold index: the store ${store.where} is read-only. Nothing was listed and nothing was written.\n`);
    return 2;
  }

  let listing: ListingResult;
  try {
    listing = await (deps.list ?? listCloud)(scope, target, { ...(deps.version ? { version: deps.version } : {}) });
  } catch (e) {
    if (e instanceof ListerConfigError || e instanceof OriginRefused || e instanceof MutatingCallRefused) {
      err(`${e.message}. Nothing was written.\n`);
      return 2;
    }
    err(`behold index: the listing failed: ${(e as Error).message}. Nothing was written.\n`);
    return 1;
  }

  const lex = await (deps.lexicons ?? substrateLexicons)(args.substrate);
  const notes: string[] = [];
  if (lex.note) notes.push(lex.note);
  const doc = api.deriveEdges(api.typeListing(listing, lex.lexicons), lex.lexicons);
  for (const n of doc.notes ?? []) notes.push(n.message);

  let write: { written: boolean; version?: string; path?: string; reason?: string };
  try {
    write = (await store.writeIndex(doc)) ?? { written: false, reason: `the ${store.kind} store keeps nothing` };
  } catch (e) {
    err(`behold index: the index version could not be written to ${store.where}: ${(e as Error).message}\n`);
    return 1;
  }
  const version = write.path ? basename(write.path) : undefined;
  const summary: IndexSummary = {
    substrate: args.substrate,
    scopeId: scope.scopeId,
    scopeKey: doc.stamp.scopeKey,
    observedAt: doc.stamp.observedAt,
    digest: doc.stamp.digest,
    store: { kind: store.kind, where: store.where },
    written: write.written,
    ...(version ? { version } : {}),
    ...(write.path ? { path: write.path } : {}),
    ...(write.reason ? { reason: write.reason } : {}),
    ...summarize(doc),
    notes,
  };

  if (args.json) {
    out(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    out(`${args.substrate} ${scope.scopeId}: ${summary.nodes} nodes (${summary.typed} typed, ${summary.unmapped} of unknown kind), ${summary.derivedEdges} derived edges\n`);
    out(`coverage: ${summary.coverage.listed} (type, location) listed, ${summary.coverage.notObserved} not observed\n`);
    for (const n of notes) out(`  note: ${n}\n`);
    if (write.written) out(`behold index: wrote ${version} under ${summary.scopeKey} in ${store.where}\n`);
    else out(`behold index: wrote nothing to ${store.where}: ${write.reason ?? "the store kept nothing"}\n`);
  }
  // An unchanged re-read at the same second, or a store that keeps nothing, is not a failure.
  return 0;
}
