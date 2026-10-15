import { Dockerfile } from "@intentius/chant-lexicon-docker";

/**
 * behold for the demo host (#570), built from the behold checkout at
 * BEHOLD_REF (the build context is the checkout's root). Until 2026-11-03 the
 * ref is a branch; from then on it is the release tag, so the image is the
 * released source. git is here because behold fetches chant/lifecycle from
 * the view checkout's origin. Written to ../behold.Dockerfile.
 */
export const beholdImage = new Dockerfile({
  from: "node:22.23.3-bookworm-slim",
  steps: [
    { run: "apt-get update \\\n  && apt-get install -y --no-install-recommends git ca-certificates" },
    { workdir: "/app" },
    // The whole tree first: npm ci runs the prepare script, which is the build.
    { copy: ". ." },
    { run: "npm ci --no-audit --no-fund && test -x dist/cli.js" },
    // Reading a Terraform estate needs chant's terraform lexicon, which behold
    // doesn't install itself (it says so and names these): beside behold, so
    // the view draws the demo's roots instead of the error.
    { run: "npm install --no-save --no-audit --no-fund @intentius/chant-lexicon-terraform@^0.124.0 @cdktn/hcl2json@^0.24.0" },
    { user: "node" },
    { expose: 4600 },
  ],
});

/**
 * The loop driver's machine (#570): what terragucci's stack/demo.sh and
 * stack/bootstrap.sh call on a laptop. node for npx tsx and the terragucci and
 * chant CLIs in the checkout's node_modules; the Docker CLI with its compose
 * and buildx plugins for the stack and the CI images (scripts/images.ts runs
 * `docker buildx build`); git, curl, jq, ssh-keygen and python3 for the
 * scripts themselves. The terragucci checkout is mounted, not copied, so the
 * image does not change when TERRAGUCCI_REF does. Written to
 * ../driver.Dockerfile.
 */
export const driverImage = new Dockerfile({
  stages: [
    { from: "docker:29.8.1-cli", as: "docker", steps: [] },
    {
      from: "node:22.23.3-bookworm-slim",
      steps: [
        {
          run: "apt-get update \\\n  && apt-get install -y --no-install-recommends \\\n    git curl jq openssh-client python3 ca-certificates procps",
        },
        { copy: "--from=docker /usr/local/bin/docker /usr/local/bin/docker" },
        { copy: "--from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/" },
        // Commits the scripts make carry a name; stack/lib.sh sets its own
        // where it cares.
        { run: "git config --system user.name \"demo driver\" \\\n  && git config --system user.email \"driver@demo.invalid\"" },
      ],
    },
  ],
});
