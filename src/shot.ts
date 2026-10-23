/**
 * behold#915: a PNG of a view, and the link to the same view. The CLI
 * (`behold shot`, src/shot-cli.ts), the route (`GET /api/shot`,
 * src/server.ts) and, with behold#916, the MCP tool all call `takeShot`.
 *
 * The page is behold's own, loaded in a headless browser with
 * `embed=1&bare=1&frame=matches` (web/shot-frame.js): it lights what the view
 * asks for, frames it with the kiosk's arithmetic, draws one caption line and
 * sets `data-behold-shot` on <html>. Nothing is photographed until that
 * attribute is set, so a page that never draws gives a refusal, never a blank
 * image. Nothing here writes a file: the CLI writes the PNG where `-o` says,
 * and the route answers the bytes.
 *
 * The browser comes from `playwright-core`, an optional peer behold does not
 * install (the way the terraform lexicon is, src/terraform-member.ts). The
 * system Chrome is tried first, then Playwright's own
 * `chromium-headless-shell`; with neither, the shot is refused with the
 * install lines.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { declaredPeerRange, resolvedPackage, type OptionalPeer } from "./terraform-member.ts";
import { SHOT_ATTR, SHOT_STATES } from "../web/shot-frame.js";

/** The optional peer that drives the browser. */
export const SHOT_PEER_PKG = "playwright-core";

/** The page's size when none is asked for, in CSS px. */
export const SHOT_WIDTH = 1600;
export const SHOT_HEIGHT = 1000;
const SIZE_MIN = 320;
const SIZE_MAX = 4096;

/** How long the page has to report ready: a live read can be slow. */
export const SHOT_TIMEOUT_MS = 60_000;

/** The view keys a shot passes to the page besides the query (web/view-url.js VIEW_KEYS, less the ones a shot has no use for). */
export const SHOT_VIEW_KEYS = ["member", "zoom", "tier", "lens", "node", "radial", "alike", "focus", "run", "pull"] as const;

export type ShotState = "drawn" | "no-matches" | "failed";

export type ShotRefusalCode = "no-browser" | "no-search" | "bad-request" | "not-ready" | "public";

/** #193's structured refusal: what went wrong, a code, and the one thing that fixes it. */
export interface ShotRefusalBody {
  error: string;
  code: ShotRefusalCode;
  remedy: string;
}

const STATUS: Record<ShotRefusalCode, number> = { "no-browser": 501, "no-search": 501, "bad-request": 400, "not-ready": 504, public: 403 };

/** A shot that could not be taken. Nothing was written. */
export class ShotRefusal extends Error {
  readonly status: number;
  constructor(readonly body: ShotRefusalBody) {
    super(body.error);
    this.status = STATUS[body.code];
  }
  get code(): ShotRefusalCode {
    return this.body.code;
  }
}

/** What a shot asks for. `view` holds the stand-in view keys (SHOT_VIEW_KEYS). */
export interface ShotRequest {
  query?: string;
  env?: string;
  snapshot?: string;
  view?: Record<string, string>;
  width?: number;
  height?: number;
  timeoutMs?: number;
}

export interface ShotResult {
  png: Buffer;
  state: ShotState;
  /** The same view without the shot's frame parameters, on `linkBase`. */
  link: string;
  /** Which browser took it: the system Chrome or Playwright's headless shell. */
  browser: BrowserWhich;
  ms: number;
  /** The cards drawn lit (all of them when the view asked for nothing); 0 with no matches. */
  matched: number;
  /** The graph's viewBox as photographed, in svg units. */
  viewBox?: number[];
}

