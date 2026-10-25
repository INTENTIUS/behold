#!/usr/bin/env bash
# Boot the three emulators the three-cloud demo runs on: floci (AWS),
# floci-az (Azure) and floci-gcp (GCP). `behold demo three-cloud` runs this as
# its setup, then serves the workspace with --local, which finds them running
# under chant's own container names and reuses them.
#
# chant's `chant emulator up` would boot its pinned images, without the Docker
# socket the emulators need to run the website's containers. So the images
# here are the builds that probe Route 53 health checks (lex00/floci#259) and
# serve Container Apps and Cloud Run from real containers, each given the
# socket, and floci-az is told to run Container Apps for real rather than mock
# them. A container that is already running is left as it is.
#
# floci-az also serves TLS, since the azure member is a choudoufu estate and
# azurerm reaches its metadata host over https (azure/main.tf). The
# certificate is the one choudoufu's scripts/floci-az-mac-cert.sh makes, from
# FLOCI_AZ_TLS_DIR (default ~/.config/choudoufu/floci-az-tls), when it is
# there: Go on macOS trusts only the keychain, so on a Mac run that script
# once and trust what it prints. Without one, floci-az makes its own CA,
# which scripts/front-door.ts adds to SSL_CERT_FILE on Linux. Plain http on
# the same port keeps answering. Then, when choudoufu (or CHOUDOUFU_BIN) is
# on PATH, `choudoufu init` fetches the estate's provider schemas, which
# behold reads the estate with.
#
# Names, ports and images can be overridden, so a second copy can run beside
# the first: FLOCI_CONTAINER, FLOCI_AZ_CONTAINER, FLOCI_GCP_CONTAINER,
# FLOCI_PORT, FLOCI_AZ_PORT, FLOCI_GCP_PORT, FLOCI_IMAGE, FLOCI_AZ_IMAGE,
# FLOCI_GCP_IMAGE.
set -euo pipefail

boot() {
  local name=$1 port=$2 inner=$3 image=$4 health=$5; shift 5
  if [ -n "$(docker ps -q -f "name=^${name}\$")" ]; then
    echo "three-cloud: ${name} already running"
  else
    docker rm -f "$name" >/dev/null 2>&1 || true
    echo "three-cloud: starting ${name} (${image}) on :${port}"
    docker run -d --name "$name" -p "${port}:${inner}" -v /var/run/docker.sock:/var/run/docker.sock "$@" "$image" >/dev/null
  fi
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:${port}${health}" >/dev/null 2>&1; then
      echo "three-cloud: ${name} ready on http://localhost:${port}"
      return 0
    fi
    sleep 2
  done
  echo "three-cloud: ${name} did not answer on :${port}${health} within two minutes" >&2
  return 1
}

boot "${FLOCI_CONTAINER:-chant-floci}" "${FLOCI_PORT:-4566}" 4566 \
  "${FLOCI_IMAGE:-ghcr.io/lex00/floci:48c6e47}" /_floci/health
TLS_DIR="${FLOCI_AZ_TLS_DIR:-$HOME/.config/choudoufu/floci-az-tls}"
TLS=(-e FLOCI_AZ_TLS_ENABLED=true)
if [ -s "$TLS_DIR/cert.pem" ] && [ -s "$TLS_DIR/key.pem" ]; then
  TLS+=(-v "$TLS_DIR/cert.pem:/etc/floci-az-tls/cert.pem:ro" -v "$TLS_DIR/key.pem:/etc/floci-az-tls/key.pem:ro"
    -e FLOCI_AZ_TLS_CERT_PATH=/etc/floci-az-tls/cert.pem -e FLOCI_AZ_TLS_KEY_PATH=/etc/floci-az-tls/key.pem)
elif [ "$(uname -s)" = "Darwin" ]; then
  echo "three-cloud: no floci-az certificate at $TLS_DIR/cert.pem, so choudoufu cannot reach floci-az from macOS: run choudoufu's scripts/floci-az-mac-cert.sh once and trust what it prints" >&2
fi
boot "${FLOCI_AZ_CONTAINER:-chant-floci-az}" "${FLOCI_AZ_PORT:-4577}" 4577 \
  "${FLOCI_AZ_IMAGE:-ghcr.io/lex00/floci-az:7f079c2}" /_floci/health \
  -e FLOCI_AZ_SERVICES_CONTAINER_APPS_MOCKED=false "${TLS[@]}"
boot "${FLOCI_GCP_CONTAINER:-chant-floci-gcp}" "${FLOCI_GCP_PORT:-4588}" 4588 \
  "${FLOCI_GCP_IMAGE:-ghcr.io/lex00/floci-gcp:641e6e8}" /_floci-gcp/health

CHOUDOUFU="${CHOUDOUFU_BIN:-choudoufu}"
if command -v "$CHOUDOUFU" >/dev/null 2>&1; then
  echo "three-cloud: choudoufu init in azure (provider schemas; downloads azurerm the first time)"
  (cd "$(dirname "$0")/../azure" && "$CHOUDOUFU" init -input=false -no-color >/dev/null)
else
  echo "three-cloud: ${CHOUDOUFU} is not on PATH (or set CHOUDOUFU_BIN), so the azure estate has no provider schemas and behold cannot read it" >&2
fi
