// The part of the tab with no Backstage and no React in it: which annotations
// on a catalog entity pick a slice of the graph, and how that slice is cut.
import { cutDocument } from './behold/graph-cut';
import type { GraphDocument } from './behold/graph-document';

export const ANNOTATION_ROOTS = 'behold.intentius.io/roots';
export const ANNOTATION_EXPORT_URL = 'behold.intentius.io/export-url';
export const ANNOTATION_DEPTH = 'behold.intentius.io/depth';
export const ANNOTATION_TERRAFORM_WORKSPACES = 'terraform/workspaces';
export const ANNOTATION_KUBERNETES_NAMESPACE = 'backstage.io/kubernetes-namespace';
export const ANNOTATION_KUBERNETES_ID = 'backstage.io/kubernetes-id';

/** Every annotation that can pick a slice. The tab's filter asks for any of them. */
export const SLICE_ANNOTATIONS = [
  ANNOTATION_ROOTS,
  ANNOTATION_TERRAFORM_WORKSPACES,
  ANNOTATION_KUBERNETES_NAMESPACE,
  ANNOTATION_KUBERNETES_ID,
] as const;

export type Annotations = Readonly<Record<string, string>> | undefined;

/** Whether an entity names a slice at all. The new frontend system's filter uses this, so a component with none gets no tab. */
export function namesSlice(annotations: Annotations): boolean {
  return SLICE_ANNOTATIONS.some(a => !!annotations?.[a]?.trim());
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

export type Resolved =
  | { ok: true; by: string; ids: string[]; asked: string[] }
  | { ok: false; reason: string };

/**
 * The box and card ids in `doc` the entity's annotations stand for, first
 * match wins:
 *
 * 1. `behold.intentius.io/roots`, a comma list. Each name is a box id in the
 *    document (`stack:prod`), a bare root name (`prod`, taken as `stack:prod`),
 *    or a card id.
 * 2. `terraform/workspaces`, a comma list matched against the same names.
 * 3. `backstage.io/kubernetes-namespace`, matched against the cards' namespace
 *    (`detail__namespace`). It finds nothing until the graph draws Kubernetes
 *    kinds (behold#1056).
 *
 * `backstage.io/kubernetes-id` is read as a label and matches a card only when
 * the card's `detail__release` or `detail__member` is that value.
 */
export function resolveSlice(doc: GraphDocument, annotations: Annotations): Resolved {
  const boxes = new Set(doc.groups.map(g => g.id));
  const cards = new Set(doc.nodes.map(n => n.id));
  const named = (names: string[]): string[] => {
    const out: string[] = [];
    for (const n of names) {
      if (boxes.has(n) || cards.has(n)) out.push(n);
      else if (boxes.has(`stack:${n}`)) out.push(`stack:${n}`);
    }
    return out;
  };

  const tried: string[] = [];
  const byNames = (key: string, names: string[]): Resolved | undefined => {
    if (!names.length) return undefined;
    tried.push(key);
    const ids = named(names);
    return ids.length ? { ok: true, by: key, ids, asked: names } : undefined;
  };
  const byField = (key: string, value: string | undefined, field: 'detail__namespace' | 'detail__release' | 'detail__member'): Resolved | undefined => {
    const v = value?.trim();
    if (!v) return undefined;
    tried.push(key);
    const ids = doc.nodes.filter(n => n[field] === v).map(n => n.id);
    return ids.length ? { ok: true, by: key, ids, asked: [v] } : undefined;
  };

  const hit =
    byNames(ANNOTATION_ROOTS, list(annotations?.[ANNOTATION_ROOTS])) ??
    byNames(ANNOTATION_TERRAFORM_WORKSPACES, list(annotations?.[ANNOTATION_TERRAFORM_WORKSPACES])) ??
    byField(ANNOTATION_KUBERNETES_NAMESPACE, annotations?.[ANNOTATION_KUBERNETES_NAMESPACE], 'detail__namespace') ??
    byField(ANNOTATION_KUBERNETES_ID, annotations?.[ANNOTATION_KUBERNETES_ID], 'detail__release') ??
    byField(ANNOTATION_KUBERNETES_ID, annotations?.[ANNOTATION_KUBERNETES_ID], 'detail__member');
  if (hit) return hit;
  return {
    ok: false,
    reason: tried.length
      ? `The published graph holds nothing for ${[...new Set(tried)].join(', ')}.`
      : 'This entity carries no annotation that picks a slice of the graph.',
  };
}

export interface Slice {
  document: GraphDocument;
  by: string;
  ids: string[];
}

/** The cut of `doc` the annotations ask for, `depth` hops out (default 1). */
export function sliceFor(doc: GraphDocument, annotations: Annotations): { ok: true; slice: Slice } | { ok: false; reason: string } {
  const r = resolveSlice(doc, annotations);
  if (!r.ok) return r;
  const depth = Number.parseInt(annotations?.[ANNOTATION_DEPTH] ?? '', 10);
  const cut = cutDocument(doc, r.ids, { depth: Number.isFinite(depth) && depth >= 0 && depth <= 5 ? depth : 1 });
  if (!cut.ok) return { ok: false, reason: cut.error };
  return { ok: true, slice: { document: cut.document, by: r.by, ids: r.ids } };
}

/** `graph.json` under an export's base URL. A URL that already ends in `.json` is taken as the document. */
export function graphUrl(base: string): string {
  const b = base.trim();
  return /\.json(\?.*)?$/i.test(b) ? b : `${b.replace(/\/+$/, '')}/graph.json`;
}

/** The viewer's address from an export's base URL: `behold.html` beside `graph.json`. */
export function viewerUrlFor(base: string): string | undefined {
  const b = base.trim();
  if (/\.json(\?.*)?$/i.test(b)) return undefined;
  return `${b.replace(/\/+$/, '')}/behold.html`;
}
