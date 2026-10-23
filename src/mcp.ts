/**
 * behold#916: `behold mcp`, a stdio MCP server for a coding agent that draws
 * what it found in the person's open behold tab.
 *
 * chant answers, behold draws (the read-contract ruling on behold#908): an
 * agent can ask its estate questions through chant's own MCP tool
 * `workspace-search` (INTENTIUS/chant#4374), and this server keeps the two
 * tools that draw, plus `ask` and `capabilities`, which hand back chant's
 * answer and chant's catalog as they are:
 *
 * - `ask` returns chant's read-contract `search` document verbatim, with
 *   `link` (the view that draws it) and `drawn: false` added, through the
 *   serve's `GET /api/search` (#913), or, with no serve running, through
 *   behold's app started in this process for the one request;
 * - `show` moves the person's open tab to a view, through the serve's
 *   `POST /api/view` (#914);
 * - `shot` returns a PNG of a view and its link, through the serve's
 *   `GET /api/shot` (#915), or, with no serve running, through a behold view
 *   started in this process for the length of the shot (src/shot-cli.ts);
 * - `capabilities` (#926) returns chant's capability catalog, the read
 *   contract's `capabilities` document (INTENTIUS/chant#4375), verbatim,
 *   through the serve's `GET /api/capabilities`, or, with no serve, through
 *   behold's app started in this process for the one request. An agent reads
 *   it before it asks a `cap:` question.
 *
 * It is a thin client of a running serve's HTTP API: it holds no copy of the
 * query, view or shot logic, and a test fails if it imports any. It finds the
 * serve through `--url` or `--port`, then through the per-user registry each
 * serve writes under the OS temp directory (src/serve-registry.ts), then at
 * http://127.0.0.1:4600. Before a tool uses a serve, it reads the serve's
 * `GET /api/project` and checks that it serves this project.
 *
 * Shaped like `terragucci mcp`: an explicit tool list, every argument listed
 * (`additionalProperties: false`) and checked, credential-named arguments
 * refused, annotations on every tool, JSON text results, `isError` for a
 * refusal, and a guard at start that refuses any tool whose name says it
 * would deploy, apply, approve, run an Op, roll back or write. Nothing here
 * changes infrastructure or the project: `show` moves a tab, which writes
 * nothing, and `shot` writes no file.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findServe, realDir, within } from "./serve-registry.ts";
import { DEFAULT_LINK_BASE, localCapabilities, localSearch, shotFromArgs } from "./shot-cli.ts";
import type { ShotRefusalBody, ShotRequest, ShotResult } from "./shot.ts";

/** The serve `behold serve` starts when no port is given. */
export const DEFAULT_SERVE_URL = "http://127.0.0.1:4600";

/** The command a person runs to start behold for `dir`. */
export const serveCommand = (dir: string): string => `npx @intentius/behold serve ${dir}`;

type Prop =
  | { type: "string"; description: string; enum?: string[] }
  | { type: "integer"; description: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description: string };

/** A tool's input: JSON Schema, every property listed, nothing else accepted. */
export interface InputSchema {
  type: "object";
  properties: Record<string, Prop>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: InputSchema;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>, ctx: Context): Promise<CallToolResult>;
}

/** A refusal: the tool answers with an error result, and the server goes on. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Words that say a tool would change something. behold does these only from
 * its panel or a shell, with a person there, never over MCP. A tool's name
 * may not hold one as a word (`deploy_stack`, `opRun`, `roll_back`).
 */
export const WRITE_WORDS = ["deploy", "apply", "approve", "run", "op", "rollback", "roll", "revert", "write", "delete", "destroy", "sync", "exec", "merge", "push", "commit", "publish", "override", "unlock", "migrate", "put", "create", "update", "trigger"] as const;

/** The write word a tool's name holds, if any. Words split on case, digits and punctuation; `ops` and `runs` count. */
export function writeWord(name: string): string | undefined {
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return WRITE_WORDS.find((w) => parts.some((p) => p === w || p === `${w}s` || (w.length >= 4 && p.startsWith(w))));
}

