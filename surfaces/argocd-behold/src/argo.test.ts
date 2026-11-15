import { describe, expect, it } from 'vitest';
import {
  Application,
  exportUrlFor,
  forApplication,
  forResource,
  heldFrom,
  identityOfManifest,
  manifestOf,
  resourceQuery,
  watchedNodes,
} from './argo';

const ARN = 'arn:aws:iam::123456789012:role/checkout';
const app: Application = {
  metadata: { name: 'shop', namespace: 'argocd', uid: 'app-uid' },
  spec: {
    project: 'default',
    source: { repoURL: 'https://github.com/acme/shop.git', path: 'deploy', targetRevision: 'main' },
  },
};
const sa = {
  apiVersion: 'v1',
  kind: 'ServiceAccount',
  metadata: { name: 'checkout', namespace: 'shop', annotations: { 'eks.amazonaws.com/role-arn': ARN } },
};
const node = { version: 'v1', kind: 'ServiceAccount', namespace: 'shop', name: 'checkout', uid: 'sa-uid' };

describe('reading the tree', () => {
  it('reads back only the kinds behold has rules for', () => {
    const kept = watchedNodes([node, { group: 'apps', version: 'v1', kind: 'Deployment', name: 'web' }]);
    expect(kept.map(n => n.kind)).toEqual(['ServiceAccount']);
  });

  it('asks the resource endpoint for one node, with the project', () => {
    const q = resourceQuery(app, node);
    expect(q).toContain('/api/v1/applications/shop/resource?');
    expect(q).toContain('resourceName=checkout');
    expect(q).toContain('kind=ServiceAccount');
    expect(q).toContain('project=default');
    expect(q).toContain('appNamespace=argocd');
  });

  it('takes the manifest from the JSON string Argo CD answers with', () => {
    expect(manifestOf({ manifest: JSON.stringify(sa) })?.metadata.name).toBe('checkout');
    expect(manifestOf({ manifest: 'not json' })).toBeUndefined();
    expect(manifestOf(undefined)).toBeUndefined();
  });
});

describe('the Application tab', () => {
  const held = heldFrom(app, [{ node, manifest: sa }]);

  it('lists the cloud role with the ServiceAccount that names it', () => {
    const { deps } = forApplication(held);
    const role = deps.find(d => d.id === `outside:identity:aws:${ARN}`);
    expect(role?.subtitle).toBe('Cloud identity');
    expect(role?.namedBy).toEqual([{ kind: 'ServiceAccount', namespace: 'shop', name: 'checkout' }]);
  });

  it('lists the git source the Application itself names, though the tree lacks the Application', () => {
    const { deps } = forApplication(held);
    const src = deps.find(d => d.subtitle === 'Git source');
    expect(src?.namedBy).toEqual([{ kind: 'Application', namespace: 'argocd', name: 'shop' }]);
  });

  it('leaves out a role the export graph already holds', () => {
    const exported = { nodes: [{ id: 'aws_iam_role.checkout', kind: 'aws_iam_role', attrs: { arn: ARN } }] };
    expect(forApplication(held, exported).deps.map(d => d.subtitle)).not.toContain('Cloud identity');
  });

  it('lists nothing for an Application whose resources name nothing', () => {
    const plain = heldFrom({ metadata: { name: 'x' } }, [
      { node, manifest: { ...sa, metadata: { name: 'checkout', namespace: 'shop' } } },
    ]);
    expect(forApplication(plain).deps).toEqual([]);
  });
});

describe('a resource tab', () => {
  const held = heldFrom(app, [{ node, manifest: sa }]);

  it('shows the role on the ServiceAccount that names it', () => {
    const cut = forResource(held, identityOfManifest(sa));
    expect(cut.cards.map(c => c.id)).toContain(`outside:identity:aws:${ARN}`);
  });

  it('keeps a manifest with no apiVersion readable by the node it came from', () => {
    const bare = { kind: 'ServiceAccount', metadata: sa.metadata };
    const h = heldFrom(app, [{ node, manifest: bare as any }]);
    expect(h.find(x => x.uid === 'sa-uid')?.manifest.apiVersion).toBe('v1');
  });
});

describe('the export URL', () => {
  it('comes from the Application annotation first', () => {
    const a = { ...app, metadata: { ...app.metadata, annotations: { 'behold.intentius.io/export-url': 'https://a/g.json' } } };
    expect(exportUrlFor(a, { EXPORT_URL: 'https://default/g.json' })).toBe('https://a/g.json');
  });
  it('falls back to the install default, whatever case the installer wrote', () => {
    expect(exportUrlFor(app, { EXPORT_URL: 'https://default/g.json' })).toBe('https://default/g.json');
    expect(exportUrlFor(app, { exportUrl: 'https://default/g.json' })).toBe('https://default/g.json');
  });
  it('is undefined with neither', () => {
    expect(exportUrlFor(app, undefined)).toBeUndefined();
    expect(exportUrlFor(app, {})).toBeUndefined();
  });
});
