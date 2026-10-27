/**
 * behold#1026: `behold index <substrate>`, tier 1 of behold#1025. It fills an
 * index from a cloud with no project, and keeps it in the index store.
 *
 * The command is chant's. On the ruling that behold is a control plane and
 * every model lives in chant
 * (https://github.com/INTENTIUS/behold/issues/1024#issuecomment-6433236820),
 * the lister (behold#1029) and the pipeline moved to chant as chant#4532:
 * `runCloudIndex` in `@intentius/chant/lifecycle/cloud-index` lists the
 * scope, types it, derives its edges and writes one stamped version. behold
 * calls it with three things of its own:
 *
 *  - the command name, so messages and the verdict line say `behold index`;
 *  - the default store (behold#1025 Q4): with no chant project and no
 *    `--store`, a `local` store in behold's per-user data directory,
 *    `$XDG_DATA_HOME/behold`, else `~/.local/share/behold`, so versions land
 *    under `.../behold/index/`, the directory src/graph-db/sources.ts's
 *    `userIndexDir` loads (behold#1027). `BEHOLD_INDEX_DIR`, when set, names
 *    that `index/` directory for both;
 *  - behold's token variables: `BEHOLD_AZURE_TOKEN` and `BEHOLD_GCP_TOKEN`
 *    are handed to chant as `CHANT_AZURE_TOKEN` and `CHANT_GCP_TOKEN` when
 *    those are unset.
 *
 * Every flag, the read-only rule (action flags refused before anything is
 * read, no server, no publish, nothing enabled on GCP) and the credential
 * rule (with an endpoint, static credentials only, never an SDK chain) are
 * chant's, in packages/core/src/lifecycle/cloud-index.ts and
 * packages/core/src/cloud-lister/.
 *
 * No published chant has `runCloudIndex` (src/chant-release.ts says
 * `released: false`), so it is found at run time under a specifier the type
 * checker and the bundler leave alone, as src/chant-drift-record.ts does.
 * When the chant beside behold lacks it, `behold index` says which chant it
 * needs and exits 2 before anything is listed. There is no behold copy to
 * fall back to.
 *
 * TODO(chant#4532, behold#1005): once src/chant-release.ts says
 * `released: true`, import `runCloudIndex` statically and drop the fallback.
 *
 * The maintainer's emulator run (behold#1026 done-when 1; never run by an
 * agent), against the pinned floci on 4566 with a scratch data dir and a
 * local build of chant's integration/consolidation-graph installed beside
 * behold:
 *
 *     env -u AWS_PROFILE -u AWS_SESSION_TOKEN \
 *       AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
 *       XDG_DATA_HOME=$(mktemp -d) \
 *       npx tsx src/cli.ts index aws --endpoint http://localhost:4566 \
 *         --account 000000000000 --regions us-east-1 \
 *         --types AWS::S3::Bucket,AWS::IAM::Role,AWS::SQS::Queue
 *
 * Its last line is the verdict, `behold index: wrote <version> ...`; run it
 * twice and both versions are listed under
 * `$XDG_DATA_HOME/behold/index/cloud/aws/000000000000/<digest>/`.
 */
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { CHANT_RELEASE } from "./chant-release.ts";
import { userIndexDir } from "./graph-db/sources.ts";

/** Where chant#4532 exports the command. */
export const CHANT_CLOUD_INDEX = "@intentius/chant/lifecycle/cloud-index";

/** chant#4532 `runCloudIndex(argv, options)`, held loosely: behold passes only the options below. */
export type RunCloudIndex = (argv: readonly string[], options: Record<string, unknown>) => Promise<number>;

export type Env = Readonly<Record<string, string | undefined>>;

