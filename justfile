# behold — live control plane on chant. `just` with no target lists everything.

default:
    @just --list

# Install behold's dependencies.
install:
    npm install

# Typecheck.
tsc:
    npm run tsc

# Unit tests.
test:
    npm test

# Build the CLI bundle (dist/cli.js).
build:
    npm run build

# tsc + tests + build — the fast local gate.
check: tsc test build

# Install the example project's chant + aws lexicon (behold shells the project's
# own chant, so this decides the chant version under test).
example-install:
    npm --prefix example install

# Serve a chant project read-only → http://localhost:4600. Defaults to the bundled
# example (run `just example-install` first). Source graph only — no creds needed.
serve project="example":
    npm run dev -- serve {{project}}

# Serve the example with the live drift overlay → queries CloudFormation, needs
# AWS credentials in the environment.
serve-live: example-install
    npm run dev -- serve example --env prod

# End-to-end: install the example's chant, build behold, serve it, assert the API.
# Auto-detects AWS creds — exercises /api/overlay when present, /api/graph when not.
e2e:
    bash e2e/run.sh
