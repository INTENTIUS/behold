/**
 * Lexicon-native icons (#227): the kind → vendored-mark mapping.
 *
 * Today every k8s kind survives on pinhole's keyword heuristic — `Deployment`
 * lands on a container, `Kustomization` and `MicroVMReplicaSet` land on the same
 * rounded square. The official sets exist and are free to use, so this module
 * carries the mapping from a chant kind to the SVG that actually names it:
 *
 *   - `K8s::*` → the Kubernetes community resource icons (`web/icons/k8s`)
 *   - `K8s::Flux::*` / `K8s::Argo::*` → those projects' own marks
 *   - `Helm::Chart` / `Helm::Release` → the Helm wheel
 *
 * Provenance, licences and the pinned upstream revisions are in THIRD_PARTY.md;
 * `scripts/vendor-icons.mjs` re-fetches the corpus.
 *
 * `src/render.ts` registers these two functions as pinhole presentation packs
 * (`registerPack`, pinhole 0.3.0 #95), which is what puts the marks on every
 * SVG behold paints. A kind with no official icon returns `undefined` on
 * purpose: pinhole's chain then falls through to the keyword heuristic, which is
 * a better answer than a wrong picture.
 *
 * One mark also carries a contrast plate (#246) — see {@link PLATE_FILL}.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A glyph carrying its own geometry. `colored: true` tells the painter to emit
 * the body as published instead of stroking it with a theme token — these are
 * brand marks and full-colour resource icons, not themeable line art.
 */
export interface PackGlyph {
  body: string;
  colored: true;
  viewBox: string;
}

/** `src/..` in dev and `dist/..` in the published bundle both land on the package root. */
const ICON_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "icons");

const cache = new Map<string, PackGlyph>();

/**
 * Drop the namespace prefixes the body can no longer resolve. A vendored file
 * declares `xmlns:inkscape`/`xmlns:sodipodi`/`xmlns:xlink` on its root `<svg>`,
 * and that root is exactly what {@link loadIcon} throws away — so every
 * surviving `inkscape:*` attribute becomes an unbound prefix in the document
 * pinhole splices the body into, and the whole SVG stops being well-formed XML.
 * The browser's HTML parser shrugs; an `image/svg+xml` consumer (a downloaded
 * `↓ SVG` export, a snapshot opened directly) does not.
 *
 * `inkscape:*`/`sodipodi:*` are editor state — Inkscape's own parametrics live
 * alongside the real `d`, so dropping them is lossless. `xlink:href` is a live
 * reference (the Argo mark's `<use>`), rewritten to the plain SVG 2 `href`
 * every current browser resolves.
 */
