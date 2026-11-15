// The "Outside the cluster" tab for Argo CD 3.5 and later. Argo CD loads this
// file from /tmp/extensions, hands it React (window.React and
// window.ReactJSXRuntime, both external in the build) and calls
// extensionsAPI.registerResourceExtension for each tab.
import { useEffect, useMemo, useState } from 'react';
import { graphOf } from '../../headlamp-behold/src/model';
import {
  Application,
  TreeNode,
  exportUrlFor,
  forApplication,
  forResource,
  heldFrom,
  identityOfManifest,
  manifestOf,
  resourceQuery,
  watchedNodes,
} from './argo';
import { Held, Manifest, subtitleOf } from '../../headlamp-behold/src/model';

declare global {
  interface Window {
    extensionsAPI: {
      registerResourceExtension(
        component: (props: any) => any,
        group: string,
        kind: string,
        tabTitle: string,
        opts?: { icon?: string }
      ): void;
    };
    BEHOLD_VARS?: Record<string, string>;
  }
}

const TITLE = 'Outside the cluster';

const baseHref = () => {
  const b = document.querySelector('base')?.getAttribute('href') || '/';
  return b.endsWith('/') ? b.slice(0, -1) : b;
};

const cache = new Map<string, Promise<Manifest | undefined>>();

/** One live manifest through Argo CD's own API, with the browser's session. Read once per object and uid. */
function readManifest(app: Application, n: TreeNode): Promise<Manifest | undefined> {
  const key = `${app.metadata.name}/${n.uid || `${n.kind}/${n.namespace}/${n.name}`}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(baseHref() + resourceQuery(app, n), { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : undefined))
      .then(manifestOf)
      .catch(() => undefined);
    cache.set(key, p);
  }
  return p;
}

function useHeld(app: Application, tree: { nodes?: TreeNode[] } | undefined) {
  const nodes = useMemo(() => watchedNodes(tree?.nodes), [tree]);
  const [held, setHeld] = useState<Held[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(nodes.map(node => readManifest(app, node).then(manifest => ({ node, manifest })))).then(
      read => live && setHeld(heldFrom(app, read))
    );
    return () => {
      live = false;
    };
  }, [app, nodes]);
  return held;
}

const exportCache = new Map<string, Promise<{ nodes: any[]; edges: any[] } | undefined>>();

function useExport(app: Application) {
  const url = exportUrlFor(app, window.BEHOLD_VARS);
  const [graph, setGraph] = useState<{ nodes: any[]; edges: any[] } | undefined>();
  useEffect(() => {
    setGraph(undefined);
    if (!url) return;
    let p = exportCache.get(url);
    if (!p) {
      p = fetch(url)
        .then(r => (r.ok ? r.json() : undefined))
        .then(graphOf)
        .catch(() => undefined);
      exportCache.set(url, p);
    }
    let live = true;
    p.then(g => live && setGraph(g));
    return () => {
      live = false;
    };
  }, [url]);
  return graph;
}

const rows = (attrs: Record<string, any>) =>
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)] as const);

const box = { padding: '16px' } as const;
const muted = { color: '#6d7f8b', fontSize: '13px' } as const;
const card = { border: '1px solid #d5dde3', borderRadius: '6px', padding: '12px', marginBottom: '12px', background: '#fff' } as const;

function Card({ label, subtitle, attrs, namedBy }: { label: string; subtitle: string; attrs: Record<string, any>; namedBy?: string[] }) {
  return (
    <div style={card} data-behold-card={label}>
      <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{label}</div>
      <div style={muted}>
        {subtitle}
        {namedBy && namedBy.length ? `, named by ${namedBy.join(', ')}` : ''}
      </div>
      <table style={{ marginTop: 8, fontSize: '13px' }}>
        <tbody>
          {rows(attrs).map(([k, v]) => (
            <tr key={k}>
              <td style={{ ...muted, paddingRight: 16, verticalAlign: 'top' }}>{k}</td>
              <td style={{ wordBreak: 'break-all' }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notes({ notes }: { notes: Array<{ path: string; message: string; waitsOn?: string }> }) {
  return (
    <>
      {notes.map((n, i) => (
        <div key={i} style={muted}>
          {n.path}: {n.message}
          {n.waitsOn ? ` (waits on ${n.waitsOn})` : ''}
        </div>
      ))}
    </>
  );
}

const isApplicationTab = (app: Application, resource: any) =>
  !resource ||
  (resource.kind === 'Application' && resource.metadata?.name === app.metadata.name && !resource.metadata?.ownerReferences);

function Tab({ application, resource, tree }: { application: Application; resource?: any; tree?: { nodes?: TreeNode[] } }) {
  const held = useHeld(application, tree);
  const exported = useExport(application);
  const view = useMemo(() => {
    if (!held) return null;
    if (isApplicationTab(application, resource)) return { app: forApplication(held, exported) };
    const manifest: Manifest = { ...resource, apiVersion: resource.apiVersion || 'v1' };
    return { one: forResource(held, identityOfManifest(manifest), exported) };
  }, [held, exported, application, resource]);

  if (!view) return <div style={box}>Reading the objects in this Application.</div>;
  if (view.app) {
    const { deps, notes } = view.app;
    return (
      <div style={box} data-behold-tab="application">
        <div style={{ ...muted, marginBottom: 12 }}>
          {deps.length === 0
            ? 'No resource in this Application names anything outside the cluster.'
            : `${deps.length} thing${deps.length === 1 ? '' : 's'} outside the cluster named by this Application and its resources.`}
        </div>
        {deps.map(d => (
          <Card key={d.id} label={d.label} subtitle={d.subtitle} attrs={d.attrs} namedBy={d.namedBy.map(n => `${n.kind} ${n.name}`)} />
        ))}
        <Notes notes={notes} />
      </div>
    );
  }
  const { cards, notes } = view.one!;
  return (
    <div style={box} data-behold-tab="resource">
      {cards.length === 0 && notes.length === 0 && (
        <div style={muted}>This object and its neighbours name nothing outside the cluster.</div>
      )}
      {cards.map(c => (
        <Card key={c.id} label={c.label} subtitle={subtitleOf(c)} attrs={c.attrs} />
      ))}
      <Notes notes={notes} />
    </div>
  );
}

// One registration covers every resource and the Application itself: Argo CD
// matches `**` against the Application's own tab too, so a second registration
// for argoproj.io/Application would show the tab twice.
window.extensionsAPI.registerResourceExtension(Tab, '**', '**', TITLE, { icon: 'fa-cloud' } as any);
