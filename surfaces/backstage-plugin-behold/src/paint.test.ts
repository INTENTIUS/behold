import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphDocument } from './behold/graph-document';
import { paint } from './paint';
import { sliceFor } from './slice';

const doc = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'example-terraform-estate.graph.json'), 'utf8')) as GraphDocument;

it('draws one box and every card of the cut', () => {
  const r = sliceFor(doc, { 'behold.intentius.io/roots': 'prod' });
  if (!r.ok) throw new Error(r.reason);
  const p = paint(r.slice.document);
  expect(p.cards).toBe(r.slice.document.nodes.length);
  expect(p.svg.startsWith('<svg')).toBe(true);
  expect(p.svg.match(/<rect /g)?.length).toBe(p.cards + 1);
});

it('escapes titles', () => {
  const evil = { ...doc, nodes: [{ ...doc.nodes[0], title: '<img src=x onerror=alert(1)>', box: undefined }], edges: [], groups: [] } as GraphDocument;
  expect(paint(evil).svg).not.toContain('<img');
});
