/**
 * The hand layout (#228, server half; #469 moved it out of the project): one
 * per-user cache file per served project, and the delta->SVG math that makes
 * an export honour it.
 *
 * WHERE IT LIVES. Under the OS user cache directory, never in the served
 * project (the 2026-10-23 ruling on #469: behold writes nothing in a served
 * project). The file is `<cache>/behold/layouts/<key>.json`, where `<cache>`
 * is `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows and
 * `$XDG_CACHE_HOME` (or `~/.cache`) elsewhere, and `<key>` is the first 32 hex
 * characters of the sha256 of the project directory's realpath. Same
 * placement rules as the MCP serve registry (src/serve-registry.ts): the
 * directory is the user's own (0700, files 0600), and `BEHOLD_CACHE_DIR`
 * replaces `<cache>/behold` (the tests use it). It is a cache in the full
 * sense: deleting it loses one operator's arrangement and nothing else.
 *
 * MIGRATION. A project served before #469 may carry `.behold/layout.json`.
 * When the cache has no file for the project, that old file is read once and
 * its lenses copied into the cache; after that only the cache is read. The old
 * file is never written, moved or deleted.
 *
 * No path here comes from a request: the key is a hash of `cfg.projectDir`
 * (or the workspace root), and a lens key from the wire is slugged to
 * `[a-z0-9+-]` before it is used, and then only as a JSON object key.
 *
 * The file:
 *   { "version": 1, "projectDir": "<realpath>", "lenses": { "<lens>": { "<node id>": {dx,dy,dw,dh} } } }
 *
 * `projectDir` is there for a person reading the cache; it is not trusted on
 * read. Deltas, never absolute positions: see web/layout-store.js for why
 * that ordering matters. `<lens>` is the same key shape the client's
 * `lensKeyOf` builds (zoom stop + `+radial` / `+stack-<name>`).
 */
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface LayoutDelta {
  dx?: number;
  dy?: number;
  dw?: number;
  dh?: number;
}
export type LayoutDeltas = Record<string, LayoutDelta>;
export interface LayoutFile {
  version: 1;
  lenses: Record<string, LayoutDeltas>;
}

/** Where layouts were kept before #469: `<projectDir>/.behold/layout.json`.
 * Read once for migration, never written. */
export const LEGACY_LAYOUT_DIR = ".behold";
export const LEGACY_LAYOUT_FILE = "layout.json";

/** Caps. A hand layout is a few dozen deltas; everything above is a mistake or
 * an attack, and either way the answer is a polite refusal, not a 40MB file in
 * someone's repo. Enforced on the request body, on what a request may add, and
 * again on the serialized file before it is written. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_IDS_PER_LENS = 2000;
export const MAX_LENSES = 64;
const MAX_ID_LENGTH = 512;
const MAX_LENS_LENGTH = 128;

const NUM = ["dx", "dy", "dw", "dh"] as const;

/** MUST stay identical to `slug` in web/layout-store.js. */
export function slug(s: unknown): string {
  return (
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

/**
 * A lens key off the wire → the one the file is keyed by, or null if it is not
 * a lens key at all. The `+` separators the client's `lensKeyOf` joins with
 * survive; everything else is slugged away, so nothing path-shaped (or
 * prototype-shaped) can reach the file's key space.
 */
export function normalizeLens(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_LENS_LENGTH) return null;
  const parts = raw.split("+").map((p) => slug(p)).filter((p) => p && p !== "unknown");
  if (!parts.length) return null;
  const key = parts.join("+");
  return key === "__proto__" || key === "constructor" || key === "prototype" ? null : key;
}

/** MUST stay identical to `normalize` in web/layout-store.js, plus a cap on
 * how many ids one lens may carry. */
export function normalizeDeltas(raw: unknown): LayoutDeltas {
  const out: LayoutDeltas = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, d] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || id.length > MAX_ID_LENGTH || id === "__proto__" || !d || typeof d !== "object") continue;
    const clean: LayoutDelta = {};
    for (const k of NUM) {
      const v = Number((d as Record<string, unknown>)[k]);
      if (Number.isFinite(v) && v !== 0) clean[k] = v;
    }
    if (Object.keys(clean).length) out[id] = clean;
    if (Object.keys(out).length >= MAX_IDS_PER_LENS) break;
  }
  return out;
}

/**
 * The lens a graph/overlay request is asking for, from its query params —
 * the server-side mirror of web/app.js's `zoomValue()` fed through
 * web/layout-store.js's `lensKeyOf()`. The two MUST agree: a delta the client
 * stored under `components` has to be the one a `?components=1` export reads
 * back. The env is deliberately not part of it (an overlay recolours the same
 * nodes, it does not re-place them).
 */
