# example-ci — the executor contract's fixture

Two components (`web`, and `api` depending on it) with no cloud behind them,
plus a `.behold.json` designating that `prod` deploys through GitHub Actions:
the committed workflow `.github/workflows/behold-e2e-dispatch.yml` at this
repository's root, named `chant-components-prod` the way chant 0.54 names a
generated pipeline. `gated` deploys through `behold-e2e-gated.yml`, whose job is bound to the
`behold-e2e-gated` environment with a required reviewer — the run stops at
`waiting` until someone approves on GitHub, which behold shows as a link and
never as a button. `staging` is deliberately undesignated.

`just e2e-ci-github` serves this project and drives the contract against the
real forge through your own `gh` login (see e2e/ci-executor-github-e2e.sh).
Nothing here applies anything: the workflow's jobs sleep, and behold's guards
refuse every local apply for `prod`.
