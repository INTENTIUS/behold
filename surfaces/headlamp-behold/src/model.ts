// The plugin's logic with no Headlamp and no React in it, so a test can run it.
// It turns the objects Headlamp holds into placeholder cards and edges
// (behold's outsideRefs) and cuts the neighbourhood of one object out of them
// (behold's neighbourhoodOf).
import { neighbourhoodOf } from './behold/neighbourhood.js';
import { OutsideCard, OutsideEdge, OutsideNote, outsideRefs } from './behold/outside-refs.js';

export interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; uid?: string; [k: string]: any };
  spec?: any;
  [k: string]: any;
}

export interface Held {
  uid: string;
  manifest: Manifest;
}

export interface Identity {
  group: string;
  kind: string;
  namespace: string;
  name: string;
}

export interface Placeholders {
  cards: OutsideCard[];
  edges: OutsideEdge[];
  notes: OutsideNote[];
}

/** The graph document behind the optional export URL: a behold-graph/1 document or the `ir` of /api/graph. */
export function graphOf(doc: any): { nodes: any[]; edges: any[] } | undefined {
  const g = doc && Array.isArray(doc.nodes) ? doc : doc && doc.ir;
  return g && Array.isArray(g.nodes)
    ? { nodes: g.nodes, edges: Array.isArray(g.edges) ? g.edges : [] }
    : undefined;
}

const groupOf = (apiVersion: string) =>
  apiVersion.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : '';

/** The id outsideRefs gives an object: `<group>/<Kind>/<namespace>/<name>`. */
export function idOf(m: Manifest): string {
  const cluster = m.kind === 'ClusterSecretStore';
  return `${groupOf(m.apiVersion)}/${m.kind}/${cluster ? '' : m.metadata.namespace || 'default'}/${
    m.metadata.name
  }`;
}

export function identityOfManifest(m: Manifest): Identity {
  const [group, kind, namespace, name] = idOf(m).split('/');
  return { group, kind, namespace, name };
}

/** A held object as the graph node behold keys on: `K8s::<Kind>` with its manifest in attrs. */
function nodeOf(h: Held) {
  const m = h.manifest;
  return {
    id: idOf(m),
    kind: `K8s::${m.kind}`,
    lexicon: 'k8s',
    attrs: { apiVersion: m.apiVersion, kind: m.kind, metadata: m.metadata },
  };
}

/**
 * Placeholders for what the held objects name. The objects are also given as
 * the graph, so a store the cluster holds gets no placeholder card, and the
 * edge from an ExternalSecret to that store is drawn here, between the two
 * objects, as chant's derived edge would draw it.
 */
export function placeholdersFor(
  held: Held[],
  exported?: { nodes: any[] }
): Placeholders & { storeEdges: Array<{ from: string; to: string }> } {
  const nodes = [...held.map(nodeOf), ...(exported ? exported.nodes : [])];
  const p = outsideRefs(
    held.map(h => h.manifest),
    { graph: { nodes } }
  );
  const ids = new Set(held.map(h => idOf(h.manifest)));
  const storeEdges: Array<{ from: string; to: string }> = [];
  for (const h of held) {
    const m = h.manifest;
    const ref = m.kind === 'ExternalSecret' ? m.spec?.secretStoreRef : undefined;
    if (!ref || typeof ref.name !== 'string') continue;
    const kind = ref.kind || 'SecretStore';
    const group = groupOf(m.apiVersion);
    const to = `${group}/${kind}/${
      kind === 'ClusterSecretStore' ? '' : m.metadata.namespace || 'default'
    }/${ref.name}`;
    if (ids.has(to)) storeEdges.push({ from: idOf(m), to });
  }
  return { ...p, storeEdges };
}

/**
 * Nodes and edges for Headlamp's Resource Map: one node per placeholder card,
 * one edge from the Kubernetes object that names it (keyed by uid, so it joins
 * the node Headlamp already draws for that object) to the card.
 */
export function mapData(held: Held[], exported?: { nodes: any[] }) {
  const p = placeholdersFor(held, exported);
  const uidById = new Map(held.map(h => [idOf(h.manifest), h.uid]));
  const cardIds = new Set(p.cards.map(c => c.id));
  const nodes = p.cards.map(c => ({ id: c.id, label: c.label, subtitle: subtitleOf(c), card: c }));
  const own = p.storeEdges
    .map(e => ({ source: uidById.get(e.from), target: uidById.get(e.to) }))
    .filter(e => e.source && e.target)
    .map(e => ({
      id: `${e.source}>${e.target}>secretStoreRef`,
      source: e.source as string,
      target: e.target as string,
      label: 'secretStoreRef',
    }));
  const edges = p.edges
    .map(e => ({ source: uidById.get(e.from), target: e.to, e }))
    .filter(e => e.source && cardIds.has(e.target))
    .map(e => ({
      id: `${e.source}>${e.target}>${e.e.viaAttr}`,
      source: e.source as string,
      target: e.target,
      label: e.e.revision ? `revision ${e.e.revision}` : undefined,
    }));
  return {
    nodes,
    edges: [...edges, ...own] as Array<{
      id: string;
      source: string;
      target: string;
      label?: string;
    }>,
    notes: p.notes,
  };
}

export const KIND_LABEL: Record<string, string> = {
  CloudIdentity: 'Cloud identity',
  SecretStore: 'Secret store',
  SecretProvider: 'Secret provider',
  Source: 'Git source',
};

export function subtitleOf(c: OutsideCard): string {
  return KIND_LABEL[c.kind] || c.kind;
}

/** The cards in the neighbourhood of one object, with the notes that name it. */
export function outsideFor(
  held: Held[],
  identity: Identity,
  exported?: { nodes: any[]; edges?: any[] }
) {
  const p = placeholdersFor(held, exported);
  const nodes: any[] = held.map(nodeOf);
  const byId = new Set(nodes.map(n => n.id));
  for (const c of p.cards) nodes.push({ id: c.id, kind: c.kind, attrs: c.attrs, label: c.label });
  const edges: any[] = [
    ...p.edges.filter(e => byId.has(e.from)),
    ...p.storeEdges.map(e => ({ ...e, kind: 'ref', viaAttr: 'spec.secretStoreRef' })),
  ];
  const cut = neighbourhoodOf({ nodes, edges }, identity);
  const own = `${identity.group}/${identity.kind}/${identity.namespace}/${identity.name}`;
  const cards = p.cards.filter(c => cut.nodes.some((n: any) => n.id === c.id));
  const notes = p.notes.filter(n => n.from === own);
  return { cards, notes, reason: cut.reason };
}

/** Rows to show for a card: its attrs, leaving out what the label already says. */
export function rowsOf(c: OutsideCard): Array<[string, string]> {
  return Object.entries(c.attrs)
    .filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)] as [string, string]);
}
