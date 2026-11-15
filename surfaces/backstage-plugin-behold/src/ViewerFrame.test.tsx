import { render } from '@testing-library/react';
import type { GraphDocument } from './behold/graph-document';
import { ViewerFrame } from './ViewerFrame';

const document_ = { schema: 'behold-graph/1', nodes: [], edges: [], groups: [], notes: [] } as unknown as GraphDocument;

it('opens the viewer with the host and answers behold:ready with the theme, the cut and the focus', () => {
  const { container } = render(<ViewerFrame viewer="https://v.example/behold.html" document={document_} focus={['stack:prod']} dark />);
  const frame = container.querySelector('iframe')!;
  const src = new URL(frame.getAttribute('src')!);
  expect(src.origin + src.pathname).toBe('https://v.example/behold.html');
  expect(src.searchParams.get('host')).toBe(window.location.origin);
  expect(src.searchParams.get('transport')).toBe('post');

  const sent: Array<[any, string]> = [];
  Object.defineProperty(frame, 'contentWindow', { value: { postMessage: (m: any, o: string) => sent.push([m, o]) } });
  // A message from another origin, or another window, is ignored.
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'behold:ready' }, origin: 'https://evil.example', source: frame.contentWindow as any }));
  expect(sent).toHaveLength(0);
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'behold:ready' }, origin: 'https://v.example', source: frame.contentWindow as any }));
  expect(sent.map(([m]) => m.type)).toEqual(['behold:theme', 'behold:graph', 'behold:view']);
  expect(sent.every(([, o]) => o === 'https://v.example')).toBe(true);
  expect(sent[0][0].theme).toBe('dark');
  expect(sent[2][0].focus).toEqual(['stack:prod']);
});
