# behold — live control plane on chant. `just` with no target lists everything.

default:
    @just --list

# Install behold's dependencies.
install:
    npm install

# Typecheck.
tsc:
    npm run tsc

# Typecheck against the chant floor package.json DECLARES, not the lockfile's
# resolution — the check that would have caught #108, and the ^0.32.0 floor that
# made #98/#100's resource rollup unreachable. Reinstalls chant; run `install`
# after to get the lockfile's version back.
tsc-floor:
    bash scripts/typecheck-floor.sh

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

# Serve a chant project read-only → http://localhost:4600. One server, one SPA.
# Pass an env for the live drift overlay (queries the cloud, needs creds); omit it
# for the source graph. Defaults to the bundled example (run `example-install` first).
#   just serve                 # source graph
#   just serve example prod    # live overlay
serve project="example" env="":
    npm run dev -- serve {{project}} {{ if env != "" { "--env " + env } else { "" } }}

# End-to-end: install the example's chant, build behold, serve it, assert the API.
# Auto-detects AWS creds — exercises /api/overlay when present, /api/graph when not.
e2e:
    bash e2e/run.sh

# End-to-end (#59, epic #54's definition of done): the unified component view
# (waves + live status + CI + resources) against a real project — loomster on
# Floci. Needs loomster checked out and its Floci already up (`just local-up`
# in loomster) — this never boots or installs loomster itself.
e2e-floci:
    bash e2e/component-view-floci-e2e.sh

# behold#100 (B·aws, chant epic #1198): the AWS lane's acceptance run — component
# status painted from the #98 resource rollup (not CFN stack status), the live
# overlay, and the nested architecture diagram, all against one running estate.
# Needs a deployed AWS project and its Floci already up; boots neither.
#   just e2e-aws-logical
#   BEHOLD_E2E_PROJECT=/path/to/example just e2e-aws-logical
e2e-aws-logical:
    bash e2e/aws-logical-floci-e2e.sh

# behold#126 (B·azure, chant epic #1200 / E slot chant#1214): the Azure lane's
# acceptance run. Same three assertions as e2e-aws-logical, against floci-az —
# but the rollup clause bites harder here: Azure has no deploy object, so the
# #98 rollup is the ONLY status source and nothing can mask a defect in it.
# Needs a deployed azure project and its floci-az already up; boots neither.
#   just e2e-azure-logical
#   BEHOLD_E2E_PROJECT=/path/to/example just e2e-azure-logical
e2e-azure-logical:
    bash e2e/azure-logical-floci-e2e.sh

# behold#126 (B·gcp, chant epic #1199 / E slot chant#1211): the GCP lane's
# acceptance run, against floci-gcp. Asserts the project/location diagram and,
# unlike the other two, asserts network containment is ABSENT — floci-gcp
# emulates no compute networking, so subnet boxes would stay empty (#101).
# Needs a deployed gcp project and its floci-gcp already up; boots neither.
# Note chant#1431: `chant emulator up --lexicon gcp` leaves GCP_ENDPOINT_URL
# unset, so the script exports it itself.
#   just e2e-gcp-logical
#   BEHOLD_E2E_PROJECT=/path/to/example just e2e-gcp-logical
e2e-gcp-logical:
    bash e2e/gcp-logical-floci-e2e.sh

# behold#148 (the CC join, chant epic #1198's "one graph" bar): the
# mixed-substrate acceptance run against chant's cc-aws-canonical on Floci.
# Asserts what the other three logical runs only print — the k8s half nests
# INSIDE the managed-cluster box (#142), one root, and the runtime tier is
# honest below the declaration boundary (#144). Needs the estate deployed and
# its Floci already up (chant test/aws-cc-e2e.sh steps 0-3 are the recipe;
# export the same AWS_ENDPOINT_URL + KUBECONFIG); boots neither.
#   just e2e-cc-logical
#   BEHOLD_E2E_PROJECT=/path/to/deployed/copy just e2e-cc-logical
e2e-cc-logical:
    bash e2e/cc-logical-floci-e2e.sh

# behold#146 (the helm lane): artifact presence + the logical release box,
# against a chart project on a k3d cluster. Installs (and uninstalls) the
# release itself; boots nothing else. Needs a chant ≥ #1516
# (observedArtifacts) and the project's declared kube context reachable.
#   BEHOLD_E2E_PROJECT=/path BEHOLD_E2E_CHART=./chart BEHOLD_E2E_RELEASE=name just e2e-helm-logical
e2e-helm-logical:
    bash e2e/helm-logical-k3d-e2e.sh

# behold#256 (the GitOps lane): the flux-estate demo driven headless against a
# REAL Flux — the estate lenses (#241) and the health verdicts (#238) asserted
# where the interesting states actually exist. Unlike every other e2e-* recipe
# this one BOOTS its substrate: a scratch k3d cluster named behold-flux-e2e,
# Flux from the pinned release manifest (no flux CLI), the control plane built
# by its own chant. One trap deletes the cluster on any exit, and it refuses to
# start if that name is already taken — no existing cluster is ever touched.
# Needs docker + k3d + kubectl and a reachable github.com (the estate's
# GitRepository is a real remote); SKIPs with exit 0 if any is missing.
#   just e2e-flux-estate
e2e-flux-estate:
    bash e2e/flux-estate-k3d-e2e.sh

# behold#269 (the GitOps lane, Argo half): the argo-estate demo driven headless
# against a REAL Argo CD — the Argo joins (#222/#235), the estate lenses (#241)
# and #238's health/sync mapping asserted in front of an application controller
# instead of fixtures. Boots its own substrate: a scratch k3d cluster named
# behold-argo-e2e, Argo from the pinned core-install manifest (the reconciler
# only — no argocd CLI, no UI), the control plane built by its own chant. One
# trap deletes the cluster on any exit, and it refuses to start if that name is
# already taken — no existing cluster is ever touched. Needs docker + k3d +
# kubectl and a reachable github.com (both Applications sync a real remote);
# SKIPs with exit 0 if any is missing.
#   just e2e-argo-estate
e2e-argo-estate:
    bash e2e/argo-estate-k3d-e2e.sh
