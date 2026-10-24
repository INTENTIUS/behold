/**
 * The kiosk (#569 step 2): a looping demo of one change across several
 * Terraform states (terragucci#1014), narrated from the `demo.json` its loop
 * driver writes to the reports bucket at every step.
 *
 * - `GET /api/terragucci/demo` reads `demo.json` at the top of the
 *   `--terragucci` source (the reports prefix, beside index.json): one GET of
 *   one object, the same read as every other report, so it works with a
 *   GetObject-only identity and under `--public`. Reads are shared for
 *   {@link DEMO_READ_TTL_MS}, so any number of open kiosks ask the bucket at
 *   most that often.
 * - `GET /kiosk` serves web/kiosk.html, which asks that route, the reports
 *   (`/api/terragucci`), the run view (`/api/terragucci/progress`) and the
 *   event stream, and writes nothing.
 *
 * The format is terragucci's, fixed in terragucci#1014: every field below,
 * none renamed. `about` (behold#571) came later and is optional: the
 * scenario's card, which the driver reads from the scenario's about.json in
 * terragucci's example-demo/; a demo.json without it, or with null, shows no
 * card. A scenario id behold doesn't know is shown by the title the driver
 * wrote. `intro`, `name`, `scenarios` and `index` (behold#571, terragucci#1050)
 * are optional too: the paragraph on the problem the demo solves, the
 * scenario's short label in plain words, and how many scenarios the loop runs
 * and which one this is (0 or null for the base). One of them of the wrong type is left out
 * (null), never a refusal of the whole narration. `tool` and `repo` (behold#571)
 * are optional the same way: the tool the scenario shows and the forge repo
 * its cycle runs on, which the per-tool pages read. `delivery` (behold#571) is
 * optional the same way: the line the kiosk's metrics pane shows over the
 * delivery (DORA) numbers, which says whose numbers they are.
 *
 * Per-tool pages (behold#571): `GET /<tool>` for each of {@link VENDOR_TOOLS}
 * serves the kiosk page for that tool alone, and `GET
 * /api/terragucci/cycles/<tool>` reads `cycles/<tool>/latest.json`, the
 * tool's newest cycle that ran to its reset, which such a page replays while
 * another tool's scenario is live.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { hostName } from "./request-guard.ts";
import { deniedWords, TerragucciDenied, type TerragucciSource } from "./terragucci-source.ts";

export const DEMO_KEY = "demo.json";

/** How long one read of demo.json is shared between kiosks. The driver holds a step 20 s. */
export const DEMO_READ_TTL_MS = 2_000;

export const DEMO_STEPS = ["pull-request", "planned", "merged", "applying", "waiting", "approved", "failed", "resumed", "applied", "reset", "stalled"] as const;
export type DemoStep = (typeof DEMO_STEPS)[number];

/** The scenario's card (behold#571): what the change is, what to watch for, what it shows. */
export interface DemoAbout {
  changes: string;
  watch: string;
  shows: string;
}

export const DEMO_ABOUT_FIELDS = ["changes", "watch", "shows"] as const;

export interface Demo {
  cycle: number;
  scenario: string;
  title: string;
  step: DemoStep;
  label: string;
  started_at: string;
  /** from: when the driver started waiting for this action (terragucci 0.4.34 on); absent from older drivers. */
  next: { action: string; from?: string; at: string | null } | null;
  pull: number | null;
  commit: string | null;
  /** Null when demo.json has no card for the scenario (the base, or a driver before behold#571). */
  about: DemoAbout | null;
  /** One paragraph, the problem the demo solves (behold#571); null without one. */
  intro: string | null;
  /** The scenario's short label in plain words, "a new subnet" (terragucci#1050); null without one. */
  name: string | null;
  /** How many scenarios the loop runs (behold#571); null without it, or 0. */
  scenarios: number | null;
  /** This scenario's place in the loop, 1-based (behold#571); null without it. */
  index: number | null;
  /** This scenario's act within its own demo, 1-based (terragucci demo.json `act`); null from a driver before it. */
  act: number | null;
  /** How many acts its demo has in this loop (`acts`); null without it. */
  acts: number | null;
  /** The tool the scenario shows, "terragrunt" (behold#571); null from a driver before it. */
  tool: string | null;
  /** The forge repo the cycle runs on, "<admin>/demo-terragrunt" (behold#571); null from a driver before it. */
  repo: string | null;
  /** The line over the delivery (DORA) numbers: they are the demo loop's own (behold#571); null from a driver before it. */
  delivery: string | null;
  /** The beat of a scenario told in several (terralith: stock, adopt, split, team, cross); null otherwise (terragucci#1131). */
  beat: string | null;
  /**
   * behold#631: the chapter of the story this step is in (a chant fan-out's
   * four: the change goes out, cluster-a breaks, the fix, done), with its
   * headline and, when the driver writes one, a short name for the track.
   * Absent from drivers and scenarios without chapters.
   */
  chapter?: DemoChapter;
  /**
   * behold#743: an apply made outside the pipeline at this step (terragucci#1163's fan-out-choudoufu: an operator's
   * `choudoufu apply` on app-01's estate while the pipeline's wave 3 applies it). Absent when demo.json has null, none,
   * or one not of its form.
   */
  outside?: DemoOutside;
  /**
   * behold#757: what is special about this step, in the scenario's own words (terragucci-89, chant#4106): the kiosk
   * opens it as a modal in Watch. Absent when demo.json has null, none, or one whose title or body is not a
   * non-empty string.
   */
  highlight?: DemoHighlight;
  /** behold#936: the prompt pane's one beat for this step (terragucci's `ask`); null without one, or one not of its form. */
  ask?: DemoAsk | null;
  /** behold#936: the step's beats played in order, in place of `ask`; null without any. */
  asks?: DemoAsk[] | null;
  /** behold#936: the line shown once in the pane at the scenario's first step; null without one. */
  opening?: string | null;
  /** behold#936: the line shown in the pane at the scenario's last step; null without one. */
  closing?: string | null;
}

