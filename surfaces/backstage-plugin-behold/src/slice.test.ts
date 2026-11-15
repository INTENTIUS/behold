import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphDocument } from './behold/graph-document';
import { graphUrl, namesSlice, resolveSlice, sliceFor, viewerUrlFor } from './slice';

const doc = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'example-terraform-estate.graph.json'), 'utf8')) as GraphDocument;

describe('namesSlice', () => {
  it('is true for any annotation that picks a slice', () => {
    expect(namesSlice({ 'behold.intentius.io/roots': 'prod' })).toBe(true);
    expect(namesSlice({ 'terraform/workspaces': 'prod' })).toBe(true);
    expect(namesSlice({ 'backstage.io/kubernetes-namespace': 'shop' })).toBe(true);
  });
  it('is false with none, and for an empty value', () => {
    expect(namesSlice(undefined)).toBe(false);
    expect(namesSlice({ 'backstage.io/owner': 'team' })).toBe(false);
    expect(namesSlice({ 'behold.intentius.io/roots': '  ' })).toBe(false);
  });
});

describe('resolveSlice', () => {
  it('takes a bare root name as its box', () => {
    expect(resolveSlice(doc, { 'behold.intentius.io/roots': 'prod' })).toMatchObject({ ok: true, ids: ['stack:prod'] });
  });
  it('takes a box id and a comma list', () => {
    expect(resolveSlice(doc, { 'behold.intentius.io/roots': 'stack:prod, platform, nope' })).toMatchObject({
      ok: true,
      ids: ['stack:prod', 'stack:platform'],
    });
  });
  it('lets roots win over terraform/workspaces', () => {
    const r = resolveSlice(doc, { 'behold.intentius.io/roots': 'platform', 'terraform/workspaces': 'prod' });
    expect(r).toMatchObject({ ok: true, by: 'behold.intentius.io/roots', ids: ['stack:platform'] });
  });
  it('falls through to terraform/workspaces when roots matches nothing', () => {
    const r = resolveSlice(doc, { 'behold.intentius.io/roots': 'ghost', 'terraform/workspaces': 'prod' });
    expect(r).toMatchObject({ ok: true, by: 'terraform/workspaces', ids: ['stack:prod'] });
  });
  it('says what it tried when nothing matches', () => {
    const r = resolveSlice(doc, { 'behold.intentius.io/roots': 'ghost' });
    expect(r).toEqual({ ok: false, reason: 'The published graph holds nothing for behold.intentius.io/roots.' });
  });
  it('matches the Kubernetes namespace against cards that carry one', () => {
    const k = { ...doc, nodes: doc.nodes.map((n, i) => (i < 2 ? { ...n, detail__namespace: 'shop' } : n)) };
    const r = resolveSlice(k, { 'backstage.io/kubernetes-namespace': 'shop' });
    expect(r).toMatchObject({ ok: true, ids: [k.nodes[0].id, k.nodes[1].id] });
    expect(resolveSlice(doc, { 'backstage.io/kubernetes-namespace': 'shop' }).ok).toBe(false);
  });
});

describe('sliceFor', () => {
  it('cuts to the root and marks its cards as seeds', () => {
    const r = sliceFor(doc, { 'behold.intentius.io/roots': 'prod' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inProd = doc.nodes.filter(n => n.box === 'stack:prod').length;
    expect(r.slice.document.nodes.length).toBe(inProd);
    expect(r.slice.document.nodes.every(n => n.box === 'stack:prod' && n.seed)).toBe(true);
    expect(r.slice.document.groups.map(g => g.id)).toEqual(['stack:prod']);
    expect(r.slice.document.cut).toMatchObject({ kind: 'around' });
  });
  it('keeps a neighbour across roots', () => {
    const edge = { id: 'x', source: doc.nodes.find(n => n.box === 'stack:prod')!.id, target: doc.nodes.find(n => n.box === 'stack:platform')!.id, kind: 'ref', inferred: true };
    const joined = { ...doc, edges: [...doc.edges, edge] };
    const r = sliceFor(joined, { 'behold.intentius.io/roots': 'prod' });
    expect(r.ok && r.slice.document.nodes.some(n => n.id === edge.target && !n.seed)).toBe(true);
  });
  it('reads the depth annotation', () => {
    const a = sliceFor(doc, { 'behold.intentius.io/roots': 'prod', 'behold.intentius.io/depth': '0' });
    expect(a.ok).toBe(true);
  });
});

describe('addresses', () => {
  it('puts graph.json under a base and takes a .json address as it is', () => {
    expect(graphUrl('https://o.github.io/estate/')).toBe('https://o.github.io/estate/graph.json');
    expect(graphUrl('https://o.github.io/estate/graph.json?x=1')).toBe('https://o.github.io/estate/graph.json?x=1');
  });
  it('derives the viewer beside graph.json, and none for a bare document address', () => {
    expect(viewerUrlFor('https://o.github.io/estate')).toBe('https://o.github.io/estate/behold.html');
    expect(viewerUrlFor('https://o.github.io/estate/graph.json')).toBeUndefined();
  });
});
