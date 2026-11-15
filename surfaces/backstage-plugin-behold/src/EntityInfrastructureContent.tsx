import { useMemo } from 'react';
import { useTheme } from '@material-ui/core/styles';
import useAsync from 'react-use/esm/useAsync';
import { Progress, WarningPanel, Link, CodeSnippet } from '@backstage/core-components';
import { configApiRef, discoveryApiRef, fetchApiRef, useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { checkGraphDocument, type GraphDocument } from './behold/graph-document';
import { toMermaid } from './behold/graph-mermaid';
import { paint } from './paint';
import { type BeholdConfig, type Source, sourceFor } from './source';
import { sliceFor, namesSlice, type Slice } from './slice';
import { ViewerFrame } from './ViewerFrame';

/** For `<EntityLayout.Route if={isBeholdAvailable}>` in a legacy app: the tab shows only when an annotation picks a slice. */
export const isBeholdAvailable = (entity: { metadata: { annotations?: Record<string, string> } }): boolean =>
  namesSlice(entity.metadata.annotations);

const isDark = () => {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
  } catch {
    return false;
  }
};

/** A same-origin-or-CORS HEAD for the viewer page. Any failure means "not there". */
async function viewerPresent(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD', credentials: 'omit' });
    return r.ok && /html/i.test(r.headers.get('content-type') ?? 'html');
  } catch {
    return false;
  }
}

type Loaded = { ok: false; error: string } | { ok: true; source: Source; cut: Slice; viewer?: string };

export function EntityInfrastructureContent() {
  const { entity } = useEntity();
  const configApi = useApi(configApiRef);
  const discovery = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const annotations = entity.metadata.annotations;

  const state = useAsync(async (): Promise<Loaded> => {
    const config: BeholdConfig = {
      exportUrl: configApi.getOptionalString('behold.exportUrl'),
      proxyPath: configApi.getOptionalString('behold.proxyPath'),
      viewerUrl: configApi.getOptionalString('behold.viewerUrl'),
    };
    const proxyBase = config.proxyPath ? await discovery.getBaseUrl('proxy') : undefined;
    const source = sourceFor(config, annotations, proxyBase);
    if (!source) {
      return { ok: false, error: 'No export is configured. Set behold.exportUrl in app-config.yaml, or add the behold.intentius.io/export-url annotation.' };
    }
    // The Backstage token goes only to the Backstage proxy, never to a direct address.
    const res = await (source.viaProxy ? fetchApi.fetch(source.graph) : fetch(source.graph, { credentials: 'omit' }));
    if (!res.ok) return { ok: false, error: `Reading ${source.graph} answered ${res.status}.` };
    const checked = checkGraphDocument(await res.json());
    if (!checked.ok) return { ok: false, error: checked.error };
    const cut = sliceFor(checked.document, annotations);
    if (!cut.ok) return { ok: false, error: cut.reason };
    const viewer = source.viewer && (await viewerPresent(source.viewer)) ? source.viewer : undefined;
    return { ok: true, source, cut: cut.slice, viewer };
  }, [entity.metadata.name, entity.metadata.namespace, annotations]);

  const paper = useTheme().palette.background.paper;
  const ready = state.value?.ok ? state.value : undefined;
  const drawn = ready && !ready.viewer ? ready.cut.document : undefined;
  const painted = useMemo(() => (drawn ? paint(drawn, paper) : undefined), [drawn, paper]);
  const mermaid = useMemo(() => (drawn ? toMermaid(drawn) : undefined), [drawn]);

  if (state.loading) return <Progress />;
  if (state.error) return <WarningPanel title="Could not read the behold graph" message={state.error.message} />;
  const v = state.value!;
  if (!v.ok) return <WarningPanel title="No infrastructure to draw" message={v.error} />;

  const doc: GraphDocument = v.cut.document;
  const boxes = v.cut.ids.filter(id => doc.groups.some(g => g.id === id));
  return (
    <div data-testid="behold-infrastructure">
      <p>
        Slice picked by <code>{v.cut.by}</code>: {v.cut.ids.join(', ')}, with what they touch ({doc.nodes.length} cards, {doc.edges.length} edges).{' '}
        {v.source.site && <Link to={v.source.site}>Open the whole estate</Link>}
      </p>
      {v.viewer ? (
        <ViewerFrame viewer={v.viewer} document={doc} focus={boxes} dark={isDark()} />
      ) : (
        <>
          {/* paint() escapes every string it writes into the markup. */}
          <div data-testid="behold-fallback-svg" style={{ overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: painted?.svg ?? '' }} />
          <details style={{ marginTop: 16 }}>
            <summary>Mermaid source</summary>
            <CodeSnippet text={mermaid ?? ''} language="text" showCopyCodeButton />
          </details>
        </>
      )}
    </div>
  );
}
