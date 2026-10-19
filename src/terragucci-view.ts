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
 * - `GET /api/terragucci/progress` is a choudoufu wave's progress per
 *   resource from the newest apply's run view (src/terragucci-progress.ts, #511).
 * - `GET /api/terragucci/demo` (#569): the looping demo's `demo.json`,
 *   which the kiosk narrates (src/terragucci-demo.ts).
 * - `GET /api/terragucci/runs` and `/api/terragucci/runs/:id` (#569): the
 *   demo's pipeline runs, which the kiosk lists (src/terragucci-runs.ts).
 * - `GET /api/terragucci/carve` (#715): each estate's roster and each estate
 *   migration's progress, for the dots layer's live carve
 *   (src/terragucci-carve.ts). Gated on choudoufu roots or estate rosters.
 * - `GET /api/terragucci/lifecycle` and `GET /api/terragucci/events` (#505):
 *   the gates and locks on `chant/lifecycle`, and the poll that pushes what
 *   moved while a page is open (src/terragucci-poll.ts).
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
import { checkoutRootDirs } from "./terraform-member.ts";
import { terragucciConfig } from "./terragucci-repo.ts";
import { readTerragucci, terragucciValidator, TerragucciReadError, type TerragucciRead } from "./terragucci-reports.ts";
import { joinTerragucci, type CheckoutRoot } from "./terragucci-overlay.ts";
import { terragucciSource, type AwsRun } from "./terragucci-source.ts";
import { auditValidator, terragucciTimelineRoute } from "./terragucci-timeline.ts";
import { indexProbe, terragucciLaneRoutes, type LaneRouteOptions } from "./terragucci-poll.ts";
import { runValidator, TerragucciProgress, terragucciProgressRoute } from "./terragucci-progress.ts";
import { terragucciCyclesRoute, terragucciDemoRoute } from "./terragucci-demo.ts";
import { terragucciRunsRoutes } from "./terragucci-runs.ts";
import { terragucciCarveRoute } from "./terragucci-carve.ts";
import { memberKindOf } from "./member-kind.ts";
import { configKeys, toolOfBinary } from "./pipeline-marks.ts";
import { readFileSync } from "node:fs";

export interface TerragucciOptions {
  /** `--terragucci`: a directory, `s3://bucket/prefix`, or an http(s) address serving the bucket. */
  source: string;
  /** `--terragucci-project`: which project, when the reports hold several. */
  project?: string;
  /**
   * behold#749, asked per request: whether it reads another checkout than the serve's own (`serve --repos`, a
   * `?repo=` naming another). Such a request reads the project its checkout's remote names, matched by
   * `<owner>/<name>` (matchProject), or none; `project` pins the serve's own checkout only.
   */
  otherRepo?: () => boolean;
  /** #569 `--terragucci-runs`: where the kiosk reads the demo's pipeline runs, when not beside the reports. */
  runsSource?: string;
  /** Injected by a test: the aws CLI and fetch the source reads through. */
  aws?: AwsRun;
  fetch?: typeof fetch;
  /** Injected by a test: the clock the read is dated with. */
  now?: () => Date;
  /** #505 `--terragucci-poll <secs>`: how often an open page is told what moved (default 30, 0 off). */
  pollSecs?: number;
  /** #505, injected by a test: the lifecycle cache and git, and the index probe. */
  lane?: Pick<LaneRouteOptions, "lifecycle" | "probe">;
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
    // behold#571: a Terragrunt repo's roots are its units.
    for (const r of checkoutRootDirs(m.dir)) {
      const path = relative(base, join(m.dir, r.dir)).split(sep).join("/") || ".";
      out.push({ member: m.name, name: r.name, path });
    }
  }
  return out;
}

/**
 * #715: whether the served estate has choudoufu roots: a served member that is
 * a choudoufu estate, or a terragucci config whose `binary:` (anywhere in it,
 * a root's own included) is choudoufu.
 */
export function servedChoudoufu(dirs: readonly string[]): boolean {
  if (dirs.some((d) => memberKindOf(d) === "choudoufu")) return true;
  for (const d of dirs) {
    const cfg = terragucciConfig(d);
    if (!cfg) continue;
    if (toolOfBinary(configKeys(cfg).binary) === "choudoufu") return true;
    try {
      if (/\bbinary\s*:\s*["']?[^\s"',}]*choudoufu\b/.test(readFileSync(cfg, "utf8"))) return true;
    } catch {
      /* unreadable: not choudoufu as far as this says */
    }
  }
  return false;
}

/** A key under the source: relative, no `.` or `..` segment, and a report file's extension. */
const FILE_KEY = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._~\-/]+\.(html|json|txt|md)$/;
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", json: "application/json", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8" };

/** Register the routes. `dirs()` is asked per request, since a project switch changes what is served. */
export function terragucciRoutes(app: Hono, opts: TerragucciOptions, dirs: () => string[]): void {
  const source = terragucciSource(opts.source, { ...(opts.aws ? { aws: opts.aws } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  let cached: { at: number; key: string; read: Promise<TerragucciRead> } | undefined;

  const read = (roots: CheckoutRoot[], served: string[], fresh: boolean): Promise<TerragucciRead> => {
    const strict = !!opts.otherRepo?.();
    const key = [...served, strict].join("\u0000");
    const now = Date.now();
    if (!fresh && cached && cached.key === key && now - cached.at < TERRAGUCCI_READ_TTL_MS) return cached.read;
    const base = repoBase(served);
    const p = readTerragucci(source, {
      ...(strict ? { strict } : opts.project ? { project: opts.project } : {}),
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

  // #511: the newest apply's run view, its progress per resource on the cards.
  const progress = new TerragucciProgress({
    source,
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.otherRepo ? { strict: opts.otherRepo } : {}),
    checkoutProject: () => checkoutProject(repoBase(dirs())),
    validators: () => ({ index: terragucciValidator(dirs()), run: runValidator(dirs()) }),
    context: async () => {
      const served = dirs();
      return { nodes: (await composeEstate(served, { detail: 3 })).nodes as never, roots: checkoutRoots(served) };
    },
    probe: (key) => indexProbe(opts.source, { key, ...(opts.aws ? { aws: opts.aws } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) }),
    ...(opts.now ? { now: opts.now } : {}),
  });
  terragucciProgressRoute(app, progress);

  // #505: the chant/lifecycle lane, and the poll that pushes what moved.
  terragucciLaneRoutes(
    app,
    { source: opts.source, ...(opts.pollSecs !== undefined ? { pollSecs: opts.pollSecs } : {}), ...(opts.aws ? { aws: opts.aws } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.now ? { now: opts.now } : {}), progress: () => progress.poll(), ...opts.lane },
    () => repoBase(dirs()),
    () => {
      cached = undefined;
      progress.forget();
    },
  );

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
      // #568: the pull request stage, read from the newest tf-plan of a pull request.
      ...(r.pull_request ? { pull_request: r.pull_request } : {}),
      // behold#741: the roots the newest apply's waves blocked (report minor 41), absent when none.
      ...(r.blocked ? { blocked: r.blocked } : {}),
      // behold#741: each root's own outcome in the newest apply's waves, absent when no report carries one.
      ...(r.outcomes ? { outcomes: r.outcomes } : {}),
      ...marks,
    });
  });

  // #569: the looping demo's narration, from demo.json at the same source.
  terragucciDemoRoute(app, source, opts.now ? { now: opts.now } : {});
  // behold#571: each tool's latest cycle, which its own page replays, beside demo.json.
  terragucciCyclesRoute(app, source, opts.now ? { now: opts.now } : {});
  // #569: the demo's pipeline runs, as the loop driver copies them from the forge.
  const runsSource = opts.runsSource ? terragucciSource(opts.runsSource, { ...(opts.aws ? { aws: opts.aws } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) }) : source;
  terragucciRunsRoutes(app, runsSource, opts.now ? { now: opts.now } : {});

  // #715: the live carve, from the estate rosters and the migrations' progress at the same source.
  // A tour of the cycle (behold.tour/v1): behold's own, or one in a served repo's .behold/tours.
  terragucciCarveRoute(app, source, { choudoufu: () => servedChoudoufu(dirs()), ...(opts.now ? { now: opts.now } : {}), tour: { dirs: () => [...new Set([repoBase(dirs()), ...dirs()])], runs: runsSource } });

  // #506: the timeline lane, from the audit record at the same source.
  terragucciTimelineRoute(app, source, {
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.otherRepo ? { strict: opts.otherRepo } : {}),
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
