# The loop driver's machine (#570): what terragucci's stack/demo.sh and
# stack/bootstrap.sh call on a laptop. node for npx tsx and the terragucci and
# chant CLIs in the checkout's node_modules; the Docker CLI with its compose
# and buildx plugins for the stack and the CI images (scripts/images.ts runs
# `docker buildx build`); git, curl, jq, ssh-keygen and python3 for the
# scripts themselves. The terragucci checkout is mounted, not copied, so the
# image does not change when TERRAGUCCI_REF does.
FROM docker:29.8.1-cli AS docker

FROM node:22.23.3-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git curl jq openssh-client python3 ca-certificates procps

COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

# Commits the scripts make carry a name; stack/lib.sh sets its own where it
# cares.
RUN git config --system user.name "demo driver" \
  && git config --system user.email "driver@demo.invalid"
