/**
 * behold#1070: what the viewer is told, and what it says. Pure, no DOM:
 * src/viewer/main.ts reads the options once at boot and runs every message
 * that arrives through {@link readInbound}.
 *
 * Options come from the query string and from a host global
 * (`window.__BEHOLD_VIEWER__`), for a host that cannot set a query (an
 * editor webview, an MCP resource). The query string wins where both say.
 *
 *   ?theme=<name>     light, dark, or a pinhole theme (blueprint, aws); absent,
 *                     the system's light or dark (prefers-color-scheme)
 *   ?node=<id>        the card to light and scroll to
 *   ?focus=<a,b>      the boxes to bring forward (a root, `stack:<root>`); the rest dim
 *   ?host=<origin>    the parent's origin, for postMessage. No host, no parent messages.
 *   ?transport=<t>    post, vscode, mcp or none; absent, picked from the page (see main.ts)
 *   ?src=<path>       a same-origin path to fetch the document from
 *
 * Messages in: `behold:graph { document, icons? }`, `behold:theme { theme?,
 * vars? }` and `behold:view { node?, focus? }`. Out: `behold:ready` once,
 * `behold:select { id, kind, file }` when a card or a box is picked,
 * `behold:drawn { cards }` after each draw and `behold:refused { error }` when
 * a document is not drawn (#1072: an editor host reports the one and tests the other).
 */
import type { VendoredIcon } from "../icon-svg.ts";

export type TransportName = "post" | "vscode" | "mcp" | "none";

export interface ViewerOptions {
  theme?: string;
  node?: string;
  focus?: string[];
  host?: string;
  transport?: TransportName;
  src?: string;
}

/** The pinhole themes, and the two words a host passes for them. */
export const THEMES = ["dark", "light", "blueprint", "aws"] as const;
const THEME_ALIASES: Readonly<Record<string, string>> = { "github light default": "light", "github dark default": "dark" };
const TRANSPORTS = new Set<TransportName>(["post", "vscode", "mcp", "none"]);

/** A theme a host named, as a pinhole theme, or undefined when it names none. */
export function themeName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  const name = THEME_ALIASES[t] ?? t;
  return (THEMES as readonly string[]).includes(name) ? name : undefined;
}

/**
 * An origin to talk to, exactly: `scheme://host[:port]`. `URL.origin` is
 * `"null"` for a scheme the URL standard does not know, `vscode-webview:`
 * among them, so the origin is built from the parts for those.
 */
export function originOf(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    if (!u.host) return undefined;
    if (!/^(https?|vscode-webview|vscode-file):$/.test(u.protocol)) return undefined;
    return u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

const list = (v: unknown): string[] | undefined => {
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : undefined;
  if (!parts) return undefined;
  const out = parts.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean);
  return out.length ? out : undefined;
};
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The options, from the query string first and the host global after it. */
export function readOptions(search: string, global?: unknown): ViewerOptions {
  const q = new URLSearchParams(search || "");
  const g = global && typeof global === "object" ? (global as Record<string, unknown>) : {};
  const pick = (k: string): unknown => (q.has(k) ? q.get(k) : g[k]);
  const out: ViewerOptions = {};
  const theme = themeName(pick("theme"));
  if (theme) out.theme = theme;
  const node = text(pick("node"));
  if (node) out.node = node;
  const focus = list(pick("focus"));
  if (focus) out.focus = focus;
  const host = originOf(pick("host"));
  if (host) out.host = host;
  const transport = pick("transport");
  if (typeof transport === "string" && TRANSPORTS.has(transport as TransportName)) out.transport = transport as TransportName;
  const src = text(pick("src"));
  if (src) out.src = src;
  return out;
}

/**
 * A `?src=` path the viewer may fetch: same origin as the page, and the page
 * on http or https. `file://` has no origin to compare (graph.js is the form
 * for it), and a document from another origin is the host's to send by message.
 */
export function sameOriginSrc(src: string, pageHref: string): string | undefined {
  try {
    const page = new URL(pageHref);
    const u = new URL(src, page);
    if (!/^https?:$/.test(page.protocol) || u.origin !== page.origin) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

export type Inbound =
  | { type: "graph"; document: unknown; icons?: Record<string, VendoredIcon> }
  | { type: "theme"; theme?: string; vars?: Record<string, string> }
  | { type: "view"; node?: string | null; focus?: string[] | null };

/** CSS custom properties a host may set: a `--name`, and a value with nothing that ends a declaration. */
export function cssVars(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!/^--[A-Za-z0-9_-]{1,64}$/.test(k) || typeof x !== "string" || x.length > 256 || /[;{}<>\\]/.test(x)) continue;
    out[k] = x.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** Icons a host sent, by the keys of src/icons.generated.ts, each a body and a viewBox. */
export function iconTable(v: unknown): Record<string, VendoredIcon> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, VendoredIcon> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const i = x as Partial<VendoredIcon> | null;
    if (i && typeof i.body === "string" && typeof i.viewBox === "string") out[k] = { body: i.body, viewBox: i.viewBox };
  }
  return Object.keys(out).length ? out : undefined;
}

/** A behold message, read into what the viewer does with it, or null when it is not one. */
export function readInbound(data: unknown): Inbound | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type === "behold:graph") {
    if (!("document" in d)) return null;
    const icons = iconTable(d.icons);
    return { type: "graph", document: d.document, ...(icons ? { icons } : {}) };
  }
  if (d.type === "behold:theme") {
    const theme = themeName(d.theme);
    const vars = cssVars(d.vars);
    return { type: "theme", ...(theme ? { theme } : {}), ...(vars ? { vars } : {}) };
  }
  if (d.type === "behold:view") {
    const out: { type: "view"; node?: string | null; focus?: string[] | null } = { type: "view" };
    if ("node" in d) out.node = d.node === null || d.node === "" ? null : (text(d.node) ?? null);
    if ("focus" in d) out.focus = d.focus === null || d.focus === "" ? null : (list(d.focus) ?? null);
    return out;
  }
  return null;
}

/** What a pick tells the host: the card's or the box's id, its kind, and the card's file when the document names one. */
export function selectMessage(pick: { id: string; kind: string; file?: string }): { type: "behold:select"; id: string; kind: string; file: string | null } {
  return { type: "behold:select", id: pick.id, kind: pick.kind, file: pick.file ?? null };
}
