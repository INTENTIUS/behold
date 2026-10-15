# behold for the demo host (#570), built from the behold checkout at
# BEHOLD_REF (the build context is the checkout's root). Until 2026-11-03 the
# ref is a branch; from then on it is the release tag, so the image is the
# released source. git is here because behold fetches chant/lifecycle from the
# view checkout's origin.
FROM node:22.23.3-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates

WORKDIR /app
# The whole tree first: npm ci runs the prepare script, which is the build.
COPY . .
RUN npm ci --no-audit --no-fund && test -x dist/cli.js
# Reading a Terraform estate needs chant's terraform lexicon, which behold
# doesn't install itself (it says so and names these): beside behold, so the
# view draws the demo's roots instead of the error.
RUN npm install --no-save --no-audit --no-fund @intentius/chant-lexicon-terraform@^0.124.0 @cdktn/hcl2json@^0.24.0

USER node
EXPOSE 4600
