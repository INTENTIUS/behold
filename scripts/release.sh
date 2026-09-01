#!/usr/bin/env bash
# behold's release — the half that happens AFTER the version-bump PR merged.
#
# The whole sequence is: bump package.json on a branch → PR → every ci check
# green → merge → THIS script on main → release.yml publishes over OIDC → npm
# shows the version. This script owns the tag-and-verify half and refuses in
# every state where a tag push would do the wrong thing:
#
#   - off main, a dirty tree, or a HEAD that is not origin/main
#   - the tag already on origin: a behold-v* push RE-FIRES release.yml, so a
#     tag is pushed exactly once, ever (release.yml's skip-if-published guard
#     makes a re-run harmless, but the point is not to need it)
#   - the tag existing only locally: something else made it — look before
#     you push
#   - the version already on npm: bump instead
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="$(node -p 'require("./package.json").name')"
V="$(node -p 'require("./package.json").version')"
TAG="behold-v${V}"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || { echo "✗ on ${branch} — releases tag main only" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "✗ working tree is not clean" >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "✗ HEAD is not origin/main — pull (or push) first" >&2; exit 1; }

if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "✗ ${TAG} is already on origin — a tag is pushed once; bump the version instead" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "✗ ${TAG} exists locally but not on origin — inspect it (git show ${TAG}) before deciding; this script never pushes a tag it did not make" >&2
  exit 1
fi
P="$(npm view "${NAME}" version 2>/dev/null || echo none)"
[ "$P" != "$V" ] || { echo "✗ ${NAME}@${V} is already on npm — bump the version" >&2; exit 1; }

git tag -a "${TAG}" -m "${NAME} ${V}"
git push origin "${TAG}"
echo "pushed ${TAG} — release.yml is publishing (gh run list --workflow release.yml)"

for _ in $(seq 1 60); do
  sleep 10
  if [ "$(npm view "${NAME}@${V}" version 2>/dev/null || true)" = "$V" ]; then
    echo "✓ ${NAME}@${V} is on npm"
    exit 0
  fi
done
echo "✗ ${NAME}@${V} not on npm after 10 minutes — check the release run: gh run list --workflow release.yml" >&2
exit 1
