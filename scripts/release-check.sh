#!/usr/bin/env bash
# The checks `chant release cut` runs before it records a release of
# @intentius/behold (release.check in release/behold/chant.config.ts, a member
# of behold's release train). The cut has already built, so the tarball is what
# the publish job will upload.
set -euo pipefail
cd "$(dirname "$0")/.."

# The cut has stamped the label into package.json and server.json
# (release.version). A file the stamp missed would publish a package, or an MCP
# Registry entry, that names another version.
label="${CHANT_RELEASE_LABEL:?CHANT_RELEASE_LABEL is not set}"
pkg="$(node -p 'require("./package.json").version')"
server="$(node -p 'require("./server.json").version')"
if [ "$pkg" != "$label" ] || [ "$server" != "$label" ]; then
  echo "label ${label} does not match package.json ${pkg} and server.json ${server}: check release.version in release/behold/chant.config.ts" >&2
  exit 1
fi

# What ships, before it ships. `files` is bin + dist + web, and web is the SPA:
# a tarball missing it publishes a server with no UI. A real tarball listed
# with tar, not `npm pack --dry-run --json`, whose `files` field depends on the
# npm version (#172). A dry-run cut builds nothing, so build here when the cut
# did not.
[ -f dist/cli.js ] || npm run build >&2
dir="$(mktemp -d)"
tarball="$(npm pack --silent --ignore-scripts --pack-destination "$dir" | tail -1)"
tar -tzf "$dir/$tarball" | sed 's|^package/||' > "$dir/files"
missing=""
for want in bin/behold.js dist/cli.js web/index.html web/app.js; do
  grep -qxF "$want" "$dir/files" || missing="$missing $want"
done
if [ -n "$missing" ]; then
  echo "tarball is missing:$missing" >&2
  exit 1
fi
echo "tarball: $(wc -l < "$dir/files" | tr -d ' ') files, all four checked present" >&2
