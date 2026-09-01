/**
 * Project autodetection (#17). behold reads the served project so the SPA can
 * offer pickers — chiefly the environment.
 *
 * Authoritative path: import the project's `chant.config.ts` and read the real
 * config object (behold runs under tsx, so `.ts` transpiles). That handles every
 * shape — `export default { … }`, `defineConfig(…)`, `satisfies ChantConfig`,
 * values built from constants. If the import can't run (odd deps, side effects),
 * fall back to a text parse of the literal fields it can (the two string arrays,
 * plus `sourceDir` — see below), then to empty (the SPA shows just `(source)`).
 *
 * `sourceDir`/`stacks` (#71): also read here, alongside `environments`/
 * `lexicons`, so `chant.ts`'s `graphPath()` can honor the project's declared
 * infra source dir instead of guessing a literal `src/` convention.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A `chant.config.ts` `stacks[]` entry: a multi-stack project's independently-
 * deployed CloudFormation stack, built from its own source directory. */
export interface StackInfo {
  /** The deployed CloudFormation stack name. */
  name: string;
  /** Source directory for this stack, relative to the project root. */
  src: string;
}

export interface ProjectInfo {
  /** Declared environments (drives the env picker → live overlay per env). */
  environments: string[];
  /** Declared lexicons (the substrates in play — shown, no picker yet). */
  lexicons: string[];
  /** `k8s.profiles` — environment → bound kubeconfig context (#106). chant's
   * k8s reader binds `--env <env>` to this and resolves the apiserver from the
   * kubeconfig; behold reads it only to report which cluster that is, never to
   * override it (see src/k8s-target.ts). */
  k8sProfiles?: Record<string, { context?: string }>;
  /** `sourceDir` (#71): the directory (relative to the project root) that holds
   * the chant infra source, honored by `chant.ts`'s `graphPath()` instead of the
   * hardcoded `src/`-then-root guess. Undefined when the config doesn't declare
   * one (chant itself defaults unset `sourceDir` to the project root). */
  sourceDir?: string;
  /** `stacks[]` (#71): a multi-stack project's per-stack source dirs. Only
   * populated when the authoritative config import succeeds — the text-parse
   * fallback doesn't attempt to parse this array of objects (see
   * `parseStringArray`, which only handles flat string arrays). Undefined for a
   * single-stack project. Graph resolution doesn't render every stack yet
   * (#76, follow-up to #71) — `graphPath()` warns rather than silently picking
   * one when this is set. */
  stacks?: StackInfo[];
}

/** The deploy-tier axis a project declares (#70) — a dimension orthogonal to
 * `environment`, entirely the served project's own convention (chant has no
 * native tier concept). `envVar` is the env var name the project's source
 * branches on (loomster: `LOOM_TIER`); `values` are its valid settings
 * (loomster: light/production/production-ha) — the tier picker's options. */
export interface TierConfig {
  envVar: string;
  values: string[];
}

/** behold's own project-root config (`.behold.json`) — distinct from
 * `chant.config.ts` (chant's own concerns): today just the optional tier
 * axis. Absent `tiers` means the project declares none. */
/**
 * Which forge deploys an environment (#165, #61): `.behold.json`'s
 * `executor` block designates the committed WORKFLOW, not just the forge —
 * `{"executor": {"prod": {"forge": "github", "workflow": "deploy-prod.yml"}}}`.
 * Designating the file is what retires the job-overlap picker for that env:
 * two envs' generated pipelines carry identical job ids, so a picker cannot
 * tell them apart, and a contract that names prod must not sit on a guess.
 *
 * Fail-closed: an entry behold cannot honour is kept, with the reason, rather
 * than dropped — a dropped entry would fall Deploy back to the laptop, which
 * is the one thing a designation exists to prevent.
 */
export type ExecutorDesignation = { forge: string; workflow: string } | { invalid: string };

export interface BeholdConfig {
  tiers?: TierConfig;
  /** Per-environment executor designations (#165). Absent means every env
   * deploys the way it always has (`chant run` on this machine). */
  executor?: Record<string, ExecutorDesignation>;
  /** Estate members (#236): the member project directories, relative to the
   * root that declares them. An estate root is not itself a chant project —
   * it's the directory you'd run `behold serve a b c` from — so this is how a
   * root says which projects compose it without behold guessing. Absent when
   * the file declares none (see `detectProjectShape`, which then falls back to
   * npm `workspaces`). */
  members?: string[];
}

