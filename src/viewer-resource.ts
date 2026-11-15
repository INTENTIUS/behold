/**
 * behold#1073: the `ui://behold/viewer` resource, the one HTML document an
 * MCP Apps host (io.modelcontextprotocol/ui, spec 2026-01-26) draws for the
 * `graph` tool.
 *
 * This is the seam to #1070's single-file viewer. `npm run build:viewer`
 * (scripts/build-viewer.mts on that branch) writes `dist/behold-viewer/viewer.html`,
 * everything inlined, as the script's header says "for an MCP resource". When
 * that file is in the package, the resource serves it. Until it is, the
 * resource serves a plain page that says the view is not in this build, so a
 * host that draws it shows a true sentence beside the text answer and not an
 * empty frame. Nothing else in the tool changes when the file appears.
 *
 * The page needs no `_meta.ui.csp`: the viewer opens no connection (its build
 * fails if it names EventSource or WebSocket) and gets its document from the
 * host, so the host's default (`default-src 'none'`, `connect-src 'none'`)
 * is what it runs under.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VIEWER_URI = "ui://behold/viewer";
/** The MIME type the spec requires of a `ui://` resource. */
export const APP_MIME = "text/html;profile=mcp-app";

export interface ViewerSource {
  html: string;
  /** `viewer` when #1070's build is in the package, `placeholder` when it is not. */
  kind: "viewer" | "placeholder";
}

export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>behold graph</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; }
</style>
</head>
<body>
<p>The interactive graph view is not in this build of behold. The answer above holds the same graph as a diagram or a table, and a link to open it in behold.</p>
</body>
</html>
`;

/** Where the viewer build lands, from the package root. */
export const VIEWER_BUILD = join("dist", "behold-viewer", "viewer.html");

/** The viewer when its build is in the package, else the placeholder. `root` is the package root (default: this package's). */
export function loadViewer(root = join(dirname(fileURLToPath(import.meta.url)), "..")): ViewerSource {
  const file = join(root, VIEWER_BUILD);
  try {
    if (existsSync(file)) return { html: readFileSync(file, "utf8"), kind: "viewer" };
  } catch {
    // Unreadable: the placeholder says the view is missing, which it is.
  }
  return { html: PLACEHOLDER_HTML, kind: "placeholder" };
}
