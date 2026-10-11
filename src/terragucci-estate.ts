/**
 * A terragucci control repo, across its projects (#509).
 *
 * A control repo lists its projects under `projects:` in terragucci.yml and
 * holds no Terraform root of its own, so `behold serve <control repo>
 * --terragucci <src>` has no card to put a mark on. What it can show is the
 * estate: one box per project, that project's roots by wave inside it, the
 * reads between projects, and terragucci's counts and waiting waves on each.
 *
 * `GET /api/terragucci/estate` reads, one GET each and no list call:
 *
 * - `estate.json` at the top of the source: every project's counts and
 *   waiting waves, as terragucci's estate page shows them (dated by its
 *   `generated`);
 * - each project's run view of its newest applied commit,
 *   `<project>/runs/<commit>/run.json` (terragucci.run/v1): its roots by wave,
 *   each root's own state and its reads of states outside the project, which
 *   match another project's roots into edges between projects the way
 *   terragucci's own estate graph does (report/estate.ts `estateGraph`).
 *
 * The commit is the estate's `run_view.commit` when it names one, else its
 * `apply.commit` (the newest commit that ran tf-apply). A project whose run
 * view is absent stays in the answer with `run: {missing}`; one whose run view
 * is malformed carries the refusal (`code: "terragucci-report"`) in its place,
 * and the other projects still draw.
 *
 * Read-only, like the rest of the terragucci view: the approve lines are for
 * a person's shell, and there is no route here that is not a GET.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Hono } from "hono";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { servedTerragucciConfig } from "./terragucci-repo.ts";
import { terragucciValidator, TerragucciReadError, type TerragucciRefusal, type Validation, type Validator } from "./terragucci-reports.ts";
import { terragucciSource, type TerragucciSource } from "./terragucci-source.ts";
import { checkoutProject, checkoutRoots, repoBase, TERRAGUCCI_READ_TTL_MS, type TerragucciOptions } from "./terragucci-view.ts";

export const RUN_SCHEMA = "terragucci.run/v1";

// ---------------------------------------------------------------------------
// Is the served directory a control repo?
// ---------------------------------------------------------------------------

export interface ControlRepo {
  /** The terragucci config that lists the projects. */
  config: string;
  /** The `projects:` keys, `<host>/<path>`, in the file's order. Empty for a terragucci.ts whose keys behold does not fold. */
  projects: string[];
}

/**
 * The `projects:` keys of a terragucci config, or undefined when it has none.
 * YAML and JSON are parsed; a terragucci.ts is read for a `projects:` key by
 * regex, since behold runs no config code (terragucci folds it without running
 * it, which behold does not reimplement).
 */
