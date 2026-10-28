/**
 * behold#1035: the Templates tab's two routes. A terragucci repo with
 * `templates` in terragucci.yml offers apps made from templates; a person who
 * writes no infrastructure code picks one, fills a form, and asks terragucci
 * to open the pull request that adds the app.
 *
 * - `GET /api/templates` runs the repo's `terragucci templates list --json`
 *   and answers what it printed, byte for byte. A terragucci without the
 *   `templates` command answers `409 terragucci-too-old`.
 * - `POST /api/templates/request` checks the request against that list (the
 *   version is one a request may name, every required input is there and of
 *   its kind) and against chant's template-request/v1 schema when the
 *   installed chant carries it, then dispatches terragucci's request workflow
 *   (`terragucci-request.yml`) with the inputs `template`, `version`, `name`
 *   and `inputs`, plus `claimed_by` when the committed workflow declares it.
 *   On GitHub through the operator's `gh workflow run`; on Forgejo through
 *   the API with the operator's `FORGEJO_TOKEN`. GitLab has no such workflow
 *   and answers `422 request-forge` with the `terragucci request` line to run.
 *
 * behold writes nothing in the tree, never runs `terragucci request` itself
 * and holds no apply credential. The run in CI opens the pull request with the
 * repo's own token (ruling A of INTENTIUS/chant#4642), and its actor is the
 * requester the forge vouches for; the person behold says filled the form goes
 * beside it as the claimed requester. The route is on TERRAGUCCI_ALLOWED_WRITES
 * for that reason. The allowlist is shared with SQL Yodeler repos, so the
 * handler refuses on its own unless the repo is terragucci and sets
 * `templates`.
 *
 * behold#1036 adds an app's view and its two requests:
 *
 * - `GET /api/templates/apps` runs `terragucci templates apps --json` and
 *   answers what it printed, byte for byte: each app's root, template,
 *   version, add-ons, `actions`, `upgrade` (a version or null) and `yanked`.
 * - `POST /api/templates/request` with `app` set asks for an add-on in that
 *   app's root (ruling C: one root, planned and applied together). The
 *   template must be an add-on template, and the app one the apps read lists,
 *   else `422 not-an-app`.
 * - `POST /api/templates/upgrade` with `{app}` dispatches terragucci's
 *   rollout workflow (`terragucci-rollout.yml`) with `module` (the app's
 *   template) and `version` (its `upgrade`). A person starts it, and the
 *   existing rollout carries it wave by wave (ruling D); behold applies
 *   nothing and opens no pull request.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Context, Hono } from "hono";
import { parseYAML } from "@intentius/chant/yaml";
import type { Broadcaster } from "./events.ts";
import { FORGEJO_DONE, FORGEJO_TOKEN_ENV, FORGEJO_URL_ENV, ForgejoRepo, originUrl, targetOfOrigin, type Fetch } from "./forgejo-api.ts";
import { defaultGhExec, dispatchWorkflow, followRun, ghReady, latestRunId, pullRequestOn, type GhExec } from "./gh-run.ts";
import type { CiPipeline } from "./chant.ts";
import type { Runner } from "./public-mode.ts";
import { productRefusal, servedProductRepo } from "./terragucci-repo.ts";

/** The request workflow's file, as terragucci#1308 renders it. */
export const REQUEST_WORKFLOW = "terragucci-request.yml";
/** The rollout workflow's file, as terragucci renders it (singular; terragucci#1312 gives it the `module` and `version` inputs). */
export const ROLLOUT_WORKFLOW = "terragucci-rollout.yml";
/** An add-on input that names an output of the app's own module: `app.<output>` (chant's `isAppOutputRef`). */
export const APP_OUTPUT_REF = /^app\.[A-Za-z_][A-Za-z0-9_-]*$/;
/** Where each forge keeps it. */
export const REQUEST_WORKFLOW_DIRS = { github: ".github/workflows", forgejo: ".forgejo/workflows" } as const;
/** The newest terragucci without `templates`: the floor is the release after it. */
export const TERRAGUCCI_WITHOUT_TEMPLATES = "0.4.46";
/** An app name, as chant's template request takes it (REQUEST_NAME_PATTERN). */
export const REQUEST_NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** How long a catalog read answers a request's check before it is read again. */
export const CATALOG_TTL_MS = 5 * 60 * 1000;

export type RequestForge = "github" | "forgejo" | "gitlab";

/** One form field, as `terragucci templates list --json` prints it. */
export interface TemplateField {
  name: string;
  kind: "string" | "number" | "bool" | "list" | "map" | "object";
  of?: string;
  label?: string;
  description?: string;
  default?: unknown;
  required: boolean;
  sensitive?: boolean;
  type?: string;
}

/** One template row, as `terragucci templates list --json` prints it. */
export interface TemplateRow {
  template: string;
  name: string;
  component?: string;
  address?: string;
  kind: "app" | "addon";
  description?: string;
  versions: { version: string; attestation: string; time?: string; commit?: string }[];
  latest: string;
  fields: TemplateField[];
}

/** One add-on of an app, as `terragucci templates apps --json` prints it. */
export interface AppAddonRow {
  name: string;
  template: string;
  version: string | null;
  upgrade?: string | null;
  yanked?: boolean;
}

/** One app, as `terragucci templates apps --json` prints it (terragucci#1309, `upgrade` and `yanked` from #1312). */
export interface AppRow {
  app: string;
  root: string;
  template: string;
  version: string | null;
  upgrade?: string | null;
  yanked?: boolean;
  addons: AppAddonRow[];
  actions?: { module: string; type: string; name: string; address: string }[];
}

