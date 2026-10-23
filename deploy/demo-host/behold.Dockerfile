# Written by chant from deploy/demo-host/chant/src/docker/images.ts (beholdImage): edit that and run
# `npm run build:docker` there. `npm run check:docker` fails when this file
# is not what the build makes.
FROM node:22.23.3-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && test -x dist/cli.js
RUN mkdir /opt/lexicon && cd /opt/lexicon && npm init -y >/dev/null && npm install --no-audit --no-fund @intentius/chant-lexicon-aws@^0.124.0 && cp -Rn /opt/lexicon/node_modules/. /app/node_modules/ && test -d /app/node_modules/@intentius/chant-lexicon-terraform && test -d /app/node_modules/@intentius/chant-lexicon-aws && test -d /app/node_modules/@cdktn/hcl2json
USER node
EXPOSE 4600
