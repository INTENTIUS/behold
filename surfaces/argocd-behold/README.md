# behold for Argo CD

A UI extension for Argo CD 3.5 and later. It adds an "Outside the cluster" tab
to an Application and to each of its resources, listing the cloud identities,
secret stores, secret providers and Git sources they name, using behold's
placeholder rules and neighbourhood cut in the browser. It needs no behold
server. Install steps are in the docs page `docs/src/content/docs/using/argocd-extension.mdx`
(published as "Outside the cluster in Argo CD").

## How it is built

- `src/index.tsx` registers one resource tab for `**`/`**` through
  `extensionsAPI.registerResourceExtension`. Argo CD also shows it on the
  Application's own details panel, so a second registration for
  `argoproj.io`/`Application` would show the tab twice.
- `src/argo.ts` has the logic with no React or Argo CD UI in it: it reads
  live manifests through `/api/v1/applications/<name>/resource` for the kinds
  behold has rules for, adds the Application itself (the resource tree does
  not hold it) and calls the shared model.
- The model is not copied. `src/argo.ts` imports `../headlamp-behold/src/model.ts`
  (`mapData`, `outsideFor`, `placeholdersFor`) and through it the copies of
  `web/cut-around.js`, `web/neighbourhood.js` and `web/outside-refs.js` in
  `../headlamp-behold/src/behold/`, which `scripts/sync-behold.mjs` there keeps
  equal to behold's `web/`. When these folders move to a `behold-surfaces`
  repository the model and those three modules should become a package both
  surfaces depend on.
- `scripts/build.mjs` bundles with esbuild and resolves `react`, `react-dom`
  and `react/jsx-runtime` to `window.React`, `window.ReactDOM` and
  `window.ReactJSXRuntime`, which Argo CD 3.5 provides. A bundled JSX runtime
  fails to load on 3.5 with a `TypeError`; `src/bundle.test.ts` checks that the
  output carries none.
- `scripts/package.mjs` writes `release/argocd-behold-<version>.tar.gz`
  (`resources/extension-behold.js/extension-behold.js`, the layout the
  installer and its `EXTENSION_JS_VARS` file expect) and `release/checksums.txt`.

## Develop

    npm ci
    npm run tsc && npm test
    npm run build && npm run package

`e2e/argocd-e2e.sh` creates a k3d cluster (`behold-argocd-ui`), installs Argo CD
v3.5.7 in full, adds the extension through the installer, syncs an Application
from a git repository served in the cluster and checks the ServiceAccount tab,
the Application tab and the console in Chrome. It leaves the cluster and a small file server for the tarball on port 8099
running; remove them yourself (`k3d cluster delete behold-argocd-ui`). Chrome
and Playwright come from behold's own dependencies.

## Configuration

The export URL, an optional behold graph, comes from the Application annotation
`behold.intentius.io/export-url`, else from `window.BEHOLD_VARS.EXPORT_URL`,
which the installer writes from `EXTENSION_JS_VARS`.

## Release

Tag `argocd-behold-v<version>` after bumping `version` in `package.json`. The
workflow `.github/workflows/argocd-extension-release.yml` builds and attaches the
tarball and `checksums.txt`. A public listing is the maintainers' step.