/** Refuse to serve a tool whose name says it would write. Run at start. */
export function assertNoWrites(tools: readonly Tool[]): void {
  for (const t of tools) {
    const w = writeWord(t.name);
    if (w) throw new Error(`behold mcp never deploys, applies, approves, runs an Op, rolls back or writes, and the tool ${t.name} would ${w}; it is not served`);
  }
}

/** The answer to a call of a tool that isn't served. */
export function refusal(name: string): string {
  const w = writeWord(name);
  const what = w ? `${name} would ${w}, and ` : `there is no tool ${name}; `;
  return (
    `behold mcp draws and never changes anything: ${what}it serves capabilities, ask, show and shot only. ` +
    "Deploys, approvals, Ops and rollbacks belong to a person in behold's panel or at a shell. " +
    "Ask estate questions with ask, after reading the catalog with capabilities."
  );
}

/** Arguments named like a credential: refused by name. behold mcp takes no credentials at all. */
const CREDENTIAL = /token|secret|password|passwd|credential|key|auth|session|cookie|signature|sas/i;

/** The arguments a tool takes, checked against its schema; any other is refused. */
export function checkArgs(tool: Tool, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const a = args ?? {};
  const s = tool.inputSchema;
  for (const k of Object.keys(a)) {
    if (Object.hasOwn(s.properties, k)) continue;
    if (CREDENTIAL.test(k)) throw new ToolError(`${tool.name} takes no ${k}: behold mcp never takes a credential; the serve reads with the credentials it was started with`);
    throw new ToolError(`${tool.name} takes no argument ${k} (it takes ${Object.keys(s.properties).join(", ") || "none"})`);
  }
  for (const k of s.required ?? []) if (a[k] === undefined) throw new ToolError(`${tool.name} needs ${k}`);
  for (const [k, p] of Object.entries(s.properties)) {
    const v = a[k];
    if (v === undefined) continue;
    if (p.type === "string") {
      if (typeof v !== "string") throw new ToolError(`${tool.name}: ${k} must be a string`);
      if (p.enum && !p.enum.includes(v)) throw new ToolError(`${tool.name}: ${k} is one of ${p.enum.join(", ")}`);
    }
    if (p.type === "boolean" && typeof v !== "boolean") throw new ToolError(`${tool.name}: ${k} must be true or false`);
    if (p.type === "integer" && !(Number.isInteger(v) && (p.minimum === undefined || (v as number) >= p.minimum) && (p.maximum === undefined || (v as number) <= p.maximum))) {
      throw new ToolError(`${tool.name}: ${k} must be a whole number${p.minimum !== undefined ? ` from ${p.minimum}` : ""}${p.maximum !== undefined ? ` to ${p.maximum}` : ""}`);
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// Reaching the serve.
// ---------------------------------------------------------------------------

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

/** A serve this server may use, confirmed against `GET /api/project`. */
export interface FoundServe {
  url: string;
  /** How it was found. */
  via: "url" | "registry" | "default";
  /** The directory it serves, as `/api/project` says. */
  serves: string;
  /** Whether it serves this server's project. */
  ours: boolean;
}

export interface Context {
  /** The project this server is for, realpath'd. */
  projectDir: string;
  /** Whether the project was named (a positional or the cwd); with an explicit --url and no project, the serve's is taken. */
  projectGiven: boolean;
  /** --url or --port, as a URL. */
  url?: string;
  fetch: Fetch;
  /** The MCP client's name, for `by`. */
  clientName(): string | undefined;
  /** The serve, or undefined when none answers. */
  findServe(): Promise<FoundServe | undefined>;
  /** A shot with no serve: behold started in this process for the project (src/shot-cli.ts). */
  localShot(req: ShotRequest): Promise<ShotResult>;
  /** behold#916: GET /api/search with no serve: behold started in this process for the one request (src/shot-cli.ts). */
  localSearch(query: URLSearchParams): Promise<{ status: number; body: Record<string, unknown> }>;
  /** behold#926: GET /api/capabilities with no serve, the body as text (src/shot-cli.ts). */
  localCapabilities(): Promise<{ status: number; text: string }>;
}

const trimUrl = (u: string): string => u.replace(/\/+$/, "");

/** What `GET /api/project` says the serve at `url` serves, or undefined when nothing answers there. */
async function servedProject(fetch: Fetch, url: string): Promise<{ projectDir: string; projectDirs: string[] } | undefined> {
  try {
    const res = await fetch(`${trimUrl(url)}/api/project`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { projectDir?: unknown; projectDirs?: unknown };
    if (typeof body.projectDir !== "string") return undefined;
    const dirs = Array.isArray(body.projectDirs) ? body.projectDirs.filter((d): d is string => typeof d === "string") : [];
    return { projectDir: body.projectDir, projectDirs: dirs };
  } catch {
    return undefined;
  }
}

/** The serve: --url/--port alone when given, else the registry's serve of this project, else the default port. */
export async function locateServe(o: { projectDir: string; projectGiven: boolean; url?: string; fetch: Fetch; registry?: (dir: string) => { url: string; projectDir: string } | undefined }): Promise<FoundServe | undefined> {
  const entry = o.url ? undefined : (o.registry ?? findServe)(o.projectDir);
  const url = o.url ?? entry?.url ?? DEFAULT_SERVE_URL;
  const via: FoundServe["via"] = o.url ? "url" : entry ? "registry" : "default";
  const p = await servedProject(o.fetch, url);
  if (!p) return undefined;
  const dirs = [p.projectDir, ...p.projectDirs, ...(entry ? [entry.projectDir] : [])].map(realDir);
  const ours = (via === "url" && !o.projectGiven) || dirs.some((d) => within(d, o.projectDir));
  return { url: trimUrl(url), via, serves: p.projectDir, ours };
}

// ---------------------------------------------------------------------------
// The tools.
// ---------------------------------------------------------------------------

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failed = (message: string, body?: Record<string, unknown>): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: body ? JSON.stringify({ error: message, ...body }, null, 2) : message }],
});