/** chant's `runCloudIndex`, or undefined when the chant beside behold has none. */
export async function chantCloudIndex(): Promise<RunCloudIndex | undefined> {
  const name: string = CHANT_CLOUD_INDEX;
  try {
    const mod = (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
    return typeof mod.runCloudIndex === "function" ? (mod.runCloudIndex as RunCloudIndex) : undefined;
  } catch {
    return undefined;
  }
}

/** What `behold index` says when chant has no `runCloudIndex`. */
export function needsChantMessage(): string {
  return (
    `behold index needs chant ${CHANT_RELEASE.version} or newer (the release with chant#4532's runCloudIndex, ${CHANT_CLOUD_INDEX}), ` +
    `and the chant beside behold lacks it. src/chant-release.ts says ${CHANT_RELEASE.version} is released: ${CHANT_RELEASE.released}; ` +
    `until it is, install a local build of chant's integration/consolidation-graph beside behold. Nothing was listed and nothing was written.\n`
  );
}

export class IndexUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexUsageError";
  }
}

/** behold#1025 Q4: the per-user store's root. Its `index/` is what src/graph-db/sources.ts `userIndexDir` loads. */
export function defaultIndexStoreDir(env: Env = process.env, home: string = homedir()): string {
  const indexDir = userIndexDir(env as NodeJS.ProcessEnv, home);
  if (basename(indexDir) !== "index") {
    throw new IndexUsageError(`BEHOLD_INDEX_DIR (${indexDir}) must end in /index: chant's local store keeps index versions under <store>/index`);
  }
  return dirname(indexDir);
}

/** The environment chant reads, with behold's token variables under chant's names. */
export function chantEnv(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  if (!out.CHANT_AZURE_TOKEN && env.BEHOLD_AZURE_TOKEN) out.CHANT_AZURE_TOKEN = env.BEHOLD_AZURE_TOKEN;
  if (!out.CHANT_GCP_TOKEN && env.BEHOLD_GCP_TOKEN) out.CHANT_GCP_TOKEN = env.BEHOLD_GCP_TOKEN;
  return out;
}

const DEFAULT_STORE_TEXT = "a local store in behold's per-user data directory ($XDG_DATA_HOME/behold, else ~/.local/share/behold)";

export interface IndexDeps {
  cwd?: string;
  env?: Env;
  home?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** chant's command; tests pass a fake. */
  chant?: () => Promise<RunCloudIndex | undefined>;
  /** behold's version, for the stamp's `source.version`. */
  version?: string;
  /** Passed through to chant's `runCloudIndex` (a test's fake lister, store or lexicons). */
  passThrough?: Record<string, unknown>;
}

/** `behold index <substrate> …`. Returns chant's exit code, or 2 when chant has no `runCloudIndex`. */
export async function runIndex(argv: readonly string[], deps: IndexDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));

  const run = await (deps.chant ?? chantCloudIndex)();
  if (!run) {
    if (argv.includes("-h") || argv.includes("--help")) {
      out(`behold index <aws|azure|gcp|kubernetes> [scope] [target] [--store <spec>] [--json]\n\n  Runs chant's \`chant index\` (chant#4532) and writes to behold's per-user store.\n\n`);
    }
    err(needsChantMessage());
    return 2;
  }

  // The default store is only read when no --store is given, so a bad
  // BEHOLD_INDEX_DIR does not stop a run that names its own store.
  const namesStore = argv.some((a) => a === "--store" || a.startsWith("--store="));
  let dir: string | undefined;
  if (!namesStore) {
    try {
      dir = defaultIndexStoreDir(env, home);
    } catch (e) {
      if (e instanceof IndexUsageError) {
        err(`behold index: ${e.message}. Nothing was listed and nothing was written.\n`);
        return 2;
      }
      throw e;
    }
  }

  return run(argv, {
    ...(deps.passThrough ?? {}),
    command: "behold index",
    defaultStoreDir: () => dir ?? defaultIndexStoreDir(env, home),
    defaultStoreText: DEFAULT_STORE_TEXT,
    cwd,
    env: chantEnv(env),
    home,
    stdout: out,
    stderr: err,
    ...(deps.version ? { version: deps.version } : {}),
  });
}
