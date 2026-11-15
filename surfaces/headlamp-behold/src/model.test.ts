import { describe, expect, it } from 'vitest';
import { graphOf, Held, mapData, outsideFor } from './model';

const ARN = 'arn:aws:iam::123456789012:role/checkout';

const sa = (name: string, annotations: Record<string, string>): Held => ({
  uid: `uid-${name}`,
  manifest: {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name, namespace: 'shop', uid: `uid-${name}`, annotations },
  },
});

describe('mapData', () => {
  it('draws a node for the IAM role and an edge from the ServiceAccount uid', () => {
    const d = mapData([sa('checkout', { 'eks.amazonaws.com/role-arn': ARN })]);
    expect(d.nodes.map(n => n.id)).toEqual([`outside:identity:aws:${ARN}`]);
    expect(d.nodes[0].label).toBe(ARN);
    expect(d.edges).toHaveLength(1);
    expect(d.edges[0].source).toBe('uid-checkout');
    expect(d.edges[0].target).toBe(`outside:identity:aws:${ARN}`);
  });

  it('shares one card between two ServiceAccounts that name the same role', () => {
    const d = mapData([
      sa('a', { 'eks.amazonaws.com/role-arn': ARN }),
      sa('b', { 'eks.amazonaws.com/role-arn': ARN }),
    ]);
    expect(d.nodes).toHaveLength(1);
    expect(d.edges.map(e => e.source).sort()).toEqual(['uid-a', 'uid-b']);
  });

  it('draws nothing for a ServiceAccount with no annotation', () => {
    const d = mapData([sa('plain', {})]);
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([]);
  });

  it('leaves out a role the export URL graph already holds', () => {
    const exported = graphOf({
      ir: {
        nodes: [{ id: 'aws_iam_role.checkout', kind: 'aws_iam_role', attrs: { arn: ARN } }],
        edges: [],
      },
    });
    expect(
      mapData([sa('checkout', { 'eks.amazonaws.com/role-arn': ARN })], exported).nodes
    ).toEqual([]);
  });

  it('draws an Argo CD Application source', () => {
    const app: Held = {
      uid: 'uid-app',
      manifest: {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: { name: 'shop', namespace: 'argocd' },
        spec: {
          source: {
            repoURL: 'https://github.com/acme/shop.git',
            path: 'deploy',
            targetRevision: 'main',
          },
        },
      },
    };
    const d = mapData([app]);
    expect(d.nodes[0].id).toBe('outside:source:https://github.com/acme/shop#deploy');
    expect(d.edges[0].label).toBe('revision main');
  });
});

describe('outsideFor', () => {
  it('lists the role for the ServiceAccount and nothing for another object', () => {
    const held = [sa('checkout', { 'eks.amazonaws.com/role-arn': ARN }), sa('plain', {})];
    const id = (name: string) => ({ group: '', kind: 'ServiceAccount', namespace: 'shop', name });
    expect(outsideFor(held, id('checkout')).cards.map(c => c.label)).toEqual([ARN]);
    expect(outsideFor(held, id('plain')).cards).toEqual([]);
  });

  it('reaches the provider through a store the cluster holds', () => {
    const store: Held = {
      uid: 'uid-store',
      manifest: {
        apiVersion: 'external-secrets.io/v1',
        kind: 'ClusterSecretStore',
        metadata: { name: 'gcp' },
        spec: { provider: { gcpsm: { projectID: 'acme-prod' } } },
      },
    };
    const es: Held = {
      uid: 'uid-es',
      manifest: {
        apiVersion: 'external-secrets.io/v1',
        kind: 'ExternalSecret',
        metadata: { name: 'db', namespace: 'shop' },
        spec: {
          secretStoreRef: { name: 'gcp', kind: 'ClusterSecretStore' },
          data: [{ remoteRef: { key: 'db-password' } }],
        },
      },
    };
    const r = outsideFor([store, es], {
      group: 'external-secrets.io',
      kind: 'ExternalSecret',
      namespace: 'shop',
      name: 'db',
    });
    expect(r.cards.map(c => c.kind).sort()).toEqual(['SecretProvider']);
  });
});
