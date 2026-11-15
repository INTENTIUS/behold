import { useEffect, useRef } from 'react';
import type { GraphDocument } from './behold/graph-document';

/** The origin of an address, or undefined when it is not an http(s) one. */
export function originOfUrl(url: string): string | undefined {
  try {
    const u = new URL(url, window.location.href);
    return /^https?:$/.test(u.protocol) ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The single-file viewer in an iframe, spoken to over postMessage (its `post`
 * transport, behold#1070). The frame is opened with `?host=<this origin>`;
 * the viewer says `behold:ready`, and the tab answers with the cut and the
 * theme. Only messages from the frame's own window and origin are read.
 */
export function ViewerFrame(props: { viewer: string; document: GraphDocument; focus: string[]; dark: boolean }) {
  const { viewer, document: doc, focus, dark } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = originOfUrl(viewer);

  const src = (() => {
    const u = new URL(viewer, window.location.href);
    u.searchParams.set('host', window.location.origin);
    u.searchParams.set('transport', 'post');
    return u.href;
  })();

  useEffect(() => {
    if (!origin) return undefined;
    const send = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, origin);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      if ((e.data as { type?: unknown } | null)?.type !== 'behold:ready') return;
      send({ type: 'behold:theme', theme: dark ? 'dark' : 'light' });
      send({ type: 'behold:graph', document: doc });
      if (focus.length) send({ type: 'behold:view', focus });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, doc, focus, dark]);

  return (
    <iframe
      ref={frame}
      title="behold graph"
      src={src}
      sandbox="allow-scripts allow-same-origin"
      style={{ width: '100%', height: 640, border: 0 }}
    />
  );
}
