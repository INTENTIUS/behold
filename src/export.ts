/**
 * Static export (interactive, hostable, no backend). Captures every read
 * endpoint's response for the whole lens matrix (envs × tiers × zooms × radial)
 * into a self-contained folder a static host can serve. The frontend (web/app.js
 * in static mode) replays the snapshots so pan/zoom, the zoom dial, radial, the
 * inspect pane, and the env/tier pickers all work with no live server.
 *
 * Capture is IN-PROCESS via `createApp` + Hono `app.request(url)` — the exact
 * same handlers the live server runs, so a snapshot is byte-identical to live
 * (reclassify / prune / value-match / composite-deps / radial all included), no
 * logic duplicated.
 */
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, type ServerOptions } from "./server.ts";

/** The only query params that select a distinct snapshot — a stable whitelist so
 * matching a request to a captured key is robust to any extra params the
 * frontend appends (target/lens/etc. don't vary a static bundle). Sorted, so
 * capture and replay agree regardless of param order. MUST stay identical to the
 * copy in web/app.js (`canonicalKey`). */
const LENS_PARAMS = ["components", "detail", "env", "network", "radial", "tier"];
export function canonicalKey(path: string, params: URLSearchParams): string {
  // The component-DAG and network views ignore detail/radial (they're
  // entity-graph knobs), but the frontend still appends the current detail —
  // drop them here so the request matches the single captured snapshot.
  const flat = params.get("components") === "1" || params.get("network") === "1";
  const q = LENS_PARAMS.filter((k) => params.has(k) && !(flat && (k === "detail" || k === "radial")))
    .map((k) => `${k}=${params.get(k)}`)
    .join("&");
  return q ? `${path}?${q}` : path;
}

/** A readable, filesystem-safe snapshot filename from a canonical key. */
function slug(key: string): string {
  const base = key.replace(/^\//, "").replace(/[^a-zA-Z0-9=_.-]+/g, "_").slice(0, 120);
  return `${base}.json`;
}

export interface ExportAxes {
  environments: string[];
  tiers?: string[];
}

/** The read URLs to capture for the given axes. */
export function captureKeys(axes: ExportAxes): string[] {
  const keys = new Set<string>();
  const add = (path: string, p: Record<string, string>) => keys.add(canonicalKey(path, new URLSearchParams(p)));

  add("/api/project", {});
  add("/api/substrates", {});
  add("/api/ops", {});

  const tiers = axes.tiers && axes.tiers.length ? axes.tiers : [""];
  const envs = ["", ...axes.environments]; // "" = the declared-source view
  for (const env of envs) {
    for (const tier of tiers) {
      const lens = (extra: Record<string, string>) => {
        const p: Record<string, string> = { ...extra };
        if (env) p.env = env;
        if (tier) p.tier = tier;
        return p;
      };
      add("/api/graph", lens({ components: "1" })); // components / waves view
      add(env ? "/api/overlay" : "/api/graph", lens({ network: "1" })); // network/regional lens (#63)
      add("/api/ci", lens({})); // CI facet — the frontend requests it without `components`
      if (env) {
        add("/api/reconcile", lens({}));
        add("/api/resources", lens({}));
        add("/api/diff", lens({})); // bulk per-node live state → inspect shows observed state offline
      }
      // Infra graph at each detail tier × radial on/off (overlay when an env is
      // picked, source graph otherwise).
      for (const detail of ["1", "2", "3"]) {
        for (const radial of ["0", "1"]) {
          const p = lens({ detail });
          if (radial === "1") p.radial = "1";
          add(env ? "/api/overlay" : "/api/graph", p);
        }
      }
    }
  }
  return [...keys];
}

function webDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "web");
}

/** A Cloudflare Worker name: lowercase, alnum + hyphens, ≤ 63 chars. */
function workerName(project: string, override?: string): string {
  const raw = override ?? `behold-${basename(project)}`;
  const name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return name || "behold-export";
}