/**
 * behold#936: one beat of the prompt pane. A prompt (typed, `>`) or an action (shown at once, a check mark), never
 * both; a reply template filled from the step's report; and what the graph does (behold#937 reads light, paths, ghost).
 */
export interface DemoAsk {
  prompt: string | null;
  action: string | null;
  reply: string | null;
  /** The status line a step shows (a spinner, the text and a timer) under the transcript; an ask with only this is valid. */
  status: string | null;
  /** Tip cards the kiosk shows over the graph while this beat's busy line shows; absent when the ask carries none. */
  tips?: DemoTip[];
  /** Short diff lines shown under the reply (`+ network  aws_subnet.x  10.0.2.0/24`); absent when the ask carries none. */
  diff?: string[];
  light: string[] | null;
  paths: boolean | null;
  ghost: boolean | null;
}

/** A tip card: a title and a body, both non-empty. */
export interface DemoTip {
  title: string;
  body: string;
  /** A small link at the end of the card: https on intentius.io or github.com/INTENTIUS only; absent otherwise. */
  link?: { label: string; url: string };
}

/** A tip's `link`: a label (default "Read how") and an https URL on intentius.io or github.com/INTENTIUS; undefined otherwise. */
export function tipLinkOf(v: unknown): { label: string; url: string } | undefined {
  if (!isRecord(v)) return undefined;
  const raw = text(v.url);
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
  const host = u.hostname.toLowerCase();
  const ok = host === "intentius.io" || host.endsWith(".intentius.io") || (host === "github.com" && (u.pathname === "/INTENTIUS" || u.pathname.startsWith("/INTENTIUS/")));
  return ok ? { label: text(v.label) ?? "Read how", url: u.href } : undefined;
}

/** An ask's `tips`: the entries with a non-empty title and body, in order; undefined when none are valid. */
export function tipsOf(v: unknown): DemoTip[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const tips: DemoTip[] = [];
  for (const t of v) {
    if (!isRecord(t)) continue;
    const title = text(t.title);
    const body = text(t.body);
    const link = tipLinkOf(t.link);
    if (title && body) tips.push({ title, body, ...(link ? { link } : {}) });
  }
  return tips.length ? tips : undefined;
}

/** Most lines, and most characters per line, of an ask's `diff`. */
export const DIFF_MAX_LINES = 8;
export const DIFF_MAX_CHARS = 120;

/** An ask's `diff`: its non-empty strings of at most {@link DIFF_MAX_CHARS} characters, the first {@link DIFF_MAX_LINES}; undefined when none are valid. */
export function diffOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const lines = v.filter((x): x is string => typeof x === "string" && x.trim() !== "" && x.length <= DIFF_MAX_CHARS).map((x) => x.trimEnd());
  return lines.length ? lines.slice(0, DIFF_MAX_LINES) : undefined;
}

/**
 * behold#936: a demo.json `ask`, or null when it is not an object with a prompt, an action, a reply or a status. A field of the
 * wrong type is null. A reply alone is a beat: an applied step prints the agent's reply with no line of the person's.
 */
