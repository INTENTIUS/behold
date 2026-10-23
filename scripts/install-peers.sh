#!/usr/bin/env bash
# Install what behold's peer-gated tests need, so they run instead of skip
# (#465): choudoufu at behold's floor. chant's terraform lexicon and
# @cdktn/hcl2json used to be installed here too; since #909 they are behold
# dependencies and `npm ci` installs them, so this only checks they resolved.
# CI's `peers` job runs it, then the tests with BEHOLD_REQUIRE_PEERS=1, which
# turns a skip into a failure.
#
# choudoufu is a release binary, checked against the release's SHA256SUMS, put
# in $PEERS_DIR/bin; the script prints that directory for the caller's PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

PEERS_DIR="${PEERS_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/behold-peers.XXXXXX")}"
CHOUDOUFU_VERSION="${CHOUDOUFU_VERSION:-v0.16.0}"
node -e 'require.resolve("@intentius/chant-lexicon-terraform"); require.resolve("@cdktn/hcl2json")' \
  || { echo "✗ the terraform lexicon or @cdktn/hcl2json did not resolve: run npm ci first" >&2; exit 1; }

mkdir -p "$PEERS_DIR/bin"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"; case "$arch" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
asset="choudoufu_${CHOUDOUFU_VERSION}_${os}_${arch}.tar.gz"
base="https://github.com/INTENTIUS/choudoufu/releases/download/${CHOUDOUFU_VERSION}"
curl -fsSL -o "$PEERS_DIR/$asset" "$base/$asset"
curl -fsSL -o "$PEERS_DIR/SHA256SUMS" "$base/SHA256SUMS"
want="$(awk -v a="$asset" '$2 == a || $2 == "./" a { print $1 }' "$PEERS_DIR/SHA256SUMS")"
got="$( (command -v sha256sum >/dev/null && sha256sum "$PEERS_DIR/$asset" || shasum -a 256 "$PEERS_DIR/$asset") | cut -d' ' -f1)"
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "✗ $asset: checksum $got, SHA256SUMS says ${want:-nothing}" >&2; exit 1; }
tar -xzf "$PEERS_DIR/$asset" -C "$PEERS_DIR/bin" choudoufu
"$PEERS_DIR/bin/choudoufu" version -json >&2
echo "$PEERS_DIR/bin"
