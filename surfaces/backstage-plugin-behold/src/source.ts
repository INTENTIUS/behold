// Where the tab reads the graph from. Pure: the app's config and the entity's
// annotations in, addresses out.
import { ANNOTATION_EXPORT_URL, graphUrl, viewerUrlFor } from './slice';

export interface BeholdConfig {
  exportUrl?: string;
  proxyPath?: string;
  viewerUrl?: string;
}

export interface Source {
  /** Where `graph.json` is fetched from. */
  graph: string;
  /** True when `graph` is on the Backstage backend's proxy, so the user's token goes with the request. */
  viaProxy: boolean;
  /** The site the "whole estate" link opens. */
  site?: string;
  /** The single-file viewer to try, if one is named or can be derived. */
  viewer?: string;
}

/**
 * An entity's `export-url` annotation wins over the app's config, and a
 * direct address wins over the proxy: the proxy is the app's own setting for
 * its own export, so an entity that names another export is read directly.
 */
export function sourceFor(
  config: BeholdConfig,
  annotations: Readonly<Record<string, string>> | undefined,
  proxyBase: string | undefined,
): Source | undefined {
  const override = annotations?.[ANNOTATION_EXPORT_URL]?.trim();
  const base = override || config.exportUrl?.trim();
  const proxy = config.proxyPath?.trim();
  if (!override && proxy && proxyBase) {
    const path = proxy.startsWith('/') ? proxy : `/${proxy}`;
    return {
      graph: graphUrl(`${proxyBase.replace(/\/+$/, '')}${path}`),
      viaProxy: true,
      site: base,
      viewer: config.viewerUrl?.trim() || undefined,
    };
  }
  if (!base) return undefined;
  return {
    graph: graphUrl(base),
    viaProxy: false,
    site: /\.json(\?.*)?$/i.test(base) ? undefined : base,
    viewer: (!override && config.viewerUrl?.trim()) || viewerUrlFor(base),
  };
}
