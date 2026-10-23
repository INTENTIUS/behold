/**
 * behold#915: `behold shot "<query>"`. Takes the picture through src/shot.ts
 * against a running serve (`--url`), or against behold's app started in this
 * process on 127.0.0.1 port 0 for the project and stopped afterwards. Writes
 * the PNG only once the page has reported ready, and prints the link to the
 * same view. Nothing is written in the served project: without `-o` the PNG
 * goes under the OS temp directory.
 */
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createApp, type ServerOptions } from "./server.ts";
import { SHOT_HEIGHT, SHOT_WIDTH, ShotRefusal, takeShot, type ShotDeps, type ShotRequest, type ShotResult } from "./shot.ts";
import { drawnMembers, hasDeclaration, readWorkspace } from "./workspace.ts";
import { servesAsEstate } from "./member-kind.ts";
import { parsePublishTarget, PublishRefusal, publishShot, type GitRun, type PublishTarget } from "./shot-publish.ts";

export const SHOT_USAGE = `Usage: behold shot "<query>" [project-dir] [--env <name>] [--snapshot <ref>] [-o <out.png>]
                  [--url <serve>] [--width <px>] [--height <px>] [--link-base <url>] [--view <k=v&...>]
                  [--publish <remote>[/<branch>] [--publish-repo <dir>]]

  Writes a PNG of the view that lights the query's matches, framed the way
  the kiosk frames a shot, and prints the link to the same view. It uses the
  serve at --url, or starts behold for project-dir (default: the current
  directory) on a free loopback port and stops it afterwards. Needs the
  optional peer playwright-core and a browser (the system Chrome, else
  Playwright's chromium-headless-shell); without one it refuses and writes
  nothing. Writes nothing in the served project: -o defaults to a file under
  the OS temp directory.

  The query is chant's search grammar (behold#913): its matches are lit and
  framed, the rest dimmed. With "" as the query, --view frames the view's own
  selection instead: behold shot "" --view node=<id> (or focus=<box,...>).

  --env <name>        the env's live view; --snapshot <ref> replays a recorded
                      snapshot of it (latest, or a ref chant lists)
  --width, --height   the page's size in px (default ${SHOT_WIDTH}x${SHOT_HEIGHT})
  --link-base <url>   where the printed link points (an export's host);
                      default: the serve, or http://localhost:4600 when the
                      app was started here
  --view <k=v&...>    view keys to pass, settled as a link's are: member,
                      zoom, tier, lens, node, radial, alike, focus, run, pull
  --publish <remote>[/<branch>]
                      off by default (behold#923): also commit the PNG to
                      <branch> (default behold-shots) of <remote> through
                      Git LFS, push it, and print its raw URL. Never the
                      branch checked out in the repo. Needs git-lfs and a
                      remote that takes LFS; without either it refuses and
                      keeps the local PNG
  --publish-repo <dir>
                      the git repo whose remote --publish names
                      (default: the current directory's)

  Exit: 0 drawn (or no matches: the dimmed graph), 1 the graph failed (the
  picture shows why), the shot was refused (no file) or the publish was
  refused (the local file is kept), 2 usage.
`;

/** Where the printed link points when the app ran in this process: the default serve. */
export const DEFAULT_LINK_BASE = "http://localhost:4600";

export interface ShotArgs {
  req: ShotRequest;
  projectDir: string;
  out?: string;
  url?: string;
  linkBase?: string;
  publish?: PublishTarget;
  publishRepo?: string;
}

