# Maintainer notes for the action

The GitHub Marketplace lists the action from this repository
(INTENTIUS/behold#1063). Its metadata file is `action.yml` at the repository
root. Everything else it needs is under `action/`.

## Layout

The root `action.yml` is the only action metadata file in the repository. In a
composite step `$GITHUB_ACTION_PATH` is the repository root, so the steps run
`$GITHUB_ACTION_PATH/action/src/main.mjs`.

- `action/src/` holds the code the steps run.
- `action/README.md` is the action's own README.
- `action/gitlab/` and `action/forgejo/` hold the templates for the other forges.
- `action/test/` holds the tests, which behold's `npm test` runs.

`node scripts/action-tree.mjs` verifies this layout and runs in CI as "action
tree". It fails on a second metadata file outside `node_modules`, on a path the
action runs that does not exist, and on a missing name, description, branding
icon or colour. It also refuses a `uses: ./` line and an input that
`action/README.md` leaves unnamed. The README must hold the listing copy from
`plugins/listing.json`.

The Marketplace page shows the README at the repository root, which is
behold's own.

## Tests

`action/test/action.test.ts` builds a throwaway git repository and reads it
through the real Terraform reader. Every GitHub call is answered from
`action/test/fixtures`. A call with no recorded answer fails the test. Nothing reaches the network.
`action/test/forges.test.ts` does the same for GitLab merge request notes and
Forgejo comments.

## What GitHub requires

From the "Publishing actions in GitHub Marketplace" and "Metadata syntax for
GitHub Actions" pages, read on 2026-11-15:

- The repository is public and holds one `action.yml` at the root. Metadata
  files in subfolders are allowed but not listed.
- The `name` is unique on the Marketplace. It must not match a category or
  a reserved feature name, and no user or organization other than the
  publisher may carry it.
  A Marketplace search for "behold" returned no results on 2026-11-15, and the
  release form gives the final answer ("Everything looks good!").
- The `description` is present. The branding icon is a Feather v4.28.0 icon
  outside GitHub's excluded list, and the colour is one of the nine GitHub
  names.
- There is no tag format rule. Publishing is a checkbox on a GitHub release. It
  needs two-factor authentication and, once, the Marketplace Developer
  Agreement. No review follows.

## Steps for the maintainer

1. Cut a behold release as usual with `just release`. The first release with
   the root `action.yml` is `behold-v0.33.0`.
2. Make sure the tag has a GitHub release. `.github/workflows/release.yml`
   publishes to npm and the MCP Registry on a `behold-v*` tag and creates no
   GitHub release, so create one for the tag if it is missing.
3. On that release page choose Edit and tick "Publish this Action to the
   GitHub Marketplace". Choose Code review as the primary category and
   Reporting as the secondary one, then update the release.
4. Open the Marketplace page and check the name, icon and categories.

Workflows then use `INTENTIUS/behold@behold-v<version>`, or a commit sha for
a stricter pin.

## Live checks still open

The GitLab and Forgejo checks are tracked on INTENTIUS/behold#1064. Each needs
a real instance and a test project that holds a small Terraform layout.
Packaging `action/gitlab/behold.gitlab-ci.yml` as a CI/CD Catalog component
needs the repository on a GitLab instance.