// ---------------------------------------------------------------------------
// The query -> view step.
// ---------------------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f]/;
const isEnvName = (env: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(env);
const bad = (error: string, remedy: string): ShotRefusal => new ShotRefusal({ error, code: "bad-request", remedy });

/**
 * The view a shot asks the page for: the query parameters behold's page reads,
 * without the frame parameters. The one place a query becomes a view.
 *
 * behold#913 fills this in: once `q` is a view key that lights chant's matches,
 * a query passes through as `q` (checked by view-url.js `checkQuery`) and
 * the "no-search" refusal below goes. Until then a query is refused, and a
 * shot frames what the view's own `node` or `focus` selects.
 */
export function queryView(req: ShotRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const query = typeof req.query === "string" ? req.query.trim() : "";
  if (query) {
    if (query.length > 2000 || CONTROL.test(query)) throw bad("a query is 1 to 2000 characters with no control characters", "Shorten the query, or take the newlines out of it.");
    throw new ShotRefusal({
      error: `behold can't answer a query yet: lighting the matches of "${query}" needs the \`q\` view key (behold#913, which reads chant workspace search).`,
      code: "no-search",
      remedy: "Until then, frame a selection: pass the view's node or focus (behold shot --view node=<id>, or GET /api/shot?node=<id>).",
    });
  }
  if (req.env !== undefined && req.env !== "") {
    if (!isEnvName(req.env)) throw bad(`not an env name: ${JSON.stringify(req.env)}`, "Pass one of the project's environments.");
    out.env = req.env;
  }
  if (req.snapshot !== undefined && req.snapshot !== "") {
    if (!out.env) throw bad("a snapshot is an env's recorded snapshot, so it needs an env", "Pass --env <name> with --snapshot (snapshot=latest replays the newest).");
    if (req.snapshot.length > 200 || CONTROL.test(req.snapshot) || /\s/.test(req.snapshot)) throw bad(`not a snapshot ref: ${JSON.stringify(req.snapshot)}`, "Pass latest, or a snapshot ref chant lists.");
    out.snapshot = req.snapshot;
  }
  for (const [k, v] of Object.entries(req.view ?? {})) {
    if (!(SHOT_VIEW_KEYS as readonly string[]).includes(k)) throw bad(`not a view key a shot takes: ${k}`, `Use one of ${SHOT_VIEW_KEYS.join(", ")}.`);
    if (typeof v !== "string" || !v.trim() || v.length > 500 || CONTROL.test(v)) throw bad(`a bad value for ${k}`, "Pass a short value with no control characters.");
    out[k] = v.trim();
  }
  if (!query && !out.node && !out.focus) throw bad("nothing to frame: a shot needs a query, or a view with node or focus", "Pass the view's node or focus (behold shot --view node=<id>).");
  return out;
}

/** The page the browser loads, and the link a person opens: the same view, the page with the shot's frame on. */
export function shotUrls(serve: string, view: Record<string, string>, linkBase: string = serve): { page: string; link: string } {
  const trim = (u: string): string => u.replace(/\/+$/, "");
  const page = new URLSearchParams(view);
  page.set("embed", "1");
  page.set("bare", "1");
  page.set("frame", "matches");
  const link = new URLSearchParams(view).toString();
  return { page: `${trim(serve)}/?${page}`, link: `${trim(linkBase)}/${link ? `?${link}` : ""}` };
}

/** A size in px within bounds, or the default; a bad one is refused. */
export function shotSize(v: unknown, fallback: number, name: string): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < SIZE_MIN || n > SIZE_MAX) throw bad(`${name} must be a whole number of px from ${SIZE_MIN} to ${SIZE_MAX}`, `Pass --${name} ${fallback}, or leave it out.`);
  return n;
}

// ---------------------------------------------------------------------------
// The peer, and the browser.
// ---------------------------------------------------------------------------

