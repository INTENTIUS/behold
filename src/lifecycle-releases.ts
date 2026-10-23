/**
 * Releases per environment, from the release ledger on `chant/lifecycle`
 * (#525): which schema each environment holds, and whether it is the one the
 * environment before it holds.
 *
 * SQL Yodeler appends a release record to `<env>/releases.jsonl` on
 * `chant/lifecycle` after every apply (sql-yodeler #208, src/release/index.ts):
 * `digest` is the applied schema's `schemaSha`, `component` the project's
 * directory in its repository (`schema` at the root), and `<component>/<tenant>`
 * for a tenant. Any chant project that runs `chant components release` writes
 * the same records. This is the question `chant components status <env>
 * --compare-to <env>` answers, drawn for every environment at once.
 *
 * How it is read: the branch is fetched into the bare cache
 * src/terragucci-lifecycle.ts keeps (`fetchIntoCache`), and chant's own
 * release-ledger reader (`listReleaseEnvironments`, `readReleaseLedger`,
 * `latestPerComponent`) reads it there. When the fetch fails, the checkout's
 * `refs/remotes/origin/chant/lifecycle` is copied into a second cache of
 * behold's (a fetch from the checkout, which reads it and moves none of its
 * refs) and read the same way; the answer says so. The served checkout is
 * never written to.
 *
 * Environment order is the wave order of `yodel-waves.json` when the checkout
 * has one, then any other environment by name.
 *
 * A project that is a chant workspace member keeps its ledgers under
 * `_members/<member>/` on the branch (#537); chant's `resolveMemberLedger`
 * names the member (src/member-ledger.ts), and chant's `listReleaseEnvironments`
 * and `readReleaseLedger` list and read the environments under that prefix
 * (their `ledgerPrefix` option, chant#3865).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { digestKindOf, releaseCompareKey } from "./component-status.ts";
import { latestPerComponent, listReleaseEnvironments, readReleaseLedger, type ReleaseRecord } from "@intentius/chant/lifecycle/release-ledger";
import {
  CHECKOUT_REF,
  LIFECYCLE_BRANCH,
  cacheDir,
  fetchIntoCache,
  fetchable,
  realGit,
  redact,
  type GitRun,
  type LifecycleVia,
} from "./terragucci-lifecycle.ts";
import { assertScratch } from "./scratch.ts";
import { memberNote, projectLedger, type ProjectLedger } from "./member-ledger.ts";

/** SQL Yodeler's waves spec (sql-yodeler src/waves/index.ts WAVES_SPEC_FILE): one wave per environment, in order. */
export const WAVES_SPEC_FILE = "yodel-waves.json";

/** The environment order `yodel-waves.json` gives (each wave's `name`), or none. */
export function waveOrder(checkout: string): string[] | undefined {
  const p = join(checkout, WAVES_SPEC_FILE);
  if (!existsSync(p)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(p, "utf8")) as { waves?: Array<{ name?: unknown }> };
    const names = (doc.waves ?? []).map((w) => w?.name).filter((n): n is string => typeof n === "string" && n.length > 0);
    return names.length ? [...new Set(names)] : undefined;
  } catch {
    return undefined;
  }
}

/** True when the served checkout is a SQL Yodeler project (its config or its waves spec at the root). */
export function hasReleaseLedgerHint(checkout: string): boolean {
  return existsSync(join(checkout, "yodel.config.ts")) || existsSync(join(checkout, WAVES_SPEC_FILE));
}

/** Where an environment's records came from: the newest commit that changed `<env>/releases.jsonl`, and when. */
export interface ReleaseSource {
  branch: typeof LIFECYCLE_BRANCH;
  path: string;
  commit?: string;
  committed?: string;
}

/** One component's newest release in one environment. */
export interface ReleaseCell {
  env: string;
  component: string;
  digest: string;
  /** What `digest` names when it is not an artifact digest (chant#4274). */
  digestKind?: string;
  timestamp: string;
  actor: string;
  approver?: string;
  gitSha: string;
  runId: string;
  runUrl?: string;
  /** The record's own word on where `runId` lives (chant#2045), when it has one. */
  runOrigin?: ReleaseRecord["runOrigin"];
  /** Set when the environment before this one holds a different digest for the component, or none. */
  differs?: {
    from: string;
    /** The digest the environment before holds now; absent when it has no release of this component. */
    digest?: string;
    /** Whether that environment's ledger ever recorded this cell's digest. */
    everHad: boolean;
  };
  source: ReleaseSource;
}