export function configProjects(file: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (extname(file) === ".ts") return /(^|[\s,{])projects\s*:\s*\{/.test(text) ? [] : undefined;
  let doc: unknown;
  try {
    doc = parseYAMLDocument(text);
  } catch {
    return undefined;
  }
  const projects = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>).projects : undefined;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return undefined;
  return Object.keys(projects);
}

/**
 * The control repo the served directories are, or undefined: a terragucci
 * config with `projects:` governs them, and the checkout declares no
 * Terraform root of its own (a repo with both is served as a repo, its roots
 * marked from its own project's reports).
 */
export function controlRepo(dirs: readonly string[], roots: () => number = () => checkoutRoots(dirs).length): ControlRepo | undefined {
  const config = servedTerragucciConfig(dirs);
  if (!config) return undefined;
  const projects = configProjects(config);
  if (!projects) return undefined;
  let n: number;
  try {
    n = roots();
  } catch {
    n = 0;
  }
  return n === 0 ? { config, projects } : undefined;
}

// ---------------------------------------------------------------------------
// The documents, as far as this view reads them.
// ---------------------------------------------------------------------------

export interface RunState {
  bucket?: string;
  key: string;
}

export interface RunRoot {
  root: string;
  wave: number;
  reads: string[];
  state?: RunState;
  external?: (RunState & { data: string })[];
}

export interface RunWave {
  number: number;
  roots: string[];
  reads: number[];
  state: string;
  gate: string;
  policy?: string;
  approval?: string;
  digest?: string | null;
  command?: string;
  report?: string;
  updated?: string;
}

export interface RunView {
  schema: string;
  project: string;
  commit: string;
  updated: string;
  roots: RunRoot[];
  waves: RunWave[];
}

interface EstateProjectDoc {
  project: string;
  status: string;
  error?: string;
  index?: string;
  drifted: number;
  failed: number;
  waiting: { project: string; wave: number; commit: string; since: string; age_seconds: number; report?: string }[];
  apply?: { commit: string };
  run_view?: { commit: string; updated: string; page?: string };
}

interface EstateDoc {
  schema: string;
  generated: string;
  projects: EstateProjectDoc[];
}

// ---------------------------------------------------------------------------
// Checking a run view: terragucci's run.schema.json when the package
// resolves, as terragucciValidator does for the other three documents, and a
// structural check of the fields read here otherwise.
// ---------------------------------------------------------------------------

export interface RunValidator {
  validation: Validation;
  check(doc: unknown): string | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export function structuralRun(doc: unknown): string | undefined {
  if (!isRecord(doc)) return "it is not a JSON object";
  if (doc.schema !== RUN_SCHEMA) return `its schema is ${JSON.stringify(doc.schema)}, not ${RUN_SCHEMA}`;
  if (!str(doc.project) || !str(doc.commit) || !str(doc.updated)) return "it lacks project, commit or updated";
  if (!Array.isArray(doc.roots) || !Array.isArray(doc.waves)) return "it has no roots or waves array";
  for (const [i, r] of doc.roots.entries()) {
    if (!isRecord(r) || !str(r.root) || !int(r.wave) || !Array.isArray(r.reads) || !r.reads.every(str)) return `root ${i} lacks root, wave or reads`;
    if (r.state !== undefined && !(isRecord(r.state) && str(r.state.key))) return `root ${String(r.root)}'s state has no key`;
    if (r.external !== undefined && !(Array.isArray(r.external) && r.external.every((x) => isRecord(x) && str(x.data) && str(x.key)))) return `root ${String(r.root)}'s external reads lack data or key`;
  }
  for (const [i, w] of doc.waves.entries()) {
    if (!isRecord(w) || !int(w.number) || !Array.isArray(w.roots) || !Array.isArray(w.reads) || !str(w.state) || !str(w.gate)) return `wave ${i} lacks number, roots, reads, state or gate`;
  }
  return undefined;
}

const compiledRun = new Map<string, RunValidator>();

/**
 * The run view's validator for documents read for the project at `dirs[0]`:
 * `@intentius/terragucci`'s `dist/run.schema.json` when the package resolves
 * from one of `dirs` or from behold and ships it, otherwise the structural
 * check. Cached by the schema's path and mtime, so an upgrade under a running
 * serve is picked up on the next read.
 */
export function runViewValidator(dirs: readonly string[] = []): RunValidator {
  for (const from of [...dirs, dirname(fileURLToPath(import.meta.url))]) {
    let entry: string;
    try {
      entry = createRequire(join(resolve(from), "noop.js")).resolve("@intentius/terragucci/report.schema.json");
    } catch {
      continue;
    }
    const dist = dirname(entry);
    const schema = join(dist, "run.schema.json");
    let stamp: string;
    try {
      const st = statSync(schema);
      const pkg = statSync(join(dist, "..", "package.json"));
      stamp = `${schema}\u0000${st.mtimeMs}:${st.size}\u0000${pkg.mtimeMs}`;
    } catch {
      continue; // a terragucci without the run schema: the structural check still runs
    }
    const hit = compiledRun.get(stamp);
    if (hit) return hit;
    let v: RunValidator;
    try {
      const version = (JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")) as { version?: string }).version ?? "";
      const validate = new Ajv2020({ strict: false, allErrors: false }).compile(JSON.parse(readFileSync(schema, "utf8")) as object);
      v = {
        validation: { by: "schema", terragucci: version },
        check(doc) {
          const id = isRecord(doc) ? doc.schema : undefined;
          if (id !== RUN_SCHEMA) return `its schema is ${JSON.stringify(id)}, not ${RUN_SCHEMA}`;
          if (validate(doc)) return undefined;
          const e = validate.errors?.[0];
          return `run.schema.json rejects it: ${e?.instancePath || "/"} ${e?.message ?? "is invalid"}`;
        },
      };
    } catch {
      continue;
    }
    for (const k of compiledRun.keys()) if (k.startsWith(`${schema}\u0000`)) compiledRun.delete(k);
    compiledRun.set(stamp, v);
    return v;
  }
  return { validation: { by: "structural" }, check: structuralRun };
}

// ---------------------------------------------------------------------------
// The answer.
// ---------------------------------------------------------------------------

/** Where a figure came from and how old it is. */
export interface Dated {
  /** The key it was read from under the source. */
  key: string;
  /** When terragucci wrote what it says: estate.json's `generated`, or a run view's `updated`. */
  at: string;
}

export interface EstateWave {
  wave: number;
  commit: string;
  since: string;
  /** Seconds it had waited when estate.json was generated. */
  age_seconds: number;
  /** The wave's report.html, as a key under the source. */
  report?: string;
  /** The set digest, from the run view when it holds this wave of this commit. */
  digest?: string | null;
  /** The line a person runs at their shell, in the project's own checkout. behold never runs it. */
  command: string;
  dated: Dated;
}

export interface ProjectRun {
  commit: string;
  updated: string;
  /** Which estate.json field named the commit: its `run_view`, or its newest `apply`. */
  from: "run_view" | "apply";
  /** run.json and run.html, as keys under the source. */
  key: string;
  page: string;
  roots: RunRoot[];
  waves: Omit<RunWave, "report">[];
  dated: Dated;
}

export interface ControlProject {
  project: string;
  /** estate.json's status for it, or `not-in-estate` for a project only the config lists. */
  status: string;
  error?: string;
  /** Its index.html, as a key under the source. */
  index?: string;
  counts?: { drifted: number; failed: number; waiting: number; dated: Dated };
  waiting: EstateWave[];
  /** Its run view, or why there is none to draw. Exactly one of the three. */
  run?: ProjectRun;
  missing?: string;
  refused?: TerragucciRefusal;
  /** Its repo, checked out beside the control repo: where, and how to serve it. */
  checkout?: { path: string; command: string };
  /** Whether terragucci.yml lists it. */
  configured: boolean;
}

export interface GraphEdge {
  from: { project: string; root: string };
  to: { project: string; root: string };
}

export interface ControlEstate {
  source: string;
  kind: TerragucciSource["kind"];
  config: string;
  /** How estate.json and each run view were checked. */
  validation: { estate: Validation; run: Validation };
  /** When behold read it. Every figure's age is its own `dated.at`, not this. */
  read: string;
  /** estate.json's `generated`, and the page it belongs to. */
  estate: { key: "estate.json"; html: "estate.html"; generated: string };
  /** How many objects were read, one GET each. */
  gets: number;
  projects: ControlProject[];
  /** Every read between roots: within a project (`to` reads `from`'s state), and across projects (`cross`). */
  edges: (GraphEdge & { cross: boolean })[];
  files: string;
}

export interface ControlReadOptions {
  validator?: Validator;
  runValidator?: RunValidator;
  /** The `projects:` keys of the control repo's config. */
  configured?: readonly string[];
  /** The directory the control repo is checked out in: its siblings are where a project's checkout is looked for. */
  base?: string;
  /** The project a directory's git remote names. Injected by a test. */
  projectOf?: (dir: string) => string | undefined;
  now?: Date;
}

const refusal = (error: string, remedy: string): TerragucciRefusal => ({ error, code: "terragucci-report", remedy });
const refuse = (error: string, remedy: string): never => {
  throw new TerragucciReadError(refusal(error, remedy));
};

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, "");

/** run.json's key for a project's commit: the page estate.json links when it is a key under the source, else `<project>/runs/<commit>/run.json`. */
export function runKey(p: { project: string; run_view?: { commit: string; page?: string } }, commit: string): string {
  const page = p.run_view?.commit === commit ? p.run_view.page : undefined;
  if (page && !/^[a-z]+:\/\//i.test(page) && !page.startsWith("/") && !page.split("/").includes("..") && page.endsWith("/run.html")) {
    return `${trimSlashes(page.slice(0, -"run.html".length))}/run.json`;
  }
  return [trimSlashes(p.project), "runs", commit, "run.json"].join("/");
}

const sameState = (a: RunState, b: RunState): boolean => a.key === b.key && (!a.bucket || !b.bucket || a.bucket === b.bucket);

/** terragucci's estate graph over the run views read: each project's own reads, and a root's read of a state outside its project matched to the root of another that holds it. */
export function controlEdges(views: readonly RunView[]): ControlEstate["edges"] {
  const edges: ControlEstate["edges"] = [];
  const has = (f: GraphEdge["from"], t: GraphEdge["to"]): boolean => edges.some((e) => e.from.project === f.project && e.from.root === f.root && e.to.project === t.project && e.to.root === t.root);
  for (const v of views) for (const r of v.roots) for (const u of r.reads) edges.push({ from: { project: v.project, root: u }, to: { project: v.project, root: r.root }, cross: false });
  const held = views.flatMap((v) => v.roots.filter((r) => r.state).map((r) => ({ project: v.project, root: r.root, state: r.state! })));
  for (const v of views) {
    for (const r of v.roots) {
      for (const x of r.external ?? []) {
        for (const h of held) {
          if (h.project === v.project || !sameState(h.state, x)) continue;
          const from = { project: h.project, root: h.root };
          const to = { project: v.project, root: r.root };
          if (!has(from, to)) edges.push({ from, to, cross: true });
        }
      }
    }
  }
  return edges;
}

/** A project's repo checked out beside the control repo: `<parent>/<last segment>` whose git remote names the project. */
export function siblingCheckout(project: string, base: string, projectOf: (dir: string) => string | undefined = checkoutProject): string | undefined {
  const name = project.split("/").filter(Boolean).pop();
  if (!name) return undefined;
  const dir = join(dirname(resolve(base)), name);
  if (dir === resolve(base) || !existsSync(join(dir, ".git"))) return undefined;
  return projectOf(dir) === project ? dir : undefined;
}

const shellWord = (s: string): string => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Read a control repo's estate from `source`. Throws {@link TerragucciReadError} when estate.json is absent or malformed; a run view's problem stays on its project. */
export async function readControlEstate(source: TerragucciSource, config: string, opts: ControlReadOptions = {}): Promise<ControlEstate> {
  const v = opts.validator ?? terragucciValidator();
  const rv = opts.runValidator ?? runViewValidator();
  let gets = 0;
  const get = async (key: string): Promise<string | undefined> => {
    gets++;
    return source.read(key);
  };

  let text: string | undefined;
  try {
    text = await get("estate.json");
  } catch (e) {
    refuse(`Could not read estate.json from ${source.location}: ${e instanceof Error ? e.message : String(e)}`, "Check the source is the top of terragucci's reports prefix and that GetObject on estate.json is allowed.");
  }
  if (text === undefined) {
    refuse(
      `${source.location} has no estate.json, so a control repo's projects have nothing to be drawn from.`,
      "Point --terragucci at the top of the reports prefix, where `terragucci estate` writes estate.json, or run `terragucci estate` once.",
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text!);
  } catch {
    refuse(`estate.json in ${source.location} is not JSON.`, "Point --terragucci at the top of terragucci's reports prefix.");
  }
  const why = v.check("estate", doc);
  if (why) {
    refuse(
      `estate.json in ${source.location} is not a terragucci terragucci.estate/v1 document: ${why}.`,
      v.validation.by === "schema"
        ? `It was checked against @intentius/terragucci ${v.validation.terragucci}'s estate.schema.json. Check that this terragucci wrote it, or upgrade behold.`
        : "Install @intentius/terragucci beside behold to check it against terragucci's own JSON Schemas, and check that terragucci wrote it.",
    );
  }
  const estate = doc as EstateDoc;
  const estateDated: Dated = { key: "estate.json", at: estate.generated };

  const views: RunView[] = [];
  const projects: ControlProject[] = [];
  const configured = new Set(opts.configured ?? []);
  for (const p of estate.projects) {
    const commit = p.run_view?.commit ?? p.apply?.commit;
    let run: ProjectRun | undefined;
    let missing: string | undefined;
    let refused: TerragucciRefusal | undefined;
    if (!commit) {
      missing = p.status === "ok" ? "no apply has run, so there is no run view" : p.status === "no-index" ? "no runs in the bucket yet" : `its index could not be read${p.error ? `: ${p.error}` : ""}`;
    } else {
      const key = runKey(p, commit);
      let body: string | undefined;
      try {
        body = await get(key);
      } catch (e) {
        refused = refusal(`Could not read ${key} from ${source.location}: ${e instanceof Error ? e.message : String(e)}`, "Check GetObject on <prefix>/*/runs/*/run.json is allowed.");
      }
      if (!refused && body === undefined) missing = `no run view at ${key}`;
      if (!refused && body !== undefined) {
        let parsed: unknown;
        let problem: string | undefined;
        try {
          parsed = JSON.parse(body);
          problem = rv.check(parsed);
        } catch {
          problem = "it is not JSON";
        }
        if (!problem && (parsed as RunView).project !== p.project) problem = `it is ${JSON.stringify((parsed as RunView).project)}'s run view, not ${p.project}'s`;
        if (!problem && (parsed as RunView).commit !== commit) problem = `it is the run view of ${(parsed as RunView).commit}, not ${commit}`;
        if (problem) {
          refused = refusal(
            `${key} in ${source.location} is not a terragucci ${RUN_SCHEMA} document: ${problem}.`,
            rv.validation.by === "schema"
              ? `It was checked against @intentius/terragucci ${rv.validation.terragucci}'s run.schema.json. Check that this terragucci wrote it, or upgrade behold.`
              : "Install @intentius/terragucci beside behold to check it against terragucci's own run.schema.json, and check that terragucci wrote it.",
          );
        } else {
          const view = parsed as RunView;
          views.push(view);
          run = {
            commit,
            updated: view.updated,
            from: p.run_view?.commit === commit ? "run_view" : "apply",
            key,
            page: key.replace(/run\.json$/, "run.html"),
            roots: view.roots.map((r) => ({
              root: r.root,
              wave: r.wave,
              reads: r.reads,
              ...(r.state ? { state: r.state } : {}),
              ...(r.external?.length ? { external: r.external } : {}),
            })),
            waves: view.waves.map((w) => ({
              number: w.number,
              roots: w.roots,
              reads: w.reads,
              state: w.state,
              gate: w.gate,
              ...(w.policy ? { policy: w.policy } : {}),
              ...(w.approval ? { approval: w.approval } : {}),
              ...(w.digest !== undefined ? { digest: w.digest } : {}),
              ...(w.command ? { command: w.command } : {}),
              ...(w.updated ? { updated: w.updated } : {}),
            })),
            dated: { key, at: view.updated },
          };
        }
      }
    }
    const waiting = p.waiting.map((w): EstateWave => {
      const fromRun = run && run.commit === w.commit ? run.waves.find((x) => x.number === w.wave) : undefined;
      const digest = fromRun?.digest;
      return {
        wave: w.wave,
        commit: w.commit,
        since: w.since,
        age_seconds: w.age_seconds,
        ...(w.report ? { report: w.report } : {}),
        ...(digest !== undefined ? { digest } : {}),
        command: fromRun?.command ?? `npx terragucci approve wave-${w.wave}${digest ? ` --plan ${digest}` : " --plan <digest>"}`,
        dated: estateDated,
      };
    });
    const at = opts.base ? siblingCheckout(p.project, opts.base, opts.projectOf) : undefined;
    projects.push({
      project: p.project,
      status: p.status,
      ...(p.error ? { error: p.error } : {}),
      ...(p.index ? { index: p.index } : {}),
      counts: { drifted: p.drifted, failed: p.failed, waiting: p.waiting.length, dated: estateDated },
      waiting,
      ...(run ? { run } : {}),
      ...(missing ? { missing } : {}),
      ...(refused ? { refused } : {}),
      ...(at ? { checkout: { path: at, command: `behold serve ${shellWord(at)} --terragucci ${shellWord(source.location)}` } } : {}),
      configured: configured.has(p.project),
    });
  }
  // A project the config lists and estate.json does not: listed, never dropped.
  for (const name of opts.configured ?? []) {
    if (projects.some((p) => p.project === name)) continue;
    const at = opts.base ? siblingCheckout(name, opts.base, opts.projectOf) : undefined;
    projects.push({
      project: name,
      status: "not-in-estate",
      waiting: [],
      missing: `estate.json (generated ${estate.generated}) does not list it`,
      ...(at ? { checkout: { path: at, command: `behold serve ${shellWord(at)} --terragucci ${shellWord(source.location)}` } } : {}),
      configured: true,
    });
  }

  return {
    source: source.location,
    kind: source.kind,
    config,
    validation: { estate: v.validation, run: rv.validation },
    read: (opts.now ?? new Date()).toISOString(),
    estate: { key: "estate.json", html: "estate.html", generated: estate.generated },
    gets,
    projects,
    edges: controlEdges(views),
    files: "/api/terragucci/file?key=",
  };
}

// ---------------------------------------------------------------------------
// The route.
// ---------------------------------------------------------------------------

/** Register `GET /api/terragucci/estate`. `dirs()` is asked per request, since a project switch changes what is served. */
export function terragucciEstateRoutes(app: Hono, opts: TerragucciOptions, dirs: () => string[]): void {
  const source = terragucciSource(opts.source, { ...(opts.aws ? { aws: opts.aws } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  let cached: { at: number; key: string; read: Promise<ControlEstate> } | undefined;

  app.get("/api/terragucci/estate", async (c) => {
    const served = dirs();
    const control = controlRepo(served);
    if (!control) {
      return c.json(
        {
          error: "This is not a terragucci control repo: its terragucci config lists no `projects:`, or the checkout has Terraform roots of its own.",
          code: "terragucci-not-control",
          remedy: "GET /api/terragucci answers a repo's own roots; this route answers a control repo, the one whose terragucci.yml lists `projects:`.",
        },
        404,
      );
    }
    const key = served.join("\u0000");
    const now = Date.now();
    const fresh = new URL(c.req.url).searchParams.get("fresh") === "1";
    if (fresh || !cached || cached.key !== key || now - cached.at >= TERRAGUCCI_READ_TTL_MS) {
      const base = repoBase(served);
      const p = readControlEstate(source, control.config, {
        validator: terragucciValidator(served),
        runValidator: runViewValidator(served),
        configured: control.projects,
        base,
        ...(opts.now ? { now: opts.now() } : {}),
      });
      cached = { at: now, key, read: p };
      p.catch(() => (cached = undefined));
    }
    try {
      return c.json(await cached!.read);
    } catch (e) {
      if (e instanceof TerragucciReadError) return c.json(e.refusal, 422);
      throw e;
    }
  });
}

/** For `/api/project`: the control repo the served directories are, when serve has `--terragucci`. */
export function controlRepoInfo(dirs: readonly string[]): { config: string; projects: string[] } | undefined {
  const c = controlRepo(dirs);
  return c ? { config: c.config, projects: c.projects } : undefined;
}
