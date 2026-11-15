// The extension's logic with no Argo CD UI and no React in it, so a test can
// run it. It turns what Argo CD hands a tab (the Application, its resource
// tree) and what the tab reads back (live manifests) into the objects behold's
// rules read, then reuses the Headlamp plugin's model for the rules and the cut.
import { Held, Identity, Manifest, identityOfManifest, mapData, outsideFor, placeholdersFor } from '../../headlamp-behold/src/model';

export interface TreeNode {
  group?: string;
  version?: string;
  kind: string;
  namespace?: string;
  name: string;
  uid?: string;
}

export interface Application {
  apiVersion?: string;
  kind?: string;
  metadata: { name: string; namespace?: string; uid?: string; annotations?: Record<string, string> };
  spec?: { project?: string; [k: string]: any };
  [k: string]: any;
}

/** The kinds behold has placeholder rules for. Only these are read back. */
export const WATCHED = new Set([
  'ServiceAccount',
  'ExternalSecret',
  'SecretStore',
  'ClusterSecretStore',
  'Application',
  'Kustomization',
  'GitRepository',
]);

export const EXPORT_ANNOTATION = 'behold.intentius.io/export-url';

export const watchedNodes = (nodes: TreeNode[] | undefined): TreeNode[] =>
  (nodes || []).filter(n => WATCHED.has(n.kind));

/** The query Argo CD's resource endpoint takes for one tree node. */
export function resourceQuery(app: Application, n: TreeNode): string {
  const q = new URLSearchParams({
    namespace: n.namespace || '',
    resourceName: n.name,
    version: n.version || '',
    kind: n.kind,
    group: n.group || '',
  });
  if (app.metadata.namespace) q.set('appNamespace', app.metadata.namespace);
  if (app.spec?.project) q.set('project', app.spec.project);
  return `/api/v1/applications/${encodeURIComponent(app.metadata.name)}/resource?${q}`;
}

/** The manifest inside Argo CD's `{ manifest: "<json>" }` answer, or undefined. */
export function manifestOf(answer: any): Manifest | undefined {
  try {
    const m = typeof answer?.manifest === 'string' ? JSON.parse(answer.manifest) : answer?.manifest;
    return m && m.kind && m.metadata?.name ? m : undefined;
  } catch {
    return undefined;
  }
}

/** The Application itself as a held object, with the apiVersion and kind a tab may not carry. */
export function applicationHeld(app: Application): Held {
  const manifest: Manifest = {
    ...app,
    apiVersion: app.apiVersion || 'argoproj.io/v1alpha1',
    kind: app.kind || 'Application',
    metadata: { ...app.metadata, namespace: app.metadata.namespace || 'argocd' },
  };
  return { uid: app.metadata.uid || `Application/${manifest.metadata.namespace}/${app.metadata.name}`, manifest };
}

/** Held objects from the manifests read for a tree, with the Application added. */
export function heldFrom(app: Application, manifests: Array<{ node: TreeNode; manifest?: Manifest }>): Held[] {
  const held: Held[] = [applicationHeld(app)];
  for (const { node, manifest } of manifests) {
    if (!manifest) continue;
    const m: Manifest = {
      ...manifest,
      apiVersion: manifest.apiVersion || (node.group ? `${node.group}/${node.version}` : node.version || 'v1'),
    };
    held.push({ uid: node.uid || m.metadata.uid || `${m.kind}/${m.metadata.namespace || ''}/${m.metadata.name}`, manifest: m });
  }
  return held;
}

/** The export URL: the Application's annotation, else the install's default (window.BEHOLD_VARS). */
export function exportUrlFor(app: Application, vars?: Record<string, string>): string | undefined {
  const own = app.metadata.annotations?.[EXPORT_ANNOTATION];
  if (own) return own;
  if (!vars) return undefined;
  const key = Object.keys(vars).find(k => k.toLowerCase().replace(/[^a-z]/g, '') === 'exporturl');
  return key ? vars[key] || undefined : undefined;
}

/** What a resource tab shows: the cards in reach of one object. */
export function forResource(held: Held[], identity: Identity, exported?: { nodes: any[]; edges?: any[] }) {
  return outsideFor(held, identity, exported);
}

export { identityOfManifest };

export interface Dependency {
  id: string;
  label: string;
  subtitle: string;
  attrs: Record<string, any>;
  namedBy: Array<{ kind: string; namespace: string; name: string }>;
}

/** What an Application tab lists: every outside card, with the objects that name it. */
export function forApplication(held: Held[], exported?: { nodes: any[] }) {
  const p = placeholdersFor(held, exported);
  const d = mapData(held, exported);
  const byUid = new Map(held.map(h => [h.uid, h.manifest]));
  const deps: Dependency[] = d.nodes.map(n => ({
    id: n.id,
    label: n.label,
    subtitle: n.subtitle,
    attrs: n.card.attrs,
    namedBy: d.edges
      .filter(e => e.target === n.id)
      .map(e => byUid.get(e.source))
      .filter((m): m is Manifest => !!m)
      .map(m => ({ kind: m.kind, namespace: m.metadata.namespace || '', name: m.metadata.name })),
  }));
  return { deps, notes: p.notes };
}
