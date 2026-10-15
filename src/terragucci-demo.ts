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
 * wrote.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
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
  next: { action: string; at: string | null } | null;
  pull: number | null;
  commit: string | null;
  /** Null when demo.json has no card for the scenario (the base, or a driver before behold#571). */
  about: DemoAbout | null;
}

export type DemoAnswer =
  | { source: string; read: string; demo: Demo }
  | { source: string; read: string; demo: null; absent: string }
  | { source: string; read: string; demo: null; error: string; code: "terragucci-demo" };

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

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
  const d = doc as Demo;
  return {
    ...base,
    demo: {
      cycle: d.cycle,
      scenario: d.scenario,
      title: d.title,
      step: d.step,
      label: d.label,
      started_at: d.started_at,
      next: d.next ? { action: d.next.action, at: d.next.at } : null,
      pull: d.pull,
      commit: d.commit,
      about: d.about ? { changes: d.about.changes, watch: d.about.watch, shows: d.about.shows } : null,
    },
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

/**
 * `GET /kiosk`: the kiosk page. Without `--terragucci` there is nothing to
 * narrate, and the page says so instead of loading.
 */
export function kioskRoute(app: Hono, webRoot: string, enabled: boolean): void {
  app.get("/kiosk", (c) => {
    if (!enabled) {
      return c.html(
        `<!doctype html><meta charset=utf-8><title>behold kiosk</title>` +
          `<script type="module">import { initTheme } from "/theme.js"; initTheme();</script>` +
          `<body style="font:16px system-ui;background:var(--bg,#1e1e2e);color:var(--fg,#cdd6f4);padding:2rem">` +
          `<h3>The kiosk follows a terragucci demo</h3><p style="color:var(--muted,#777a8c)">Start behold with <code>--terragucci &lt;reports source&gt;</code>; the kiosk reads <code>demo.json</code> there.</p></body>`,
        404,
      );
    }
    return new Response(readFileSync(join(webRoot, "kiosk.html"), "utf8"), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  });
}