/** The served repo, when it is terragucci's. */
export interface TemplatesRepo {
  config: string;
  /** The repository root: where the workflows are. */
  root: string;
  /** terragucci.yml sets `templates`. */
  templates: boolean;
  forge?: RequestForge;
}

/** One `terragucci <args>` run in `cwd`. Code 127: no terragucci to run. */
export type TerragucciRun = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** What the routes reach outside behold through. A test hands in spies. */
export interface TemplatesIo {
  terragucci?: TerragucciRun;
  gh?: GhExec;
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  appearTimeoutMs?: number;
  followTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TemplatesDeps {
  dirs: () => readonly string[];
  runner: Runner;
  broadcaster?: Broadcaster;
  /** The person behold says is asking, or undefined when it cannot tell. */
  claimed: (c: Context) => string | undefined;
  preview: () => boolean;
  io?: TemplatesIo;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The keys of terragucci's config this reads: `templates` and `forge`. */
function configKeys(config: string): { templates?: unknown; forge?: unknown } {
  let text: string;
  try {
    text = readFileSync(config, "utf8");
  } catch {
    return {};
  }
  if (config.endsWith(".ts")) {
    // A TypeScript config is not run here; its keys are read off the text.
    const forge = /\bforge\s*:\s*["'](github|forgejo|gitlab)["']/.exec(text)?.[1];
    return { ...(/^\s*templates\s*:/m.test(text) ? { templates: true } : {}), ...(forge ? { forge } : {}) };
  }
  try {
    const doc = config.endsWith(".json") ? JSON.parse(text) : parseYAML(text);
    return isRecord(doc) ? { templates: doc.templates, forge: doc.forge } : {};
  } catch {
    return {};
  }
}

function gitRoot(dir: string): string {
  let at = resolve(dir);
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return resolve(dir);
    at = up;
  }
}

/** The forge the request goes through: terragucci.yml's `forge`, else the committed request workflow's directory, else GitLab's pipeline, else origin's host. */
export function requestForge(root: string, declared?: unknown): RequestForge | undefined {
  if (declared === "github" || declared === "forgejo" || declared === "gitlab") return declared;
  if (existsSync(join(root, REQUEST_WORKFLOW_DIRS.forgejo, REQUEST_WORKFLOW))) return "forgejo";
  if (existsSync(join(root, REQUEST_WORKFLOW_DIRS.github, REQUEST_WORKFLOW))) return "github";
  if (existsSync(join(root, ".gitlab-ci.yml")) || existsSync(join(root, ".gitlab", "terragucci.yml"))) return "gitlab";
  const origin = originUrl(root) ?? "";
  if (/github\.com[/:]/.test(origin)) return "github";
  if (/gitlab/.test(origin)) return "gitlab";
  return undefined;
}

/** The served terragucci repo and whether it sets `templates`, or undefined when the repo is not terragucci's. */
export function templatesRepo(dirs: readonly string[]): TemplatesRepo | undefined {
  const r = servedProductRepo(dirs);
  if (r?.product !== "terragucci") return undefined;
  const keys = configKeys(r.config);
  const root = gitRoot(dirname(r.config));
  const templates = keys.templates !== undefined && keys.templates !== null && keys.templates !== false;
  const forge = requestForge(root, keys.forge);
  return { config: r.config, root, templates, ...(forge ? { forge } : {}) };
}

/** The installed terragucci package under `dir` (its root and version), walking up the node_modules directories. */
export function terragucciPackage(dir: string): { root: string; version?: string; bin?: string } | undefined {
  let at = resolve(dir);
  for (;;) {
    const root = join(at, "node_modules", "@intentius", "terragucci");
    const pkg = join(root, "package.json");
    if (existsSync(pkg)) {
      try {
        const p = JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown; bin?: unknown };
        const bin = typeof p.bin === "string" ? p.bin : isRecord(p.bin) && typeof p.bin.terragucci === "string" ? p.bin.terragucci : undefined;
        return { root, ...(typeof p.version === "string" ? { version: p.version } : {}), ...(bin ? { bin: join(root, bin) } : {}) };
      } catch {
        return { root };
      }
    }
    const up = dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/** The repo's own terragucci (its node_modules), else one on PATH. */
export const defaultTerragucci: TerragucciRun = (cwd, args) =>
  new Promise((done) => {
    const pkg = terragucciPackage(cwd);
    const [cmd, pre] = pkg?.bin ? [process.execPath, [pkg.bin]] : ["terragucci", []];
    let stdout = "";
    let stderr = "";
    let proc;
    try {
      proc = spawn(cmd, [...pre, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      done({ code: 127, stdout, stderr });
      return;
    }
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", () => done({ code: 127, stdout, stderr }));
    proc.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });

/** A refusal: its HTTP status and body. */
export interface Refusal {
  status: 403 | 409 | 422 | 424 | 502;
  body: { error: string; code: string; field?: string; remedy?: string; refusals?: { code: string; field: string; reason: string }[] };
}

const refuse = (status: Refusal["status"], code: string, error: string, extra: Partial<Refusal["body"]> = {}): Refusal => ({ status, body: { error, code, ...extra } });

/** The catalog read: what terragucci printed, and its rows when it is a templates envelope. */
export type CatalogRead = { ok: true; printed: string; exit: number; rows?: TemplateRow[] } | { ok: false; refusal: Refusal };

/** `terragucci templates list --json` in the repo, or why it could not answer. */
export async function readCatalog(repo: TemplatesRepo, run: TerragucciRun): Promise<CatalogRead> {
  const { code, stdout, stderr } = await run(repo.root, ["templates", "list", "--json"]);
  if (code === 127) {
    return { ok: false, refusal: refuse(424, "no-terragucci", "there is no terragucci to run: the repo has none in node_modules and none is on PATH", { remedy: "Run npm install in the repo, so its own terragucci is the one behold runs." }) };
  }
  let env: unknown;
  try {
    env = JSON.parse(stdout);
  } catch {
    env = undefined;
  }
  if (!isRecord(env) || env.command !== "templates") {
    if (/unknown command "templates"/.test(`${stdout}\n${stderr}`)) {
      const have = terragucciPackage(repo.root)?.version;
      return {
        ok: false,
        refusal: refuse(409, "terragucci-too-old", `the repo's terragucci${have ? ` ${have}` : ""} has no templates command; it needs a terragucci newer than ${TERRAGUCCI_WITHOUT_TEMPLATES}`, {
          remedy: `Move the repo to a terragucci release after ${TERRAGUCCI_WITHOUT_TEMPLATES}, which has terragucci templates and the request workflow.`,
        }),
      };
    }
    const why = (stderr || stdout).trim().split("\n").filter(Boolean).pop() ?? `exit ${code}`;
    return { ok: false, refusal: refuse(502, "terragucci-failed", `terragucci templates list --json printed no templates envelope (${why})`) };
  }
  const exit = typeof env.exit === "number" ? env.exit : code;
  return { ok: true, printed: stdout, exit, ...(Array.isArray(env.results) ? { rows: env.results as TemplateRow[] } : {}) };
}

/** The apps read: what terragucci printed, and its rows when it is a templates envelope. */
export type AppsRead = { ok: true; printed: string; exit: number; rows?: AppRow[] } | { ok: false; refusal: Refusal };

/** `terragucci templates apps --json` in the repo, or why it could not answer. */
export async function readApps(repo: TemplatesRepo, run: TerragucciRun): Promise<AppsRead> {
  const { code, stdout, stderr } = await run(repo.root, ["templates", "apps", "--json"]);
  if (code === 127) {
    return { ok: false, refusal: refuse(424, "no-terragucci", "there is no terragucci to run: the repo has none in node_modules and none is on PATH", { remedy: "Run npm install in the repo, so its own terragucci is the one behold runs." }) };
  }
  let env: unknown;
  try {
    env = JSON.parse(stdout);
  } catch {
    env = undefined;
  }
  if (!isRecord(env) || env.command !== "templates") {
    // A terragucci with `templates list` and no `apps` prints its usage line; one older still has no `templates` at all.
    const said = `${stdout}\n${stderr}`;
    if (/unknown command "templates"/.test(said) || (/usage: terragucci templates/.test(said) && !/\bapps\b/.test(said))) {
      const have = terragucciPackage(repo.root)?.version;
      return {
        ok: false,
        refusal: refuse(409, "terragucci-too-old", `the repo's terragucci${have ? ` ${have}` : ""} has no templates apps command; it needs a terragucci newer than ${TERRAGUCCI_WITHOUT_TEMPLATES} that lists the apps made from templates`, {
          remedy: "Move the repo to a terragucci release with terragucci templates apps.",
        }),
      };
    }
    const why = (stderr || stdout).trim().split("\n").filter(Boolean).pop() ?? `exit ${code}`;
    return { ok: false, refusal: refuse(502, "terragucci-failed", `terragucci templates apps --json printed no templates envelope (${why})`) };
  }
  const exit = typeof env.exit === "number" ? env.exit : code;
  return { ok: true, printed: stdout, exit, ...(Array.isArray(env.results) ? { rows: env.results as AppRow[] } : {}) };
}

/** The dispatch inputs a committed workflow declares (the request workflow unless `name` says another), or undefined when the file is not there. */
export function requestWorkflowInputs(root: string, forge: "github" | "forgejo", name: string = REQUEST_WORKFLOW): string[] | undefined {
  const file = join(root, REQUEST_WORKFLOW_DIRS[forge], name);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const d = parseYAML(text) as Record<string, unknown>;
    const on = d.on ?? d[true as unknown as string];
    const dispatch = isRecord(on) ? on.workflow_dispatch : undefined;
    const inputs = isRecord(dispatch) ? dispatch.inputs : undefined;
    if (isRecord(inputs)) return Object.keys(inputs);
  } catch {
    /* read off the text below */
  }
  const block = /^\s+inputs:\s*\n((?:\s{4,}.*\n?)*)/m.exec(text)?.[1] ?? "";
  const indent = /^(\s+)\S/.exec(block)?.[1]?.length ?? 0;
  return block.split("\n").filter((l) => new RegExp(`^\\s{${indent}}[A-Za-z_][\\w-]*\\s*:`).test(l)).map((l) => l.trim().replace(/\s*:.*$/, ""));
}

/** The request's branch, as chant's `requestBranch` names it: `request/<template>/<app>`, and `/<addon>` after it for an add-on. */
export function requestBranch(template: string, name: string, app?: string): string {
  const parts = template.split("/").filter(Boolean);
  const short = (parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1]) ?? template;
  return app !== undefined ? `request/${short}/${app}/${name}` : `request/${short}/${name}`;
}

/** The first wave's branch of a rollout to `version`, as terragucci's rollout names it (`terragucci/rollout/<module>-<to>/wave-1`). */
export function rolloutBranch(module: string, version: string): string {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `terragucci/rollout/${slug(module)}-${slug(version)}/wave-1`;
}

/** Why `value` is not of `field`'s kind, or undefined when it is (chant's `inputKindProblem`, on any chant). */
export function kindProblem(field: Pick<TemplateField, "kind" | "of">, value: unknown): string | undefined {
  const scalar = (k: string, v: unknown): boolean => (k === "string" ? typeof v === "string" : k === "number" ? typeof v === "number" && Number.isFinite(v) : k === "bool" ? typeof v === "boolean" : true);
  const want = field.of ? `${field.kind} of ${field.of}` : field.kind;
  const bad = `is not a ${want}`;
  if (value === null || value === undefined) return bad;
  switch (field.kind) {
    case "string":
    case "number":
    case "bool":
      return scalar(field.kind, value) ? undefined : bad;
    case "list":
      return Array.isArray(value) && (!field.of || value.every((v) => scalar(field.of!, v))) ? undefined : bad;
    case "map":
      return isRecord(value) && (!field.of || Object.values(value).every((v) => scalar(field.of!, v))) ? undefined : bad;
    case "object":
      return isRecord(value) ? undefined : bad;
    default:
      return undefined;
  }
}

/** What a request asks for. */
export interface RequestBody {
  template: string;
  version?: string;
  name: string;
  app?: string;
  inputs: Record<string, unknown>;
}

/** The body, or the refusal of a body that is not a request. */
export function parseRequestBody(raw: unknown): { ok: true; body: RequestBody } | { ok: false; refusal: Refusal } {
  if (!isRecord(raw)) return { ok: false, refusal: refuse(422, "invalid", "the request is not a JSON object") };
  const { template, version, name, app, inputs } = raw;
  if (typeof template !== "string" || !template) return { ok: false, refusal: refuse(422, "invalid", "the request names no template", { field: "template" }) };
  if (typeof name !== "string") return { ok: false, refusal: refuse(422, "invalid", "the request names no app (name)", { field: "name" }) };
  if (version !== undefined && version !== null && typeof version !== "string") return { ok: false, refusal: refuse(422, "invalid", "version is not a string", { field: "version" }) };
  if (app !== undefined && typeof app !== "string") return { ok: false, refusal: refuse(422, "invalid", "app is not a string", { field: "app" }) };
  if (inputs !== undefined && !isRecord(inputs)) return { ok: false, refusal: refuse(422, "invalid", "inputs is not an object of values by name", { field: "inputs" }) };
  return { ok: true, body: { template, name, ...(typeof version === "string" && version ? { version } : {}), ...(typeof app === "string" ? { app } : {}), inputs: (inputs as Record<string, unknown> | undefined) ?? {} } };
}

/**
 * Check a request against the catalog's rows: the template is listed, the
 * version is one a request may name (the list holds only active, attested
 * template versions, so a yanked one is `not-active`), the name is a name,
 * and the inputs match the fields: none unknown, none sensitive, each of its
 * kind, every required one given. The fields are the newest version's, the
 * only ones the list prints; the run in CI checks an older version's own.
 */
export function checkRequest(rows: readonly TemplateRow[], body: RequestBody): { ok: true; row: TemplateRow; version: string } | { ok: false; refusal: Refusal } {
  const fail = (code: string, field: string, reason: string, more: { code: string; field: string; reason: string }[] = []): { ok: false; refusal: Refusal } => ({
    ok: false,
    refusal: refuse(422, code, reason, { field, refusals: [{ code, field, reason }, ...more] }),
  });
  if (!REQUEST_NAME.test(body.name)) return fail("bad-name", body.app !== undefined ? "name" : "app", `${body.app !== undefined ? "add-on" : "app"} ${JSON.stringify(body.name)} is not a name: a lowercase letter, then up to 39 lowercase letters, digits and -`);
  if (body.app !== undefined && !REQUEST_NAME.test(body.app)) return fail("bad-name", "app", `app ${JSON.stringify(body.app)} is not a name: a lowercase letter, then up to 39 lowercase letters, digits and -`);
  const want = body.template.replace(/\/+$/, "");
  const row = rows.find((r) => r.template === want || r.address === want || r.component === want);
  if (!row) return fail("unknown-version", "version", `the catalog lists no template ${JSON.stringify(want)} with a version a request may name`);
  const addon = body.app !== undefined;
  if (!addon && row.kind !== "app") return fail("wrong-kind", "template", `${row.template} is an add-on template; a request from the form makes an app, and an add-on names the app it goes into`);
  if (addon && row.kind !== "addon") return fail("wrong-kind", "template", `${row.template} is an app template; an add-on request names an add-on template`);
  const version = body.version ?? row.latest;
  if (!row.versions.some((v) => v.version === version)) {
    const offered = row.versions.map((v) => v.version).join(", ") || "none";
    return fail("not-active", "version", `version ${version} of ${row.template} is not one a request may name (it is yanked, deprecated, unattested or unknown); the catalog offers ${offered}`);
  }
  const refusals: { code: string; field: string; reason: string }[] = [];
  const byName = new Map(row.fields.map((f) => [f.name, f]));
  for (const [name, value] of Object.entries(body.inputs)) {
    const field = `inputs.${name}`;
    const f = byName.get(name);
    if (!f) refusals.push({ code: "unknown-input", field, reason: `${field}: ${row.template} ${version} has no input ${JSON.stringify(name)}` });
    else if (f.sensitive) refusals.push({ code: "sensitive-input", field, reason: `${field} is sensitive, and a request is written into a pull request; the app reads it from its secret store` });
    else if (f.required && f.kind === "string" && value === "") continue;
    // An add-on may take a value from the app's own module (`app.<output>`); terragucci's renderAddonCall checks the output exists.
    else if (addon && typeof value === "string" && APP_OUTPUT_REF.test(value)) continue;
    else {
      const p = kindProblem(f, value);
      if (p) refusals.push({ code: "input-type", field, reason: `${field} ${p}` });
    }
  }
  for (const f of row.fields) {
    if (f.sensitive || !f.required) continue;
    const v = body.inputs[f.name];
    if (v === undefined || v === null || v === "") refusals.push({ code: "missing-input", field: `inputs.${f.name}`, reason: `inputs.${f.name} (${f.label ?? f.name}) is required by ${row.template} ${version} and the request gives none` });
  }
  if (refusals.length) {
    const first = refusals[0]!;
    return { ok: false, refusal: refuse(422, first.code, first.reason, { field: first.field, refusals }) };
  }
  return { ok: true, row, version };
}

/** chant's template-request module (chant#4651), when the installed chant carries it. */
type ChantTemplateRequest = {
  makeTemplateRequest: (i: Record<string, unknown>) => unknown;
  validateTemplateRequest: (doc: unknown) => string[];
};

let chantModule: Promise<ChantTemplateRequest | undefined> | undefined;
/** The module, or undefined on a chant without it (the published 0.124.54). */
export function chantTemplateRequest(): Promise<ChantTemplateRequest | undefined> {
  const name = "@intentius/chant/template-request";
  chantModule ??= import(/* @vite-ignore */ name)
    .then((m: Record<string, unknown>) => (typeof m.makeTemplateRequest === "function" && typeof m.validateTemplateRequest === "function" ? (m as unknown as ChantTemplateRequest) : undefined))
    .catch(() => undefined);
  return chantModule;
}

/** The request's or upgrade's state, as `GET /api/templates/requests/:id` answers it. */
export interface RequestRecord {
  id: string;
  /** What was dispatched: an app, an add-on in `app`, or an upgrade of `app` to `version`. */
  kind: "app" | "addon" | "upgrade";
  /** The app an add-on goes into, or the app whose upgrade started the rollout. */
  app?: string;
  template: string;
  version: string;
  name: string;
  branch: string;
  forge: "github" | "forgejo";
  workflow: string;
  dispatchedAt: string;
  /** The person behold passed as `claimed_by`, when the workflow takes it. */
  claimedBy?: string;
  state: "dispatched" | "running" | "ended";
  run?: number;
  runUrl?: string;
  conclusion?: "success" | "failure" | "lost" | "unknown";
  pull_request?: number;
  url?: string;
  note?: string;
}

/** The single-job pipeline the dial paints for a dispatched run: the request workflow's `request` job, or the rollout's `rollout`. */
const onePipeline = (job: string): CiPipeline => ({ stages: [job], jobs: [{ jobName: job, component: job, stage: job, needs: [], script: [] }] });
const PIPELINES: Record<string, CiPipeline> = { [REQUEST_WORKFLOW]: onePipeline("request"), [ROLLOUT_WORKFLOW]: onePipeline("rollout") };

/** One shell word: as is when it is safe, else single-quoted. */
const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** The line a person runs on GitLab, where there is no request workflow. */
export function gitlabRequestLine(body: RequestBody): string {
  const q = shellWord;
  const inputs = Object.entries(body.inputs).map(([k, v]) => `--input ${q(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)}`);
  return ["npx terragucci request", q(body.template), "--name", q(body.name), ...(body.app !== undefined ? ["--app", q(body.app)] : []), ...(body.version ? ["--version", q(body.version)] : []), ...inputs].join(" ");
}

/** The line a person runs on GitLab to start an upgrade, where the rollout job has no dispatch inputs. */
export function gitlabRolloutLine(module: string, version: string): string {
  return ["npx terragucci rollout", shellWord(module), shellWord(version), "--mode apply"].join(" ");
}

/** What a dispatch sends and how it is followed: the workflow, its inputs, the branch whose pull request answers it, and its record. */
interface DispatchPlan {
  workflow: string;
  inputs: [string, string][];
  /** The runner's label, such as `terragucci request orders`. */
  label: string;
  /** The words after the workflow on the run's first line. */
  what: string;
  /** The branch whose pull request the run opens. */
  branch: string;
  rec: RequestRecord;
}

/**
 * Register `GET /api/templates`, `GET /api/templates/apps`,
 * `POST /api/templates/request`, `POST /api/templates/upgrade` and
 * `GET /api/templates/requests/:id`.
 */
export function templatesRoutes(app: Hono, deps: TemplatesDeps): void {
  const io = deps.io ?? {};
  const run = io.terragucci ?? defaultTerragucci;
  const gh = io.gh ?? defaultGhExec;
  const env = () => io.env ?? process.env;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = io.pollMs ?? 5000;
  const cache = new Map<string, { at: number; rows: TemplateRow[] }>();
  const appsCache = new Map<string, { at: number; rows: AppRow[] }>();
  const records = new Map<string, RequestRecord>();
  let seq = 0;

  /** The repo, or the refusal of a repo that offers no templates. */
  const repoOr = (what = "requesting an app from a template"): { ok: true; repo: TemplatesRepo } | { ok: false; refusal: Refusal } => {
    const dirs = deps.dirs();
    const repo = templatesRepo(dirs);
    if (repo?.templates) return { ok: true, repo };
    const guarded = servedProductRepo(dirs);
    if (guarded && guarded.product !== "terragucci") return { ok: false, refusal: { status: 409, body: productRefusal(guarded, what) } };
    return {
      ok: false,
      refusal: refuse(409, "no-templates", repo ? `${repo.config} sets no templates, so this repo offers no app from a template` : "the served project is not a terragucci repo, so it offers no app from a template", repo ? { remedy: "Add a templates block to terragucci.yml and run terragucci init, which writes the request workflow." } : {}),
    };
  };
  const send = (c: Context, r: Refusal) => c.json(r.body, r.status);

  /** The apps, from the last read when it is fresh, else read again. */
  const appsOf = async (repo: TemplatesRepo): Promise<{ ok: true; rows: AppRow[] } | { ok: false; res: (c: Context) => Response }> => {
    const got = appsCache.get(repo.root);
    if (got && Date.now() - got.at <= CATALOG_TTL_MS) return { ok: true, rows: got.rows };
    const read = await readApps(repo, run);
    if (!read.ok) return { ok: false, res: (c) => send(c, read.refusal) };
    if (read.exit !== 0 || !read.rows) return { ok: false, res: (c) => c.json({ error: "terragucci templates apps did not answer the apps", code: "terragucci-failed", printed: read.printed }, 502) };
    appsCache.set(repo.root, { at: Date.now(), rows: read.rows });
    return { ok: true, rows: read.rows };
  };

  /**
   * Dispatch `plan.workflow` and follow its run in the runner's slot: `gh
   * workflow run` on GitHub, the API with FORGEJO_TOKEN on Forgejo. Answers
   * the refusal when it could not dispatch, else undefined once the run is
   * on its way and `plan.rec` is listed.
   */
  const dispatch = async (c: Context, repo: TemplatesRepo, forge: "github" | "forgejo", plan: DispatchPlan): Promise<Response | undefined> => {
    if (deps.runner.running) return c.json({ error: `busy: ${deps.runner.running} is running`, code: "busy" }, 409);
    const { workflow, inputs, branch, rec } = plan;
    const pipeline = PIPELINES[workflow] ?? onePipeline("run");
    const changed = () => deps.broadcaster?.emit("template-request", rec.id);
    const end = (p: Pick<RequestRecord, "conclusion"> & Partial<RequestRecord>) => {
      Object.assign(rec, { ...p, state: "ended" });
      changed();
    };
    const say = (line: string) => deps.broadcaster?.emit("op", line);

    let follow: (io2: { line: (s: string) => void; progress: (s: never) => void }) => Promise<number>;
    if (forge === "github") {
      const ready = await ghReady(gh);
      if (!ready.ok) return c.json({ error: ready.reason, code: "gh" }, 422);
      const ghIn: GhExec = (args) => gh(args, { cwd: repo.root });
      const watermark = await latestRunId(workflow, ghIn);
      const d = await dispatchWorkflow(workflow, inputs, { cwd: repo.root, exec: gh });
      if (d.code !== 0) return c.json({ error: `gh workflow run ${workflow} failed: ${d.out.trim().split("\n")[0] ?? `exit ${d.code}`}`, code: "dispatch-failed" }, 502);
      follow = async (o) => {
        o.line(`▶ gh workflow run ${workflow} (${plan.what})`);
        let runId: number | undefined;
        const deadline = Date.now() + (io.appearTimeoutMs ?? 60_000);
        while (Date.now() < deadline) {
          await sleep(Math.min(pollMs, 3000));
          const got = await latestRunId(workflow, ghIn);
          if (got !== undefined && got !== watermark) {
            runId = got;
            break;
          }
        }
        if (runId === undefined) {
          end({ conclusion: "unknown", note: "dispatched, but the run never appeared in gh run list" });
          return 1;
        }
        Object.assign(rec, { run: runId, state: "running" });
        changed();
        const code = await followRun(runId, pipeline, {
          exec: ghIn,
          pollMs,
          sleep,
          ...(io.followTimeoutMs ? { followTimeoutMs: io.followTimeoutMs } : {}),
          onLine: o.line,
          onProgress: o.progress as never,
          onAdopted: ({ url }) => {
            if (url) rec.runUrl = url;
          },
        });
        const pr = await pullRequestOn(branch, { cwd: repo.root, exec: gh });
        end({ conclusion: code === 0 ? "success" : code === 75 ? "lost" : "failure", ...(pr ? { pull_request: pr.number, ...(pr.url ? { url: pr.url } : {}) } : {}) });
        return code;
      };
    } else {
      const token = env()[FORGEJO_TOKEN_ENV];
      if (!token) return c.json({ error: `${FORGEJO_TOKEN_ENV} is not set; behold dispatches a Forgejo workflow with the operator's token`, code: "forge-token", remedy: `Start behold with ${FORGEJO_TOKEN_ENV} set to a token that may dispatch workflows on this repo.` }, 422);
      const origin = originUrl(repo.root);
      const target = origin ? targetOfOrigin(origin, env()[FORGEJO_URL_ENV]) : undefined;
      if (!target) return c.json({ error: "the repo has no origin behold can read a Forgejo host, owner and repo from", code: "request-forge" }, 422);
      const fj = new ForgejoRepo(target, token, io.fetch);
      let runId: number | undefined;
      try {
        const ref = await fj.defaultBranch();
        runId = (await fj.dispatch(workflow, ref, Object.fromEntries(inputs))).run;
      } catch (e) {
        return c.json({ error: (e as Error).message, code: "dispatch-failed" }, 502);
      }
      if (runId !== undefined) rec.run = runId;
      follow = async (o) => {
        o.line(`▶ Forgejo dispatch of ${workflow} (${plan.what})`);
        const deadline = Date.now() + (io.followTimeoutMs ?? 6 * 60 * 60 * 1000);
        let conclusion: RequestRecord["conclusion"] = "unknown";
        if (runId !== undefined) {
          rec.state = "running";
          changed();
          for (;;) {
            const v = await fj.run(runId).catch(() => null);
            if (v === undefined) break; // this Forgejo has no run read: the pull request answers instead
            if (v?.url) rec.runUrl = v.url;
            if (v && FORGEJO_DONE.has(v.status)) {
              conclusion = v.status === "success" ? "success" : "failure";
              o.line(`■ run ${runId} ${v.status}`);
              break;
            }
            if (Date.now() >= deadline) {
              conclusion = "lost";
              break;
            }
            await sleep(pollMs);
          }
        }
        let pr: { number: number; url?: string } | undefined;
        for (;;) {
          pr = await fj.pullRequestOn(branch).catch(() => undefined);
          if (pr || conclusion !== "unknown" || Date.now() >= deadline) break;
          await sleep(pollMs);
        }
        if (pr && conclusion === "unknown") conclusion = "success";
        end({ conclusion, ...(pr ? { pull_request: pr.number, ...(pr.url ? { url: pr.url } : {}) } : {}) });
        return conclusion === "success" ? 0 : 1;
      };
    }

    records.set(rec.id, rec);
    changed();
    const tracked = deps.runner.track(plan.label, follow as never);
    if (!tracked) void follow({ line: say, progress: (() => {}) as never }).catch(() => end({ conclusion: "lost" }));
    return undefined;
  };
  const nextId = () => `${Date.now().toString(36)}-${++seq}`;

  app.get("/api/templates", async (c) => {
    const r = repoOr();
    if (!r.ok) return send(c, r.refusal);
    const read = await readCatalog(r.repo, run);
    if (!read.ok) return send(c, read.refusal);
    if (read.exit === 0 && read.rows) cache.set(r.repo.root, { at: Date.now(), rows: read.rows });
    return new Response(read.printed, { status: read.exit === 0 ? 200 : 422, headers: { "content-type": "application/json; charset=utf-8" } });
  });

  // behold#1036: the apps made from templates, as the graph frames them.
  app.get("/api/templates/apps", async (c) => {
    const r = repoOr();
    if (!r.ok) return send(c, r.refusal);
    const read = await readApps(r.repo, run);
    if (!read.ok) return send(c, read.refusal);
    if (read.exit === 0 && read.rows) appsCache.set(r.repo.root, { at: Date.now(), rows: read.rows });
    return new Response(read.printed, { status: read.exit === 0 ? 200 : 422, headers: { "content-type": "application/json; charset=utf-8" } });
  });

  app.get("/api/templates/requests/:id", (c) => {
    const rec = records.get(c.req.param("id"));
    return rec ? c.json(rec) : c.json({ error: `no request ${c.req.param("id")} was dispatched by this behold`, code: "unknown-request" }, 404);
  });

  app.post("/api/templates/request", async (c) => {
    if (deps.preview()) return c.json({ error: "requesting an app is disabled in preview mode", code: "preview" }, 403);
    const r = repoOr();
    if (!r.ok) return send(c, r.refusal);
    const repo = r.repo;
    const parsed = parseRequestBody(await c.req.json().catch(() => undefined));
    if (!parsed.ok) return send(c, parsed.refusal);
    const body = parsed.body;
    if (repo.forge === "gitlab") {
      const line = gitlabRequestLine(body);
      return c.json({ error: "a GitLab repo has no request workflow for behold to dispatch; run the request at your shell, where it opens the pull request with your token", code: "request-forge", command: line, remedy: `Run ${line}` }, 422);
    }
    if (!repo.forge) return c.json({ error: "behold cannot tell which forge this repo is on; set forge in terragucci.yml", code: "request-forge" }, 422);
    const forge = repo.forge;
    const declared = requestWorkflowInputs(repo.root, forge);
    if (!declared) {
      return c.json({ error: `${REQUEST_WORKFLOW_DIRS[forge]}/${REQUEST_WORKFLOW} is not committed, so there is no request workflow to dispatch`, code: "no-request-workflow", remedy: "Run terragucci init with templates set, and commit the workflow it writes." }, 409);
    }
    if (body.app !== undefined && !declared.includes("app")) {
      return c.json({ error: "the request workflow takes no app input: this terragucci makes apps from templates, not add-ons", code: "wrong-kind", field: "app" }, 422);
    }

    // The catalog: the tab's last read when it is fresh, so a request checks against what the form showed.
    let rows = cache.get(repo.root);
    if (!rows || Date.now() - rows.at > CATALOG_TTL_MS) {
      const read = await readCatalog(repo, run);
      if (!read.ok) return send(c, read.refusal);
      if (read.exit !== 0 || !read.rows) return c.json({ error: "terragucci templates list did not answer a catalog", code: "terragucci-failed", printed: read.printed }, 502);
      rows = { at: Date.now(), rows: read.rows };
      cache.set(repo.root, rows);
    }
    const check = checkRequest(rows.rows, body);
    if (!check.ok) return send(c, check.refusal);
    const { row, version } = check;

    // behold#1036: an add-on goes into an app the repo has (a root with `module "app"`), under a name it does not use yet.
    if (body.app !== undefined) {
      const apps = await appsOf(repo);
      if (!apps.ok) return apps.res(c);
      const target = apps.rows.find((a) => a.app === body.app);
      if (!target) {
        const known = apps.rows.map((a) => a.app).join(", ") || "none";
        return c.json({ error: `${body.app} is not an app: no root with a module "app" call is named so (the apps are ${known})`, code: "not-an-app", field: "app" }, 422);
      }
      if (body.name === "app" || target.addons.some((a) => a.name === body.name)) {
        return c.json({ error: `${body.app} already has a module named ${body.name}`, code: "addon-exists", field: "name" }, 422);
      }
    }
    const claimed = deps.claimed(c);
    const claim = declared.includes("claimed_by") && claimed ? claimed : undefined;
    const kind = body.app !== undefined ? "addon" : "app";

    // chant's template-request/v1, when the installed chant has it: the document the run will build.
    const chant = await chantTemplateRequest();
    if (chant) {
      const doc = chant.makeTemplateRequest({
        kind,
        template: row.template,
        version,
        app: body.app ?? body.name,
        ...(body.app !== undefined ? { addon: body.name } : {}),
        inputs: body.inputs,
        requestedBy: claimed ?? "behold",
        ...(claim ? { claimedBy: claim } : {}),
        via: "form",
      });
      const problems = chant.validateTemplateRequest(doc);
      if (problems.length) return c.json({ error: `the request ${problems[0]}`, code: "invalid", refusals: problems.map((p) => ({ code: "invalid", field: p.split(" ")[0] ?? "", reason: `the request ${p}` })) }, 422);
    }

    const inputs: [string, string][] = [
      ["template", row.template],
      ["version", version],
      ["name", body.name],
      ["inputs", JSON.stringify(body.inputs)],
      ...(body.app !== undefined ? ([["app", body.app]] as [string, string][]) : []),
      ...(claim ? ([["claimed_by", claim]] as [string, string][]) : []),
    ];
    const branch = requestBranch(row.template, body.name, body.app);
    const id = nextId();
    const rec: RequestRecord = {
      id,
      kind,
      ...(body.app !== undefined ? { app: body.app } : {}),
      template: row.template,
      version,
      name: body.name,
      branch,
      forge,
      workflow: REQUEST_WORKFLOW,
      dispatchedAt: new Date().toISOString(),
      ...(claim ? { claimedBy: claim } : {}),
      state: "dispatched",
    };
    const what = body.app !== undefined ? `${row.template} ${version} as ${body.name} in ${body.app}` : `${row.template} ${version} as ${body.name}`;
    const refused = await dispatch(c, repo, forge, { workflow: REQUEST_WORKFLOW, inputs, label: `terragucci request ${body.app !== undefined ? `${body.app}/` : ""}${body.name}`, what, branch, rec });
    if (refused) return refused;
    return c.json({ dispatched: true, id, workflow: REQUEST_WORKFLOW, forge, branch, template: row.template, version, name: body.name, ...(body.app !== undefined ? { app: body.app } : {}), ...(rec.run !== undefined ? { run: rec.run } : {}), ...(claim ? { claimedBy: claim } : {}) }, 202);
  });

  // behold#1036: a person starts an app's upgrade; terragucci's rollout carries it wave by wave (ruling D).
  app.post("/api/templates/upgrade", async (c) => {
    if (deps.preview()) return c.json({ error: "starting an upgrade is disabled in preview mode", code: "preview" }, 403);
    const r = repoOr("starting an upgrade");
    if (!r.ok) return send(c, r.refusal);
    const repo = r.repo;
    const raw = (await c.req.json().catch(() => undefined)) as unknown;
    if (!isRecord(raw) || typeof raw.app !== "string" || !raw.app) return c.json({ error: "the upgrade names no app", code: "invalid", field: "app" }, 422);
    if (raw.version !== undefined && typeof raw.version !== "string") return c.json({ error: "version is not a string", code: "invalid", field: "version" }, 422);
    const name = raw.app;
    const asked = typeof raw.version === "string" && raw.version ? raw.version : undefined;

    // What the apps read says now, never what the page last drew: the version comes from terragucci, not from the caller.
    appsCache.delete(repo.root);
    const apps = await appsOf(repo);
    if (!apps.ok) return apps.res(c);
    const target = apps.rows.find((a) => a.app === name);
    if (!target) return c.json({ error: `${name} is not an app: no root with a module "app" call is named so`, code: "not-an-app", field: "app" }, 422);
    const to = typeof target.upgrade === "string" && target.upgrade ? target.upgrade : undefined;
    if (!to) return c.json({ error: `${name} is on ${target.template} ${target.version ?? "an unpinned version"}, and the catalog offers no newer active version`, code: "no-upgrade", field: "app" }, 422);
    if (asked && asked !== to) return c.json({ error: `${name}'s upgrade is to ${to} now, not ${asked}; read the app again`, code: "stale-upgrade", field: "version", upgrade: to }, 409);

    if (repo.forge === "gitlab") {
      const line = gitlabRolloutLine(target.template, to);
      return c.json({ error: "a GitLab repo's rollout job takes no dispatch inputs; start the upgrade at your shell", code: "request-forge", command: line, remedy: `Run ${line}` }, 422);
    }
    if (!repo.forge) return c.json({ error: "behold cannot tell which forge this repo is on; set forge in terragucci.yml", code: "request-forge" }, 422);
    const forge = repo.forge;
    const declared = requestWorkflowInputs(repo.root, forge, ROLLOUT_WORKFLOW);
    if (!declared) {
      return c.json({ error: `${REQUEST_WORKFLOW_DIRS[forge]}/${ROLLOUT_WORKFLOW} is not committed, so there is no rollout workflow to dispatch`, code: "no-rollout-workflow", remedy: "Set rollouts (a schedule) in terragucci.yml, run terragucci init, and commit the workflow it writes." }, 409);
    }
    if (!declared.includes("module") || !declared.includes("version")) {
      return c.json({ error: `${ROLLOUT_WORKFLOW} takes no module and version inputs, so it cannot start one module's rollout`, code: "terragucci-too-old", remedy: "Move the repo to a terragucci release whose rollout workflow takes module and version, and run terragucci init." }, 409);
    }

    const inputs: [string, string][] = [
      ["module", target.template],
      ["version", to],
    ];
    const branch = rolloutBranch(target.template, to);
    const id = nextId();
    const rec: RequestRecord = { id, kind: "upgrade", app: name, template: target.template, version: to, name, branch, forge, workflow: ROLLOUT_WORKFLOW, dispatchedAt: new Date().toISOString(), state: "dispatched" };
    const refused = await dispatch(c, repo, forge, { workflow: ROLLOUT_WORKFLOW, inputs, label: `terragucci rollout ${target.template} ${to}`, what: `${target.template} to ${to}, from ${name}`, branch, rec });
    if (refused) return refused;
    return c.json({ dispatched: true, id, workflow: ROLLOUT_WORKFLOW, forge, branch, app: name, template: target.template, from: target.version, version: to, ...(rec.run !== undefined ? { run: rec.run } : {}) }, 202);
  });
}