export function lensFromQuery(params: URLSearchParams): string {
  const zoom =
    params.get("components") === "1"
      ? "components"
      : params.get("logical") === "1"
        ? "logical"
        : params.get("runtime") === "1"
          ? "runtime"
          : ({ 1: "composites", 2: "resources", 3: "attributes" }[Number(params.get("detail") ?? 2)] ?? "resources");
  const stack = params.get("stack");
  return [slug(zoom), params.get("radial") === "1" ? "radial" : null, stack ? slug(`stack-${stack}`) : null].filter(Boolean).join("+");
}

/** The OS's per-user cache directory (not behold's own subdirectory). */
export function userCacheDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Caches");
  if (platform === "win32") return env.LOCALAPPDATA || join(home, "AppData", "Local");
  const xdg = env.XDG_CACHE_HOME;
  return xdg && isAbsolute(xdg) ? xdg : join(home, ".cache");
}

/** behold's cache root: `BEHOLD_CACHE_DIR`, else `<user cache>/behold`. */
export function beholdCacheDir(): string {
  return process.env.BEHOLD_CACHE_DIR || join(userCacheDir(), "behold");
}

/** Where the layout files live. */
export function layoutCacheDir(root: string = beholdCacheDir()): string {
  return join(root, "layouts");
}

function realDir(dir: string): string {
  try {
    return realpathSync(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

/** A project's cache key: sha256 of its realpath, 32 hex characters. */
export function layoutKey(projectDir: string): string {
  return createHash("sha256").update(realDir(projectDir)).digest("hex").slice(0, 32);
}

/** The cache file holding a project's layout. Outside the project, always. */
export function layoutPath(projectDir: string, root?: string): string {
  return join(layoutCacheDir(root), `${layoutKey(projectDir)}.json`);
}

/** The pre-#469 location, inside the project. Only ever read. */
export function legacyLayoutPath(projectDir: string): string {
  return join(projectDir, LEGACY_LAYOUT_DIR, LEGACY_LAYOUT_FILE);
}

/** Why this project directory can't be written, or null when it can. Used by
 * carve mode's demo copy (src/carve-actions.ts); the layout no longer writes
 * into a project, so the layout routes ask `layoutUnwritableReason`. */
export function unwritableReason(projectDir: string): string | null {
  if (!projectDir || !existsSync(projectDir)) return `no such project directory: ${projectDir || "(none)"}`;
  try {
    accessSync(projectDir, constants.W_OK);
  } catch {
    return "the served project directory is read-only";
  }
  return null;
}

/** Why a layout for this project can't be saved, or null when it can: the
 * project has to exist (a cache for nothing is a leak), and the cache
 * directory has to be writable. */
export function layoutUnwritableReason(projectDir: string, root?: string): string | null {
  if (!projectDir || !existsSync(projectDir)) return `no such project directory: ${projectDir || "(none)"}`;
  const dir = layoutCacheDir(root);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
  } catch {
    return `the layout cache ${dir} isn't writable`;
  }
  return null;
}

/** Parse a layout file's text. Oversized, unparseable or the wrong shape all
 * read as null. */
function parseLayout(raw: string): LayoutFile | null {
  if (raw.length > MAX_FILE_BYTES) return null;
  const parsed = JSON.parse(raw) as { lenses?: unknown };
  if (!parsed || typeof parsed !== "object" || !parsed.lenses || typeof parsed.lenses !== "object") return null;
  const lenses: Record<string, LayoutDeltas> = {};
  for (const [lens, deltas] of Object.entries(parsed.lenses as Record<string, unknown>)) {
    const key = normalizeLens(lens);
    if (!key) continue;
    const clean = normalizeDeltas(deltas);
    if (Object.keys(clean).length) lenses[key] = clean;
    if (Object.keys(lenses).length >= MAX_LENSES) break;
  }
  return { version: 1, lenses };
}

function readParsed(file: string): LayoutFile | null {
  try {
    return existsSync(file) ? parseLayout(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

/** Write a project's cache file through a sibling `.tmp` + rename. */
function writeCache(projectDir: string, lenses: Record<string, LayoutDeltas>, root?: string): number {
  const body = JSON.stringify({ version: 1, projectDir: realDir(projectDir), lenses }, null, 2) + "\n";
  if (body.length > MAX_FILE_BYTES) throw new LayoutTooLarge(`a layout is capped at ${MAX_FILE_BYTES} bytes`);
  const file = layoutPath(projectDir, root);
  mkdirSync(layoutCacheDir(root), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
  return body.length;
}

/** Replace a project's whole layout in the cache (doctor --fix uses it to
 * carry a loose estate's layout to its workspace root). */
export function writeLayoutFile(projectDir: string, file: LayoutFile, root?: string): string {
  writeCache(projectDir, file.lenses, root);
  return layoutPath(projectDir, root);
}

/** Whether the cache already holds a layout for this project. */
export function hasCachedLayout(projectDir: string, root?: string): boolean {
  return existsSync(layoutPath(projectDir, root));
}

/** Read a project's whole layout. The cache file when there is one; else
 * the pre-#469 `.behold/layout.json`, copied into the cache so it is read only
 * this once (best-effort: a cache that can't be written just means it's read
 * again next time). Missing, oversized, unparseable or the wrong shape all
 * read as empty: a layout is a nicety and must never break a render. */
export function readLayoutFile(projectDir: string, root?: string): LayoutFile {
  const empty: LayoutFile = { version: 1, lenses: {} };
  if (!projectDir) return empty;
  if (hasCachedLayout(projectDir, root)) return readParsed(layoutPath(projectDir, root)) ?? empty;
  const legacy = readParsed(legacyLayoutPath(projectDir));
  if (!legacy) return empty;
  try {
    writeCache(projectDir, legacy.lenses, root);
  } catch {
    /* read again next time */
  }
  return legacy;
}

/** One lens's deltas — `{}` when the file, the lens, or the disk isn't there. */
export function readLens(projectDir: string, lens: string, root?: string): LayoutDeltas {
  const key = normalizeLens(lens);
  if (!key) return {};
  return readLayoutFile(projectDir, root).lenses[key] ?? {};
}

export class LayoutTooLarge extends Error {}

/**
 * Replace one lens's deltas and persist them to the project's cache file. An
 * empty map drops the lens. The file stays even when the last lens leaves, so
 * an old `.behold/layout.json` is not migrated back in over a cleared layout.
 *
 * Returns what was actually stored (normalized), so the caller echoes truth
 * rather than the request.
 */
export function writeLens(projectDir: string, lens: string, deltas: unknown, root?: string): { lens: string; deltas: LayoutDeltas; bytes: number } {
  const key = normalizeLens(lens);
  if (!key) throw new Error(`not a lens key: ${String(lens)}`);
  const clean = normalizeDeltas(deltas);
  const current = readLayoutFile(projectDir, root);
  const lenses = { ...current.lenses };
  if (Object.keys(clean).length) lenses[key] = clean;
  else delete lenses[key];
  if (Object.keys(lenses).length > MAX_LENSES) throw new LayoutTooLarge(`a layout holds at most ${MAX_LENSES} lenses`);
  const bytes = writeCache(projectDir, lenses, root);
  return { lens: key, deltas: clean, bytes };
}

// --- The delta → SVG math ---------------------------------------------------
// The three functions below MUST stay identical to their copies in
// web/layout-store.js — same shapes, same number formatting, byte for byte.
// web/layout-store.test.js asserts that across a table of cases, importing
// both modules, so a drift is a failing test rather than an export that
// disagrees with the screen it was taken from. (Same discipline as
// src/export.ts's `canonicalKey`, which mirrors web/app.js's.)

/** A node group's transform with its delta ridden on top of dagre's own. */
export function nodeTransform(base: string, d: LayoutDelta): string {
  const dx = d.dx || 0;
  const dy = d.dy || 0;
  if (!dx && !dy) return base;
  return `translate(${dx}, ${dy}) ${base}`.trim();
}

/** First and last coordinate pair of a path `d` — pinhole's own edge anchors. */
export function pathAnchors(d: string | null | undefined): { sx: number; sy: number; ex: number; ey: number } | null {
  const n = String(d || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!n || n.length < 4) return null;
  return { sx: +n[0], sy: +n[1], ex: +n[n.length - 2], ey: +n[n.length - 1] };
}

/** An edge whose ends moved: a straight line between the original anchors,
 * each shifted by ITS OWN end's delta. #228 accepts the straight-line
 * fallback explicitly; spline re-routing stays pinhole's job. */
export function straightEdge(
  anchors: { sx: number; sy: number; ex: number; ey: number },
  from: LayoutDelta | undefined,
  to: LayoutDelta | undefined,
): string {
  const { sx, sy, ex, ey } = anchors;
  return `M ${sx + ((from && from.dx) || 0)} ${sy + ((from && from.dy) || 0)} L ${ex + ((to && to.dx) || 0)} ${ey + ((to && to.dy) || 0)}`;
}

/** XML entities in an attribute value → the raw text, so an id off the wire
 * can be compared with what the painter escaped into the SVG. */
function unescapeAttr(v: string): string {
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? unescapeAttr(m[1]) : null;
}

/** Index of the `</g>` closing the group whose body starts at `from`. */
function groupEnd(svg: string, from: number): number {
  const tok = /<g\b|<\/g\s*>/g;
  tok.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tok.exec(svg))) {
    if (m[0][1] === "/") {
      depth--;
      if (!depth) return m.index;
    } else depth++;
  }
  return svg.length;
}

/**
 * Bake a lens's translate deltas into a rendered SVG string, so a server-side
 * export or static snapshot shows the graph the way it was arranged by hand.
 *
 * Deliberately the SAME transform the client applies (`nodeTransform`), and
 * deliberately NOT everything the client does:
 *   * `{dw,dh}` box resizes are skipped, still. pinhole 0.3.3 stamps
 *     `data-group-id` on the boxes `layoutArchitecture` places (#250), so the
 *     logical lenses could now be baked — but `layoutIr`'s wave/stack/container
 *     boxes set no `GroupBox.id`, and the client synthesizes `box:<title>` ids
 *     from live DOM structure for those (see wrapContainmentBoxes in
 *     web/app.js). Baking one lens's boxes and not another's would make an
 *     export's fidelity depend on which view produced it, which is worse than
 *     the honest, uniform skip. Boxes join here when every layout carries ids.
 *   * edge labels keep their original midpoints. The CLIENT stopped doing that
 *     in #267 — it moves the chip to the re-anchored line's midpoint — but it
 *     can only find the chip at all because it holds a live DOM reference taken
 *     before anything reorders (see edgeLabelOf in web/app.js), and the pairing
 *     it relies on is document order plus matching text, which is a weaker
 *     thing to do by string surgery on a whole document. So a server-side bake
 *     leaves labels where the painter put them; the browser's own export
 *     (exportSvg serialises the live SVG) carries the moved ones. Joins here
 *     with the boxes, the day pinhole stamps the chip with its edge.
 *   * the #267 containment clamp is skipped for the same reason the boxes are:
 *     no box identity means nothing to clamp against.
 *
 * This is a string pass, not a DOM one: no XML parser rides in the server
 * bundle, and the painter's output is machine-generated and regular. A node id
 * containing a literal `>` would defeat the tag scan; chant ids don't, and the
 * failure mode is a delta not applied, never a corrupted document.
 */
export function applyLayoutToSvg(svg: string, deltas: LayoutDeltas): { svg: string; applied: number } {
  const moved: LayoutDeltas = {};
  for (const [id, d] of Object.entries(normalizeDeltas(deltas))) if (d.dx || d.dy) moved[id] = d;
  if (!Object.keys(moved).length || typeof svg !== "string" || !svg) return { svg, applied: 0 };

  const placed = new Set<string>();
  let out = svg.replace(/<g\b([^>]*?)(\/?)>/g, (tag, attrs: string, selfClose: string) => {
    const id = attrOf(attrs, "data-node-id");
    const d = id ? moved[id] : undefined;
    if (!id || !d) return tag;
    placed.add(id);
    // The base transform is spliced RAW (the delta is pure digits, so nothing
    // needs escaping and the painter's own escaping is preserved verbatim) —
    // and every other attribute is left exactly as it was painted.
    const base = /\btransform="([^"]*)"/.exec(attrs);
    const next = nodeTransform(base ? base[1] : "", d);
    if (base) return `<g${attrs.replace(base[0], () => `transform="${next}"`)}${selfClose}>`;
    return `<g${attrs}${/\s$/.test(attrs) ? "" : " "}transform="${next}"${selfClose}>`;
  });

  out = reanchorEdges(out, moved);
  return { svg: out, applied: placed.size };
}

/** Re-anchor every edge with a displaced end, leaving the rest byte-identical. */
function reanchorEdges(svg: string, moved: LayoutDeltas): string {
  const open = /<g\b([^>]*\bdata-edge-from="[^"]*"[^>]*?)(\/?)>/g;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(svg))) {
    const bodyStart = m.index + m[0].length;
    if (m[2] === "/") continue; // self-closing: no paths to move
    const bodyEnd = groupEnd(svg, bodyStart);
    open.lastIndex = bodyEnd;
    const from = moved[attrOf(m[1], "data-edge-from") ?? ""];
    const to = moved[attrOf(m[1], "data-edge-to") ?? ""];
    if (!from && !to) continue;
    const body = svg.slice(bodyStart, bodyEnd);
    const first = /<path\b[^>]*\bd="([^"]*)"/.exec(body);
    const anchors = first ? pathAnchors(first[1]) : null;
    if (!anchors) continue;
    const d = straightEdge(anchors, from, to);
    out += svg.slice(cursor, bodyStart) + body.replace(/(<path\b[^>]*\bd=")([^"]*)(")/g, (_t, a: string, _d: string, z: string) => a + d + z);
    cursor = bodyEnd;
  }
  return out + svg.slice(cursor);
}
