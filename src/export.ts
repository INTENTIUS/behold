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
import { mkdirSync, writeFileSync, copyFileSync, cpSync, readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { S3Error, S3Object } from "./s3-object.ts";
import { fileURLToPath } from "node:url";
import { createApp, type ServerOptions } from "./server.ts";

/** The only query params that select a distinct snapshot — a stable whitelist so
 * matching a request to a captured key is robust to any extra params the
 * frontend appends (target/lens/etc. don't vary a static bundle). Sorted, so
 * capture and replay agree regardless of param order. MUST stay identical to the
 * copy in web/app.js (`canonicalKey`). */
const LENS_PARAMS = ["collapse", "components", "detail", "env", "logical", "ops", "radial", "stacks", "tier"];
export function canonicalKey(path: string, params: URLSearchParams): string {
  // The component-DAG, logical and ops views ignore detail/radial (they're
  // entity-graph knobs), but the frontend still appends the current detail —
  // drop them here so the request matches the single captured snapshot.
  const flat =
    params.get("components") === "1" ||
    params.get("logical") === "1" ||
    params.get("ops") === "1" ||
    params.get("stacks") === "1";
  const q = LENS_PARAMS.filter((k) => params.has(k) && !(flat && (k === "detail" || k === "radial")))
    .map((k) => `${k}=${params.get(k)}`)
    .join("&");
  return q ? `${path}?${q}` : path;
}

/**
 * A readable, filesystem-safe snapshot filename from a canonical key, with
 * the first 16 hex digits of the body's SHA-256 before `.json` (#500). The
 * name changes whenever the bytes do, so a published snapshot can be cached
 * for good, and a new manifest never points at an old body under the same name.
 */
function slug(key: string, body: string): string {
  const base = key.replace(/^\//, "").replace(/[^a-zA-Z0-9=_.-]+/g, "_").slice(0, 120);
  return `${base}.${createHash("sha256").update(body).digest("hex").slice(0, 16)}.json`;
}

/** A snapshot file whose name carries its content hash (slug above). */
export const CONTENT_ADDRESSED = /^snapshots\/[A-Za-z0-9=_.-]+\.[0-9a-f]{16}\.json$/;

export interface ExportAxes {
  environments: string[];
  tiers?: string[];
  /** How many Ops the estate has emitted (#284) — the ops lens stop exists only
   * when this is non-zero, exactly as the SPA gates it on `/api/project`'s
   * `ops`. Absent/0 means no stop, so nothing to capture. */
  ops?: number;
  /** #491: the export was given `--terragucci`, so the marks are one more snapshot. */
  terragucci?: boolean;
}

/** The read URLs to capture for the given axes. */
export function captureKeys(axes: ExportAxes): string[] {
  const keys = new Set<string>();
  const add = (path: string, p: Record<string, string>) => keys.add(canonicalKey(path, new URLSearchParams(p)));

  add("/api/project", {});
  add("/api/substrates", {});
  add("/api/ops", {});
  // The ops lens (#284): ONE snapshot, outside the env/tier loops — the view
  // reads no live state and no tier, so every lens combination would capture
  // the same bytes. Only when the estate has emitted Ops, so a bundle never
  // offers a stop it has nothing behind (the SPA gates the stop on the same
  // number, out of the captured /api/project).
  // `entities=1` (chant#2022) is what the SPA sends, so the snapshot carries
  // the step→estate links; the canonical key ignores it, so the SPA's lookup
  // still matches.
  if (axes.ops) add("/api/graph", { ops: "1", entities: "1" });
  // #491: the terragucci marks: one read, whatever the lens, as the SPA asks it.
  if (axes.terragucci) add("/api/terragucci", {});
  // #506: and the audit record's timeline, the SPA's one unfiltered ask (it filters by root itself).
  if (axes.terragucci) add("/api/terragucci/timeline", {});

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
      add(env ? "/api/overlay" : "/api/graph", lens({ logical: "1" })); // logical/architecture lens (#63)
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

/** The package root: where LICENSE, THIRD_PARTY.md and licenses/ sit, one
 * level above web/ and dist/ alike. */
function pkgRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The notice files an export carries (#394): behold's own LICENSE, the
 * third-party summary, and every vendored licence under licenses/. Exported
 * for the test; a missing file is skipped rather than fatal, because a
 * checkout mid-edit must still export. */
export const NOTICE_FILES = ["LICENSE", "THIRD_PARTY.md"] as const;
export function copyNotices(outDir: string, root: string = pkgRoot()): string[] {
  const copied: string[] = [];
  for (const f of NOTICE_FILES) {
    if (!existsSync(join(root, f))) continue;
    copyFileSync(join(root, f), join(outDir, f));
    copied.push(f);
  }
  const lic = join(root, "licenses");
  if (existsSync(lic)) {
    mkdirSync(join(outDir, "licenses"), { recursive: true });
    for (const f of readdirSync(lic)) {
      copyFileSync(join(lic, f), join(outDir, "licenses", f));
      copied.push(`licenses/${f}`);
    }
  }
  return copied;
}

/** A Cloudflare Worker name: lowercase, alnum + hyphens, ≤ 63 chars. */
function workerName(project: string, override?: string): string {
  const raw = override ?? `behold-${basename(project)}`;
  const name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return name || "behold-export";
}

/** Capture the estate `cfg` observes into a static bundle at `outDir`. */
export interface ExportOptions {
  name?: string;
  /** `--no-source`: leave each card's source text (a Terraform root's whole file, in `attrs.source`) out of the bundle. */
  noSource?: boolean;
  /** Where a terragucci report key opens from the bundle (#491): relative to it, `../../` by default, since the estate job uploads it to `<prefix>/views/behold/`. */
  reportsBase?: string;
}

/** Export's default for a report key's base: the bundle sits at `<prefix>/views/behold/`, so `../../` is the prefix. */
export const VIEWS_REPORTS_BASE = "../../";

export async function runExport(cfg: ServerOptions, outDir: string, opts: ExportOptions = {}): Promise<void> {
  // A capture reads the project; it never writes to it (#228). The layout
  // sidecar is the one thing behold can write, and an export is exactly the
  // wrong moment for it — so the app built here refuses that write outright
  // rather than relying on nothing happening to call it.
  const app = createApp({ ...cfg, layoutWrites: false });

  const proj = (await (await app.request("/api/project")).json()) as { environments?: string[]; tiers?: string[]; ops?: number; terragucciReports?: unknown };
  const axes: ExportAxes = {
    environments: proj.environments ?? [],
    tiers: proj.tiers ?? [],
    ...(proj.ops ? { ops: proj.ops } : {}),
    ...(proj.terragucciReports ? { terragucci: true } : {}),
  };
  const scrub = exportScrubber(cfg);

  const snapDir = join(outDir, "snapshots");
  mkdirSync(snapDir, { recursive: true });

  const keyToFile: Record<string, string> = {};
  let ok = 0;
  let failed = 0;
  for (const key of captureKeys(axes)) {
    // `layout=1` asks the graph/overlay routes to bake the hand-layout sidecar's
    // deltas into the SVG (#228), so a bundle shows the estate arranged the way
    // it was arranged by hand. It is NOT a lens param — `canonicalKey` whitelists
    // the six that select a distinct snapshot and drops everything else — so the
    // captured key stays exactly what the frontend will ask for.
    const res = await app.request(`${key}${key.includes("?") ? "&" : "?"}layout=1`); // key is already `path?sortedLensParams`
    const body = scrub(shapeSnapshot(key, await res.text(), opts));
    const file = slug(key, body);
    writeFileSync(join(snapDir, file), body);
    keyToFile[key] = `snapshots/${file}`;
    if (res.ok) ok++;
    else failed++;
    // #491: a view asked to carry terragucci's marks and could not read them is
    // no view: the estate job's step fails, rather than publishing a picture
    // with no marks that looks like an estate with nothing to say.
    if (key === "/api/terragucci" && !res.ok) {
      const refusal = JSON.parse(body) as { error?: string; remedy?: string };
      throw new Error(`terragucci reports not read: ${refusal.error ?? res.status}${refusal.remedy ? `\n  ${refusal.remedy}` : ""}`);
    }
  }

  const manifest = {
    static: true,
    capturedAt: new Date().toISOString(),
    projectDir: basename(cfg.projectDir),
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
  // Copy every sibling web asset, not just app.js: the SPA is unbundled ES modules, so app.js
  // imports theme.js which imports themes.js. Copying app.js alone 404s the rest of the module
  // graph and the whole bundle fails to boot. index.html is templated above, so skip it here.
  // #489: web/icons is a directory (the icon corpus), so each entry is copied
  // recursively; copyFileSync on it died with ENOTSUP mid-export.
  for (const f of readdirSync(webDir())) {
    if (f === "index.html" || f.endsWith(".test.js")) continue;
    cpSync(join(webDir(), f), join(outDir, f), { recursive: true });
  }
  writeFileSync(join(outDir, "README.md"), BUNDLE_README);
  // #394: the bundle redistributes what the SPA vendors — the iTerm2 colour
  // schemes in themes.js, the CNCF artwork and Kubernetes icons under
  // web/icons — so the notices travel with it. Whoever serves an export is
  // the redistributor, and the notices left behind in this repo would not
  // reach them. behold's own grant rides along for the same reason.
  copyNotices(outDir);

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

// ---------------------------------------------------------------------------
// What a bundle carries (#491). A bundle is meant to be put where other people
// open it (a bucket, a Worker), so it carries the picture and nothing about
// the machine that captured it: no list of the operator's other projects, no
// user name, no absolute path, and, on request, no source text.
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Delete `attrs.source` wherever an object carries `attrs`. */
function dropSource(v: unknown): void {
  if (Array.isArray(v)) return v.forEach(dropSource);
  if (!isRecord(v)) return;
  if (isRecord(v.attrs)) delete v.attrs.source;
  for (const x of Object.values(v)) dropSource(x);
}

/** One snapshot as the bundle keeps it. Bodies that are not JSON pass through. */
export function shapeSnapshot(key: string, body: string, opts: ExportOptions = {}): string {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(doc)) return body;
  if (key === "/api/project") {
    // The switcher's recents are the operator's other projects; the approver
    // is their login. Neither is part of the picture.
    delete doc.recents;
    delete doc.approver;
  }
  if (key === "/api/terragucci" || key === "/api/terragucci/timeline") doc.files = opts.reportsBase ?? VIEWS_REPORTS_BASE;
  if (opts.noSource) dropSource(doc);
  return JSON.stringify(doc);
}

/**
 * Replace the capturing machine's paths with names: each served directory
 * (and a local reports directory) by its basename, then the home directory by
 * `~`. Longest first, so a member inside the root keeps its own name.
 */
export function exportScrubber(cfg: Pick<ServerOptions, "projectDir" | "projectDirs" | "workspace" | "terragucci">, home: string = homedir()): (text: string) => string {
  const dirs = [cfg.projectDir, ...(cfg.projectDirs ?? []), ...(cfg.workspace ? [cfg.workspace.root] : [])];
  const tg = cfg.terragucci?.source;
  if (tg && !/^[a-z0-9]+:\/\//i.test(tg)) dirs.push(resolve(tg));
  const pairs = new Map<string, string>();
  for (const d of dirs) {
    for (const p of [resolve(d), safeRealpath(d)]) if (p && p !== "/") pairs.set(p, basename(p));
  }
  const ordered = [...pairs].sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [from, to] of ordered) out = out.split(from).join(to);
    if (home && home !== "/") out = out.split(home).join("~");
    return out;
  };
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Publishing a bundle to a bucket (#491): the one cloud write behold makes,
// and only when an export is asked for it.
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  jsonc: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};
const contentType = (file: string): string => {
  const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? (ext ? "application/octet-stream" : "text/plain; charset=utf-8");
};

/**
 * Where `--publish` may write: `s3://<bucket>/<…>/views/<name>`. A bundle has
 * an `index.html` and a `manifest.json` at its top, and a reports prefix has
 * an `index.html` of its own, so a destination outside a `views/` directory
 * (terragucci's reserved prefix, which it never writes) could overwrite a
 * page behold did not make. Refused rather than guessed at.
 */
export function publishTarget(spec: string): { bucket: string; prefix: string } | { error: string } {
  const m = /^s3:\/\/([^/]+)\/(.+?)\/?$/.exec(spec);
  if (!m) return { error: `--publish takes s3://<bucket>/<prefix>/views/<name>, not ${spec}` };
  const prefix = m[2]!;
  const parts = prefix.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return { error: `--publish ${spec}: the prefix has an empty, . or .. segment` };
  const at = parts.lastIndexOf("views");
  if (at < 0 || at !== parts.length - 2) {
    return { error: `--publish writes only to a views/<name> directory, such as s3://${m[1]}/${parts.filter((p) => p !== "views").join("/")}/views/behold: a bundle's index.html would overwrite the prefix's own pages anywhere else` };
  }
  return { bucket: m[1]!, prefix };
}

/** Cache-Control for a file whose name changes with its bytes. */
export const IMMUTABLE = "public, max-age=31536000, immutable";
/** Cache-Control for every other file: the reader asks the bucket again each time. */
export const NO_CACHE = "no-cache";

/** What a publish did. */
export interface Published {
  /** How many files were uploaded. */
  files: number;
  /** Keys of the previous export's snapshots this one removed. */
  removed: string[];
  /** Why the sweep of the previous export's files stopped short, when it did. The publish still succeeded. */
  warnings: string[];
}

/** The snapshot files a manifest names, each a plain `snapshots/<name>` so a delete can only land under the prefix. */
function manifestFiles(text: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const map = isRecord(doc) && isRecord(doc.keyToFile) ? doc.keyToFile : {};
  return Object.values(map).filter((f): f is string => typeof f === "string" && /^snapshots\/[A-Za-z0-9=_.-]+$/.test(f) && !f.includes(".."));
}

/**
 * Upload every file under `outDir` to `<prefix>/<path>` (#491), in the order
 * that keeps a reader from seeing a half-written view (#500): every file but
 * `manifest.json` and `index.html`, then `manifest.json`, then `index.html`.
 * A content-addressed snapshot is uploaded with IMMUTABLE, every other file
 * with NO_CACHE.
 *
 * Before uploading, it reads the previous `manifest.json` under the prefix
 * (one GET, no list call); after the new `index.html`, it deletes the
 * snapshots that manifest named and this export did not write, only under the
 * prefix. The sweep is best effort: a delete S3 refuses stops it with a
 * warning naming `s3:DeleteObject`, and the publish still succeeds.
 */
export async function publishBundle(outDir: string, target: { bucket: string; prefix: string }, client: Pick<S3Object, "put" | "get" | "delete">): Promise<Published> {
  const files = (readdirSync(outDir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((d) => d.isFile())
    .map((d) => relative(outDir, join(d.parentPath, d.name)).split(sep).join("/"))
    .sort();
  const warnings: string[] = [];
  const at = (f: string) => `${target.prefix}/${f}`;

  let previous: string[] = [];
  try {
    const text = await client.get(at("manifest.json"));
    if (text !== undefined) previous = manifestFiles(text);
  } catch (e) {
    const note = e instanceof S3Error && e.status === 403 ? " (S3 answers 403 for a missing object too when the credentials lack s3:ListBucket)" : "";
    warnings.push(`the previous manifest.json could not be read, so its files are left in place: ${e instanceof Error ? e.message : String(e)}${note}`);
  }

  const last = ["manifest.json", "index.html"];
  const order = [...files.filter((f) => !last.includes(f)), ...last.filter((f) => files.includes(f))];
  for (const f of order) await client.put(at(f), readFileSync(join(outDir, f)), contentType(f), CONTENT_ADDRESSED.test(f) ? IMMUTABLE : NO_CACHE);

  const wrote = new Set(files);
  const removed: string[] = [];
  for (const f of previous) {
    if (wrote.has(f)) continue;
    try {
      await client.delete(at(f));
      removed.push(at(f));
    } catch (e) {
      const denied = e instanceof S3Error && (e.status === 403 || e.code === "AccessDenied");
      warnings.push(
        denied
          ? `the previous export's files were left in s3://${target.bucket}/${target.prefix}/: deleting them needs s3:DeleteObject on that prefix, which these credentials lack`
          : `the previous export's files were left in s3://${target.bucket}/${target.prefix}/: ${e instanceof Error ? e.message : String(e)}`,
      );
      break;
    }
  }
  return { files: files.length, removed, warnings };
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