export function askOf(v: unknown): DemoAsk | null {
  if (!isRecord(v)) return null;
  const prompt = text(v.prompt);
  const action = prompt ? null : text(v.action);
  const reply = text(v.reply);
  const status = text(v.status);
  if (!prompt && !action && !reply && !status) return null;
  const tips = tipsOf(v.tips);
  const diff = diffOf(v.diff);
  return {
    prompt,
    action,
    reply,
    status,
    ...(tips ? { tips } : {}),
    ...(diff ? { diff } : {}),
    light: Array.isArray(v.light) && v.light.every((x) => str(x) && x.trim()) ? (v.light as string[]).map((x) => x.trim()) : null,
    paths: typeof v.paths === "boolean" ? v.paths : null,
    ghost: typeof v.ghost === "boolean" ? v.ghost : null,
  };
}

/** behold#936: a demo.json `asks`, its valid beats in order, or null when it has none. */
export function asksOf(v: unknown): DemoAsk[] | null {
  if (!Array.isArray(v)) return null;
  const beats = v.map(askOf).filter((a): a is DemoAsk => a !== null);
  return beats.length ? beats : null;
}

/** behold#757: a step's `highlight`, as the driver writes it. */
export interface DemoHighlight {
  title: string;
  body: string;
}

/** behold#757: a demo step's `highlight`, or undefined unless its title and body are both non-empty strings (chant#4106's floor). */
export function highlightOf(v: unknown): DemoHighlight | undefined {
  if (!isRecord(v)) return undefined;
  const title = text(v.title);
  const body = text(v.body);
  return title && body ? { title, body } : undefined;
}

/** behold#743: demo.json's `outside`, as the driver writes it (terragucci#1163). */
export interface DemoOutside {
  who: string;
  estate: string;
  command: string;
  state: (typeof OUTSIDE_STATES)[number];
  started_at: string | null;
  ended_at: string | null;
  resources: string[];
  log: string[];
}

export const OUTSIDE_STATES = ["applying", "applied", "failed"] as const;

/** behold#743: a demo.json `outside`, or undefined when it is null, absent or not of the driver's form. */
export function outsideOf(v: unknown): DemoOutside | undefined {
  if (!isRecord(v)) return undefined;
  const estate = text(v.estate);
  const state = v.state;
  if (!estate || !str(state) || !(OUTSIDE_STATES as readonly string[]).includes(state)) return undefined;
  const time = (t: unknown): string | null => (str(t) && UTC_MS.test(t) ? t : null);
  const lines = (l: unknown, n: number): string[] => (Array.isArray(l) ? l.filter(str).map((x) => x.slice(0, 300)) : []).slice(-n);
  return {
    who: text(v.who) ?? "someone",
    estate,
    command: text(v.command) ?? "an apply",
    state: state as DemoOutside["state"],
    started_at: time(v.started_at),
    ended_at: time(v.ended_at),
    resources: lines(v.resources, 50).filter((r) => r.trim()),
    log: lines(v.log, 20),
  };
}

export interface DemoChapter {
  n: number;
  of: number;
  headline: string;
  short?: string;
}

/** A demo.json `chapter`, or undefined when it is not one. */
export function chapterOf(v: unknown): DemoChapter | undefined {
  if (!isRecord(v)) return undefined;
  const n = v.n;
  const of = v.of;
  if (!int(n) || !int(of) || n < 1 || of < n || !str(v.headline) || !v.headline.trim()) return undefined;
  const short = text(v.short) ?? text(v.name) ?? text(v.title);
  return { n, of, headline: v.headline.trim(), ...(short ? { short } : {}) };
}

export type DemoAnswer =
  | { source: string; read: string; demo: Demo }
  | { source: string; read: string; demo: null; absent: string }
  | { source: string; read: string; demo: null; error: string; code: "terragucci-demo" };

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** behold#743: the same, with or without milliseconds. */
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

const positive = (v: unknown): number | null => (int(v) && v > 0 ? v : null);

/** What is wrong with a demo.json, or undefined when it is the fixed format. */
export function demoProblem(doc: unknown): string | undefined {
  if (!isRecord(doc)) return "it is not an object";
  if (!int(doc.cycle)) return "cycle is not an integer";
  if (!str(doc.scenario) || !doc.scenario) return "scenario is not a string";
  if (!str(doc.title)) return "title is not a string";
  if (!str(doc.step) || !(DEMO_STEPS as readonly string[]).includes(doc.step)) return `step is not one of ${DEMO_STEPS.join(", ")}`;
  if (!str(doc.label)) return "label is not a string";
  if (!str(doc.started_at) || !UTC.test(doc.started_at)) return "started_at is not a UTC time (YYYY-MM-DDTHH:MM:SSZ)";
  if (doc.next !== null) {
    if (!isRecord(doc.next)) return "next is neither an object nor null";
    if (!str(doc.next.action)) return "next.action is not a string";
    if (doc.next.at !== null && !(str(doc.next.at) && UTC.test(doc.next.at))) return "next.at is neither a UTC time nor null";
    if (doc.next.from !== undefined && !(str(doc.next.from) && UTC.test(doc.next.from))) return "next.from is not a UTC time";
  }
  if (doc.pull !== null && !int(doc.pull)) return "pull is neither an integer nor null";
  if (doc.commit !== null && !str(doc.commit)) return "commit is neither a string nor null";
  if (doc.about !== undefined && doc.about !== null) {
    if (!isRecord(doc.about)) return "about is neither an object nor null";
    for (const f of DEMO_ABOUT_FIELDS) if (!str(doc.about[f]) || !doc.about[f].trim()) return `about.${f} is not a non-empty string`;
  }
  return undefined;
}