const SEARCH_OPTIONS =
  "The query is chant's search grammar, unchanged (https://intentius.io/chant/cli/search/). env reads that environment live (chant search --live --env <env>); " +
  "snapshot with env replays a recorded snapshot instead (chant --snapshot <ref>, such as latest); chant's --explain is always on, for the near-misses drawn. " +
  "It takes no --check-live or --check-snapshot (drift is not drawn), and no --ambient, --src or --fail-on-drift. " +
  "Read the capabilities tool first: it lists the capabilities a cap: term asks (cap:internet-reachable(22), ->[cap=network]), each one's meaning, parameters and rule (INTENTIUS/chant#4375).";

const VIEW_PROPS: Record<string, Prop> = {
  query: { type: "string", description: "A chant search query whose matches the view lights, such as `attr:internetFacing=true`." },
  env: { type: "string", description: "The environment whose live state the view shows. Without it, the declared source." },
  snapshot: { type: "string", description: "With env: a recorded snapshot to show instead of a live read (latest, or a ref chant lists). Not with plan." },
  plan: {
    type: "boolean",
    description:
      "The plan read (behold#922): the query is answered at the plan depth (CHANT_TERRAFORM_OBSERVE=plan, chant search --live --env), and the cards carry each Terraform root's planAction, planActions, planReplacePaths and planActionReason. " +
      "On a bare Terraform folder no env is needed; on a chant project pass env. Refused with snapshot. Runs terraform plan -lock=false in each root: it changes nothing, and reads every resource.",
  },
  countBy: {
    type: "string",
    description: "Group the matches the way chant search --count-by does: kind, module or attr:<name> (behold#922). The answer is chant's groups and total; the view lights each group's cards and labels the group with its count. The query may then be empty, to count the whole estate.",
  },
  member: { type: "string", description: "Show one estate member." },
  zoom: { type: "string", description: "The zoom: components, resources, attributes, or another behold offers." },
  focus: { type: "string", description: "Comma-separated box ids to keep at full weight; the rest dims." },
  node: { type: "string", description: "A card to select, by behold's node id." },
};

