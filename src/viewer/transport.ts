/**
 * behold#1070: how the viewer talks to whatever loaded it. Three hosts, one
 * vocabulary: each transport turns its host's messages into the
 * `behold:*` messages src/viewer/options.ts reads, and sends the viewer's
 * `behold:ready` and `behold:select` the host's way.
 *
 *   post    a parent page: `postMessage` to `?host=` only, and only messages
 *           from that origin and from the parent window are read
 *   vscode  a VS Code webview: `acquireVsCodeApi()` (callable once per page)
 *           out, and the webview's own `message` events in
 *   mcp     an MCP Apps view: JSON-RPC 2.0 over `postMessage` with the
 *           parent (`ui/initialize`, then `ui/notifications/tool-result`
 *           carries the document and `ui/notifications/host-context-changed`
 *           the theme); a pick is sent as `ui/update-model-context`
 *
 * The window is passed in, so the tests drive each transport with a stand-in.
 */
import { cssVars, originOf, readInbound, themeName, type Inbound, type TransportName, type ViewerOptions } from "./options.ts";

export interface MessageEventLike {
  data: unknown;
  origin: string;
  source: unknown;
}

export interface WindowLike {
  parent: { postMessage(message: unknown, targetOrigin: string): void } | WindowLike;
  location: { href: string };
  addEventListener(type: "message", fn: (e: MessageEventLike) => void): void;
  acquireVsCodeApi?: () => { postMessage(message: unknown): void };
}

export interface Transport {
  name: TransportName;
  send(message: { type: string; [k: string]: unknown }): void;
}

/** The protocol version of MCP Apps the viewer speaks (`@modelcontextprotocol/ext-apps` 2.0's LATEST_PROTOCOL_VERSION). */
export const MCP_APPS_PROTOCOL = "2026-01-26";

/** Which transport a page gets when it does not say: VS Code's API when it is there, the parent when a host is named, MCP Apps when framed with none named. */
export function pickTransport(win: WindowLike, opts: ViewerOptions): TransportName {
  if (opts.transport) return opts.transport;
  if (typeof win.acquireVsCodeApi === "function") return "vscode";
  if (opts.host) return "post";
  if (win.parent && win.parent !== (win as unknown)) return "mcp";
  return "none";
}

/** The graph document in an MCP tool result: the structured content itself, or its `document` or `graph`. */
export function documentInToolResult(params: unknown): unknown {
  const sc = params && typeof params === "object" ? (params as Record<string, unknown>).structuredContent : undefined;
  if (!sc || typeof sc !== "object") return undefined;
  const s = sc as Record<string, unknown>;
  if (typeof s.schema === "string") return s;
  for (const k of ["document", "graph"]) {
    const d = s[k];
    if (d && typeof d === "object" && typeof (d as Record<string, unknown>).schema === "string") return d;
  }
  return undefined;
}

/** An MCP Apps host context as a `behold:theme` message, or null when it carries no theme and no styles. */
export function themeFromHostContext(ctx: unknown): Inbound | null {
  if (!ctx || typeof ctx !== "object") return null;
  const c = ctx as { theme?: unknown; styles?: { variables?: unknown } };
  const theme = themeName(c.theme);
  const vars = cssVars(c.styles?.variables);
  return theme || vars ? { type: "theme", ...(theme ? { theme } : {}), ...(vars ? { vars } : {}) } : null;
}

export function openTransport(win: WindowLike, opts: ViewerOptions, onInbound: (m: Inbound) => void, version = "0"): Transport {
  const name = pickTransport(win, opts);
  if (name === "post" && opts.host) {
    const host = opts.host;
    win.addEventListener("message", (e) => {
      if (e.origin !== host || e.source !== win.parent) return;
      const m = readInbound(e.data);
      if (m) onInbound(m);
    });
    return { name, send: (message) => (win.parent as { postMessage(m: unknown, o: string): void }).postMessage(message, host) };
  }
  if (name === "vscode" && typeof win.acquireVsCodeApi === "function") {
    const api = win.acquireVsCodeApi();
    // The extension's messages reach the webview as `message` events from the webview's own origin.
    const own = originOf(win.location.href);
    win.addEventListener("message", (e) => {
      if (own && e.origin !== own) return;
      const m = readInbound(e.data);
      if (m) onInbound(m);
    });
    return { name, send: (message) => api.postMessage(message) };
  }
  if (name === "mcp" && win.parent && win.parent !== (win as unknown)) return mcpTransport(win, onInbound, version);
  return { name: "none", send: () => {} };
}

function mcpTransport(win: WindowLike, onInbound: (m: Inbound) => void, version: string): Transport {
  const parent = win.parent as { postMessage(m: unknown, o: string): void };
  // The view's frame has no fixed origin to name (a sandbox proxy, a srcdoc), so the
  // parent window is what is checked, as the MCP Apps SDK does.
  const post = (m: unknown) => parent.postMessage(m, "*");
  let next = 1;
  const initId = next++;
  win.addEventListener("message", (e) => {
    if (e.source !== win.parent) return;
    const d = e.data as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown } | null;
    if (!d || d.jsonrpc !== "2.0") return;
    if (d.id === initId && d.result && typeof d.result === "object") {
      const theme = themeFromHostContext((d.result as { hostContext?: unknown }).hostContext);
      if (theme) onInbound(theme);
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      return;
    }
    if (d.method === "ui/notifications/tool-result") {
      const document = documentInToolResult(d.params);
      if (document !== undefined) onInbound({ type: "graph", document });
      return;
    }
    if (d.method === "ui/notifications/host-context-changed") {
      const theme = themeFromHostContext(d.params);
      if (theme) onInbound(theme);
      return;
    }
    if (d.method === "ui/resource-teardown" && d.id !== undefined) post({ jsonrpc: "2.0", id: d.id, result: {} });
  });
  post({
    jsonrpc: "2.0",
    id: initId,
    method: "ui/initialize",
    params: { appInfo: { name: "behold-viewer", version }, appCapabilities: {}, protocolVersion: MCP_APPS_PROTOCOL },
  });
  return {
    name: "mcp",
    send(message) {
      if (message.type !== "behold:select") return;
      const { type: _type, ...pick } = message;
      post({
        jsonrpc: "2.0",
        id: next++,
        method: "ui/update-model-context",
        params: {
          content: [{ type: "text", text: `Selected ${String(pick.kind)} ${String(pick.id)}${pick.file ? ` (${String(pick.file)})` : ""} in the behold graph.` }],
          structuredContent: { selected: pick },
        },
      });
    },
  };
}