/** One read of demo.json from the source. Never throws: a refusal is an answer the kiosk shows. */
export async function readDemo(source: TerragucciSource, now: Date = new Date()): Promise<DemoAnswer> {
  const base = { source: source.location, read: now.toISOString() };
  let body: string | undefined;
  try {
    body = await source.read(DEMO_KEY);
  } catch (e) {
    if (e instanceof TerragucciDenied) return { ...base, demo: null, error: deniedWords(e, "the demo's narration"), code: "terragucci-demo" };
    return { ...base, demo: null, error: `behold could not read ${DEMO_KEY} from ${source.location}: ${e instanceof Error ? e.message : String(e)}`, code: "terragucci-demo" };
  }
  if (body === undefined) {
    return { ...base, demo: null, absent: `${source.location} has no ${DEMO_KEY}: the demo's loop driver writes it at every step (terragucci's stack/demo.sh), beside index.json.` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return { ...base, demo: null, error: `${DEMO_KEY} in ${source.location} is not JSON.`, code: "terragucci-demo" };
  }
  const problem = demoProblem(doc);
  if (problem) return { ...base, demo: null, error: `${DEMO_KEY} in ${source.location} is not the demo's format: ${problem}.`, code: "terragucci-demo" };
  return { ...base, demo: demoOf(doc as Demo) };
}

const text = (v: unknown): string | null => (str(v) && v.trim() ? v.trim() : null);

/** demo.json's fields as the kiosk reads them, from a document {@link demoProblem} passed. */
export function demoOf(d: Demo): Demo {
  return {
    cycle: d.cycle,
    scenario: d.scenario,
    title: d.title,
    step: d.step,
    label: d.label,
    started_at: d.started_at,
    next: d.next ? { action: d.next.action, ...(d.next.from ? { from: d.next.from } : {}), at: d.next.at } : null,
    pull: d.pull,
    commit: d.commit,
    about: d.about ? { changes: d.about.changes, watch: d.about.watch, shows: d.about.shows } : null,
    intro: text(d.intro),
    name: text(d.name),
    scenarios: positive(d.scenarios),
    index: positive(d.index),
    act: positive(d.act),
    acts: positive(d.acts),
    tool: text(d.tool),
    repo: text(d.repo),
    delivery: text(d.delivery),
    beat: text(d.beat),
    ...((): { chapter?: DemoChapter } => {
      const ch = chapterOf((d as { chapter?: unknown }).chapter);
      return ch ? { chapter: ch } : {};
    })(),
    // behold#743: kept only when it is one, so a demo.json without it reads as before.
    ...((): { outside?: DemoOutside } => {
      const o = outsideOf((d as { outside?: unknown }).outside);
      return o ? { outside: o } : {};
    })(),
    ask: askOf((d as { ask?: unknown }).ask),
    asks: asksOf((d as { asks?: unknown }).asks),
    opening: text((d as { opening?: unknown }).opening),
    closing: text((d as { closing?: unknown }).closing),
    // behold#757: so is the step's highlight.
    ...((): { highlight?: DemoHighlight } => {
      const h = highlightOf((d as { highlight?: unknown }).highlight);
      return h ? { highlight: h } : {};
    })(),
  };
}

/** `GET /api/terragucci/demo`, the narration's read, shared for {@link DEMO_READ_TTL_MS}. */
export function terragucciDemoRoute(app: Hono, source: TerragucciSource, opts: { now?: () => Date } = {}): void {
  let cached: { at: number; read: Promise<DemoAnswer> } | undefined;
  app.get("/api/terragucci/demo", async (c) => {
    const at = Date.now();
    if (!cached || at - cached.at >= DEMO_READ_TTL_MS) cached = { at, read: readDemo(source, opts.now ? opts.now() : new Date()) };
    const a = await cached.read;
    return c.json(a, "error" in a ? 502 : 200, { "cache-control": "no-store" });
  });
}

const disabledPage =
  `<!doctype html><meta charset=utf-8><title>behold · live demo</title>` +
  `<script type="module">import { initTheme } from "/theme.js"; initTheme();</script>` +
  `<body style="font:16px system-ui;background:var(--bg,#1e1e2e);color:var(--fg,#cdd6f4);padding:2rem">` +
  `<h3>The kiosk follows a terragucci demo</h3><p style="color:var(--muted,#777a8c)">Start behold with <code>--terragucci &lt;reports source&gt;</code>; the kiosk reads <code>demo.json</code> there.</p></body>`;

/** The demos worth listing: those live in demo.json now, or with a published cycle. In {@link VENDOR_TOOLS}' order. */
export async function listedDemos(source: TerragucciSource, now: Date = new Date()): Promise<{ demos: Array<{ tool: VendorTool; live: boolean }>; live: VendorTool | null }> {
  const d = await readDemo(source, now);
  const liveTool = d.demo && d.demo.scenario !== "base" && d.demo.tool && isVendorTool(d.demo.tool) ? d.demo.tool : null;
  const demos: Array<{ tool: VendorTool; live: boolean }> = [];
  for (const tool of VENDOR_TOOLS) {
    if (tool === liveTool) demos.push({ tool, live: true });
    else if ((await readCycle(source, tool, now)).cycle) demos.push({ tool, live: false });
  }
  return { demos, live: liveTool };
}

/** `GET /api/terragucci/demos`: the listed demos, shared for {@link DEMO_READ_TTL_MS}. */
export function terragucciDemosRoute(app: Hono, source: TerragucciSource, opts: { now?: () => Date } = {}): () => ReturnType<typeof listedDemos> {
  let cached: { at: number; read: ReturnType<typeof listedDemos> } | undefined;
  const read = () => {
    const at = Date.now();
    if (!cached || at - cached.at >= DEMO_READ_TTL_MS) cached = { at, read: listedDemos(source, opts.now ? opts.now() : new Date()) };
    return cached.read;
  };
  app.get("/api/terragucci/demos", async (c) => c.json(await read(), 200, { "cache-control": "no-store" }));
  return read;
}

/**
 * `GET /`: the demo, served directly: the live demo's page, else the first listed one. A request with a query (the
 * kiosk's own graph frame loads `/?embed=1&...`) goes on to the app. `GET /kiosk` redirects to `/`, so old links work.
 * `listed` says which demos are listed; without it the first demo is served.
 */
export function kioskRoute(app: Hono, webRoot: string, enabled: boolean, allowedHosts: string[] = [], opts: KioskPageOptions = {}): void {
  app.get("/kiosk", (c) => {
    // behold#752: with chant's fan-out demo the only one served (`--chant-demo`, no `--terragucci`), /kiosk is its page.
    if (!enabled && opts.chantDemo) return chantFanoutPage(c, webRoot, allowedHosts, "/kiosk", opts.ciRuns);
    if (!enabled) return c.html(disabledPage, 404);
    return c.redirect("/", 302);
  });
  app.get("/", async (c, next) => {
    if (!enabled || new URL(c.req.url).search) return next();
    let tool: VendorTool = VENDOR_TOOLS[0];
    try {
      const l = opts.listed ? await opts.listed() : undefined;
      if (l) tool = l.live ?? l.demos[0]?.tool ?? tool;
    } catch {
      /* the first demo's page says it has not run */
    }
    return demoPage(c, webRoot, allowedHosts, tool, "/", opts.ciRuns);
  });
}

// ---------------------------------------------------------------------------
// behold#571: link previews. A link to the demo pasted into LinkedIn, Slack
// or X shows behold's share image (docs/scripts/brand/share.mjs draws it into
// web/share.png). The crawlers ignore a relative og:image or og:url, so both
// are absolute, built from the request's Host. Only a name the serve was
// told to answer (`--allow-host`, which the demo host sets to its public
// name) is ever written into the page; any other Host gets the title and
// description alone.

/** The share image: a static file in web/, its size, and what it shows. */
export const SHARE_IMAGE = {
  path: "/share.png",
  width: 1200,
  height: 630,
  alt: "The pixel behold logo above the word BEHOLD and the line: a live infrastructure loop you can watch.",
} as const;

/** How long a browser or crawler keeps the share image. It changes only with a release. */
export const SHARE_IMAGE_MAX_AGE_SECS = 86_400;

/**
 * The origin to write into a page's absolute URLs, or undefined when the
 * request's Host isn't one of `allowedHosts`. https when the proxy says the
 * request reached it over https (X-Forwarded-Proto), http otherwise. A port
 * on the Host is kept only when it is digits.
 */
export function shareOrigin(host: string | undefined, forwardedProto: string | undefined, allowedHosts: string[]): string | undefined {
  if (!host) return undefined;
  const m = /^([a-z0-9.-]+)(:\d{1,5})?$/.exec(host.trim().toLowerCase());
  if (!m) return undefined;
  const name = m[1]!;
  if (!allowedHosts.some((h) => hostName(h) === name)) return undefined;
  const proto = (forwardedProto ?? "").split(",")[0]!.trim().toLowerCase() === "https" ? "https" : "http";
  return `${proto}://${name}${m[2] ?? ""}`;
}

const attr = (v: string): string => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * kiosk.html with its title and the Open Graph and Twitter tags in place of
 * its <title>. og:url, og:image and twitter:image only with an `origin`.
 */
export function sharePage(html: string, p: { title: string; description: string; origin: string | undefined; path: string }): string {
  const tags: Array<[string, string, string]> = [
    ["property", "og:type", "website"],
    ["property", "og:site_name", "behold"],
    ["property", "og:title", p.title],
    ["property", "og:description", p.description],
    ["name", "description", p.description],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", p.title],
    ["name", "twitter:description", p.description],
  ];
  if (p.origin) {
    const image = `${p.origin}${SHARE_IMAGE.path}`;
    tags.push(
      ["property", "og:url", `${p.origin}${p.path}`],
      ["property", "og:image", image],
      ["property", "og:image:type", "image/png"],
      ["property", "og:image:width", String(SHARE_IMAGE.width)],
      ["property", "og:image:height", String(SHARE_IMAGE.height)],
      ["property", "og:image:alt", SHARE_IMAGE.alt],
      ["name", "twitter:image", image],
      ["name", "twitter:image:alt", SHARE_IMAGE.alt],
    );
  }
  const head = [`<title>${attr(p.title)}</title>`, ...tags.map(([k, n, v]) => `<meta ${k}="${n}" content="${attr(v)}" />`)].join("\n    ");
  return html.replace(/<title>[^<]*<\/title>/, () => head);
}

/** `GET /share.png`: the share image, cacheable, in every mode (the public one included). */
export function shareImageRoute(app: Hono, webRoot: string): void {
  app.get(SHARE_IMAGE.path, () => {
    const png = readFileSync(join(webRoot, "share.png"));
    return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": `public, max-age=${SHARE_IMAGE_MAX_AGE_SECS}` } });
  });
}

// ---------------------------------------------------------------------------
// behold#571: a page per tool. Each tool's maker can share
// `https://<host>/<tool>`: the kiosk with that tool's scenarios alone, live
// when demo.json's `tool` is it, otherwise a replay of its newest cycle.

/**
 * The demos with a page of their own, in the order they are listed: the multi-state plan-and-apply ones. web/kiosk-vendor.js
 * VENDORS has their banner words. A demo is listed once its tool has a published cycle or is live ({@link listedDemos}).
 */
export const VENDOR_TOOLS = ["choudoufu-compose", "terragrunt-choudoufu", "atmos-choudoufu"] as const;
export type VendorTool = (typeof VENDOR_TOOLS)[number];

/** Each demo's name for the page's title. web/kiosk-vendor.js VENDORS has the same names. */
export const VENDOR_NAMES: Record<VendorTool, string> = {
  "choudoufu-compose": "terragucci and choudoufu",
  "terragrunt-choudoufu": "choudoufu with Terragrunt",
  "atmos-choudoufu": "choudoufu with Atmos",
};

/** The tools that had a page before the list narrowed to the demos above: their URLs redirect to `/`. */
export const LEGACY_TOOLS = ["terraform", "terragrunt", "cdk-terrain", "choudoufu", "chant", "chant-fanout", "tofu-fanout", "choudoufu-fanout"] as const;

export const isVendorTool = (v: string): v is VendorTool => (VENDOR_TOOLS as readonly string[]).includes(v);

export const cycleKey = (tool: string): string => `cycles/${tool}/latest.json`;

/**
 * behold#631: a tool name a cycle may be read for: a vendor page's, or any
 * demo.json `tool` whose kiosk draws the cycle track from its last cycle
 * (`chant-fanout`, a page of its own since behold#746). Lower-case words and dashes.
 */
export const cycleToolName = (v: string): boolean => isVendorTool(v) || /^[a-z0-9][a-z0-9-]{0,40}$/.test(v);

/** How long one read of a tool's latest cycle is shared. It changes once a cycle, at its reset. */
export const CYCLE_READ_TTL_MS = 10_000;

/** One step of a cycle: demo.json as the driver wrote it, and when (`at`). */
export type CycleStep = Demo & { at: string };

/** A tool's newest cycle that ran to its reset (terragucci's scripts/demo-cycles.ts, demo.cycle/v1). */
export interface Cycle {
  tool: string;
  repo: string;
  scenario: string;
  cycle: number;
  started: string | null;
  ended: string | null;
  steps: CycleStep[];
  runs: number[];
}

export type CycleAnswer =
  | { source: string; read: string; cycle: Cycle }
  | { source: string; read: string; cycle: null; absent: string }
  | { source: string; read: string; cycle: null; error: string; code: "terragucci-cycle" };

const timeOrNull = (v: unknown): boolean => v === null || v === undefined || (str(v) && UTC.test(v));

/** What is wrong with a cycle document, or undefined when it is the driver's format for `tool`. */
export function cycleProblem(doc: unknown, tool: string): string | undefined {
  if (!isRecord(doc)) return "it is not an object";
  if (doc.schema !== undefined && doc.schema !== "demo.cycle/v1") return `schema is ${JSON.stringify(doc.schema)}, not demo.cycle/v1`;
  if (doc.tool !== tool) return `tool is ${JSON.stringify(doc.tool)}, not ${tool}`;
  if (!str(doc.repo) || !doc.repo) return "repo is not a string";
  if (!str(doc.scenario) || !doc.scenario) return "scenario is not a string";
  if (!int(doc.cycle)) return "cycle is not an integer";
  if (!timeOrNull(doc.started) || !timeOrNull(doc.ended)) return "started or ended is neither a UTC time nor null";
  if (!Array.isArray(doc.runs) || !doc.runs.every((r) => int(r) && r > 0)) return "runs is not a list of run ids";
  if (!Array.isArray(doc.steps) || !doc.steps.length) return "steps is not a list of demo.json writes";
  for (const [i, s] of doc.steps.entries()) {
    const p = demoProblem(s);
    if (p) return `steps[${i}]: ${p}`;
    if (!str((s as Record<string, unknown>).at) || !UTC.test((s as Record<string, string>).at)) return `steps[${i}].at is not a UTC time`;
  }
  return undefined;
}

/** One read of `cycles/<tool>/latest.json`. Never throws. */
export async function readCycle(source: TerragucciSource, tool: string, now: Date = new Date()): Promise<CycleAnswer> {
  const base = { source: source.location, read: now.toISOString() };
  const key = cycleKey(tool);
  let body: string | undefined;
  try {
    body = await source.read(key);
  } catch (e) {
    if (e instanceof TerragucciDenied) return { ...base, cycle: null, error: deniedWords(e, `${tool}'s latest cycle`), code: "terragucci-cycle" };
    return { ...base, cycle: null, error: `behold could not read ${key} from ${source.location}: ${e instanceof Error ? e.message : String(e)}`, code: "terragucci-cycle" };
  }
  if (body === undefined) return { ...base, cycle: null, absent: `${source.location} has no ${key}: the loop driver writes it when a cycle of ${tool}'s scenario ends.` };
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return { ...base, cycle: null, error: `${key} in ${source.location} is not JSON.`, code: "terragucci-cycle" };
  }
  const problem = cycleProblem(doc, tool);
  if (problem) return { ...base, cycle: null, error: `${key} in ${source.location} is not the driver's format: ${problem}.`, code: "terragucci-cycle" };
  const c = doc as Cycle;
  return {
    ...base,
    cycle: {
      tool: c.tool,
      repo: c.repo,
      scenario: c.scenario,
      cycle: c.cycle,
      started: c.started ?? null,
      ended: c.ended ?? null,
      steps: c.steps.map((s) => ({ ...demoOf(s), at: s.at })),
      runs: [...c.runs],
    },
  };
}