/** The view keys a tool passes through, in the names the serve reads. */
const VIEW_ARGS = ["member", "zoom", "focus", "node"] as const;

function viewOf(a: Record<string, unknown>): Record<string, string> {
  const v: Record<string, string> = {};
  if (typeof a.query === "string" && a.query.trim()) v.q = a.query;
  if (typeof a.env === "string" && a.env) v.env = a.env;
  if (typeof a.snapshot === "string" && a.snapshot) v.snapshot = a.snapshot;
  if (a.plan === true) v.plan = "1";
  if (typeof a.countBy === "string" && a.countBy) v.countBy = a.countBy;
  if (v.plan && v.snapshot) throw new ToolError("plan and snapshot were both asked: a plan is read now, and a snapshot replays what was recorded. Drop one.");
  for (const k of VIEW_ARGS) if (typeof a[k] === "string" && a[k]) v[k] = a[k] as string;
  if (v.snapshot && !v.env) throw new ToolError("snapshot needs env: a snapshot is recorded per environment");
  return v;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * behold#916: what `ask` returns, from what GET /api/search answered: chant's
 * document as it is, with `link` and `drawn: false` added after its own
 * fields. Nothing else of the route's answer goes in. A route refusal with no
 * document is a refusal.
 */
export function askAnswer(status: number, body: Record<string, unknown>): { doc: Record<string, unknown>; failed: boolean } {
  const doc = body.document;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ToolError(typeof body.error === "string" ? body.error : `GET /api/search answered ${status}`, { status, ...body });
  }
  const failed = "error" in (doc as Record<string, unknown>);
  return { doc: { ...(doc as Record<string, unknown>), link: typeof body.link === "string" ? body.link : null, drawn: false }, failed };
}

