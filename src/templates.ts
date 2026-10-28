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

/** The dispatch inputs a committed request workflow declares, or undefined when the file is not there. */
export function requestWorkflowInputs(root: string, forge: "github" | "forgejo"): string[] | undefined {
  const file = join(root, REQUEST_WORKFLOW_DIRS[forge], REQUEST_WORKFLOW);
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

/** The request's branch, as chant's `requestBranch` names it. */
export function requestBranch(template: string, name: string): string {
  const parts = template.split("/").filter(Boolean);
  const short = (parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1]) ?? template;
  return `request/${short}/${name}`;
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
  if (!REQUEST_NAME.test(body.name)) return fail("bad-name", "app", `app ${JSON.stringify(body.name)} is not a name: a lowercase letter, then up to 39 lowercase letters, digits and -`);
  const want = body.template.replace(/\/+$/, "");
  const row = rows.find((r) => r.template === want || r.address === want || r.component === want);
  if (!row) return fail("unknown-version", "version", `the catalog lists no template ${JSON.stringify(want)} with a version a request may name`);
  if (row.kind !== "app") return fail("wrong-kind", "template", `${row.template} is an add-on template; a request from the form makes an app`);
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

/** The request's state, as `GET /api/templates/requests/:id` answers it. */
export interface RequestRecord {
  id: string;
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

/** The single-job pipeline the dial paints for a request run. */
const REQUEST_PIPELINE: CiPipeline = { stages: ["request"], jobs: [{ jobName: "request", component: "request", stage: "request", needs: [], script: [] }] };

/** The line a person runs on GitLab, where there is no request workflow. */
export function gitlabRequestLine(body: RequestBody): string {
  const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  const inputs = Object.entries(body.inputs).map(([k, v]) => `--input ${q(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)}`);
  return ["npx terragucci request", q(body.template), "--name", q(body.name), ...(body.version ? ["--version", q(body.version)] : []), ...inputs].join(" ");
}

/** Register `GET /api/templates`, `POST /api/templates/request` and `GET /api/templates/requests/:id`. */
export function templatesRoutes(app: Hono, deps: TemplatesDeps): void {
  const io = deps.io ?? {};
  const run = io.terragucci ?? defaultTerragucci;
  const gh = io.gh ?? defaultGhExec;
  const env = () => io.env ?? process.env;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = io.pollMs ?? 5000;
  const cache = new Map<string, { at: number; rows: TemplateRow[] }>();
  const records = new Map<string, RequestRecord>();
  let seq = 0;

  /** The repo, or the refusal of a repo that offers no templates. */
  const repoOr = (): { ok: true; repo: TemplatesRepo } | { ok: false; refusal: Refusal } => {
    const dirs = deps.dirs();
    const repo = templatesRepo(dirs);
    if (repo?.templates) return { ok: true, repo };
    const guarded = servedProductRepo(dirs);
    if (guarded && guarded.product !== "terragucci") return { ok: false, refusal: { status: 409, body: productRefusal(guarded, "requesting an app from a template") } };
    return {
      ok: false,
      refusal: refuse(409, "no-templates", repo ? `${repo.config} sets no templates, so this repo offers no app from a template` : "the served project is not a terragucci repo, so it offers no app from a template", repo ? { remedy: "Add a templates block to terragucci.yml and run terragucci init, which writes the request workflow." } : {}),
    };
  };
  const send = (c: Context, r: Refusal) => c.json(r.body, r.status);

  app.get("/api/templates", async (c) => {
    const r = repoOr();
    if (!r.ok) return send(c, r.refusal);
    const read = await readCatalog(r.repo, run);
    if (!read.ok) return send(c, read.refusal);
    if (read.exit === 0 && read.rows) cache.set(r.repo.root, { at: Date.now(), rows: read.rows });
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
    const claimed = deps.claimed(c);
    const claim = declared.includes("claimed_by") && claimed ? claimed : undefined;

    // chant's template-request/v1, when the installed chant has it: the document the run will build.
    const chant = await chantTemplateRequest();
    if (chant) {
      const doc = chant.makeTemplateRequest({ kind: "app", template: row.template, version, app: body.name, inputs: body.inputs, requestedBy: claimed ?? "behold", ...(claim ? { claimedBy: claim } : {}), via: "form" });
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
    if (deps.runner.running) return c.json({ error: `busy: ${deps.runner.running} is running`, code: "busy" }, 409);

    const branch = requestBranch(row.template, body.name);
    const id = `${Date.now().toString(36)}-${++seq}`;
    const rec: RequestRecord = { id, template: row.template, version, name: body.name, branch, forge, workflow: REQUEST_WORKFLOW, dispatchedAt: new Date().toISOString(), ...(claim ? { claimedBy: claim } : {}), state: "dispatched" };
    const changed = () => deps.broadcaster?.emit("template-request", id);
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
      const watermark = await latestRunId(REQUEST_WORKFLOW, ghIn);
      const d = await dispatchWorkflow(REQUEST_WORKFLOW, inputs, { cwd: repo.root, exec: gh });
      if (d.code !== 0) return c.json({ error: `gh workflow run ${REQUEST_WORKFLOW} failed: ${d.out.trim().split("\n")[0] ?? `exit ${d.code}`}`, code: "dispatch-failed" }, 502);
      follow = async (o) => {
        o.line(`▶ gh workflow run ${REQUEST_WORKFLOW} (${row.template} ${version} as ${body.name})`);
        let runId: number | undefined;
        const deadline = Date.now() + (io.appearTimeoutMs ?? 60_000);
        while (Date.now() < deadline) {
          await sleep(Math.min(pollMs, 3000));
          const got = await latestRunId(REQUEST_WORKFLOW, ghIn);
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
        const code = await followRun(runId, REQUEST_PIPELINE, {
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
        runId = (await fj.dispatch(REQUEST_WORKFLOW, ref, Object.fromEntries(inputs))).run;
      } catch (e) {
        return c.json({ error: (e as Error).message, code: "dispatch-failed" }, 502);
      }
      if (runId !== undefined) rec.run = runId;
      follow = async (o) => {
        o.line(`▶ Forgejo dispatch of ${REQUEST_WORKFLOW} (${row.template} ${version} as ${body.name})`);
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

    records.set(id, rec);
    changed();
    const label = `terragucci request ${body.name}`;
    const tracked = deps.runner.track(label, follow as never);
    if (!tracked) void follow({ line: say, progress: (() => {}) as never }).catch(() => end({ conclusion: "lost" }));
    return c.json({ dispatched: true, id, workflow: REQUEST_WORKFLOW, forge, branch, template: row.template, version, name: body.name, ...(rec.run !== undefined ? { run: rec.run } : {}), ...(claim ? { claimedBy: claim } : {}) }, 202);
  });
}
