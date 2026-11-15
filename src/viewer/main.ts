/// <reference lib="dom" />
/**
 * behold#1070: the single-file viewer. One script that draws a
 * `behold-graph/1` document with no server behind it, for the export, an
 * editor webview, an MCP Apps view and a page that frames it.
 *
 * The same file is the page's script and its Web Worker: loaded where there
 * is no `document`, it waits for documents to paint and posts back the SVG.
 * The page starts the worker from its own script URL (or, inlined in
 * viewer.html, from its own text) and paints on the main thread when no
 * worker starts, which is the case from `file://` and under a CSP that
 * allows no worker.
 *
 * The document arrives, in order of precedence, by a `behold:graph`
 * message, from `window.__BEHOLD_GRAPH__` (graph.js, the only form that works
 * from `file://`), or from `?src=`. src/viewer/options.ts has the options and
 * the messages; src/viewer/transport.ts the hosts.
 */
import { THEMES as PIN_THEMES, TOKEN_NAMES } from "@intentius/pinhole";
import { supplyIcons } from "../icon-packs.ts";
import type { VendoredIcon } from "../icon-svg.ts";
import { checkGraphDocument, type GraphDocument, type GraphDocumentNode } from "../graph-document.ts";
import { paintDocument, type PaintResult } from "./paint.ts";
import { iconTable, readOptions, sameOriginSrc, selectMessage, type Inbound, type ViewerOptions } from "./options.ts";
import { openTransport, type Transport, type WindowLike } from "./transport.ts";

declare const __VIEWER_FORMAT__: "esm" | "iife";
declare const __VIEWER_VERSION__: string;

interface PaintJob {
  document: unknown;
  icons?: Record<string, VendoredIcon>;
}

type Scope = typeof globalThis & {
  document?: Document;
  __BEHOLD_GRAPH__?: unknown;
  __BEHOLD_ICONS__?: unknown;
  __BEHOLD_VIEWER__?: unknown;
  __BEHOLD_VIEWER_STATE__?: ViewerState;
  onmessage?: ((e: MessageEvent) => void) | null;
  postMessage?: (m: unknown) => void;
};

/** What a test or a host reads back: how the last draw went. */
interface ViewerState {
  state: "waiting" | "drawing" | "drawn" | "refused";
  cards?: number;
  /** Where the layout ran. */
  where?: "worker" | "main";
  /** From the document arriving to its picture in the page, ms. */
  firstPaintMs?: number;
  layoutMs?: number;
  error?: string;
}

const scope = globalThis as Scope;

// Read before anything else runs: `currentScript` is only set while the script first runs.
const script: HTMLScriptElement | null = typeof document !== "undefined" ? (document.currentScript as HTMLScriptElement | null) : null;
const selfUrl: string | undefined = __VIEWER_FORMAT__ === "esm" ? import.meta.url : script?.src || undefined;
const selfText: string | undefined = !selfUrl && script ? script.textContent || undefined : undefined;

if (typeof document === "undefined") {
  // The worker: paint each document posted in and post the result back.
  scope.onmessage = (e: MessageEvent) => {
    const job = e.data as PaintJob;
    if (job.icons) supplyIcons(job.icons);
    scope.postMessage!(paintDocument(job.document));
  };
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => boot(), { once: true });
} else {
  boot();
}

