# Written by chant from deploy/demo-host/chant/src/docker/images.ts (beholdImage): edit that and run
# `npm run build:docker` there. `npm run check:docker` fails when this file
# is not what the build makes.
FROM node:22.23.3-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && test -x dist/cli.js
RUN npm install --no-save --no-audit --no-fund @intentius/chant-lexicon-terraform@^0.124.0 @cdktn/hcl2json@^0.24.0
USER node
EXPOSE 4600
