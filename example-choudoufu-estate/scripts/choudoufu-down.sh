#!/usr/bin/env bash
# Tear down the choudoufu-estate demo: remove OUR floci container, by its name
# and no other (behold's scratch discipline, src/scratch.ts). The estate
# copies stay — they are yours to edit; the next choudoufu-up.sh re-applies.
set -euo pipefail
CONTAINER=behold-choudoufu-floci
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
echo "choudoufu-estate demo: ${CONTAINER} removed."