/** The command line, read. Throws a message on a usage error. */
export function parseShotArgs(rest: string[], cwd = process.cwd()): ShotArgs | "help" {
  const req: ShotRequest = {};
  const positional: string[] = [];
  let out: string | undefined;
  let url: string | undefined;
  let linkBase: string | undefined;
  let publish: PublishTarget | undefined;
  let publishRepo: string | undefined;
  const need = (flag: string, v: string | undefined): string => {
    if (v === undefined || (v.startsWith("-") && v.length > 1 && flag !== "--view")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-h" || a === "--help") return "help";
    else if (a === "--env") req.env = need(a, rest[++i]);
    else if (a === "--snapshot") req.snapshot = need(a, rest[++i]);
    else if (a === "-o" || a === "--out") out = need(a, rest[++i]);
    else if (a === "--url") url = need(a, rest[++i]);
    else if (a === "--link-base") linkBase = need(a, rest[++i]);
    else if (a === "--publish") publish = parsePublishTarget(need(a, rest[++i]));
    else if (a === "--publish-repo") publishRepo = need(a, rest[++i]);
    else if (a === "--width") req.width = Number(need(a, rest[++i]));
    else if (a === "--height") req.height = Number(need(a, rest[++i]));
    else if (a === "--view") {
      const v = need(a, rest[++i]);
      req.view = { ...(req.view ?? {}), ...Object.fromEntries(new URLSearchParams(v)) };
    } else if (a.startsWith("-") && a !== "-" && !a.startsWith("->")) throw new Error(`unexpected argument '${a}'`);
    else positional.push(a);
  }
  if (positional.length < 1) throw new Error('give the query (or "" with --view node=<id>)');
  if (positional.length > 2) throw new Error(`unexpected argument '${positional[2]}'`);
  req.query = positional[0];
  if (publishRepo && !publish) throw new Error("--publish-repo goes with --publish <remote>[/<branch>]");
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      throw new Error(`--url is not an http(s) URL: ${url}`);
    }
  }
  return { req, projectDir: resolve(cwd, positional[1] ?? "."), ...(out ? { out: resolve(cwd, out) } : {}), ...(url ? { url } : {}), ...(linkBase ? { linkBase } : {}), ...(publish ? { publish, publishRepo: resolve(cwd, publishRepo ?? ".") } : {}) };
}

/**
 * behold's app for `projectDir`, served on 127.0.0.1 port 0 for the length of
 * `fn`. The app is the one `behold preview` serves; it writes nothing in the
 * project unless a page posts a layout, and the shot's page posts none.
 */
