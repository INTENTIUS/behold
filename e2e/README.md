# behold's e2e scripts

Each script here is run as `bash e2e/<name>.sh` from the repo root (most have
a `just e2e-*` recipe). The emulator ones start their own floci containers or
k3d clusters, refuse to adopt one that already exists, and remove theirs on
exit by name. They skip, exit 0, when Docker or the engine binary is absent.

## Running beside other sessions (behold#1032)

Every name, port and image an emulator script uses comes from the
environment, with the values below as defaults. Leave them unset and a run
behaves as it always has. To run a second copy beside the first, or beside
another session's run, give it its own names and ports. Keep the `behold-`
prefix on names (src/scratch.ts: anything behold creates is named
`behold-*`), and pick ports nobody else is using.

| Script | Variables (default) |
| --- | --- |
| multi-engine-demo-e2e.sh | `FLOCI_CONTAINER` (behold-multi-engine-floci), `FLOCI_AZ_CONTAINER` (behold-multi-engine-floci-az), `FLOCI_GCP_CONTAINER` (behold-multi-engine-floci-gcp), `FLOCI_PORT` (4664), `FLOCI_AZ_PORT` (4665), `FLOCI_GCP_PORT` (4666) |
| three-cloud-change-set-e2e.sh | `FLOCI_CONTAINER` (behold-three-cloud-floci), `FLOCI_AZ_CONTAINER` (behold-three-cloud-floci-az), `FLOCI_GCP_CONTAINER` (behold-three-cloud-floci-gcp), `FLOCI_PORT` (4661), `FLOCI_AZ_PORT` (4662), `FLOCI_GCP_PORT` (4663) |
| both of the above | `FLOCI_IMAGE` (ghcr.io/lex00/floci:48c6e47), `FLOCI_AZ_IMAGE` (ghcr.io/lex00/floci-az:7f079c2), `FLOCI_GCP_IMAGE` (ghcr.io/lex00/floci-gcp:641e6e8), read by example-three-cloud/scripts/emulators-up.sh |
| choudoufu-estate-floci-e2e.sh, streamed-drift-e2e.sh, and `behold demo choudoufu-estate` | `BEHOLD_CHOUDOUFU_FLOCI_CONTAINER` (behold-choudoufu-floci), `BEHOLD_CHOUDOUFU_FLOCI_PORT` (4650), `BEHOLD_CHOUDOUFU_FLOCI_IMAGE` (choudoufu's live/floci-image digest, pinned in example-choudoufu-estate/scripts/choudoufu-up.sh) |
| argo-estate-k3d-e2e.sh, flux-estate-k3d-e2e.sh | `BEHOLD_E2E_CLUSTER` (behold-argo-e2e, behold-flux-e2e) |
| every script that serves behold | `BEHOLD_E2E_PORT` (each script's own; see its head) |
| the logical-floci scripts | `AWS_ENDPOINT_URL`, `AZURE_ENDPOINT_URL`, `GCP_ENDPOINT_URL` (the shared emulator's 4566, 4577, 4588) |

`BEHOLD_CHOUDOUFU_FLOCI_PORT` also reaches behold's own choudoufu spawns:
demos.json's choudoufu-estate `spawnEnv` reads
`http://127.0.0.1:${BEHOLD_CHOUDOUFU_FLOCI_PORT:-4650}`, and behold expands
`${NAME}` and `${NAME:-default}` in spawnEnv values from the environment it
starts in (src/demos.ts `expandSpawnEnv`). The up script, the down script and
the endpoint therefore agree on one port.

A second three-cloud run beside the first:

```sh
FLOCI_CONTAINER=behold-me2-floci FLOCI_AZ_CONTAINER=behold-me2-floci-az FLOCI_GCP_CONTAINER=behold-me2-floci-gcp \
FLOCI_PORT=4761 FLOCI_AZ_PORT=4762 FLOCI_GCP_PORT=4763 BEHOLD_E2E_PORT=4791 \
  bash e2e/lib/safe-env.sh bash e2e/three-cloud-change-set-e2e.sh
```

## No real cloud in reach: e2e/lib/safe-env.sh

`bash e2e/lib/safe-env.sh <command>` runs the command with GCP
application-default credentials, AWS keys and profiles, and Azure client
secrets unset; CLOUDSDK_CONFIG, AZURE_CONFIG_DIR, AWS_CONFIG_FILE and
AWS_SHARED_CREDENTIALS_FILE pointed at empty scratch locations; a scratch
file:// PULUMI_BACKEND_URL (one the caller set to file:// is kept) and
PULUMI_SKIP_UPDATE_CHECK=true. The output is copied to a log
(`BEHOLD_SAFE_ENV_LOG`, default run.log in the scratch directory), and after
the run the log is scanned for a public cloud turning a request away:
UnrecognizedClientException, InvalidClientTokenId, invalid_grant, AADSTS,
CREDENTIALS_MISSING, or a 401 on a line naming a googleapis, amazonaws or
azure host. A hit prints the lines and exits 3, even when the script passed.
Treat it as a stop: something left the emulator.

Sourced (`. e2e/lib/safe-env.sh`), it clears the calling shell's environment
and defines `behold_e2e_scan_log <log>`; `bash e2e/lib/safe-env.sh --scan
<log>` scans a log written some other way.

e2e/run.sh exercises the live overlay against real AWS when it finds AWS
credentials. Under safe-env it finds none and takes its source-graph mode.

## TMPDIR

Leave TMPDIR at the default. A long TMPDIR (a deep scratch directory, for
example) breaks the provider plugin handshake in `choudoufu apply`.
safe-env.sh makes its
scratch under the default TMPDIR and does not change it. To keep a run's
files somewhere else, use the scripts' own knobs (`BEHOLD_E2E_WORK`,
`BEHOLD_E2E_TARGET`, `BEHOLD_SAFE_ENV_DIR`) rather than TMPDIR.

## Which chant the three-cloud scripts use

multi-engine-demo-e2e.sh and three-cloud-change-set-e2e.sh install the
example copy's own dependencies, which name chant 0.124.54 from npm, the
first release with member-outputs (chant#4455) and the pulumi lexicon
(chant#4453). A copy whose install lacks either fails; nothing is linked in
(behold#1005 dropped `BEHOLD_E2E_CHANT_LINK`).

## three-cloud-change-set needs floci 48c6e47

three-cloud-change-set-e2e.sh reads a CloudFormation change set for a new
stack from floci. Its default `FLOCI_IMAGE`, ghcr.io/lex00/floci:48c6e47
(from emulators-up.sh), answers DescribeChangeSet with the stack's changes.
choudoufu's pinned floci image (the digest choudoufu-up.sh uses) answers it
with no changes for a new stack, so the change set this script asserts on
comes back empty. Don't point `FLOCI_IMAGE` at choudoufu's image for this script.
