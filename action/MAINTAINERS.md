# Maintainer notes for the action

This file stays in behold. `scripts/action-tree.mjs` builds the tree that the
`behold-action` repository holds and leaves this file, `test/` and anything
else out of it (INTENTIUS/behold#1063).

## Tests (they stay in behold)

`action/test/action.test.ts` runs under the repository's vitest. It builds a
throwaway git repository, reads it through the real Terraform reader, and
answers every GitHub call from `action/test/fixtures` (bodies shaped after the
REST documentation: comment lists with a `Link` header, create, edit, a 403,
a pull request, event payloads). A call with no recorded answer fails the
test, so nothing reaches the network and nothing is posted to a real pull
request. `action/test/forges.test.ts` does the same for GitLab (`gitlab-*`
fixtures, merge request notes, CI variables) and Forgejo (`forgejo-*`
fixtures, Gitea-shaped comments and event payloads).

The tests import `../../src/graph-package.ts` and `../../src/terraform-member.ts`
from behold, so they cannot run from the `behold-action` repository, which holds
none of behold's source. They are part of behold's `npm test`.

## What `behold-action` holds

`node scripts/action-tree.mjs <empty dir>` writes it, and `--check` (run in
CI as "action tree" in `.github/workflows/ci.yml`) builds it in a temporary
directory and fails when it is incomplete or reaches outside `action/`:

- `action.yml` at the root, the only metadata file
- `README.md`, shown on the Marketplace page
- `LICENSE` (copied from the behold repository root)
- `src/`, `gitlab/` and `forgejo/`

The script applies a short list of path rewrites, each of which must match
the number of times it names, so a drift in the source fails the build. They
turn `INTENTIUS/behold/<sha>/action/gitlab/...` into
`INTENTIUS/behold-action/<sha>/gitlab/...` and `<clone>/action/src/main.mjs`
into `<clone>/src/main.mjs`, because the action sits at the root there.

Without the script, the same tree comes from
`git subtree split --prefix=action -b behold-action-split` followed by
deleting `test/` and `MAINTAINERS.md` and adding `LICENSE`; that keeps history
but not the path rewrites, so prefer the script.

## Marketplace requirements checked

From GitHub's "Publishing actions in GitHub Marketplace" and "Metadata syntax
for GitHub Actions" pages (read 2026-11-15):

- the repository is public and holds one `action.yml` or `action.yaml` at the
  root; metadata files in subfolders are not listed
- `name` is unique among Marketplace actions and does not match a Marketplace
  category, a reserved GitHub feature name, or a user or organization name
  other than the publisher's. The script cannot check this: GitHub's release
  form reports it ("Everything looks good!")
- `description` is present; `branding.icon` is a Feather v4.28.0 icon outside
  the excluded list; `branding.color` is one of white, black, yellow, blue,
  green, orange, red, purple, gray-dark. The check covers the color and the
  excluded icon names
- publishing needs two-factor authentication and the owner's acceptance of the
  GitHub Marketplace Developer Agreement; a release with a tag, a primary
  category and an optional secondary one; no review follows
- GitHub states no README rules. The check requires the listing copy from
  `plugins/listing.json` (#1054) verbatim (the `short` line, the `paragraph`
  and the `command`), and every input and output of `action.yml` named

## Steps for the maintainer, in order

1. Publish `@intentius/behold` to npm. The action runs
   `npm install @intentius/behold@<behold-version>` on every run and the
   default is `latest`, so nothing works before this.
2. Choose the name. `name` in `action.yml` is "behold changed cut". Search the
   Marketplace for it and check that no user or organization is called that.
   If it is taken, change `name` in `action/action.yml` and apply the same
   change here; re-run `node scripts/action-tree.mjs --check`.
3. Create the public repository `INTENTIUS/behold-action` (the second of the
   epic's two new repositories). Enable two-factor authentication on the
   publishing account and accept the Marketplace Developer Agreement as an
   owner of the organization.
4. From a behold checkout at the commit to publish, run
   `node scripts/action-tree.mjs /path/to/empty-dir`, copy that directory into
   a clone of `behold-action`, commit it and push to its default branch.
5. Take a screenshot of a real comment from step 6 and add it to the
   README's "What the comment holds" section in `action/README.md` here (so the
   source stays the one place), then repeat step 4. The README has no image
   yet, because none exists before a real run.
6. In a separate public test repository, add the minimal workflow with
   `uses: INTENTIUS/behold-action@<commit sha>` and open a pull request that
   changes two resources; push again and check the comment is edited; open a
   fork pull request and run the two workflows of the fork recipe. Record the
   results on INTENTIUS/behold#1063.
7. Open `action.yml` on the repository page, choose Draft a release, tick
   "Publish this Action to the GitHub Marketplace", clear any message until it
   reads "Everything looks good!", pick Code review as the primary category
   and Reporting as the secondary, tag `v1.0.0`, title it, and publish with
   two-factor authentication.
8. Move the major tag: `git tag -f v1 v1.0.0 && git push -f origin v1`, on
   each later release. The README's workflows use `@v1`.
9. Check the Marketplace page loads with the name, icon and categories.
10. Transfer the `surface:action` issues from behold to `behold-action`.

## Still waiting on live checks (from INTENTIUS/behold#1064)

- GitLab test project (#1064). On a GitLab instance or gitlab.com: create a
  project holding a copy of `action/test`'s two-commit Terraform layout (any
  `.tf` files); create a project access token (`api`, Reporter) and store it as
  `BEHOLD_GITLAB_TOKEN`; commit the include above with a real `BEHOLD_ACTION_REF`;
  open a merge request that changes two resources and check one note with a
  rendered block and the widget link; push again and check the note is edited,
  not added; open a second merge request that changes 55 or more resources and
  check the table, the SVG link and no block shown as text; with a second
  account, fork the project, open a merge request from the fork and check that
  the job posts nothing. Record on the issue whether `CI_JOB_TOKEN` can create a
  note (`POST` with `JOB-TOKEN`), whether `expose_as` accepts the folder, the
  rendered Mermaid limit actually applied, and that
  `.../artifacts/file/behold-changed/changed.svg` opens.
- Forgejo test instance (#1064). On a Forgejo 17 instance with a runner (label
  `docker`): create a repository, copy `forgejo/behold.yml` to
  `.forgejo/workflows/`, and put a copy of the `action/` folder where its
  `uses` line points; open a pull request that changes two resources and check
  the summary, one comment, and the artifact on the run page; push again and
  check the comment is edited; check which of `FORGEJO_API_URL`,
  `FORGEJO_RUN_NUMBER` and `FORGEJO_STEP_SUMMARY` the runner really sets; check
  the Actions token may comment (repository Actions settings, default token
  permissions); open a pull request from a fork and check no comment and no
  error; record the Mermaid block size the instance renders so the `forgejo`
  row of `FORGE_BUDGETS` can be confirmed.
- packaging `gitlab/behold.gitlab-ci.yml` as a CI/CD Catalog component, which
  needs the repository on a GitLab instance