/** A painter that lays out in a worker when one starts, and on the main thread when not. */
function painter(): (job: PaintJob) => Promise<PaintResult & { where: "worker" | "main" }> {
  let worker: Worker | undefined;
  let broken = false;
  const start = (): Worker | undefined => {
    if (worker || broken) return worker;
    try {
      if (selfUrl && !selfUrl.startsWith("file:")) worker = new Worker(selfUrl, __VIEWER_FORMAT__ === "esm" ? { type: "module" } : {});
      else if (selfText) worker = new Worker(URL.createObjectURL(new Blob([selfText], { type: "text/javascript" })));
    } catch {
      worker = undefined;
    }
    if (!worker) broken = true;
    return worker;
  };
  const inline = (job: PaintJob) => {
    if (job.icons) supplyIcons(job.icons);
    return { ...paintDocument(job.document), where: "main" as const };
  };
  return (job) =>
    new Promise((resolve) => {
      const w = start();
      if (!w) return resolve(inline(job));
      const done = (fn: () => void) => {
        w.removeEventListener("message", onMessage);
        w.removeEventListener("error", onError);
        fn();
      };
      const onMessage = (e: MessageEvent) => done(() => resolve({ ...(e.data as PaintResult), where: "worker" }));
      // A worker the page's CSP or origin refuses fails here, before it ever answers.
      const onError = (e: Event) => {
        e.preventDefault?.();
        done(() => {
          worker?.terminate();
          worker = undefined;
          broken = true;
          resolve(inline(job));
        });
      };
      w.addEventListener("message", onMessage);
      w.addEventListener("error", onError);
      w.postMessage(job);
    });
}