function unprefix(body: string): string {
  return body
    .replace(/\s(?:inkscape|sodipodi):[\w-]+\s*=\s*(["'])[\s\S]*?\1/g, "")
    .replace(/\sxlink:href\s*=/g, " href=");
}

/**
 * The opaque ground painted under a plated mark (#246).
 *
 * White because that is the ground CNCF's `icon/color` variants are drawn for,
 * and because it is the one ground that needs no knowledge of anything else in
 * the picture: the Helm navy `#0f1689` clears 14:1 on it, always.
 */
export const PLATE_FILL = "#ffffff";

/** Fraction of the slot given to the plate's margin on each side. */
const PLATE_INSET = 0.1;

/**
 * Marks that carry no light ink of their own, and so get {@link PLATE_FILL}.
 *
 * A colored mark is painted as authored into a 22px slot on a card, and the
 * card is its background. What that background will be is not knowable from
 * here: on an exported SVG or a static snapshot it is pinhole's
 * `--pin-<status>Fill`, near-black under a dark theme; in the SPA
 * `recolorNodesByCategory` has already replaced it with a per-kind hue drawn
 * out of the active palette — any of 552, in either polarity. Nor is the
 * light/dark axis a proxy for it: the measured worst grounds for the Helm navy
 * include light themes (Xcode Light hc lands the mark on `#141090`, 1.01:1),
 * because a light theme's ANSI palette produces plenty of dark category fills.
 *
 * What separates the marks that survive an unknown ground from the one that
 * doesn't is whether the artwork spans any luminance at all. Measured over the
 * whole vendored corpus (`icon-packs.test.ts` sweeps it): every Kubernetes icon
 * and the Flux and Argo marks carry a light ink as well as a dark one —
 * relative luminance up to 1.0 for the 32 that use white, 0.64 for the Flux
 * mark's pale blue — so something in them reads whichever way the ground goes.
 * The Helm wheel is the single exception: one ink, `#0f1689`, luminance 0.025,
 * nothing else. Its ink IS the whole mark, so the ground decides it entirely.
 *
 * Hence the rule, and hence its narrowness: give a ground only to the marks
 * that have no light value to fall back on. See #246 for the screenshot
 * comparison against the two alternatives (lift the card fill under a mark;
 * swap in cncf/artwork's `icon/white` variant on dark themes — which the same
 * measurement rules out, since it would vanish on exactly the pale category
 * fills a dark theme's palette produces).
 */
const PLATED = new Set(["cncf/helm"]);

/** Every mark {@link PLATED} covers — the tests' and the smoke's enumeration. */
export function platedMarks(): string[] {
  return [...PLATED];
}

/**
 * Put an opaque square plate under a mark and inset the mark inside it.
 *
 * Both halves stay inside the glyph's own viewBox, so the painted footprint is
 * exactly what it was — pinhole scales a glyph by `size / max(vbW, vbH)` and
 * centres it, so a square of side `max(vbW, vbH)` centred on the viewBox is
 * precisely the slot pinhole will paint into, no more. Nothing about the
 * painter changes, and nothing needs to know the theme.
 *
 * The mark scales uniformly about the plate's centre, so its proportions are
 * untouched (which is what the trademark guidelines ask for); the plate is the
 * clear space around it.
 */
function plate(glyph: PackGlyph): PackGlyph {
  const [minX, minY, w, h] = glyph.viewBox.trim().split(/[\s,]+/).map(Number);
  const side = Math.max(w, h);
  const cx = minX + w / 2;
  const cy = minY + h / 2;
  const k = 1 - 2 * PLATE_INSET;
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  const ground =
    `<rect x="${round(cx - side / 2)}" y="${round(cy - side / 2)}" width="${round(side)}" height="${round(side)}"` +
    ` rx="${round(side * 0.18)}" fill="${PLATE_FILL}"/>`;
  const inset = `translate(${round(cx * (1 - k))} ${round(cy * (1 - k))}) scale(${k})`;
  return { ...glyph, body: `${ground}<g transform="${inset}">${glyph.body}</g>` };
}

/** Read a vendored SVG and split it into its viewBox and its inner markup. */
function loadIcon(rel: string): PackGlyph {
  const hit = cache.get(rel);
  if (hit) return hit;

  const raw = readFileSync(join(ICON_ROOT, `${rel}.svg`), "utf8");
  const open = raw.indexOf("<svg");
  const openEnd = raw.indexOf(">", open);
  const close = raw.lastIndexOf("</svg");
  if (open < 0 || openEnd < 0 || close < 0) throw new Error(`malformed vendored icon: ${rel}.svg`);

  const viewBox = /\bviewBox\s*=\s*(["'])(.*?)\1/.exec(raw.slice(open, openEnd))?.[2];
  if (!viewBox) throw new Error(`vendored icon has no viewBox: ${rel}.svg`);

  const bare: PackGlyph = { body: unprefix(raw.slice(openEnd + 1, close).trim()), colored: true, viewBox };
  const glyph = PLATED.has(rel) ? plate(bare) : bare;
  cache.set(rel, glyph);
  return glyph;
}

/**
 * Kinds with an official icon in the community set. Names are the upstream file
 * stems, so a reader can check any row against `web/icons/k8s/<stem>.svg`.
 *
 * Deliberately absent: `*List` wrappers (a list is not the resource), the RBAC
 * subject art (`user`, `group` — subjects, not API objects), and `psp` (the
 * PodSecurityPolicy API is gone). Everything else falls through.
 */
const K8S_ICON_BY_KIND: Record<string, string> = {
  "K8s::Apiextensions::CustomResourceDefinition": "crd",
  "K8s::Apps::DaemonSet": "ds",
  "K8s::Apps::Deployment": "deploy",
  "K8s::Apps::ReplicaSet": "rs",
  "K8s::Apps::StatefulSet": "sts",
  "K8s::Autoscaling::HorizontalPodAutoscaler": "hpa",
  "K8s::Batch::CronJob": "cronjob",
  "K8s::Batch::Job": "job",
  "K8s::Core::ConfigMap": "cm",
  "K8s::Core::Endpoints": "ep",
  "K8s::Core::LimitRange": "limits",
  "K8s::Core::Namespace": "ns",
  "K8s::Core::PersistentVolume": "pv",
  "K8s::Core::PersistentVolumeClaim": "pvc",
  "K8s::Core::Pod": "pod",
  "K8s::Core::PodTemplate": "pod",
  "K8s::Core::ReplicationController": "rs", // the pre-ReplicaSet spelling of the same thing
  "K8s::Core::ResourceQuota": "quota",
  "K8s::Core::Secret": "secret",
  "K8s::Core::Service": "svc",
  "K8s::Core::ServiceAccount": "sa",
  "K8s::Core::Volume": "vol",
  "K8s::Networking::Ingress": "ing",
  "K8s::Networking::IngressClass": "ing",
  "K8s::Networking::NetworkPolicy": "netpol",
  "K8s::Rbac::ClusterRole": "c-role",
  "K8s::Rbac::ClusterRoleBinding": "crb",
  "K8s::Rbac::Role": "role",
  "K8s::Rbac::RoleBinding": "rb",
  "K8s::Storage::StorageClass": "sc",
};

/** Kind prefixes whose whole family carries a project mark. */
const K8S_MARK_BY_PREFIX: Array<[string, string]> = [
  ["K8s::Flux::", "cncf/flux"],
  ["K8s::Argo::", "cncf/argo"],
];

/** The chart and release kinds `src/helm-releases.ts` puts on the graph. */
const HELM_MARK_KINDS = new Set(["Helm::Chart", "Helm::Release"]);

/** The icon for a `k8s` lexicon kind, or undefined to fall through. */
export function k8sIconFor(kind: string): PackGlyph | undefined {
  for (const [prefix, rel] of K8S_MARK_BY_PREFIX) {
    if (kind.startsWith(prefix)) return loadIcon(rel);
  }
  const stem = K8S_ICON_BY_KIND[kind];
  return stem ? loadIcon(`k8s/${stem}`) : undefined;
}

/** The icon for a `helm` lexicon kind, or undefined to fall through. */
export function helmIconFor(kind: string): PackGlyph | undefined {
  return HELM_MARK_KINDS.has(kind) ? loadIcon("cncf/helm") : undefined;
}

/** Every kind this module answers for — the test's enumeration, and the docs'. */
export function mappedKinds(): { k8s: string[]; helm: string[] } {
  return { k8s: Object.keys(K8S_ICON_BY_KIND), helm: [...HELM_MARK_KINDS] };
}
