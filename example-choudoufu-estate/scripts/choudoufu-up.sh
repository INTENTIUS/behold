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

# behold#415: the adoptable card's subject. team-a declares `aws_vpc.main` at
# 10.77.0.0/16 and nothing applies that estate, so it has no marker and no
# identity a configuration can reconstruct — EC2 assigns the `vpc-…` id. That
# makes it NEEDS_DISCOVERY, and `aws_vpc` is in choudoufu's content-match table
# keyed on `cidr_block`, so the estate-wide sweep can match it to a live VPC
# carrying the same cidr and no marker.
#
# Created out of band on purpose: a VPC choudoufu applied would wear the estate
# markers and read `bound`, which is the opposite of what this demonstrates.
# `aws` is not a requirement of this demo, so a machine without it gets the
# whole estate minus one card and is told which one.
if command -v aws >/dev/null 2>&1; then
  echo "→ seeding an unmarked VPC at 10.77.0.0/16 (the adoptable card — behold#415)"
  AWS_ENDPOINT_URL="http://127.0.0.1:${PORT}" AWS_ACCESS_KEY_ID=test \
  AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
    aws ec2 create-vpc --cidr-block 10.77.0.0/16 --query 'Vpc.VpcId' --output text >/dev/null 2>&1 \
    || echo "  (floci refused the create — the adoptable card will not appear)"
else
  echo "→ no 'aws' on PATH, so the adoptable card is skipped; everything else stands up"
fi

echo "choudoufu-estate demo: up. behold serves it next; the plan in monolith/carve.json moves team-a's resources out."