const CONFIG_NAMES = ["chant.config.ts", "chant.config.mts", "chant.config.js", "chant.config.mjs"];
const BEHOLD_CONFIG_NAME = ".behold.json";

/** The project's chant config file, or undefined when the directory has none —
 * the single "is this a chant project" test, shared by `detectProject`,
 * `detectProjectShape` and the CLI's startup warning so all three agree. */
export function chantConfigPath(projectDir: string): string | undefined {
  for (const name of CONFIG_NAMES) {
    const p = join(projectDir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Pull a `stacks[]` array's well-formed `{name, src}` entries, dropping any
 * malformed one rather than throwing — a config typo shouldn't crash graph
 * resolution. */
function readStacks(v: unknown): StackInfo[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const stacks = v.filter(
    (s): s is StackInfo =>
      !!s && typeof s === "object" && typeof (s as StackInfo).name === "string" && typeof (s as StackInfo).src === "string",
  );
  return stacks.length ? stacks : undefined;
}

/** Pull `k8s.profiles` — `{ <env>: { context } }` — keeping only entries with a
 * string context. Absent (not `{}`) when the project declares none, so a caller
 * can tell "no binding declared" from "declared and empty" (#106). */
function readK8sProfiles(k8s: unknown): Record<string, { context?: string }> | undefined {
  const profiles = (k8s as { profiles?: unknown } | undefined)?.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return undefined;
  const out: Record<string, { context?: string }> = {};
  for (const [env, value] of Object.entries(profiles as Record<string, unknown>)) {
    const context = (value as { context?: unknown } | undefined)?.context;
    if (typeof context === "string" && context.length > 0) out[env] = { context };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Pull a config object's `environments`/`lexicons`/`sourceDir`/`stacks`,
 * keeping only well-formed entries (string arrays, a string, `{name,src}[]`). */
function readInfo(cfg: Record<string, unknown> | undefined): ProjectInfo {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // An environments entry is a bare name OR chant's `{ name, endpoint }` form
  // (the emulator binding — see chant's Config File docs). The object form was
  // dropped here, so a project like cc-aws-canonical served with an empty env
  // picker despite declaring `local`.
  const envNames = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .map((x) => (typeof x === "string" ? x : typeof (x as { name?: unknown })?.name === "string" ? (x as { name: string }).name : undefined))
          .filter((x): x is string => !!x)
      : [];
  const stacks = readStacks(cfg?.stacks);
  const k8sProfiles = readK8sProfiles(cfg?.k8s);
  // #191: a pure-k8s project binds its clusters through `k8s.profiles`, not a
  // top-level `environments` array — the profile keys ARE the environment
  // names (the same list `--env` validates against downstream). Inferred only
  // when `environments` is absent/empty, so an explicit list always wins.
  const environments = envNames(cfg?.environments);
  return {
    environments: environments.length ? environments : Object.keys(k8sProfiles ?? {}),
    lexicons: arr(cfg?.lexicons),
    ...(k8sProfiles ? { k8sProfiles } : {}),
    ...(typeof cfg?.sourceDir === "string" ? { sourceDir: cfg.sourceDir } : {}),
    ...(stacks ? { stacks } : {}),
  };
}

/** Extract the string literals from a `key: [ "a", "b" ]` array in config source.
 * Only matches a literal array — a computed value yields []. Pure. */
function parseStringArray(content: string, key: string): string[] {
  const arr = content.match(new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!arr) return [];
  return [...arr[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** Extract environment NAMES from a literal `environments: [...]` array in
 * config source — entries are bare strings or chant's `{ name, endpoint }`
 * objects, and the generic string scan would happily return an endpoint URL as
 * an environment. Pure. */
function parseEnvironmentNames(content: string): string[] {
  const arr = content.match(/\benvironments\s*:\s*\[([^\]]*)\]/);
  if (!arr) return [];
  const body = arr[1];
  if (body.includes("{")) {
    return [...body.matchAll(/\bname\s*:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  }
  return [...body.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/** #191: environment names from a literal `k8s: { profiles: { <env>: {…} } }`
 * block in config source — the text-parse counterpart of `readInfo`'s
 * profile-key inference, for a config that can't be imported (a `satisfies
 * ChantConfig` on a project whose deps aren't installed is the common case).
 * Brace-balanced scan of the profiles object; the keys at its top level are
 * the env names. Pure. */
function parseK8sProfileNames(content: string): string[] {
  const m = content.match(/\bprofiles\s*:\s*\{/);
  if (!m || m.index === undefined) return [];
  const start = m.index + m[0].length;
  let depth = 1;
  let end = start;
  for (; end < content.length && depth > 0; end++) {
    if (content[end] === "{") depth++;
    else if (content[end] === "}") depth--;
  }
  const body = content.slice(start, end - 1);
  const names: string[] = [];
  let d = 0;
  let segment = "";
  for (const ch of body) {
    if (ch === "{") {
      if (d === 0) {
        const key = segment.match(/(["'`]?)([\w.-]+)\1\s*:\s*$/);
        if (key) names.push(key[2]);
        segment = "";
      }
      d++;
    } else if (ch === "}") {
      d--;
    } else if (d === 0) {
      segment += ch;
    }
  }
  return names;
}

/** Extract a `key: "value"` string literal from config source. Only matches a
 * literal string — a computed value (e.g. `process.env.X`) yields undefined.
 * Pure. Used for `sourceDir` (#71) in the text-parse fallback; `stacks[]` (an
 * array of objects, not strings) isn't attempted here — see `ProjectInfo`. */
function parseStringLiteral(content: string, key: string): string | undefined {
  const m = content.match(new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
  return m?.[1];
}

/** Detect what the project offers. Async: it may import the project's config. */
export async function detectProject(projectDir: string): Promise<ProjectInfo> {
  const path = chantConfigPath(projectDir);
  if (!path) return { environments: [], lexicons: [] };

  // Authoritative: run the real config.
  try {
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    const cfg = (mod.default ?? mod.config ?? mod) as Record<string, unknown>;
    const info = readInfo(cfg);
    if (info.environments.length || info.lexicons.length || info.sourceDir || info.stacks?.length) return info;
  } catch {
    // Import wouldn't run — fall through to a text parse.
  }

  const content = readFileSync(path, "utf8");
  const sourceDir = parseStringLiteral(content, "sourceDir");
  // #191: same inference as readInfo — profile keys stand in for an
  // absent/empty environments array.
  const environments = parseEnvironmentNames(content);
  return {
    environments: environments.length ? environments : parseK8sProfileNames(content),
    lexicons: parseStringArray(content, "lexicons"),
    ...(sourceDir ? { sourceDir } : {}),
  };
}

/** Validate a parsed `.behold.json`'s `tiers` block, keeping only a
 * well-formed one — a non-empty `envVar` string alongside a non-empty array
 * of string `values`. Anything else (missing, wrong shape, empty values)
 * degrades to "no tiers", the same as an absent file. Pure. */
function readTiers(cfg: Record<string, unknown> | undefined): TierConfig | undefined {
  const tiers = cfg?.tiers as Record<string, unknown> | undefined;
  if (!tiers || typeof tiers.envVar !== "string" || !tiers.envVar) return undefined;
  const values = Array.isArray(tiers.values) ? tiers.values.filter((v): v is string => typeof v === "string") : [];
  if (!values.length) return undefined;
  return { envVar: tiers.envVar, values };
}

/** The forges a designation may name. Only `github` has a trigger in behold
 * today (the operator's `gh`); the other two are recognised so a designation
 * disables local Deploy for the env, and say why nothing dispatches. */
export const EXECUTOR_FORGES = ["github", "gitlab", "forgejo"] as const;

/** Validate a parsed `.behold.json`'s `executor` block. Every key is kept —
 * a malformed value becomes `{invalid}` with the reason (fail-closed, see
 * {@link ExecutorDesignation}); a block that isn't an object is no block. Pure. */
export function readExecutor(cfg: Record<string, unknown> | undefined): Record<string, ExecutorDesignation> | undefined {
  const raw = cfg?.executor;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, ExecutorDesignation> = {};
  for (const [env, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!env) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      out[env] = { invalid: `executor.${env} must be {forge, workflow}, got ${JSON.stringify(value)}` };
      continue;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.forge !== "string" || !(EXECUTOR_FORGES as readonly string[]).includes(v.forge)) {
      out[env] = { invalid: `executor.${env}.forge must be one of ${EXECUTOR_FORGES.join(", ")}, got ${JSON.stringify(v.forge)}` };
      continue;
    }
    if (typeof v.workflow !== "string" || !/^[^/\\]+\.ya?ml$/.test(v.workflow)) {
      out[env] = { invalid: `executor.${env}.workflow must name a file in .github/workflows (e.g. deploy-${env}.yml), got ${JSON.stringify(v.workflow)}` };
      continue;
    }
    out[env] = { forge: v.forge, workflow: v.workflow };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Read `.behold.json` from the project root — behold's own config (#70),
 * kept separate from `chant.config.ts` so behold's concerns (like the tier
 * picker) don't leak into chant's. No file, unparseable JSON, or a malformed/
 * absent `tiers` key all degrade to `{}` (no tier axis) rather than throwing —
 * a project that doesn't opt in just doesn't get the picker. Sync: it's a
 * plain JSON read, no code to run (unlike `detectProject`'s `chant.config.ts`
 * import). Shape:
 * ```json
 * { "tiers": { "envVar": "LOOM_TIER", "values": ["light", "production", "production-ha"] } }
 * ```
 */
export function loadBeholdConfig(projectDir: string): BeholdConfig {
  const path = join(projectDir, BEHOLD_CONFIG_NAME);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const tiers = readTiers(raw);
    const members = Array.isArray(raw.members) ? raw.members.filter((m): m is string => typeof m === "string" && !!m) : [];
    const executor = readExecutor(raw);
    return { ...(tiers ? { tiers } : {}), ...(members.length ? { members } : {}), ...(executor ? { executor } : {}) };
  } catch {
    return {};
  }
}

/** What kind of thing a directory is, as far as behold is concerned (#236):
 *  - `project` — a chant project: it has a `chant.config.*`.
 *  - `estate`  — not itself a project, but it names member projects that are:
 *                `.behold.json`'s `members`, else npm `workspaces`. This is the
 *                `behold serve a b c` shape (#31) with the member list written
 *                down — `behold demo flux-estate` is one.
 *  - `none`    — neither, which is #193's structured dead end. */
export type ProjectKind = "project" | "estate" | "none";

export interface ProjectShape {
  kind: ProjectKind;
  /** The `chant.config.*` path, for `kind: "project"`. */
  configFile?: string;
  /** Member directories relative to `dir`, for `kind: "estate"` — only those
   * that are themselves chant projects, in declared order. */
  members?: string[];
  /** Where the member list came from, so a report never implies behold chose it. */
  membersFrom?: "behold-config" | "workspaces";
}

/** Read npm `workspaces` from a root package.json — the array form only (the
 * `{ packages: [...] }` object form too). Globs are not expanded: a member
 * entry has to name a directory, which is what an estate root writes. */
function readWorkspaces(projectDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
    const ws = Array.isArray(raw.workspaces) ? raw.workspaces : (raw.workspaces as { packages?: unknown })?.packages;
    return Array.isArray(ws) ? ws.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

/** Classify a directory (#236's first doctor line, and the CLI's startup
 * warning): a chant project, an estate root naming member projects, or
 * neither. Sync and read-only — `existsSync` plus two JSON reads, no config
 * import (that's `detectProject`, which needs the members resolved first). */
export function detectProjectShape(projectDir: string): ProjectShape {
  const configFile = chantConfigPath(projectDir);
  if (configFile) return { kind: "project", configFile };
  const declared = loadBeholdConfig(projectDir).members;
  const from: ProjectShape["membersFrom"] = declared ? "behold-config" : "workspaces";
  const members = (declared ?? readWorkspaces(projectDir)).filter((m) => !!chantConfigPath(join(projectDir, m)));
  if (members.length) return { kind: "estate", members, membersFrom: from };
  return { kind: "none" };
}
