// #199: a stub behold backend for the UI smoke — serves web/ verbatim plus
// canned JSON for every read endpoint the SPA touches, so the whole SPA boots
// and can be driven in a browser with no chant, no Docker, no estate. The
// canned graph is pinhole-shaped enough for app.js's post-passes to run:
// g[data-node-id] groups, var(--pin-*) fills, a status-bar rect per node.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// #246: the REAL Helm mark, straight out of the pack behold registers with
// pinhole — plate and all. Everything else in this file is a hand-cut stand-in;
// this one is not, because the check it feeds is about that exact artwork.
// (`npm run smoke:ui` runs under tsx, which is what lets a .mjs reach a .ts.)
import { helmIconFor } from "../src/icon-packs.ts";
// #254: the carve lens itself, so carve mode's stub graph is the real
// conversion of the real committed report — see the carve block below.
import { carveReportToIr } from "../src/carve-lens.ts";

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

// #246: the Helm wheel in a 22px card slot, placed the way pinhole's own
// `glyphMarkup` places a pack glyph — viewBox scaled into the slot by
// `size / max(vbW, vbH)`, then translated. The plate is the body's first child,
// so `[data-mark="helm"] > rect` is the ground and the `<path>`s are the ink.
const helm = helmIconFor("Helm::Release");
const helmSlot = 22;
const helmScale = helmSlot / Math.max(...helm.viewBox.trim().split(/[\s,]+/).slice(2).map(Number));
const helmMark = `
    <g data-mark="helm" transform="translate(116 20) scale(${helmScale})">${helm.body}</g>`;

const nodeSvg = (id, x, tone, label, mark = "") => `
  <g data-node-id="${id}" transform="translate(${x}, 80)">
    <rect x="0" y="0" width="150" height="64" rx="8" fill="var(--pin-${tone}Fill, #1c2431)" stroke="var(--pin-${tone}Stroke, #345)"/>
    <rect x="0" y="0" width="4" height="64" fill="var(--pin-${tone}Bar, #3fb950)"/>
    <text x="16" y="30" font-size="13" fill="var(--pin-text, #e6edf3)">${label}</text>
    <text x="16" y="50" font-size="10" fill="var(--pin-textMuted, #8b949e)">Component</text>${mark}
  </g>`;

// #228: an edge shaped the way pinhole's `Canvas.edge` emits one — a bezier
// between the two card centres plus a fat transparent hit-path, both in a
// `g[data-edge-*]`. It is what the layout drag re-anchors when either end moves.
const EDGE_A = [115, 112];
const EDGE_Z = [305, 112];
const EDGE_D = `M ${EDGE_A[0]} ${EDGE_A[1]} C ${EDGE_A[0]} ${EDGE_A[1]}, ${EDGE_Z[0]} ${EDGE_Z[1]}, ${EDGE_Z[0]} ${EDGE_Z[1]}`;

// #267: and the chip pinhole paints on a LABELLED edge — reproduced to the
// digit from `Canvas.edgeLabel`, because the thing under test is exactly how
// weakly the two are joined. The chip is an anonymous `<g>` immediately after
// the edge group, with no id on it; all that links them is document order and
// the fact that its text is the edge's own `data-edge-via`. Its rect is
// centred on the edge's midpoint, which is what the smoke measures.
export const EDGE_VIA = "project";
const LX = (EDGE_A[0] + EDGE_Z[0]) / 2;
const LY = (EDGE_A[1] + EDGE_Z[1]) / 2;
const LW = EDGE_VIA.length * 5.7 + 14;
const edgeLabel = `<g><rect x="${(LX - LW / 2).toFixed(1)}" y="${LY - 9}" width="${LW.toFixed(1)}" height="18" rx="9" fill="var(--pin-bg0, #0d1117)" stroke="var(--pin-neutralStroke, #345)" stroke-width="1"/><text x="${LX.toFixed(1)}" y="${LY + 3.5}" text-anchor="middle" fill="var(--pin-textMuted, #8b949e)" font-size="10.5">${EDGE_VIA}</text></g>`;

