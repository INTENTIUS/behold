# Written by chant from deploy/demo-host/chant/src/docker/images.ts (driverImage): edit that and run
# `npm run build:docker` there. `npm run check:docker` fails when this file
# is not what the build makes.
FROM docker:29.8.1-cli AS docker
FROM node:22.23.3-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git curl jq openssh-client python3 ca-certificates procps
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
RUN git config --system user.name "demo driver" \
  && git config --system user.email "driver@demo.invalid"