export interface ReleasesAnswer {
  branch: typeof LIFECYCLE_BRANCH;
  found: boolean;
  via: LifecycleVia;
  origin?: string;
  fetch: { ok: boolean; error?: string };
  read: { at: string };
  /** Columns, in wave order when `yodel-waves.json` gives one. */
  environments: string[];
  /** Where the column order came from. */
  order: "waves" | "name";
  /** Rows: every component or tenant any environment released. */
  components: string[];
  cells: ReleaseCell[];
  /** Ledger lines chant's reader skipped as malformed, per environment. */
  malformed: Record<string, number>;
  /** Set when the project is a workspace member (its records under `_members/<member>/`), or chant could not place it. */
  member?: { members: string[]; prefix: string; error?: string };
  note: string;
}

/** Column order: the waves' first, then the rest by name. */
export function orderEnvironments(envs: string[], waves: string[] | undefined): string[] {
  const seen = new Set(envs);
  const first = (waves ?? []).filter((e) => seen.has(e));
  const rest = envs.filter((e) => !first.includes(e)).sort();
  return [...first, ...rest];
}

/**
 * The strip, from each environment's full ledger: the newest record per
 * component (chant's `latestPerComponent`), and a mark on a cell whose digest
 * the environment before it does not hold. Pure.
 */