export async function withLocalServe<T>(cfg: ServerOptions, fn: (base: string) => Promise<T>): Promise<T> {
  const app = createApp({ ...cfg, port: 0, host: "127.0.0.1" });
  const server = await new Promise<ReturnType<typeof serve>>((ok) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => ok(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

/**
 * The app's options for `dir` the way `behold serve <dir>` reads it: a
 * declared workspace with members is served whole (so a search is chant
 * workspace search at its root, behold#913), and a directory of a kind chant
 * cannot read composes as a one-member estate. Quiet: no startup lines.
 */
export async function localServeOptions(dir: string): Promise<ServerOptions> {
  if (hasDeclaration(dir)) {
    const read = await readWorkspace(dir);
    if (read.ok && read.workspace.members.length) {
      const drawn = drawnMembers(read.workspace).map((m) => m.abs);
      return { projectDir: drawn[0] ?? read.workspace.root, projectDirs: drawn, workspace: read.workspace, port: 0 };
    }
  }
  return { projectDir: dir, port: 0, ...(servesAsEstate([dir]) ? { projectDirs: [dir] } : {}) };
}

/** Take the shot the arguments ask for. Refusals come back as ShotRefusal; nothing is written here. */
export async function shotFromArgs(args: ShotArgs, deps?: ShotDeps): Promise<ShotResult> {
  if (args.url) return takeShot(args.url, args.req, { linkBase: args.linkBase ?? args.url, ...(deps ? { deps } : {}) });
  if (!existsSync(args.projectDir)) throw new Error(`project not found at ${args.projectDir}`);
  const cfg = await localServeOptions(args.projectDir);
  return withLocalServe({ ...cfg, ...(args.req.env ? { env: args.req.env } : {}) }, (base) => takeShot(base, args.req, { linkBase: args.linkBase ?? DEFAULT_LINK_BASE, ...(deps ? { deps } : {}) }));
}

/**
 * behold#916: `ask` with no serve running. behold's app for the project,
 * started in this process for the one request, answers GET /api/search: the
 * same route a running serve answers, so no rows are computed anywhere else.
 * `query` is the route's query string. Answers the status and the body.
 */
export async function localSearch(projectDir: string, query: URLSearchParams): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!existsSync(projectDir)) throw new Error(`project not found at ${projectDir}`);
  const cfg = await localServeOptions(projectDir);
  return withLocalServe(cfg, async (base) => {
    const res = await fetch(`${base}/api/search?${query}`, { headers: { accept: "application/json" } });
    const body = (await res.json()) as Record<string, unknown>;
    // The app is gone once this returns: the link points where a serve of the project opens by default.
    if (typeof body.link === "string") body.link = body.link.replace(base, DEFAULT_LINK_BASE);
    return { status: res.status, body };
  });
}

/**
 * behold#926: GET /api/capabilities with no serve running, through behold's
 * app started in this process for the one request. The body is chant's
 * capabilities document as the route answered it, as text, so it reaches
 * the agent byte for byte.
 */
export async function localCapabilities(projectDir: string): Promise<{ status: number; text: string }> {
  if (!existsSync(projectDir)) throw new Error(`project not found at ${projectDir}`);
  const cfg = await localServeOptions(projectDir);
  return withLocalServe(cfg, async (base) => {
    const res = await fetch(`${base}/api/capabilities`, { headers: { accept: "application/json" } });
    return { status: res.status, text: await res.text() };
  });
}

/** The default file: under the OS temp directory, never in the project. */
export function defaultShotPath(now = new Date()): string {
  return join(tmpdir(), `behold-shot-${now.toISOString().replace(/[:.]/g, "-")}.png`);
}

/** `behold shot`: the exit code. */
export async function runShot(rest: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, deps?: ShotDeps, git?: GitRun): Promise<number> {
  let args: ShotArgs | "help";
  try {
    args = parseShotArgs(rest);
  } catch (e) {
    io.err(`behold shot: ${(e as Error).message}\n\n${SHOT_USAGE}`);
    return 2;
  }
  if (args === "help") {
    io.out(SHOT_USAGE);
    return 0;
  }
  let shot: ShotResult;
  try {
    shot = await shotFromArgs(args, deps);
  } catch (e) {
    if (e instanceof ShotRefusal) {
      io.err(`behold shot: ${e.body.error}\n  ${e.body.remedy}\n  (${e.body.code}; nothing written)\n`);
      return 1;
    }
    io.err(`behold shot: ${(e as Error).message}\n  (nothing written)\n`);
    return 1;
  }
  const path = args.out ?? defaultShotPath();
  writeFileSync(path, shot.png);
  io.out(`${path}\n${shot.link}\n`);
  const how = `${shot.state}, ${shot.browser === "chrome" ? "system Chrome" : "chromium-headless-shell"}, ${shot.ms} ms`;
  io.err(`behold shot: wrote ${path} (${how})\n`);
  if (!args.url && !args.linkBase) io.err(`  the link opens on \`npx @intentius/behold serve ${args.projectDir}\`\n`);
  if (shot.state === "failed") {
    if (args.publish) io.err("behold shot: not published: the graph failed\n");
    return 1;
  }
  if (!args.publish) return 0;
  try {
    const p = publishShot({ png: path, target: args.publish, repoDir: args.publishRepo ?? process.cwd(), ...(args.url ? {} : { projectDir: args.projectDir }) }, git);
    io.out(`${p.rawUrl ?? `${p.remoteUrl} ${args.publish.branch}:${p.path} (${p.commit})`}\n`);
    io.err(`behold shot: published ${p.path} to ${args.publish.remote}/${args.publish.branch} through Git LFS (${p.commit.slice(0, 12)})\n`);
    return 0;
  } catch (e) {
    const remedy = e instanceof PublishRefusal ? `\n  ${e.remedy}` : "";
    io.err(`behold shot: not published: ${(e as Error).message}${remedy}\n  (the local file ${path} is kept)\n`);
    return 1;
  }
}
