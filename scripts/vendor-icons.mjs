#!/usr/bin/env node
/**
 * vendor-icons.mjs — re-fetch the lexicon icon corpus (#227) at pinned revisions.
 *
 * behold renders server-side through pinhole, so the icons a graph paints have to
 * live on disk next to the code that registers the packs. This script is how they
 * got there, and re-running it reproduces `web/icons/` byte-for-byte from upstream.
 * It is deliberately NOT wired into any build step — the vendored files are
 * committed, and this exists so the provenance is checkable rather than folkloric.
 *
 *   node scripts/vendor-icons.mjs          # write web/icons/ + licenses/
 *   node scripts/vendor-icons.mjs --check  # fetch and diff, write nothing (exit 1 on drift)
 *
 * Sources, pinned:
 *
 *   kubernetes/community @ 920f1d89cb3d0a7ff0591ef9223864c552f9e589
 *     icons/svg/resources/unlabeled/*.svg — the official Kubernetes resource icon
 *     set, dual-licensed Apache-2.0 OR CC-BY-4.0. behold takes Apache-2.0.
 *     The repo LICENSE is vendored to licenses/kubernetes-icons-LICENSE.
 *
 *   cncf/artwork @ bad6b7fd04344be33d79b4ad60d9ea83321d690c
 *     projects/{flux,argo,helm}/icon/color/*.svg — the projects' own marks, used
 *     nominatively to identify those projects' own resources. The repo's
 *     LICENSE.md (Linux Foundation trademark usage guidelines) is vendored to
 *     licenses/cncf-artwork-LICENSE.md.
 *
 * What the fetch changes (see THIRD_PARTY.md): the XML prolog, comments, editor
 * state (`<metadata>`, `<sodipodi:namedview>`) and inter-tag whitespace are
 * dropped; `id`/`class` names are namespaced per file so that inlining several
 * bodies into one document cannot collide (Flux and Helm both ship a `.cls-1`,
 * and half the Inkscape files call a layer `layer1`). No geometry is touched —
 * every path `d` is exactly as published.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const K8S_REPO = "kubernetes/community";
export const K8S_SHA = "920f1d89cb3d0a7ff0591ef9223864c552f9e589";
const K8S_PATH = "icons/svg/resources/unlabeled";

/** The full unlabeled resource set as published at K8S_SHA. */
const K8S_ICONS = [
  "c-role",
  "cm",
  "crb",
  "crd",
  "cronjob",
  "deploy",
  "ds",
  "ep",
  "group",
  "hpa",
  "ing",
  "job",
  "limits",
  "netpol",
  "ns",
  "pod",
  "psp",
  "pv",
  "pvc",
  "quota",
  "rb",
  "role",
  "rs",
  "sa",
  "sc",
  "secret",
  "sts",
  "svc",
  "user",
  "vol",
];

export const CNCF_REPO = "cncf/artwork";
export const CNCF_SHA = "bad6b7fd04344be33d79b4ad60d9ea83321d690c";

/** Project marks, colour icon variant (square, no wordmark). */
const CNCF_MARKS = [
  { name: "flux", path: "projects/flux/icon/color/flux-icon-color.svg" },
  { name: "argo", path: "projects/argo/icon/color/argo-icon-color.svg" },
  { name: "helm", path: "projects/helm/icon/color/helm-icon-color.svg" },
];

const LICENSES = [
  {
    url: raw(K8S_REPO, K8S_SHA, "LICENSE"),
    out: "licenses/kubernetes-icons-LICENSE",
  },
  {
    url: raw(CNCF_REPO, CNCF_SHA, "LICENSE.md"),
    out: "licenses/cncf-artwork-LICENSE.md",
  },
];