// The containment box. Deliberately roomier than the cards need (#267): the
// clamp only earns its keep if the smoke can drag INTO a wall on purpose, and
// every drag that isn't about the wall has to stay clear of one.
//
// #250: shaped the way pinhole 0.3.3 emits an ARCHITECTURE group box — a
// `data-group-id` carrying the container key, and a title `<text>` that is
// NOT that key (`layoutArchitecture` titles a box `<id>  ·  <kind>`). The two
// disagreeing on purpose is the assertion: a delta stored under `box:wave-1`
// proves the key came off the attribute, and not off the title text the old
// structural matcher had to read.
export const BOX = { x: 20, y: 40, w: 580, h: 220 };
export const BOX_ID = "wave-1";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 300" width="620" height="300">
  <style>:root{--pin-bg0:#0d1117;--pin-text:#e6edf3}</style>
  <rect x="0" y="0" width="620" height="300" fill="var(--pin-bg0, #0d1117)"/>
  <rect data-group-id="${BOX_ID}" x="${BOX.x}" y="${BOX.y}" width="${BOX.w}" height="${BOX.h}" rx="10" fill="none" stroke="var(--pin-edge, #444)"/>
  <text x="30" y="30" font-size="12" fill="var(--pin-textMuted, #999)">${BOX_ID}  ·  Wave</text>
  <g data-edge-from="api" data-edge-to="worker" data-edge-via="${EDGE_VIA}"><path class="pin-edge-line" d="${EDGE_D}" fill="none" stroke="var(--pin-edge, #444)" stroke-width="1.4"/><path d="${EDGE_D}" fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke"/></g>
  ${edgeLabel}
  ${nodeSvg("api", 40, "good", "api", coloredMark)}
  ${nodeSvg("worker", 230, "accent", "worker", helmMark)}
  ${nodeSvg("frontend", 420, "neutral", "frontend")}
</svg>`;

// #259: `api` carries a DECLARED object attribute, so the inspect pane's
// "declared" section has a real nested value to render as a tree (it used to be
// one flat JSON.stringify line). Present in the source graph and the overlay
// alike, so the check doesn't depend on which lens the smoke is on.
const declaredSpec = {
  image: "ghcr.io/acme/api:1.4.2",
  ports: [80, 443],
  resources: { limits: { cpu: "500m", memory: "512Mi" } },
};

const ir = {
  nodes: [
    { id: "api", kind: "Component", lexicon: "aws", attrs: { _status: "good", spec: declaredSpec } },
    { id: "worker", kind: "Component", lexicon: "aws", attrs: { _status: "accent" } },
    { id: "frontend", kind: "Component", lexicon: "aws", attrs: { _status: "neutral" } },
  ],
  edges: [{ from: "api", to: "worker" }],
};

// #259: the observed/drift payload the inspect pane renders for `api` — the
// shape `/api/diff` really returns, with the three things the JSON view exists
// for: a subtree deep enough to start collapsed (`spec.template.metadata`), a
// string long enough to truncate, and a drift pair whose sides are objects
// rather than scalars. `smoke/ui-smoke.mjs` asserts against these exact values.
const DEEP_LABELS = { app: "api", tier: "web", "app.kubernetes.io/managed-by": "chant" };
const LONG_STRING = "kubectl.kubernetes.io/last-applied-configuration=" + "x".repeat(400);
const observedSpec = {
  replicas: 3,
  lastApplied: LONG_STRING,
  template: { metadata: { labels: DEEP_LABELS, annotations: { "chant.dev/owner": "estate" } } },
};
const diffNodes = {
  api: {
    observed: {
      type: "k8s::Deployment",
      status: "Running",
      physicalId: "deploy/api",
      attributes: { spec: observedSpec, endpoints: ["10.0.0.4:8080", "10.0.0.5:8080"] },
    },
    health: "healthy",
    diff: {
      category: "drifted",
      changes: [
        { path: "spec.replicas", oldValue: 3, newValue: 5 },
        { path: "spec.resources", oldValue: { cpu: "500m" }, newValue: { cpu: "1", memory: "1Gi" } },
      ],
    },
    fieldDrift: {
      drifted: [{ path: "spec.replicas", kind: "changed", owner: "hpa-controller", declared: 3, live: 5 }],
      accepted: [],
    },
  },
};

// #229: the live overlay reports `worker` as deployed — same node ids, one
// changed `_status`. That's exactly the input the render-diff pulse keys on, so
// picking an env in the smoke drives the motion signature end to end.
const irFor = (env) =>
  env ? { ...ir, nodes: ir.nodes.map((n) => (n.id === "worker" ? { ...n, attrs: { ...n.attrs, _status: "good" } } : n)) } : ir;

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
  // #268: the demo catalog the switcher renders — one runnable entry, one
  // blocked by a missing prerequisite (which must render disabled with its
  // reason, not vanish), and one that clones from the network (which must say
  // so on the button before it is clicked).
  "/api/demos": {
    demos: [
      { name: "argo-estate", description: "Declared-only Argo CD estate.", requires: [], source: "bundled", fetches: false, target: "/tmp/behold-demos/argo-estate", loaded: false, satisfiable: true },
      { name: "k8s", description: "nginx on a throwaway k3d cluster.", requires: ["docker", "k3d"], source: "bundled", fetches: false, target: "/tmp/behold-demos/k8s", loaded: false, satisfiable: false, reason: "needs k3d on PATH" },
      { name: "fountain", description: "The mature estate, cloned.", requires: [], source: "git", repo: "https://github.com/INTENTIUS/fountain-ops", fetches: true, target: "/tmp/behold-demos/fountain", loaded: false, satisfiable: true },
    ],
  },
  "/api/ops": { ops: [], adoptLexicons: [], autoSync: "off" },
  "/api/ci": { jobs: [], forge: "github" },
  "/api/resources": { byComponent: {} },
  "/api/reconcile": { total: 2, byComponent: { worker: 2 }, uncorrelated: 0 },
  "/api/diff": { env: "local", nodes: diffNodes },
};

// What the smoke expects to find inside the rendered trees / copied payloads.
export const JSON_FIXTURE = { declaredSpec, observedSpec, deepLabels: DEEP_LABELS, longString: LONG_STRING };

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

// ---------------------------------------------------------------------------
// #254: carve mode, for the walkthrough half of the smoke.
//
// The report is the REAL committed one (example-carve/carve-report.json) run
// through the REAL lens (src/carve-lens.ts) — so the smoke drives the same IR a
// `behold demo carve` serves, bands and all, rather than a hand-cut stand-in.
// The two POST steps answer canned results shaped exactly like
// src/carve-actions.ts's, which is what makes the six-step walk deterministic:
// no chant, no @cdktf/hcl2json, no npm install in CI.
// ---------------------------------------------------------------------------
const CARVE_REPORT = JSON.parse(readFileSync(join(WEB, "..", "example-carve", "carve-report.json"), "utf8"));
const carveIr = carveReportToIr(CARVE_REPORT);
const carveSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 ${80 + carveIr.nodes.length * 70}" width="900" height="${80 + carveIr.nodes.length * 70}">
  <rect x="0" y="0" width="900" height="${80 + carveIr.nodes.length * 70}" fill="var(--pin-bg0, #0d1117)"/>
  ${carveIr.nodes
    .map((n, i) => {
      const tone = { good: "good", warn: "warn", neutral: "neutral" }[n.attrs._status] || "neutral";
      return `<g data-node-id="${n.id}" transform="translate(40, ${40 + i * 70})">
    <rect x="0" y="0" width="360" height="56" rx="8" fill="var(--pin-${tone}Fill, #1c2431)" stroke="var(--pin-${tone}Stroke, #345)"/>
    <rect x="0" y="0" width="4" height="56" fill="var(--pin-${tone}Bar, #3fb950)"/>
    <text x="16" y="24" font-size="13" fill="var(--pin-text, #e6edf3)">${n.id}</text>
    <text x="16" y="44" font-size="10" fill="var(--pin-textMuted, #8b949e)">score: ${n.attrs.score} · ${n.attrs.carve}</text>
  </g>`;
    })
    .join("\n  ")}
</svg>`;

const CARVE_DEMO = {
  root: "/demos/carve",
  from: "/demos/carve/legacy-tf",
  state: "/demos/carve/legacy-tf/terraform.tfstate",
  project: "/demos/carve/app",
  out: "/demos/carve/app/carveout",
  outLabel: "app/carveout",
  fromLabel: "legacy-tf",
  runnable: true,
  buildCaveat: "The gate shown is `chant lint`, not `chant build` — `build` fails only WAW042 now, real drift the Terraform never declared (chant#1637).",
};

/** What POST /api/carve/emit answers — src/carve-actions.ts's CarveEmitResult. */
export const CARVE_EMIT = {
  ok: true,
  select: "aws_s3_bucket.assets",
  command:
    "chant carve emit --from legacy-tf --state legacy-tf/terraform.tfstate --select aws_s3_bucket.assets --output app/carveout",
  output: "Carved aws_s3_bucket.assets (peelability 84) — observe position, reversible.\n  Emitted: app/carveout/src/assets.ts",
  artifacts: [
    {
      path: "app/carveout/src/assets.ts",
      kind: "ts",
      bytes: 142,
      truncated: false,
      text: 'import { Bucket } from "@intentius/chant-lexicon-aws";\n\nexport const assets = new Bucket({\n  BucketName: "acme-platform-assets-prod",\n});\n',
    },
  ],
  boundary: {
    target: "aws_s3_bucket.assets",
    inbound: [
      { direction: "inbound", survivor: "aws_lambda_function.api", carved: "aws_s3_bucket.assets", attrs: ["bucket"], bridge: "tf-data-source" },
    ],
    outbound: [],
  },
  lint: { ok: true, code: 0, command: "chant lint carveout/src", output: "  5:1  warning  never referenced  COR004\n\n⚠ 3 warnings" },
  buildCaveat: CARVE_DEMO.buildCaveat,
};

/** What POST /api/carve/bridge answers — CarveBridgeResult. */
export const CARVE_BRIDGE = {
  ok: true,
  select: "aws_s3_bucket.assets",
  command: "chant carve bridge --from legacy-tf --select aws_s3_bucket.assets --output app/carveout",
  output: "Wrote proposals to app/carveout/ — review, then apply. Nothing in your Terraform changed.",
  runbook: {
    path: "app/carveout/aws_s3_bucket-assets-runbook.md",
    kind: "md",
    bytes: 210,
    truncated: false,
    text:
      "# Carve-out: aws_s3_bucket.assets → chant\n\n" +
      "## 2. Stop Terraform managing the resource (does NOT destroy it)\n" +
      "    terraform state rm aws_s3_bucket.assets\n\n" +
      "## 3. Confirm no destroy, then patch the survivors\n" +
      "    terraform plan   # expect 0 to destroy\n" +
      "    terraform apply\n",
  },
  proposals: [
    {
      path: "app/carveout/aws_s3_bucket-assets-datasources.tf",
      kind: "tf",
      bytes: 64,
      truncated: false,
      text: 'data "aws_s3_bucket" "assets" {\n  bucket = "acme-platform-assets-prod"\n}\n',
    },
  ],
};

/**
 * Start the stub on `port`; resolves to the http.Server (close() to stop).
 *
 * `{ carve: true }` serves the #254 walkthrough instead of the project estate:
 * the carve graph, `/api/carve`, and the two POST steps. `server.carvePosts`
 * records what the page sent, so the smoke can assert the wire contract
 * (a JSON body carrying the picked address) and not just the pixels.
 */
export function startStub(port, { carve = false } = {}) {
  // #228: the hand-layout sidecar, in memory instead of `.behold/layout.json`
  // — the SAME wire contract src/server.ts serves (lens-keyed deltas, a
  // `writable` flag on the read), so the smoke drives the client's whole sync
  // layer without a project on disk. `server.layout` lets the test read and
  // seed it as if it were the file.
  const layout = new Map();
  const carvePosts = [];
  const readBody = (req) =>
    new Promise((r) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => r(s || "{}"));
    });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (carve) {
      const json = (body, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/api/carve") return json(CARVE_REPORT);
      if (path === "/api/carve/emit" || path === "/api/carve/bridge") {
        const body = JSON.parse(await readBody(req));
        carvePosts.push({ path, method: req.method, contentType: req.headers["content-type"], body });
        // Same refusal shape src/server.ts sends for a select the report
        // doesn't rank, so the client's error path is exercisable too.
        if (!CARVE_REPORT.resources.some((r) => r.address === body.select)) {
          return json({ error: `\`select\` must name a resource this report ranks — ${JSON.stringify(body.select)} isn't one.`, code: "carve-select", remedy: "Pick a card in the graph." }, 400);
        }
        return json(path.endsWith("emit") ? CARVE_EMIT : CARVE_BRIDGE);
      }
      if (path === "/api/project") {
        return json({
          projectDir: "/demos/carve/carve-report.json",
          recents: [],
          environments: [],
          lexicons: ["terraform"],
          currentEnv: null,
          targets: [],
          carve: {
            report: "/demos/carve/carve-report.json",
            from: CARVE_REPORT.from,
            count: CARVE_REPORT.count,
            bands: CARVE_REPORT.bands,
            advisory: CARVE_REPORT.advisory,
            demo: CARVE_DEMO,
          },
        });
      }
      if (path === "/api/graph") {
        return json({
          ir: carveIr,
          svg: carveSvg,
          meta: { projectDir: "/demos/carve/carve-report.json", env: null, tier: null, target: null, carve: true, note: "chant carve advisory for legacy-tf" },
        });
      }
      if (path === "/api/substrates") return json({ substrates: [] });
      if (path === "/api/history") return json({ commits: [] });
      if (path === "/api/resources") return json({ byComponent: {} });
      if (path === "/api/ci") return json({ stages: [], jobs: [], forge: null });
      if (path === "/api/ops") return json({ ops: [], adoptLexicons: [], autoSync: "off" });
      if (path === "/api/layout") return json({ lens: url.searchParams.get("lens"), writable: false, reason: "a carve report isn't a project", deltas: {} });
    }
    if (path === "/api/layout") {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (Object.keys(body.deltas || {}).length) layout.set(body.lens, body.deltas);
        else layout.delete(body.lens);
        return res.end(JSON.stringify({ ok: true, lens: body.lens, deltas: body.deltas || {} }));
      }
      const lens = url.searchParams.get("lens");
      return res.end(JSON.stringify({ lens, writable: true, deltas: layout.get(lens) || {} }));
    }
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
      return res.end(JSON.stringify({ ir: irFor(meta.env), svg, meta }));
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
  server.layout = layout; // the sidecar, for the smoke to read and seed (#228)
  server.carvePosts = carvePosts; // what the stepper actually sent (#254)
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