export const TOOLS: Tool[] = [
  {
    name: "ask",
    description:
      "Ask a chant search query of the estate behold serves, and get chant's answer: its read-contract search document, verbatim, " +
      "with `link` (the behold view that draws it) and `drawn: false` added. ask never moves the person's tab; use show for that. " +
      "On a declared workspace the document is chant workspace search's, with every member's rows as <member>/<id>; on one project or a Terraform folder it is chant search --json's. " +
      "Uses the running behold serve of this project; with none, behold answers in this process. Needs chant 0.124.46 or newer. " +
      "Which demo questions it answers: \"what's in here?\" is countBy kind with the query kind:aws_ (or empty); \"how many resources does each module own, by type?\" is countBy module, then countBy kind with the query narrowed to a module; " +
      "\"what would this change do, and why does it replace the database?\" is plan with the query attr:planAction=replace and show planActions,planReplacePaths,planActionReason. " +
      SEARCH_OPTIONS,
    inputSchema: {
      type: "object",
      properties: {
        query: VIEW_PROPS.query!,
        env: VIEW_PROPS.env!,
        snapshot: VIEW_PROPS.snapshot!,
        plan: VIEW_PROPS.plan!,
        countBy: VIEW_PROPS.countBy!,
        show: { type: "string", description: "Comma-separated attributes to carry on each row (chant search --show)." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(a, ctx) {
      const view = viewOf(a);
      if (!view.q && !view.countBy) throw new ToolError("ask needs a query, or countBy to count the whole estate");
      const q = new URLSearchParams({
        q: view.q ?? "",
        ...(view.env ? { env: view.env } : {}),
        ...(view.snapshot ? { snapshot: view.snapshot } : {}),
        ...(view.plan ? { plan: "1" } : {}),
        ...(view.countBy ? { countBy: view.countBy } : {}),
        ...(typeof a.show === "string" && a.show ? { show: a.show } : {}),
      });
      const serve = await ctx.findServe();
      let status: number;
      let body: Record<string, unknown>;
      if (serve?.ours) {
        const res = await ctx.fetch(`${serve.url}/api/search?${q}`, { headers: { accept: "application/json" } });
        status = res.status;
        body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      } else {
        ({ status, body } = await ctx.localSearch(q));
      }
      const { doc, failed: refused } = askAnswer(status, body);
      const note = serve?.ours
        ? `Nothing is drawn: ask never moves the tab. show with the same query draws it in the open tab at ${serve.url}.`
        : `Nothing is drawn: no behold serve of ${ctx.projectDir} was running${serve ? ` (the one at ${serve.url} serves ${serve.serves})` : ""}, so behold answered in this process. Start \`${serveCommand(ctx.projectDir)}\` to see it.`;
      return { ...(refused ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(doc) }, { type: "text", text: note }] };
    },
  },
  {
    name: "show",
    description:
      "Move the person's open behold tab to a view: the query's matches lit and the rest dimmed, in the env or snapshot asked for. " +
      "The tab says an agent moved it and keeps the view it left one Back away. It changes nothing but what the tab shows. " +
      "Needs a running behold serve of this project; with none, it refuses and names the command that starts one. With no tab open it answers the link to hand the person. " +
      SEARCH_OPTIONS,
    inputSchema: { type: "object", properties: VIEW_PROPS, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a, ctx) {
      const view = viewOf(a);
      if (!Object.keys(view).length) throw new ToolError("show needs a query or a view key (env, plan, countBy, member, zoom, focus, node)");
      const serve = await ctx.findServe();
      if (!serve) {
        throw new ToolError(`No behold serve of ${ctx.projectDir} is running, so there is no tab to move. Start one with \`${serveCommand(ctx.projectDir)}\` and open it, or take a shot instead.`, {
          code: "no-serve",
          remedy: serveCommand(ctx.projectDir),
        });
      }
      if (!serve.ours) {
        throw new ToolError(`The behold at ${serve.url} serves ${serve.serves}, not ${ctx.projectDir}, so show won't move its tab.`, {
          code: "other-project",
          serves: serve.serves,
          project: ctx.projectDir,
          remedy: `Start behold for this project (\`${serveCommand(ctx.projectDir)} --port <n>\`) and pass behold mcp --url, or switch the open serve to it.`,
        });
      }
      const client = ctx.clientName();
      const by = `${client ?? "an agent"} via behold mcp`.slice(0, 80);
      const res = await ctx.fetch(`${serve.url}/api/view`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        // POST /api/view takes plan as a boolean, as a host's behold:view does.
        body: JSON.stringify({ view: { ...view, ...(view.plan ? { plan: true } : {}) }, by }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new ToolError(typeof body.error === "string" ? body.error : `POST /api/view answered ${res.status}`, { status: res.status, ...body });
      return json({ ...body, serve: serve.url });
    },
  },
  {
    name: "shot",
    description:
      "A PNG of a view, framed on the query's matches, and the link to the same view. Returns the image inline. " +
      "Uses the running behold serve of this project; with none, it starts behold in this process for the shot and stops it after. " +
      "Needs the optional peer playwright-core and a browser; without them it refuses with the install line. Writes no file. " +
      "Without a query, node or focus frames the view's own selection. " +
      SEARCH_OPTIONS,
    inputSchema: {
      type: "object",
      properties: {
        ...VIEW_PROPS,
        width: { type: "integer", description: "The page's width in px (default 1600).", minimum: 320, maximum: 4096 },
        height: { type: "integer", description: "The page's height in px (default 1000).", minimum: 320, maximum: 4096 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(a, ctx) {
      const view = viewOf(a);
      const serve = await ctx.findServe();
      if (serve?.ours) {
        const q = new URLSearchParams(view);
        if (a.width !== undefined) q.set("width", String(a.width));
        if (a.height !== undefined) q.set("height", String(a.height));
        const res = await ctx.fetch(`${serve.url}/api/shot?${q}`, { headers: { accept: "image/png" } });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as Partial<ShotRefusalBody> & Record<string, unknown>;
          throw new ToolError(typeof body.error === "string" ? body.error : `GET /api/shot answered ${res.status}`, { status: res.status, ...body });
        }
        const png = Buffer.from(await res.arrayBuffer());
        const facts = { link: res.headers.get("behold-view-link"), state: res.headers.get("behold-shot-state"), serve: serve.url };
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, { type: "text", text: JSON.stringify(facts, null, 2) }] };
      }
      const { q, env, snapshot, ...rest } = view;
      const req: ShotRequest = {
        ...(q ? { query: q } : {}),
        ...(env ? { env } : {}),
        ...(snapshot ? { snapshot } : {}),
        view: rest,
        ...(a.width !== undefined ? { width: a.width as number } : {}),
        ...(a.height !== undefined ? { height: a.height as number } : {}),
      };
      const shot = await ctx.localShot(req);
      const facts = {
        link: shot.link,
        state: shot.state,
        matched: shot.matched,
        serve: null,
        note: `No behold serve of ${ctx.projectDir} was running${serve ? ` (the one at ${serve.url} serves ${serve.serves})` : ""}, so behold ran in this process for the shot. The link opens once \`${serveCommand(ctx.projectDir)}\` is running.`,
      };
      return { content: [{ type: "image", data: shot.png.toString("base64"), mimeType: "image/png" }, { type: "text", text: JSON.stringify(facts, null, 2) }] };
    },
  },
  {
    name: "capabilities",
    description:
      "Read this first. The capability catalog chant answers cap: terms with, for the estate behold serves: chant's read-contract capabilities document, verbatim " +
      "(chant search --capabilities --json, INTENTIUS/chant#4375; chant workspace search --capabilities --json on a declared workspace). " +
      "Each capability has its name, what it means, its parameters, the search term that asks it (cap:internet-reachable, ->[cap=network]), the questions it answers, " +
      "what it does not evaluate, its rule, and which lexicons supply it. Then ask with that term; a cap: match's path is in its because hops, and show draws it. " +
      "Uses the running behold serve of this project; with none, behold answers in this process. Takes no arguments. Needs chant 0.124.46 or newer.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    async run(_a, ctx) {
      const serve = await ctx.findServe();
      let status: number;
      let text: string;
      if (serve?.ours) {
        const res = await ctx.fetch(`${serve.url}/api/capabilities`, { headers: { accept: "application/json" } });
        status = res.status;
        text = await res.text();
      } else {
        ({ status, text } = await ctx.localCapabilities());
      }
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        // Not JSON: refused below with the status.
      }
      // chant's own document, a failure one included, goes back as chant printed it; a route refusal is a refusal.
      if (body.contract === undefined) throw new ToolError(typeof body.error === "string" ? body.error : `GET /api/capabilities answered ${status}`, { status, ...body });
      return { ...("error" in body || status !== 200 ? { isError: true } : {}), content: [{ type: "text", text }] };
    },
  },
];

/** Answer one tools/call: a listed tool with its own arguments, or a refusal. */
export async function callTool(tools: readonly Tool[], name: string, args: Record<string, unknown> | undefined, ctx: Context): Promise<CallToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return failed(refusal(name));
  try {
    return await tool.run(checkArgs(tool, args), ctx);
  } catch (e) {
    if (e instanceof ToolError) return failed(e.message, e.body);
    // A ShotRefusal from the no-serve shot: its structured body, as the route would answer it.
    const body = (e as { body?: ShotRefusalBody }).body;
    if (body?.code) return failed(body.error, { code: body.code, remedy: body.remedy });
    return failed(`${name} failed: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// The server.
// ---------------------------------------------------------------------------

function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface McpOptions {
  projectDir: string;
  /** Whether project-dir was given on the command line. */
  projectGiven?: boolean;
  url?: string;
  fetch?: Fetch;
  tools?: Tool[];
  /** For tests: the registry lookup and the no-serve shot. */
  registry?: (dir: string) => { url: string; projectDir: string } | undefined;
  localShot?: (req: ShotRequest) => Promise<ShotResult>;
  localSearch?: Context["localSearch"];
  localCapabilities?: Context["localCapabilities"];
}

export const INSTRUCTIONS =
  "behold draws a Terraform or chant estate in the person's browser. Read capabilities first: chant's capability catalog, what each cap: term means and asks. " +
  "ask returns chant's answer to an estate question (its search document, verbatim, plus the link to the view); " +
  "then use show to move the person's open behold tab to the matches, or shot to get a PNG of them and the link. " +
  "Nothing here deploys, approves, runs an Op, rolls back or writes; a person does that.";

/** The server, on any transport. */
export async function serveMcp(o: McpOptions, transport: Transport): Promise<Server> {
  const tools = o.tools ?? TOOLS;
  assertNoWrites(tools);
  const projectDir = realDir(o.projectDir);
  const fetch: Fetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const server = new Server({ name: "behold", version: version() }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const ctx: Context = {
    projectDir,
    projectGiven: o.projectGiven ?? true,
    ...(o.url ? { url: o.url } : {}),
    fetch,
    clientName: () => server.getClientVersion()?.name,
    findServe: () => locateServe({ projectDir, projectGiven: o.projectGiven ?? true, ...(o.url ? { url: o.url } : {}), fetch, ...(o.registry ? { registry: o.registry } : {}) }),
    localShot: o.localShot ?? ((req) => shotFromArgs({ req, projectDir, linkBase: DEFAULT_LINK_BASE })),
    localSearch: o.localSearch ?? ((query) => localSearch(projectDir, query)),
    localCapabilities: o.localCapabilities ?? (() => localCapabilities(projectDir)),
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(tools, req.params.name, req.params.arguments, ctx));
  await server.connect(transport);
  return server;
}

export const MCP_USAGE = `Usage: behold mcp [project-dir] [--url <serve> | --port <n>]

  A stdio MCP server with four tools: capabilities returns chant's
  capability catalog, verbatim, to read first; ask returns chant's search
  document for a query, verbatim, with the link to the view that draws it;
  show moves the open behold tab to a view; shot returns a PNG of one with
  its link.
  chant answers and behold draws. Configure it in the agent,
  for example: claude mcp add behold -- npx @intentius/behold mcp <dir>

  It reaches the serve at --url (or http://127.0.0.1:--port), else the serve
  of project-dir (default: the current directory) that the per-user registry
  under the OS temp directory names, else http://127.0.0.1:4600. With no serve
  running, show refuses with the command that starts one, and capabilities,
  ask and shot start behold in their own process. Nothing it does deploys, approves,
  runs an Op, rolls back or writes.
`;

/** The command line, read. Throws a message on a usage error. */
export function parseMcpArgs(rest: string[], cwd = process.cwd()): McpOptions | "help" {
  let url: string | undefined;
  let port: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-h" || a === "--help") return "help";
    else if (a === "--url") url = rest[++i];
    else if (a === "--port") port = rest[++i];
    else if (a.startsWith("-")) throw new Error(`unexpected argument '${a}'`);
    else positional.push(a);
  }
  if (positional.length > 1) throw new Error(`unexpected argument '${positional[1]}'`);
  if (url !== undefined && port !== undefined) throw new Error("pass --url or --port, not both");
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port needs a port number, not ${port ?? "nothing"}`);
    url = `http://127.0.0.1:${n}`;
  }
  if (url !== undefined) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`--url is not an http(s) URL: ${url}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`--url is not an http(s) URL: ${url}`);
  }
  return { projectDir: resolve(cwd, positional[0] ?? "."), projectGiven: positional.length > 0 || url === undefined, ...(url ? { url } : {}) };
}

/** `behold mcp`: serve on stdin and stdout until the client closes them. */
export async function runMcp(rest: string[]): Promise<number> {
  let o: McpOptions | "help";
  try {
    o = parseMcpArgs(rest);
  } catch (e) {
    process.stderr.write(`behold mcp: ${(e as Error).message}\n\n${MCP_USAGE}`);
    return 2;
  }
  if (o === "help") {
    process.stdout.write(MCP_USAGE);
    return 0;
  }
  const server = await serveMcp(o, new StdioServerTransport());
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
  });
  await server.close();
  return 0;
}
