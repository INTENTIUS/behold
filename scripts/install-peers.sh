#!/usr/bin/env bash
# Install what behold's optional-peer tests need, so they run instead of skip
# (#465): chant's terraform lexicon and @cdktn/hcl2json at the versions behold
# declares as peers, and choudoufu at behold's floor. CI's `peers` job runs it,
# then the tests with BEHOLD_REQUIRE_PEERS=1, which turns a skip into a failure.
#
# The peers go into a directory of their own and are linked into node_modules:
# npm will not install a root project's own optional peers with --no-save.
# choudoufu is a release binary, checked against the release's SHA256SUMS, put
# in $PEERS_DIR/bin; the script prints that directory for the caller's PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

PEERS_DIR="${PEERS_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/behold-peers.XXXXXX")}"
CHOUDOUFU_VERSION="${CHOUDOUFU_VERSION:-v0.16.0}"
peer() { node -p "require('./package.json').peerDependencies['$1'].replace(/^[\\^~]/, '')"; }
LEXICON="$(peer @intentius/chant-lexicon-terraform)"
PARSER="$(peer @cdktn/hcl2json)"
# The lexicon loads chant from beside itself, as it would beside behold in a
# user's install: the chant behold's lockfile installed.
CHANT="$(node -p "require('./node_modules/@intentius/chant/package.json').version")"

mkdir -p "$PEERS_DIR/bin"
echo '{"name":"behold-peers","private":true}' > "$PEERS_DIR/package.json"
npm install --prefix "$PEERS_DIR" --no-audit --no-fund --legacy-peer-deps \
  "@intentius/chant@$CHANT" "@intentius/chant-lexicon-terraform@$LEXICON" "@cdktn/hcl2json@$PARSER" >&2
mkdir -p node_modules/@intentius node_modules/@cdktn
ln -sfn "$PEERS_DIR/node_modules/@intentius/chant-lexicon-terraform" node_modules/@intentius/chant-lexicon-terraform
ln -sfn "$PEERS_DIR/node_modules/@cdktn/hcl2json" node_modules/@cdktn/hcl2json

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