export function releaseCells(ledgers: Map<string, ReleaseRecord[]>, order: string[], sources: Map<string, ReleaseSource>): { components: string[]; cells: ReleaseCell[] } {
  const latest = new Map(order.map((env) => [env, latestPerComponent(ledgers.get(env) ?? [])]));
  const components = [...new Set(order.flatMap((env) => [...latest.get(env)!.keys()]))].sort();
  const cells: ReleaseCell[] = [];
  for (const component of components) {
    order.forEach((env, i) => {
      const r = latest.get(env)!.get(component);
      if (!r) return;
      const prevEnv = i > 0 ? order[i - 1] : undefined;
      const prev = prevEnv ? latest.get(prevEnv)!.get(component) : undefined;
      const differs =
        prevEnv && (prev ? releaseCompareKey(prev) : undefined) !== releaseCompareKey(r)
          ? {
              from: prevEnv,
              ...(prev ? { digest: prev.digest } : {}),
              everHad: (ledgers.get(prevEnv) ?? []).some((x) => x.component === component && releaseCompareKey(x) === releaseCompareKey(r)),
            }
          : undefined;
      cells.push({
        env,
        component,
        digest: r.digest,
        ...(digestKindOf(r) ? { digestKind: digestKindOf(r) } : {}),
        timestamp: r.timestamp,
        actor: r.actor,
        ...(r.approver ? { approver: r.approver } : {}),
        gitSha: r.gitSha,
        runId: r.runId,
        ...(r.runOrigin?.url && /^https?:\/\//.test(r.runOrigin.url) ? { runUrl: r.runOrigin.url } : {}),
        ...(r.runOrigin ? { runOrigin: r.runOrigin } : {}),
        ...(differs ? { differs } : {}),
        source: sources.get(env) ?? { branch: LIFECYCLE_BRANCH, path: `${env}/releases.jsonl` },
      });
    });
  }
  return { components, cells };
}

export interface ReleasesOptions {
  cacheRoot?: string;
  git?: GitRun;
  now?: () => Date;
}

/** Copy the checkout's own `origin/chant/lifecycle` into a cache of behold's, reading the checkout and moving none of its refs. */
async function copyCheckoutRef(git: GitRun, checkout: string, cache: string): Promise<boolean> {
  assertScratch(cache.split(/[\\/]/).pop()!);
  if (!existsSync(join(cache, "HEAD"))) {
    const init = await git(["init", "--bare", "-q", cache]);
    if (init.code !== 0) return false;
  }
  const f = await git(["--git-dir", cache, "fetch", "-q", "--no-tags", checkout, `+${CHECKOUT_REF}:refs/heads/${LIFECYCLE_BRANCH}`]);
  return f.code === 0;
}

/** Read every environment's ledger in the bare repository `cache`, with chant's reader, under the member's prefix when there is one. */
async function readCache(git: GitRun, cache: string, prefix = ""): Promise<{ ledgers: Map<string, ReleaseRecord[]>; malformed: Record<string, number>; sources: Map<string, ReleaseSource> }> {
  // The cache is a bare repository with no member to resolve from, so the prefix goes to chant as it is (`ledgerPrefix`, chant#3865).
  const at = { cwd: cache, ledgerPrefix: prefix };
  const envs = await listReleaseEnvironments(at);
  const ledgers = new Map<string, ReleaseRecord[]>();
  const malformed: Record<string, number> = {};
  const sources = new Map<string, ReleaseSource>();
  for (const env of envs) {
    const r = await readReleaseLedger(env, at);
    ledgers.set(env, r.records);
    if (r.malformed) malformed[env] = r.malformed;
    const path = `${prefix}${env}/releases.jsonl`;
    const log = await git(["--git-dir", cache, "log", "-1", "--format=%H%x00%cI", `refs/heads/${LIFECYCLE_BRANCH}`, "--", path]);
    const [commit, committed] = log.code === 0 && log.stdout.trim() ? log.stdout.trim().split("\0") : [];
    sources.set(env, { branch: LIFECYCLE_BRANCH, path, ...(commit ? { commit } : {}), ...(committed ? { committed } : {}) });
  }
  return { ledgers, malformed, sources };
}

/**
 * Read the release ledger for the checkout at `checkout`. Never throws for a
 * git failure; the answer says what happened.
 */
export async function readReleases(checkout: string, opts: ReleasesOptions = {}): Promise<ReleasesAnswer> {
  const git = opts.git ?? realGit;
  const now = (opts.now ?? (() => new Date()))();
  const waves = waveOrder(checkout);
  const ledger: ProjectLedger = await projectLedger(checkout, git);
  const member = ledger.members.length || ledger.error ? { member: { members: ledger.members, prefix: ledger.prefix, ...(ledger.error ? { error: ledger.error } : {}) } } : {};
  const also = memberNote(ledger);
  const base = { branch: LIFECYCLE_BRANCH, read: { at: now.toISOString() }, order: (waves ? "waves" : "name") as ReleasesAnswer["order"], ...member } as const;
  const empty = { environments: [] as string[], components: [] as string[], cells: [] as ReleaseCell[], malformed: {} };
  const answer = async (cache: string, via: LifecycleVia, fetch: ReleasesAnswer["fetch"], origin: string | undefined, note: string): Promise<ReleasesAnswer> => {
    const { ledgers, malformed, sources } = await readCache(git, cache, ledger.prefix);
    const environments = orderEnvironments([...ledgers.keys()], waves);
    const { components, cells } = releaseCells(ledgers, environments, sources);
    return { ...base, found: true, via, ...(origin ? { origin } : {}), fetch, environments, components, cells, malformed, note: also ? `${note} ${also}` : note };
  };

  const remote = await git(["-C", checkout, "remote", "get-url", "origin"]);
  const url = remote.code === 0 ? remote.stdout.trim() : "";
  let fetchError: string;
  let origin: string | undefined;
  if (!url) {
    fetchError = "the checkout has no origin remote";
  } else {
    const from = fetchable(url, checkout);
    origin = redact(from);
    const cache = cacheDir(from, opts.cacheRoot);
    let f: Awaited<ReturnType<typeof fetchIntoCache>>;
    try {
      f = await fetchIntoCache(git, from, cache);
    } catch (e) {
      f = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (f.ok && !f.found) return { ...base, found: false, via: "fetch", origin, fetch: { ok: true }, ...empty, note: `${origin} has no ${LIFECYCLE_BRANCH} branch: no environment has recorded a release yet.` };
    if (f.ok) {
      try {
        return await answer(cache, "fetch", { ok: true }, origin, `release ledger on ${LIFECYCLE_BRANCH} as fetched from ${origin} at ${base.read.at}.`);
      } catch (e) {
        fetchError = `fetched ${LIFECYCLE_BRANCH}, but chant's release-ledger reader failed on it: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      fetchError = f.error;
    }
  }

  const copy = cacheDir(`checkout-ref:${checkout}`, opts.cacheRoot);
  try {
    if (await copyCheckoutRef(git, checkout, copy)) {
      return await answer(copy, "checkout-ref", { ok: false, error: fetchError }, origin, `behold could not fetch ${LIFECYCLE_BRANCH} (${fetchError}), so this is the checkout's ${CHECKOUT_REF}, as of its last git fetch.`);
    }
  } catch {
    /* fall through to none */
  }
  return {
    ...base,
    found: false,
    via: "none",
    ...(origin ? { origin } : {}),
    fetch: { ok: false, error: fetchError },
    ...empty,
    note: `behold could not fetch ${LIFECYCLE_BRANCH} (${fetchError}) and the checkout has no ${CHECKOUT_REF}, so the releases are unknown.`,
  };
}

/** How long a read is reused by the route, as the lifecycle lane's is. */
export const RELEASES_READ_TTL_MS = 30_000;

/** `GET /api/lifecycle/releases[?fresh=1]`: the release ledger of the served checkout. */
export function releasesRoutes(app: Hono, base: () => string, opts: ReleasesOptions = {}): void {
  let cached: { at: number; base: string; read: Promise<ReleasesAnswer> } | undefined;
  app.get("/api/lifecycle/releases", async (c) => {
    const b = base();
    const force = new URL(c.req.url).searchParams.get("fresh") === "1";
    if (force || !cached || cached.base !== b || Date.now() - cached.at >= RELEASES_READ_TTL_MS) {
      const read = readReleases(b, opts);
      cached = { at: Date.now(), base: b, read };
      read.catch(() => (cached = undefined));
    }
    try {
      return c.json(await cached!.read);
    } catch (e) {
      return c.json({ error: `release ledger not read: ${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  });
}