/** `GET /api/terragucci/cycles/:tool`: a tool's latest cycle, 404 for a tool with no page or no cycle yet. */
export function terragucciCyclesRoute(app: Hono, source: TerragucciSource, opts: { now?: () => Date } = {}): void {
  const cache = new Map<string, { at: number; read: Promise<CycleAnswer> }>();
  app.get("/api/terragucci/cycles/:tool", async (c) => {
    const tool = c.req.param("tool");
    if (!cycleToolName(tool)) return c.json({ error: `no tool "${tool.slice(0, 40)}" has a page; the tools are ${VENDOR_TOOLS.join(", ")}`, code: "terragucci-cycle" }, 404);
    const at = Date.now();
    const hit = cache.get(tool);
    const read = hit && at - hit.at < CYCLE_READ_TTL_MS ? hit.read : readCycle(source, tool, opts.now ? opts.now() : new Date());
    if (read !== hit?.read) cache.set(tool, { at, read });
    const a = await read;
    return c.json(a, "error" in a ? 502 : "absent" in a ? 404 : 200, { "cache-control": "no-store" });
  });
}

/**
 * behold#752: where a kiosk page reads its demo. `chant-demo`: chant's fan-out demo's own records (src/chant-demo.ts,
 * /api/chant/demo…); without the tag, terragucci's (/api/terragucci/demo…). web/kiosk-source.js reads it.
 */
