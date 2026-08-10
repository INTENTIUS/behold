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

  const glyph: PackGlyph = { body: unprefix(raw.slice(openEnd + 1, close).trim()), colored: true, viewBox };
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
