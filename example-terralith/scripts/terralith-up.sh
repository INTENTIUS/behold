#!/usr/bin/env bash
# Phase 1 of `behold demo terralith`: a stock terralith.
#
# A scratch floci (the AWS emulator) on 127.0.0.1:4652, a state bucket in it,
# and one Terraform root applied the stock way: 23 resources (a network and
# three teams' IAM and log groups) in one state file on S3. No markers yet.
#
# Scratch discipline: the container is named behold-terralith-floci (or
# TERRALITH_CONTAINER), this script refuses to adopt one that already exists,
# and only terralith-down.sh stops it. The port is not the shared emulator's
# (:4566), so nothing here reaches a floci another tool runs.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh

docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker and re-run."
need_choudoufu

if [ -f snapshots/1-stock/phase.json ]; then
  say "phase 1 is already up (snapshots/1-stock). terralith-down.sh stops the emulator; a fresh copy starts over."
  exit 0
fi
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  die "container ${CONTAINER} already exists from an earlier run. Run scripts/terralith-down.sh, or set TERRALITH_CONTAINER to a new name."
fi

say "floci on 127.0.0.1:${PORT} (${CONTAINER})"
docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:4566" "$IMAGE" >/dev/null
for _ in $(seq 1 40); do
  curl -fs -o /dev/null "http://127.0.0.1:${PORT}/" && break
  sleep 1
done

say "state bucket s3://${BUCKET}, versioned"
curl -fs -o /dev/null -X PUT "http://127.0.0.1:${PORT}/${BUCKET}"
curl -fs -o /dev/null -X PUT "http://127.0.0.1:${PORT}/${BUCKET}?versioning" -H 'content-type: application/xml' \
  -d '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>'

say "choudoufu init in terralith (an OpenTofu fork; with no live block it runs stock)"
init_root terralith -backend-config=use_path_style=true

say "apply: the terralith, 23 resources in one state file"
(cd terralith && "$CHOUDOUFU" apply -auto-approve -input=false -no-color | tail -1)

say "snapshot: phase 1"
mkdir -p snapshots/1-stock
snap snapshots/1-stock terralith
finish snapshots/1-stock stock 1 terralith

say "phase 1 is up. Next: bash scripts/terralith-step.sh adopt"
