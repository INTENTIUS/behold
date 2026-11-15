# behold for Backstage

An "Infrastructure" tab on a component's page. The component's annotations
pick a slice of a published behold `graph.json`, and the tab draws that slice:
the Terraform roots the component names and what they touch. It is frontend
only. The portal reads a file that `behold export` already published, so it
needs no checkout and no cloud credentials.

## Annotations

The first one that matches the published graph wins.

| Annotation | Value |
|---|---|
| `behold.intentius.io/roots` | A comma list of root names or box ids from `graph.json` (`prod`, or `stack:prod`; a card id works too). |
| `terraform/workspaces` | The same names, for a component that already carries the Terraform plugin's annotation. |
| `backstage.io/kubernetes-namespace` | Matched against the namespace of the cards in the graph. It finds nothing until the graph draws Kubernetes kinds (behold#1056). |
| `backstage.io/kubernetes-id` | Matched against a card's Helm release or workspace member, with the same limit. |
| `behold.intentius.io/export-url` | Reads this export instead of the configured one. Read directly, never through the proxy. |
| `behold.intentius.io/depth` | Hops out from the roots, 0 to 5. Default 1. |

A component with none of the first four gets no tab. The cut is behold's own
(`cutDocument`, the one `behold graph --around` runs), copied into
`src/behold/`.

## Configuration

```yaml
# app-config.yaml
behold:
  exportUrl: https://example.github.io/estate/   # the site `behold export` publishes to
  # proxyPath: /behold                           # read graph.json through proxy.endpoints
  # viewerUrl: https://example.github.io/estate/behold.html
```

For a private bucket, add a proxy endpoint and set `proxyPath`. Backstage's
proxy adds the header, so there is no backend code to write:

```yaml
proxy:
  endpoints:
    /behold:
      target: https://storage.example.com/estate-export
      headers:
        Authorization: Bearer ${BEHOLD_EXPORT_TOKEN}
```

`graph.json` is then read from `<backend>/api/proxy/behold/graph.json` with the
user's Backstage token, and `exportUrl` is only where "Open the whole estate"
points. A direct `exportUrl` is fetched with no credentials. A public site
needs `access-control-allow-origin` for the portal's origin (GitHub Pages
sends `*`). Do not put the export in the TechDocs bucket: the TechDocs
publisher serves HTML as `text/plain`.

## How the slice is drawn

1. The tab fetches `graph.json`, checks it is `behold-graph/1`, and cuts it
   around the annotation's roots.
2. If the single-file viewer is there (`behold.html` beside `graph.json`, or
   `behold.viewerUrl`), the tab opens it in an iframe with
   `?host=<portal origin>&transport=post` and answers its `behold:ready` with
   the theme, the cut (`behold:graph`) and the roots to bring forward
   (`behold:view`).
3. Otherwise the tab draws the cut itself as SVG (`src/paint.ts`) and offers
   the Mermaid text of the cut under it.

The single-file viewer's build waits on the pinhole 0.6.0 release (behold#1070,
behold#1069), which is a maintainer step. Until the viewer is published
beside an export, every tab takes step 3. The frame protocol is covered by
`src/ViewerFrame.test.tsx` against the viewer's transport as written in
`src/viewer/transport.ts`, and has not run against a built viewer.

## Wiring

New frontend system (Backstage 1.49 and later; the app discovers or lists it):

```tsx
import beholdPlugin from '@intentius/backstage-plugin-behold/alpha';
export default createApp({ features: [catalogPlugin, beholdPlugin] });
```

The `./alpha` export is `createFrontendPlugin` with an `EntityContentBlueprint`
whose filter shows the tab only when an annotation picks a slice.

Legacy apps:

```tsx
import { EntityInfrastructureContent, isBeholdAvailable } from '@intentius/backstage-plugin-behold';

<EntityLayout.Route path="/infrastructure" title="Infrastructure" if={isBeholdAvailable}>
  <EntityInfrastructureContent />
</EntityLayout.Route>
```

## Layout and what moves

This folder lives in the behold repository until a `behold-surfaces`
repository exists. `src/behold/` holds copies of `web/cut-around.js` (and its
`.d.ts`), `src/graph-cut.ts`, `src/graph-document.ts`, `src/graph-mermaid.ts`
and `src/mermaid-budgets.ts`; `node scripts/sync-behold.mjs` refreshes them
and `src/sync.test.ts` fails if they drift. The Headlamp folder keeps its own copy of
`cut-around.js` (and the Argo CD extension, once applied, its own), so these
files are the shared model to move into one place in `behold-surfaces`. To move the folder, take
`surfaces/backstage-plugin-behold/` and the six source files above, then drop
the drift test.

## Develop

    npm install
    npm run tsc && npm run lint && npm test
    npm run build

The tests run through `backstage-cli`. To try the tab in a scaffolded app,
create one with `npx @backstage/create-app@latest` (add `--legacy` for the
legacy system), then:

    e2e/install-into-app.sh <app-dir> new      # or: legacy
    node e2e/serve-export.mjs <behold-export-dir> 4801 &
    cd <app-dir> && BROWSER=none yarn workspace backend start &
    cd <app-dir> && BROWSER=none yarn workspace app start &
    BACKSTAGE_URL=http://localhost:3000 node e2e/backstage-e2e.mjs

`install-into-app.sh` copies the plugin into the app's `plugins/`, adds the
test components in `fixtures/catalog-info.yaml` and wires the tab.
`e2e/backstage-e2e.mjs` checks the tab on an annotated component, the
Terraform workspace annotation, and no tab without one. It needs Chrome and
Playwright from behold's own dependencies.

## Release and listing

Maintainer steps, in order. Nothing here is done.

1. Publish `@intentius/backstage-plugin-behold` to npm (`npm run build`, then
   `npm publish`; the package's `publishConfig` points at `dist/`).
2. Add the plugin to Backstage's plugin directory with a pull request to
   backstage/backstage (an outside repository) and package it for Red Hat
   Developer Hub (behold#1077).
