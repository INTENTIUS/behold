# behold for Headlamp

A Headlamp plugin that draws what live Kubernetes objects name outside the
cluster, using behold's placeholder rules and neighbourhood cut. It reads only
the objects Headlamp already holds, so it needs no server and no configuration.

- A map source, "Outside the cluster (behold)", adds a node for each cloud
  identity, secret store, secret provider and Git source the cluster names,
  and an edge from the object that names it. A ServiceAccount annotated with
  `eks.amazonaws.com/role-arn` gets a node for that role. Linked nodes stack
  into one group on the map. ServiceAccounts sit under the Security kind,
  which Headlamp's map leaves off by default: tick it in the map's filter.
- A details section, "Outside the cluster", on the pages of ServiceAccounts,
  ExternalSecrets, SecretStores, ClusterSecretStores, Argo CD Applications and
  Flux Kustomizations, listing those cards as a table. It shows the objects
  within reach of the one on screen (behold's `neighbourhoodOf`).
- A settings field, "Export URL", for an optional behold graph (a
  `behold export` file or `behold serve`'s `/api/graph?detail=3`, which must
  be served with CORS for the browser). A target that graph already holds gets
  no placeholder.

What the plugin reads: ServiceAccounts, and the external-secrets.io,
argoproj.io and Flux kinds when their CRDs exist. A cluster without a CRD
shows nothing for that kind. A masked field (chant#5116) shows as a note.

## Layout and what moves

This folder lives in the behold repository until a `behold-surfaces`
repository exists. `src/behold/` holds copies of three modules from behold's
`web/` (`cut-around.js`, `neighbourhood.js`, `outside-refs.js`); `node
scripts/sync-behold.mjs` refreshes them and a test fails if they drift. To move
the folder, take `surfaces/headlamp-behold/`, `.github/workflows/headlamp-plugin-release.yml`
and the three modules as the source of `src/behold/`, then drop the drift test.
The e2e imports Playwright from behold's dependencies and needs its own.

## Develop

    npm ci
    npm run tsc && npm run lint && npm test
    npm run build

`e2e/headlamp-e2e.sh` creates a k3d cluster (`behold-headlamp`), applies
`fixtures/`, starts the Headlamp web image with the plugin mounted and checks
the map and the ServiceAccount page in Chrome. It leaves the cluster and the
`behold-headlamp-ui` container running; remove them with `k3d cluster delete
behold-headlamp` and `docker rm -f behold-headlamp-ui`.

## Release and listing

`node scripts/package.mjs` writes `release/headlamp-behold-<version>.tar.gz`
(the same bytes on every build of one commit) and puts its sha256 in
`artifacthub-pkg.yml`. The tag `headlamp-behold-v<version>` runs
`.github/workflows/headlamp-plugin-release.yml`, which rebuilds, fails if the
checksum differs from the file, and attaches the tarball to a release.

Maintainer steps, in order:

1. Bump `version` in `package.json` and `artifacthub-pkg.yml` (and the version
   in `archive-url`), run `npm run build && node scripts/package.mjs`, commit.
2. Push the tag `headlamp-behold-v<version>` and confirm the release holds the
   tarball.
3. On artifacthub.io, add the repository as kind "Headlamp plugins", pointing
   at this folder's repository path. Copy its repository ID into
   `artifacthub-repo.yml` with the owner's email.
4. Request Verified Publisher by committing `artifacthub-repo.yml` with that ID
   and owner, as Artifact Hub's guide describes. Official status is requested
   from the Headlamp project after that.
5. Replace the `logoURL` if the plugin gets its own logo.