function boot(): void {
  const doc = document;
  const root = doc.documentElement;
  const opts: ViewerOptions = readOptions(location.search, scope.__BEHOLD_VIEWER__);
  const status = doc.getElementById("behold-status") ?? doc.body.appendChild(doc.createElement("p"));
  const stage = doc.getElementById("behold-graph") ?? doc.body.appendChild(doc.createElement("div"));
  const paint = painter();
  const state: ViewerState = { state: "waiting" };
  scope.__BEHOLD_VIEWER_STATE__ = state;
  root.setAttribute("data-behold-viewer", state.state);

  let shown: GraphDocument | undefined;
  let icons: Record<string, VendoredIcon> | undefined = iconTable(scope.__BEHOLD_ICONS__);
  let theme = opts.theme ?? systemTheme();
  let view: { node?: string; focus?: string[] } = { ...(opts.node ? { node: opts.node } : {}), ...(opts.focus ? { focus: opts.focus } : {}) };
  let drawing = 0;

  const say = (text: string) => {
    status.textContent = text;
    status.hidden = !text;
  };
  const set = (patch: Partial<ViewerState>) => {
    Object.assign(state, patch);
    root.setAttribute("data-behold-viewer", state.state);
  };

  applyTheme(theme);

  async function draw(value: unknown, extraIcons?: Record<string, VendoredIcon>) {
    const t0 = performance.now();
    const checked = checkGraphDocument(value);
    if (!checked.ok) {
      set({ state: "refused", error: checked.error });
      transport.send({ type: "behold:refused", error: checked.error });
      return say(checked.error);
    }
    if (extraIcons) icons = { ...icons, ...extraIcons };
    const mine = ++drawing;
    set({ state: "drawing" });
    say(`Laying out ${checked.document.nodes.length} cards.`);
    const r = await paint({ document: checked.document, ...(icons ? { icons } : {}) });
    if (mine !== drawing) return; // a newer document arrived while this one was laid out
    if (!r.ok) {
      set({ state: "refused", error: r.error, where: r.where });
      transport.send({ type: "behold:refused", error: r.error });
      return say(r.error);
    }
    shown = checked.document;
    stage.innerHTML = r.svg;
    say("");
    applyView();
    set({ state: "drawn", cards: r.cards, where: r.where, layoutMs: r.ms, firstPaintMs: Math.round(performance.now() - t0), error: undefined });
    transport.send({ type: "behold:drawn", cards: r.cards });
  }

  function applyView() {
    const svg = stage.querySelector("svg");
    if (!svg || !shown) return;
    const cards = svg.querySelectorAll<SVGElement>("[data-node-id]");
    const lit = litCards(shown, view);
    for (const c of cards) {
      const id = c.getAttribute("data-node-id")!;
      c.classList.toggle("behold-dim", !!lit && !lit.has(id));
      c.classList.toggle("behold-lit", view.node === id);
    }
    if (view.node) {
      const at = [...cards].find((c) => c.getAttribute("data-node-id") === view.node);
      at?.scrollIntoView?.({ block: "center", inline: "center" });
    }
  }

  function applyTheme(name: string, vars?: Record<string, string>) {
    theme = name;
    root.setAttribute("data-theme", name);
    // The SVG carries its painted theme's tokens on :root; set on the element, these win without a repaint.
    const tokens = PIN_THEMES[name]?.tokens as Record<string, string> | undefined;
    if (tokens) for (const t of TOKEN_NAMES) root.style.setProperty(`--pin-${t}`, tokens[t]!);
    for (const [k, v] of Object.entries(vars ?? {})) root.style.setProperty(k, v);
  }

  const onInbound = (m: Inbound) => {
    if (m.type === "graph") void draw(m.document, m.icons);
    else if (m.type === "theme") applyTheme(m.theme ?? theme, m.vars);
    else {
      if (m.node !== undefined) view = { ...view, node: m.node ?? undefined };
      if (m.focus !== undefined) view = { ...view, focus: m.focus ?? undefined };
      applyView();
    }
  };
  const transport: Transport = openTransport(scope as unknown as WindowLike, opts, onInbound, __VIEWER_VERSION__);

  stage.addEventListener("click", (e) => {
    const el = (e.target as Element | null)?.closest?.("[data-node-id], [data-group-id]");
    if (!el || !shown) return;
    const id = el.getAttribute("data-node-id");
    if (id) {
      const n: GraphDocumentNode | undefined = shown.nodes.find((x) => x.id === id);
      transport.send(selectMessage({ id, kind: n?.kind ?? "card", ...(n?.file ? { file: n.file } : {}) }));
      return;
    }
    const key = el.getAttribute("data-group-id")!;
    const g = shown.groups.find((x) => x.id === key || x.id.endsWith(`:${key}`));
    transport.send(selectMessage({ id: g?.id ?? key, kind: g?.kind ?? "box" }));
  });

  if (!opts.theme && typeof matchMedia === "function") {
    matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => applyTheme(systemTheme()));
  }

  transport.send({ type: "behold:ready" });
  if (scope.__BEHOLD_GRAPH__ !== undefined) void draw(scope.__BEHOLD_GRAPH__);
  else if (opts.src) {
    const url = sameOriginSrc(opts.src, location.href);
    if (!url) {
      set({ state: "refused", error: "src is not a same-origin path" });
      say(`?src=${opts.src} is not on this page's origin, so it is not fetched.`);
    } else {
      say("Fetching the graph.");
      fetch(url)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
        .then((d) => (shown || drawing ? undefined : draw(d)))
        .catch((e) => {
          set({ state: "refused", error: String(e) });
          say(`Could not read ${opts.src}: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
  } else say("Waiting for a graph.");
}

function systemTheme(): string {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The cards a view lights: the asked-for card, or every card in the focused boxes. Undefined when nothing is asked, so nothing dims. */
export function litCards(doc: GraphDocument, view: { node?: string; focus?: string[] }): Set<string> | undefined {
  if (!view.focus?.length) return view.node ? new Set([view.node]) : undefined;
  const groups = new Map(doc.groups.map((g) => [g.id, g] as const));
  const wanted = new Set(view.focus.flatMap((f) => [f, ...doc.groups.filter((g) => g.id.endsWith(`:${f}`)).map((g) => g.id)]));
  const lit = new Set<string>();
  for (const n of doc.nodes) {
    for (let at = n.box ? groups.get(n.box) : undefined, hops = 0; at && hops < 64; at = at.parent ? groups.get(at.parent) : undefined, hops++) {
      if (wanted.has(at.id)) {
        lit.add(n.id);
        break;
      }
    }
  }
  if (view.node) lit.add(view.node);
  return lit;
}
