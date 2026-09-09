#!/usr/bin/env bash
# Stand up the choudoufu-estate demo (behold#372, M4 of #366): a scratch floci
# (the AWS emulator), provider schemas in each estate copy, and the terralith
# applied — one estate with three teams' worth of IAM and log groups in it,
# the shape the live-mv workbench splits. The team estates start empty: their
# declared resources are the monolith's, and the plan in monolith/carve.json
# says which move where.
#
# Scratch discipline (behold's src/scratch.ts): the container is named
# behold-*, this script refuses to adopt an existing one, and only
# choudoufu-down.sh removes it — by this name and no other. The port is not
# the shared emulator's (:4566); nothing here can reach a floci that another
# tool runs.
#
# `choudoufu init` runs here, in behold's OWN copy of the estates (the demo
# target), never in a served project: that is #366's decision, and this is
# the one place it holds.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=behold-choudoufu-floci
PORT=4650
# The image the live-mv workbench measures against (choudoufu's live/floci-image).
IMAGE="ghcr.io/lex00/floci@sha256:a39185cc3971d0188663d61043cb038dff1260d8a975b1aa72c4e2bb1feac3cb"

if ! docker info >/dev/null 2>&1; then
  echo "choudoufu-estate demo: Docker is not running — start Docker and re-run." >&2
  exit 1
fi
# behold#388: the same binary behold itself spawns — the Homebrew release is
# below the 0.16.0 floor, so a build from main is named by CHOUDOUFU_BIN and
# every script that runs choudoufu has to honour it or the demo's `init` and
# behold's own reads would be two different tools.
CHOUDOUFU="${CHOUDOUFU_BIN:-choudoufu}"
if ! command -v "$CHOUDOUFU" >/dev/null 2>&1; then
  echo "choudoufu-estate demo: ${CHOUDOUFU} is not on PATH — https://github.com/INTENTIUS/choudoufu (0.16.0 or newer), or set CHOUDOUFU_BIN." >&2
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "choudoufu-estate demo: container ${CONTAINER} already exists — a previous run didn't tear down. \`bash scripts/choudoufu-down.sh\` and re-run." >&2
  exit 1
fi
echo "→ floci on 127.0.0.1:${PORT} (${CONTAINER})"
docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:4566" "$IMAGE" >/dev/null
for _ in $(seq 1 40); do
  curl -fs -o /dev/null "http://127.0.0.1:${PORT}/" && break
  sleep 1
done

export AWS_ENDPOINT_URL="http://127.0.0.1:${PORT}"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

for estate in monolith team-a team-b team-c; do
  echo "→ choudoufu init in ${estate} (provider schemas — what makes the rungs real)"
  (cd "$estate" && "$CHOUDOUFU" init -input=false -no-color >/dev/null)
done

echo "→ choudoufu apply in monolith (the terralith: 21 resources, three teams in one estate)"
(cd monolith && "$CHOUDOUFU" apply -auto-approve -input=false -no-color | tail -1)

echo "choudoufu-estate demo: up. behold serves it next; the plan in monolith/carve.json moves team-a's resources out."
