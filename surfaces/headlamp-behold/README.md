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
the folder, take `surfaces/headlamp-behold/` (its `chant.config.ts` is a release train
member), the `headlamp-behold` job of `.github/workflows/surfaces.yml` and the three modules as the source of `src/behold/`, then drop the drift test.
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
`artifacthub-pkg.yml`; `--check`, which `just headlamp-plugin` and pull-request
CI run, fails when the file names another checksum.

The plugin is released on behold's release train (`just release` at the
repository root; `chant.config.ts` in this folder is its member). A train that
finds a change here since the last release cuts the next version, stamps it
into `package.json`, runs the typecheck and tests, builds the tarball and
attaches it, with its `.sha256`, to the release `headlamp-behold-v<version>`.
The tarball holds `package.json`, so `artifacthub-pkg.yml` can name its
checksum only once the version is known.

Maintainer steps, in order:

1. Release it with `just release` and confirm the release holds the tarball.
2. In a pull request of its own, set `version` in `package.json` and
   `artifacthub-pkg.yml` (and the version in `archive-url`) to the released
   version, run `npm run build && node scripts/package.mjs`, and check that the
   checksum it writes is the release's `.sha256`.
3. On artifacthub.io, add the repository as kind "Headlamp plugins", pointing
   at this folder's repository path. Copy its repository ID into
   `artifacthub-repo.yml` with the owner's email.
4. Request Verified Publisher by committing `artifacthub-repo.yml` with that ID
   and owner, as Artifact Hub's guide describes. Official status is requested
   from the Headlamp project after that.
5. Replace the `logoURL` if the plugin gets its own logo.
