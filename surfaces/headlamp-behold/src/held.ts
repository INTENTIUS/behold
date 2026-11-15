// The objects Headlamp holds, as the manifests behold's rules read.
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { makeCustomResourceClass } from '@kinvolk/headlamp-plugin/lib/lib/k8s/crd';
import { useEffect, useMemo, useState } from 'react';
import { graphOf, Held, Manifest } from './model';

export interface Settings {
  exportUrl?: string;
}

export const settingsStore = new ConfigStore<Settings>('headlamp-behold');

const crd = (
  group: string,
  version: string,
  kind: string,
  pluralName: string,
  isNamespaced = true
) =>
  makeCustomResourceClass({
    apiInfo: [{ group, version }],
    kind,
    pluralName,
    singularName: kind.toLowerCase(),
    isNamespaced,
  } as any);

// The kinds behold has placeholder rules for. A cluster without one of these
// CRDs answers 404, which the list hook reports as an error and the plugin
// treats as an empty list.
const ExternalSecret = crd('external-secrets.io', 'v1', 'ExternalSecret', 'externalsecrets');
const SecretStore = crd('external-secrets.io', 'v1', 'SecretStore', 'secretstores');
const ClusterSecretStore = crd(
  'external-secrets.io',
  'v1',
  'ClusterSecretStore',
  'clustersecretstores',
  false
);
const Application = crd('argoproj.io', 'v1alpha1', 'Application', 'applications');
const Kustomization = crd('kustomize.toolkit.fluxcd.io', 'v1', 'Kustomization', 'kustomizations');
const GitRepository = crd('source.toolkit.fluxcd.io', 'v1', 'GitRepository', 'gitrepositories');

/** Kinds the plugin reads, with the apiVersion a list item may leave out. */
export const WATCHED: Record<string, string> = {
  ServiceAccount: 'v1',
  ExternalSecret: 'external-secrets.io/v1',
  SecretStore: 'external-secrets.io/v1',
  ClusterSecretStore: 'external-secrets.io/v1',
  Application: 'argoproj.io/v1alpha1',
  Kustomization: 'kustomize.toolkit.fluxcd.io/v1',
};

function heldOf(items: any[] | null | undefined, kind: string, apiVersion: string): Held[] {
  return (items || []).map(o => {
    const j = o.jsonData || o;
    const manifest: Manifest = {
      ...j,
      kind: j.kind || kind,
      apiVersion: j.apiVersion || apiVersion,
    };
    return {
      uid: j.metadata?.uid || `${kind}/${j.metadata?.namespace || ''}/${j.metadata?.name}`,
      manifest,
    };
  });
}

/** Every object of the watched kinds Headlamp holds, or null while the first list loads. */
export function useHeld(): Held[] | null {
  const [sas] = K8s.ResourceClasses.ServiceAccount.useList();
  const [es] = ExternalSecret.useList();
  const [ss] = SecretStore.useList();
  const [css] = ClusterSecretStore.useList();
  const [apps] = Application.useList();
  const [ks] = Kustomization.useList();
  const [grs] = GitRepository.useList();
  return useMemo(() => {
    if (sas === null) return null;
    return [
      ...heldOf(sas, 'ServiceAccount', 'v1'),
      ...heldOf(es, 'ExternalSecret', WATCHED.ExternalSecret),
      ...heldOf(ss, 'SecretStore', WATCHED.SecretStore),
      ...heldOf(css, 'ClusterSecretStore', WATCHED.ClusterSecretStore),
      ...heldOf(apps, 'Application', WATCHED.Application),
      ...heldOf(ks, 'Kustomization', WATCHED.Kustomization),
      ...heldOf(grs, 'GitRepository', 'source.toolkit.fluxcd.io/v1'),
    ];
  }, [sas, es, ss, css, apps, ks, grs]);
}

/** The graph behind the optional export URL, fetched once per URL. */
export function useExport(): { nodes: any[]; edges: any[] } | undefined {
  const url = settingsStore.useConfig()()?.exportUrl;
  const [graph, setGraph] = useState<{ nodes: any[]; edges: any[] } | undefined>();
  useEffect(() => {
    setGraph(undefined);
    if (!url) return;
    let live = true;
    fetch(url)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(doc => live && setGraph(graphOf(doc)))
      .catch(() => live && setGraph(undefined));
    return () => {
      live = false;
    };
  }, [url]);
  return graph;
}
