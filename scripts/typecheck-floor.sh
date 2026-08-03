#!/usr/bin/env bash
#
# Typecheck against the chant version behold DECLARES, not the one the lockfile
# happens to resolve.
#
# Why this exists (behold#108, and the same bug again at the 0.32/0.34 boundary):
# CI runs `npm ci`, which honours `package-lock.json`. So the declared range in
# `package.json` is never exercised, and a floor that is lower than the source
# actually needs stays green forever. #108 was that bug — `^0.18.32` declared,
# 0.32 required, invisible until someone ran `npm install` instead of `npm ci`.
#
# It recurred in the other direction and cost more. The floor sat at `^0.32.0`
# while `ComponentStatusRow.resources` (behold#98, chant#1300) lands in 0.34. A
# caret on a 0.x pins the minor, so `^0.32.0` resolves `>=0.32.0 <0.33.0` and the
# field could never arrive. The rollup tier of `componentStatusColor` was
# unreachable code, and #98/#100 — both closed as shipped — did nothing on the
# substrates they were written for. Nothing failed; the palette just quietly fell
# through to the tier below.
#
# Installing the exact floor and typechecking against it makes both directions
# loud: source that needs more than the floor declares fails here, and a type
# behold references that the floor cannot supply fails here too.
set -euo pipefail

cd "$(dirname "$0")/.."

# `^0.38.0` -> `0.38.0`. The floor of a caret range is its literal version, which
# is the whole point: it is the oldest chant a consumer's `npm install` may pick.
floor="$(node -p "require('./package.json').dependencies['@intentius/chant'].replace(/^[^0-9]*/, '')")"

echo "declared chant floor: $floor"
npm install --no-save --no-audit --no-fund "@intentius/chant@$floor"

echo "installed: $(node -p "require('./node_modules/@intentius/chant/package.json').version")"
npm run tsc
