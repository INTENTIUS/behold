# behold — live control plane on chant. `just` with no target lists everything.

default:
    @just --list

# Install dependencies.
install:
    npm install

# Typecheck.
tsc:
    npm run tsc

# Tests.
test:
    npm test

# Build the CLI bundle.
build:
    npm run build

# tsc + tests + build.
check: tsc test build

# Serve a chant project read-only → http://localhost:4600
serve project="../chant/examples/gitlab-aws-alb-infra":
    npm run dev -- serve {{project}}