export type KioskSource = "chant-demo";

/** What a kiosk page is served with: chant's demo (`--chant-demo`), and behold#815 chant's run index (`--ci-report-url`). */
export interface KioskPageOptions {
  chantDemo?: boolean;
  /** Which demos are listed and which is live ({@link terragucciDemosRoute}); absent, `/` serves the first demo. */
  listed?: () => Promise<{ demos: Array<{ tool: VendorTool; live: boolean }>; live: VendorTool | null }>;
  ciRuns?: boolean;
}

/**
 * behold#815: a page whose runs pane reads chant's run index (/api/chant/ci/runs) rather than the forge's runs,
 * told so by a meta tag web/kiosk-source.js reads. Without `--ci-report-url` the page is as it was.
 */
export function runsMeta(html: string, ciRuns?: boolean): string {
  return ciRuns ? html.replace(/<meta charset="utf-8" \/>/, `<meta charset="utf-8" />\n    <meta name="kiosk-runs" content="chant-ci" />`) : html;
}

/** The kiosk page for one tool: kiosk.html, told its tool (and, behold#752, its demo's source) by meta tags the page reads. */
export function vendorPage(html: string, tool: string, source?: KioskSource): string {
  const src = source ? `\n    <meta name="kiosk-source" content="${source}" />` : "";
  return html.replace(/<meta charset="utf-8" \/>/, `<meta charset="utf-8" />\n    <meta name="kiosk-tool" content="${tool}" />${src}`);
}

