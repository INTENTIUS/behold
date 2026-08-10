// #199: a stub behold backend for the UI smoke — serves web/ verbatim plus
// canned JSON for every read endpoint the SPA touches, so the whole SPA boots
// and can be driven in a browser with no chant, no Docker, no estate. The
// canned graph is pinhole-shaped enough for app.js's post-passes to run:
// g[data-node-id] groups, var(--pin-*) fills, a status-bar rect per node.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

// #227: a lexicon-native mark, shaped exactly as pinhole 0.3.0 emits a pack's
// `colored` glyph — a bare transform group whose children carry their own
// paint and ride no `--pin-*` token. Both authoring styles the vendored corpus
// uses are here: the Kubernetes set fills via `style`, the CNCF marks via the
// `fill` attribute. recolorNodesByCategory must classify neither, which is what
// ui-smoke.mjs asserts across a theme flip.
const coloredMark = `
    <g transform="translate(120 20) scale(0.9)">
      <path data-mark="badge" style="fill:#326ce5;fill-opacity:1;stroke:none" d="M12 1 3 6v11l9 5 9-5V6z"/>
      <path data-mark="detail" fill="#ffffff" d="M9 8h6v8H9z"/>
    </g>`;

const nodeSvg = (id, x, tone, label, mark = "") => `
  <g data-node-id="${id}" transform="translate(${x}, 80)">
    <rect x="0" y="0" width="150" height="64" rx="8" fill="var(--pin-${tone}Fill, #1c2431)" stroke="var(--pin-${tone}Stroke, #345)"/>
    <rect x="0" y="0" width="4" height="64" fill="var(--pin-${tone}Bar, #3fb950)"/>
    <text x="16" y="30" font-size="13" fill="var(--pin-text, #e6edf3)">${label}</text>
    <text x="16" y="50" font-size="10" fill="var(--pin-textMuted, #8b949e)">Component</text>${mark}
  </g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 240" width="620" height="240">
  <style>:root{--pin-bg0:#0d1117;--pin-text:#e6edf3}</style>
  <rect x="0" y="0" width="620" height="240" fill="var(--pin-bg0, #0d1117)"/>
  <rect x="20" y="40" width="580" height="140" rx="10" fill="none" stroke="var(--pin-edge, #444)"/>
  <text x="30" y="30" font-size="12" fill="var(--pin-textMuted, #999)">wave-1</text>
  ${nodeSvg("api", 40, "good", "api", coloredMark)}
  ${nodeSvg("worker", 230, "accent", "worker")}
  ${nodeSvg("frontend", 420, "neutral", "frontend")}
</svg>`;

const ir = {
  nodes: [
    { id: "api", kind: "Component", lexicon: "aws", attrs: { _status: "good" } },
    { id: "worker", kind: "Component", lexicon: "aws", attrs: { _status: "accent" } },
    { id: "frontend", kind: "Component", lexicon: "aws", attrs: { _status: "neutral" } },
  ],
  edges: [{ from: "api", to: "worker" }],
};

const JSON_ROUTES = {
  "/api/project": {
    projectDir: "/estates/stub-estate",
    recents: ["/estates/older-estate"],
    environments: ["local", "prod"],
    k8sContexts: { local: "stub-cluster" },
    lexicons: ["aws", "k8s"],
    currentEnv: "local",
    tiers: ["dev", "prod"],
    targets: [{ endpoint: "http://localhost:4566" }],
    tier: "dev",
    target: "http://localhost:4566",
  },
  "/api/substrates": {
    substrates: [
      { name: "docker", label: "Docker", status: "up", detail: "Docker daemon running" },
      { name: "floci", label: "Floci", status: "up", detail: "emulator @ localhost:4566" },
      { name: "k3d", label: "k3d", status: "on-demand", detail: "cluster not created yet", bringUp: { cmd: "k3d", args: ["cluster", "create", "demo"] } },
      { name: "github", label: "GitHub Actions", status: "unknown", detail: "gh CLI available" },
    ],
  },
  "/api/ops": { ops: [], adoptLexicons: [], autoSync: "off" },
  "/api/ci": { jobs: [], forge: "github" },
  "/api/resources": { byComponent: {} },
  "/api/reconcile": { total: 2, byComponent: { worker: 2 }, uncorrelated: 0 },
  "/api/diff": { env: "local", nodes: {} },
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

/** Start the stub on `port`; resolves to the http.Server (close() to stop). */
export function startStub(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return; // held open — the SPA's EventSource stays quiet
    }
    if (path === "/api/graph" || path === "/api/overlay") {
      const components = url.searchParams.get("components") === "1";
      const meta = {
        mode: components ? "component-status" : url.searchParams.get("env") ? "overlay" : "graph",
        env: url.searchParams.get("env") || null,
        projectDir: "/estates/stub-estate",
        components,
        tier: "dev",
        target: "http://localhost:4566",
      };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ir, svg, meta }));
    }
    if (JSON_ROUTES[path]) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(JSON_ROUTES[path]));
    }
    if (path === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    const file = path === "/" ? "index.html" : path.slice(1);
    try {
      const body = await readFile(join(WEB, file));
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found: " + path);
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
