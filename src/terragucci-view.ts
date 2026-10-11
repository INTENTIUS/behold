/**
 * `behold serve . --terragucci <dir|s3://bucket/prefix>` (#490): the routes
 * that paint a terragucci estate from its reports.
 *
 * - `GET /api/terragucci` answers the marks: each root of the checkout with
 *   the newest tf-plan, tf-drift and tf-apply run that held it, the cards
 *   those runs flag, the waves waiting for an approval, and terragucci's own
 *   estate counts when the source has an estate.json. Everything is dated by
 *   its run; nothing is a status.
 * - `GET /api/terragucci/file?key=<key>` hands back one report page or JSON
 *   from the same source, so a mark's "report" link opens wherever the reports
 *   live (a directory, or a bucket only the operator's aws CLI can read).
 * - `GET /api/terragucci/timeline` is the audit record's lane
 *   (src/terragucci-timeline.ts, #506).
 *
 * No write: approving a waiting wave is a person's act at their shell
 * (`npx terragucci approve wave-<k> --plan <digest>`), and the page offers
 * that line to copy, never a button. The served repo is a terragucci repo, so
 * every behold write route already refuses (#489).
 */
import { execFileSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import type { Hono } from "hono";
import type { GraphIR } from "@intentius/chant";
import { composeEstate, estateMembers } from "./estate.ts";
import { discoverTerraformRoots } from "./terraform-member.ts";
import { terragucciConfig } from "./terragucci-repo.ts";
import { readTerragucci, terragucciValidator, TerragucciReadError, type TerragucciRead } from "./terragucci-reports.ts";
import { joinTerragucci, type CheckoutRoot } from "./terragucci-overlay.ts";
import { terragucciSource, type AwsRun } from "./terragucci-source.ts";
import { auditValidator, terragucciTimelineRoute } from "./terragucci-timeline.ts";

export interface TerragucciOptions {
  /** `--terragucci`: a directory, `s3://bucket/prefix`, or an http(s) address serving the bucket. */
  source: string;
  /** `--terragucci-project`: which project, when the reports hold several. */
  project?: string;
  /** Injected by a test: the aws CLI and fetch the source reads through. */
  aws?: AwsRun;
  fetch?: typeof fetch;
  /** Injected by a test: the clock the read is dated with. */
  now?: () => Date;
}

/** How long a read is reused before the next page load reads the source again. */
export const TERRAGUCCI_READ_TTL_MS = 30_000;

/** The repo the served directories sit in: where terragucci's config is, else the git root, else the first directory. */
export function repoBase(dirs: readonly string[]): string {
  for (const d of dirs) {
    const cfg = terragucciConfig(d);
    if (cfg) return dirname(cfg);
  }
  try {
    return execFileSync("git", ["-C", dirs[0]!, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return dirs[0]!;
  }
}

/**
 * terragucci's name for the checkout's project: the git remote's `<host>/<path>`
 * (terragucci's reports-bucket page). Undefined without a remote: terragucci
 * then names it after the directory, which is no help in choosing among
 * several projects.
 */
export function checkoutProject(base: string): string | undefined {
  let url: string;
  try {
    url = execFileSync("git", ["-C", base, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
  return projectFromRemote(url);
}

export function projectFromRemote(url: string): string | undefined {
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp && !url.includes("://")) return `${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return path ? `${u.host}/${path}` : undefined;
  } catch {
    return undefined;
  }
}

/** The checkout's Terraform roots, by member, with terragucci's path for each (relative to the repo). */
export function checkoutRoots(dirs: readonly string[], base: string = repoBase(dirs)): CheckoutRoot[] {
  const out: CheckoutRoot[] = [];
  for (const m of estateMembers(dirs)) {
    if (m.kind !== "terraform") continue;
    for (const r of discoverTerraformRoots(m.dir).roots) {
      const path = relative(base, join(m.dir, r.dir)).split(sep).join("/") || ".";
      out.push({ member: m.name, name: r.name, path });
    }
  }
  return out;
}

/** A key under the source: relative, no `.` or `..` segment, and a report file's extension. */
const FILE_KEY = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._~\-/]+\.(html|json|txt|md)$/;
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", json: "application/json", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8" };

/** Register the two routes. `dirs()` is asked per request, since a project switch changes what is served. */
export function terragucciRoutes(app: Hono, opts: TerragucciOptions, dirs: () => string[]): void {
  const source = terragucciSource(opts.source, { ...(opts.aws ? { aws: opts.aws } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  let cached: { at: number; key: string; read: Promise<TerragucciRead> } | undefined;

  const read = (roots: CheckoutRoot[], served: string[], fresh: boolean): Promise<TerragucciRead> => {
    const key = served.join("\u0000");
    const now = Date.now();
    if (!fresh && cached && cached.key === key && now - cached.at < TERRAGUCCI_READ_TTL_MS) return cached.read;
    const base = repoBase(served);
    const p = readTerragucci(source, {
      ...(opts.project ? { project: opts.project } : {}),
      ...(checkoutProject(base) ? { checkoutProject: checkoutProject(base)! } : {}),
      roots: roots.map((r) => r.path),
      validator: terragucciValidator(served),
      ...(opts.now ? { now: opts.now() } : {}),
    });
    cached = { at: now, key, read: p };
    // A refusal is not kept: the next load asks again, so a fixed source shows.
    p.catch(() => (cached = undefined));
    return p;
  };

  app.get("/api/terragucci", async (c) => {
    const served = dirs();
    const roots = checkoutRoots(served);
    let r: TerragucciRead;
    try {
      r = await read(roots, served, new URL(c.req.url).searchParams.get("fresh") === "1");
    } catch (e) {
      if (e instanceof TerragucciReadError) return c.json(e.refusal, 422);
      throw e;
    }
    let ir: GraphIR;
    try {
      ir = await composeEstate(served, { detail: 3 });
    } catch (e) {
      return c.json({ error: `behold could not read the checkout's roots to place the marks on: ${e instanceof Error ? e.message : String(e)}`, code: "terragucci-graph", remedy: "`behold doctor` names what the Terraform read needs." }, 422);
    }
    const marks = joinTerragucci(r, ir.nodes as never, roots);
    return c.json({
      source: r.source,
      kind: r.kind,
      project: r.project,
      validation: r.validation,
      read: r.read,
      reports: r.reports,
      // Where a key opens: this server, which reads it from the same source.
      files: "/api/terragucci/file?key=",
      ...(r.estate ? { estate: r.estate } : {}),
      ...marks,
    });
  });

  // #506: the timeline lane, from the audit record at the same source.
  terragucciTimelineRoute(app, source, {
    ...(opts.project ? { project: opts.project } : {}),
    checkoutProject: () => checkoutProject(repoBase(dirs())),
    validator: () => auditValidator(dirs()),
    ...(opts.now ? { now: opts.now } : {}),
  });

  app.get("/api/terragucci/file", async (c) => {
    const key = new URL(c.req.url).searchParams.get("key") ?? "";
    if (!FILE_KEY.test(key)) return c.json({ error: `not a report file: ${JSON.stringify(key)}`, code: "terragucci-file" }, 400);
    let body: string | undefined;
    try {
      body = await source.read(key);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e), code: "terragucci-file" }, 502);
    }
    if (body === undefined) return c.json({ error: `${source.location} has no ${key}`, code: "terragucci-file" }, 404);
    // A report page is somebody's bucket object, served from behold's origin:
    // sandboxed, so its scripts run in an opaque origin that behold's request
    // guard refuses, and can never reach a route of this server.
    return c.body(body, 200, {
      "content-type": TYPES[key.slice(key.lastIndexOf(".") + 1)]!,
      "content-security-policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
      "x-content-type-options": "nosniff",
    });
  });
}