/** behold#752: chant's fan-out page, reading chant's own demo records, at `path`. */
function chantFanoutPage(c: { req: { header(name: string): string | undefined } }, webRoot: string, allowedHosts: string[], path: string, ciRuns?: boolean): Response {
  const name = "chant";
  const shared = sharePage(readFileSync(join(webRoot, "kiosk.html"), "utf8"), {
    title: `behold · ${name}`,
    description: `Watch ${name} carry one change from pull request to apply, live.`,
    origin: shareOrigin(c.req.header("host"), c.req.header("x-forwarded-proto"), allowedHosts),
    path,
  });
  return new Response(runsMeta(vendorPage(shared, "chant-fanout", "chant-demo"), ciRuns), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

/** One demo's kiosk page, served at `path`. */
function demoPage(c: { req: { header(name: string): string | undefined } }, webRoot: string, allowedHosts: string[], tool: VendorTool, path: string, ciRuns?: boolean): Response {
  const name = VENDOR_NAMES[tool];
  const shared = sharePage(readFileSync(join(webRoot, "kiosk.html"), "utf8"), {
    title: `behold · ${name}`,
    description: `Watch ${name} carry one change from pull request to apply, live.`,
    origin: shareOrigin(c.req.header("host"), c.req.header("x-forwarded-proto"), allowedHosts),
    path,
  });
  return new Response(runsMeta(vendorPage(shared, tool), ciRuns), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

/**
 * `GET /<tool>` for each of {@link VENDOR_TOOLS}, and a {@link LEGACY_TOOLS} URL: a 302 to `/`, which shows the live demo. Without `--terragucci` a demo's page says what /kiosk says.
 */
export function vendorRoutes(app: Hono, webRoot: string, enabled: boolean, allowedHosts: string[] = [], opts: KioskPageOptions = {}): void {
  for (const tool of VENDOR_TOOLS) {
    app.get(`/${tool}`, (c) => (enabled ? c.redirect("/", 302) : c.html(disabledPage, 404)));
  }
  for (const tool of LEGACY_TOOLS) {
    app.get(`/${tool}`, (c) => {
      // behold#752: `--chant-demo` alone still gives /chant-fanout chant's own records.
      if (opts.chantDemo && tool === "chant-fanout") return chantFanoutPage(c, webRoot, allowedHosts, `/${tool}`, opts.ciRuns);
      return c.redirect("/", 302);
    });
  }
}

/** A short path that names no page, where a tool's page would be: a page that links to the demo. */
export const VENDOR_PATH = /^\/[a-z][a-z0-9-]{0,40}$/;

export const notFoundPage =
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1"><title>No page here</title>` +
  `<script type="module">import { initTheme } from "/theme.js"; initTheme();</script>` +
  `<body style="font:16px system-ui;background:var(--bg,#1e1e2e);color:var(--fg,#cdd6f4);padding:2rem">` +
  `<h3>No page here</h3><p style="color:var(--muted,#777a8c)">This address shows nothing. The demo is at <a style="color:inherit" href="/">the front page</a>.</p></body>`;

/**
 * Registered after the static files: a one-segment path that is no file and
 * no route answers 404 with a link to the front page, instead of an empty 404.
 */
export function vendorFallback(app: Hono): void {
  app.get("*", (c) => (VENDOR_PATH.test(c.req.path) ? c.html(notFoundPage, 404) : c.notFound()));
}