function raw(repo, sha, path) {
  return `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.text();
}

/** Escape a string for use inside a RegExp. */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sanitize and lightly minify one SVG, namespacing its internal names with
 * `prefix` so several bodies can share one document.
 */
export function sanitizeSvg(source, prefix) {
  let svg = source;

  // Prolog, doctype, comments.
  svg = svg.replace(/<\?xml[\s\S]*?\?>/g, "");
  svg = svg.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  svg = svg.replace(/<!--[\s\S]*?-->/g, "");

  // Anything executable or foreign. There is none in these sets; the strip is
  // the guarantee, not a fix.
  for (const tag of ["script", "foreignObject"]) {
    svg = svg.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, "gi"), "");
    svg = svg.replace(new RegExp(`<${tag}\\b[^>]*/>`, "gi"), "");
  }
  svg = svg.replace(/\son\w+\s*=\s*(["'])[\s\S]*?\1/gi, "");

  // Editor state — Inkscape writes both into every file in the k8s set.
  svg = svg.replace(/<metadata\b[\s\S]*?<\/metadata\s*>/gi, "");
  svg = svg.replace(/<sodipodi:namedview\b[\s\S]*?(?:\/>|<\/sodipodi:namedview\s*>)/gi, "");

  // Namespace ids, then rewrite every reference to them.
  const ids = new Set();
  for (const m of svg.matchAll(/\sid\s*=\s*(["'])(.*?)\1/g)) ids.add(m[2]);
  for (const id of ids) {
    const to = `${prefix}${id}`;
    svg = svg.replace(new RegExp(`(\\sid\\s*=\\s*["'])${esc(id)}(["'])`, "g"), `$1${to}$2`);
    svg = svg.replace(new RegExp(`url\\(\\s*#${esc(id)}\\s*\\)`, "g"), `url(#${to})`);
    svg = svg.replace(
      new RegExp(`((?:xlink:)?href\\s*=\\s*["'])#${esc(id)}(["'])`, "g"),
      `$1#${to}$2`,
    );
  }

  // Namespace classes the same way — the CNCF marks carry a <style> block and
  // all three of them declare `.cls-1`.
  const classes = new Set();
  for (const m of svg.matchAll(/\sclass\s*=\s*(["'])(.*?)\1/g)) {
    for (const c of m[2].split(/\s+/)) if (c) classes.add(c);
  }
  for (const c of classes) {
    const to = `${prefix}${c}`;
    svg = svg.replace(new RegExp(`\\.${esc(c)}\\b`, "g"), `.${to}`);
    svg = svg.replace(new RegExp(`(\\sclass\\s*=\\s*["'][^"']*?)\\b${esc(c)}\\b`, "g"), `$1${to}`);
  }

  // Light minification: no inter-tag whitespace, no runs of space inside tags.
  svg = svg.replace(/>\s+</g, "><");
  svg = svg.replace(/<([^>]+)>/g, (_all, inner) => `<${inner.replace(/\s+/g, " ").trim()}>`);
  svg = svg.trim();

  if (!/\bviewBox\s*=/.test(svg)) throw new Error(`no viewBox survived for ${prefix}`);
  if (/<script|<foreignObject/i.test(svg)) throw new Error(`executable content left in ${prefix}`);
  return svg;
}

async function emit(relPath, text, check) {
  const abs = join(ROOT, relPath);
  if (check) {
    let have = null;
    try {
      have = await readFile(abs, "utf8");
    } catch {
      /* missing counts as drift */
    }
    return have === text ? null : relPath;
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, text);
  return null;
}

async function main() {
  const check = process.argv.includes("--check");
  const drift = [];
  let bytes = 0;

  for (const name of K8S_ICONS) {
    const src = await fetchText(raw(K8S_REPO, K8S_SHA, `${K8S_PATH}/${name}.svg`));
    const out = `${sanitizeSvg(src, `k8s-${name}-`)}\n`;
    bytes += Buffer.byteLength(out);
    const d = await emit(`web/icons/k8s/${name}.svg`, out, check);
    if (d) drift.push(d);
  }

  for (const mark of CNCF_MARKS) {
    const src = await fetchText(raw(CNCF_REPO, CNCF_SHA, mark.path));
    const out = `${sanitizeSvg(src, `cncf-${mark.name}-`)}\n`;
    bytes += Buffer.byteLength(out);
    const d = await emit(`web/icons/cncf/${mark.name}.svg`, out, check);
    if (d) drift.push(d);
  }

  for (const lic of LICENSES) {
    const d = await emit(lic.out, await fetchText(lic.url), check);
    if (d) drift.push(d);
  }

  const count = K8S_ICONS.length + CNCF_MARKS.length;
  if (check) {
    if (drift.length) {
      console.error(`drift in ${drift.length} file(s):\n  ${drift.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`${count} icons + ${LICENSES.length} licenses match the pinned revisions.`);
    return;
  }
  console.log(
    `vendored ${K8S_ICONS.length} k8s icons + ${CNCF_MARKS.length} CNCF marks ` +
      `(${bytes} bytes) and ${LICENSES.length} licenses.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