/** The parts of playwright-core's API a shot uses. */
export interface ShotPage {
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForFunction(fn: (attr: string) => unknown, arg: string, opts: { timeout: number; polling: number }): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  screenshot(opts: { type: "png" }): Promise<Buffer>;
}
export interface ShotBrowser {
  newPage(opts: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<ShotPage>;
  close(): Promise<void>;
}
export interface ShotChromium {
  launch(opts: { channel?: string; headless: boolean }): Promise<ShotBrowser>;
}
export type BrowserWhich = "chrome" | "headless-shell";

/** For tests: a stand-in for the peer. `null` is "the peer is not installed". */
export interface ShotDeps {
  chromium?: () => ShotChromium | null;
}

const here = (): string => dirname(fileURLToPath(import.meta.url));

/** The page's globals the driver's functions read; they run in the browser, and tsc here has no DOM lib. */
declare const document: {
  documentElement: { getAttribute(name: string): string | null };
  querySelectorAll(selector: string): { length: number };
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
};

/** The peer as installed beside behold: the range behold declares and the version found, if any. */
export function shotPeer(from = here()): OptionalPeer & { dir?: string } {
  const range = declaredPeerRange(SHOT_PEER_PKG, join(from, ".."));
  const found = resolvedPackage(SHOT_PEER_PKG, from);
  return { pkg: SHOT_PEER_PKG, ...(range ? { range } : {}), ...(found ? { version: found.version, dir: found.dir } : {}) };
}

/** The install lines a refusal carries. */
export function installLines(range = shotPeer().range): string {
  return `npm i -g ${SHOT_PEER_PKG}@${range ?? "latest"}, then install Google Chrome or run npx ${SHOT_PEER_PKG} install chromium-headless-shell`;
}

/** playwright-core's `chromium`, loaded from beside behold, or null when it is not installed. */
export function loadChromium(from = here()): ShotChromium | null {
  const peer = shotPeer(from);
  if (!peer.version) return null;
  try {
    const mod = createRequire(join(resolve(from), "noop.js"))(SHOT_PEER_PKG) as { chromium?: ShotChromium };
    return mod.chromium ?? null;
  } catch {
    return null;
  }
}

const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split("\n").find((l) => l.trim()) ?? "failed";

/**
 * A browser: the system Chrome first, then Playwright's headless shell.
 * Refused with the install lines when the peer is missing or neither launches.
 */
export async function launchShotBrowser(deps: ShotDeps = {}): Promise<{ browser: ShotBrowser; which: BrowserWhich }> {
  const chromium = (deps.chromium ?? (() => loadChromium()))();
  if (!chromium) {
    throw new ShotRefusal({
      error: `A shot needs a headless browser, which behold does not install: ${SHOT_PEER_PKG} is not resolvable from ${here()}.`,
      code: "no-browser",
      remedy: `Install it beside behold: ${installLines()}.`,
    });
  }
  const tried: string[] = [];
  const order: Array<[BrowserWhich, { channel?: string; headless: boolean }]> = [
    ["chrome", { channel: "chrome", headless: true }],
    ["headless-shell", { headless: true }],
  ];
  for (const [which, opts] of order) {
    try {
      return { browser: await chromium.launch(opts), which };
    } catch (e) {
      tried.push(`${which === "chrome" ? "system Chrome" : "chromium-headless-shell"}: ${firstLine(e)}`);
    }
  }
  throw new ShotRefusal({
    error: `A shot needs a headless browser, and none launched (${tried.join("; ")}).`,
    code: "no-browser",
    remedy: `Install Google Chrome, or run npx ${SHOT_PEER_PKG} install chromium-headless-shell.`,
  });
}

// ---------------------------------------------------------------------------
// The shot.
// ---------------------------------------------------------------------------

/**
 * Photograph `view` on the serve at `serve`. Launches a browser, loads the
 * page, waits for `data-behold-shot`, and takes the picture; the browser is
 * closed whatever happens. A page that never reports ready, or reports a drawn
 * graph with no cards, is refused: nothing comes back to write.
 */
export async function takeShot(serve: string, req: ShotRequest, opts: { linkBase?: string; deps?: ShotDeps } = {}): Promise<ShotResult> {
  const t0 = Date.now();
  const view = queryView(req);
  const width = shotSize(req.width, SHOT_WIDTH, "width");
  const height = shotSize(req.height, SHOT_HEIGHT, "height");
  const timeout = req.timeoutMs ?? SHOT_TIMEOUT_MS;
  const { page: pageUrl, link } = shotUrls(serve, view, opts.linkBase ?? serve);
  const { browser, which } = await launchShotBrowser(opts.deps);
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout });
      await page.waitForFunction((attr: string) => document.documentElement.getAttribute(attr), SHOT_ATTR, { timeout, polling: 100 });
    } catch (e) {
      throw new ShotRefusal({
        error: `The page never reported ready within ${Math.round(timeout / 1000)} s (${firstLine(e)}), so no picture was taken.`,
        code: "not-ready",
        remedy: `Open ${link} to see why it does not draw.`,
      });
    }
    const seen = await page.evaluate(
      (attr: string) => ({
        state: document.documentElement.getAttribute(attr),
        cards: document.querySelectorAll("#graph [data-node-id]").length,
        lit: document.querySelectorAll("#graph [data-node-id]:not([data-shot-dim])").length,
        viewBox: document.querySelector("#graph svg")?.getAttribute("viewBox") ?? null,
      }),
      SHOT_ATTR,
    );
    const state = seen.state as ShotState;
    if (!SHOT_STATES.includes(state)) {
      throw new ShotRefusal({ error: `The page reported ${JSON.stringify(seen.state)}, not a shot state.`, code: "not-ready", remedy: "Use a behold whose page knows frame=matches." });
    }
    if (state !== "failed" && seen.cards === 0) {
      throw new ShotRefusal({ error: "The page drew no cards, so no picture was taken.", code: "not-ready", remedy: `Open ${link} to see what it draws.` });
    }
    const png = await page.screenshot({ type: "png" });
    const viewBox = (seen.viewBox ?? "").split(/[\s,]+/).map(Number);
    return { png, state, link, browser: which, ms: Date.now() - t0, matched: state === "no-matches" ? 0 : seen.lit, ...(viewBox.length === 4 && viewBox.every(Number.isFinite) ? { viewBox } : {}) };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Shots one at a time per serve: each starts a browser, and a burst of
 * requests should not start a dozen.
 */
export function shotQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
