import { sourceFor } from './source';

const annotations = { 'behold.intentius.io/export-url': 'https://other.example/est/' };

describe('sourceFor', () => {
  it('reads the configured export directly', () => {
    expect(sourceFor({ exportUrl: 'https://o.github.io/e/' }, undefined, undefined)).toEqual({
      graph: 'https://o.github.io/e/graph.json',
      viaProxy: false,
      site: 'https://o.github.io/e/',
      viewer: 'https://o.github.io/e/behold.html',
    });
  });
  it('goes through the proxy when a proxy path is set, and keeps exportUrl as the link', () => {
    const s = sourceFor({ exportUrl: 'https://bucket.example/e', proxyPath: '/behold' }, undefined, 'http://localhost:7007/api/proxy');
    expect(s).toMatchObject({ graph: 'http://localhost:7007/api/proxy/behold/graph.json', viaProxy: true, site: 'https://bucket.example/e' });
    expect(s?.viewer).toBeUndefined();
  });
  it('lets the entity annotation override both, read directly with no token', () => {
    const s = sourceFor({ exportUrl: 'https://o.github.io/e/', proxyPath: 'behold', viewerUrl: 'https://v.example/' }, annotations, 'http://b/api/proxy');
    expect(s).toMatchObject({ graph: 'https://other.example/est/graph.json', viaProxy: false, viewer: 'https://other.example/est/behold.html' });
  });
  it('has no source with nothing set', () => {
    expect(sourceFor({}, undefined, undefined)).toBeUndefined();
  });
});
