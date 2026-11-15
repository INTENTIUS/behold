# kubectl behold

Draws the current kubectl context with behold and opens the picture in a
browser. Given an object, the picture is that object and what references it or
is referenced by.

```sh
kubectl behold                      # the whole context
kubectl behold deploy/web -n app    # one Deployment and its neighbours
kubectl behold deploy web -n app    # the same, kubectl's other spelling
kubectl behold --no-open -o web.svg deploy/web -n app
```

It is a launcher over `behold graph --context ... --svg [--around <id>]`
(behold#1083, the bare-cluster reader). The read is chant's read-only lister:
nothing is written to the cluster, and the only file written is the SVG. It
needs `kubectl` and Node 20 or newer, and runs the behold release named by
`BEHOLD_PIN` in `kubectl-behold` through npx. Set `BEHOLD_BIN` to run another
command (for example `node bin/behold.js` from a checkout), and `BEHOLD_OPEN`
to change what opens the file.

A kubeconfig user that authenticates through an exec plugin (the GKE, EKS and
AKS tools) is refused, because behold would run the command the file names.
The error says to pass `--allow-exec-plugin`, which runs it once and reads with
the credential it prints.

## Files

| File | What it is |
| --- | --- |
| `kubectl-behold` | the plugin: one bash script, Linux and macOS |
| `krew/behold.yaml` | the krew plugin manifest, checksum written by `scripts/package.mjs` |
| `k9s/behold.yaml` | the k9s plugin entry: Shift-B on a workload, service, pod, job or ingress |
| `scripts/package.mjs` | builds the reproducible release archive; `--check` fails when the manifest's checksum or URL is stale |
| `e2e/kubectl-behold-e2e.sh` | scratch k3d cluster, the plugin, krew install and uninstall from the built archive, the k9s entry, the exec-plugin refusal |
| `e2e/k9s-drive.exp` | drives a real k9s in a pty for the e2e when `K9S_BIN` is set |

`just kubectl-behold` runs the parse and checksum checks (CI runs them in
`.github/workflows/kubectl-behold-release.yml`). `just kubectl-behold-e2e`
needs docker, k3d, kubectl and node, creates `behold-kubectl-e2e`, and leaves
it in place. For the krew step set `KREW_BIN` to a krew binary, and for the k9s
step `K9S_BIN` to k9s.

## Release and submission (maintainer steps)

1. Set `BEHOLD_PIN` in `kubectl-behold` to a published behold release that has
   `behold graph --context` (behold#1083), then run `node scripts/package.mjs`
   and commit the new checksum in `krew/behold.yaml`.
2. Tag `kubectl-behold-v<version>` (the version in `krew/behold.yaml`). The
   workflow attaches `kubectl-behold-v<version>.tar.gz` and its `.sha256` to
   the release.
3. Pull request to `kubernetes-sigs/krew-index`: add `plugins/behold.yaml`,
   byte for byte `krew/behold.yaml`. A reviewer may ask for another name.
4. After krew accepts it, pull request to `derailed/k9s`: add
   `plugins/behold.yaml`, byte for byte `k9s/behold.yaml`, and its row in
   `plugins/README.md` (scopes: workloads, services, pods, jobs, ingresses;
   shortcut Shift-B; dependency: the krew plugin `behold`).

## Moving to behold-surfaces

When that repository exists, this whole folder moves with `surfaces/` beside
`headlamp-behold`: the folder, `.github/workflows/kubectl-behold-release.yml`
(its paths and the tag filter), and the `kubectl-behold` and
`kubectl-behold-e2e` recipes in the justfile. The only thing it takes from this
repository is the root `LICENSE` (copied into the archive by
`scripts/package.mjs`) and a behold build for the e2e (`BEHOLD_BIN`).