/** Capture the estate `cfg` observes into a static bundle at `outDir`. */
export async function runExport(cfg: ServerOptions, outDir: string, opts: { name?: string } = {}): Promise<void> {
  const app = createApp(cfg);

  const proj = (await (await app.request("/api/project")).json()) as { environments?: string[]; tiers?: string[] };
  const axes: ExportAxes = { environments: proj.environments ?? [], tiers: proj.tiers ?? [] };

  const snapDir = join(outDir, "snapshots");
  mkdirSync(snapDir, { recursive: true });

  const keyToFile: Record<string, string> = {};
  let ok = 0;
  let failed = 0;
  for (const key of captureKeys(axes)) {
    const res = await app.request(key); // key is already `path?sortedLensParams`
    const body = await res.text();
    const file = slug(key);
    writeFileSync(join(snapDir, file), body);
    keyToFile[key] = `snapshots/${file}`;
    if (res.ok) ok++;
    else failed++;
  }

  const manifest = {
    static: true,
    capturedAt: new Date().toISOString(),
    projectDir: cfg.projectDir,
    axes,
    keyToFile,
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Copy the SPA, flipping it into static mode.
  const html = readFileSync(join(webDir(), "index.html"), "utf8").replace(
    /<\/head>/i,
    `  <script>window.__BEHOLD_STATIC__ = true;</script>\n  </head>`,
  );
  writeFileSync(join(outDir, "index.html"), html);
  copyFileSync(join(webDir(), "app.js"), join(outDir, "app.js"));
  writeFileSync(join(outDir, "README.md"), BUNDLE_README);

  // Deploy-ready: an assets-only Cloudflare Worker config (no server code — the
  // bundle is pure static), so `cd <out> && wrangler deploy` hosts it on
  // <name>.workers.dev. Matches the blacklight Worker + Static Assets setup.
  const name = workerName(cfg.projectDir, opts.name);
  writeFileSync(
    join(outDir, "wrangler.jsonc"),
    JSON.stringify(
      { $schema: "node_modules/wrangler/config-schema.json", name, compatibility_date: "2025-06-01", assets: { directory: "." } },
      null,
      2,
    ) + "\n",
  );

  process.stdout.write(
    `behold export → ${outDir}\n  ${ok} snapshots${failed ? ` (${failed} endpoint error(s) captured as-is)` : ""}\n` +
      `  View:   npx serve ${outDir}\n` +
      `  Deploy: cd ${outDir} && npx wrangler deploy   → https://${name}.<your-account>.workers.dev\n`,
  );
}

const BUNDLE_README = `# behold — static export

An interactive, read-only snapshot of an estate captured by \`behold export\`.
No server or backend — everything runs client-side from the bundled snapshots.
Pan/zoom, the zoom dial, radial layout, the inspect pane, and the env/tier
pickers all work; there's no live observe or deploy.

## View it locally
It must be served over http (not opened as a \`file://\` — browsers block the
snapshot fetches on that protocol):
\`\`\`sh
npx serve .
# or
python3 -m http.server 8000
\`\`\`

## Deploy to Cloudflare (Workers Static Assets)
This folder is deploy-ready — an assets-only \`wrangler.jsonc\` is included (no
server code; the bundle is pure static). With [wrangler](https://developers.cloudflare.com/workers/wrangler/)
installed and Cloudflare auth set:
\`\`\`sh
npx wrangler deploy
# → https://<name>.<your-account>.workers.dev
\`\`\`
Auth: run \`npx wrangler login\`, or set \`CLOUDFLARE_API_TOKEN\` +
\`CLOUDFLARE_ACCOUNT_ID\`. Rename by editing \`"name"\` in \`wrangler.jsonc\`.

## Other static hosts
It's just files — GitHub Pages, S3, nginx, or Cloudflare Pages
(\`wrangler pages deploy .\`) all work.
`;
