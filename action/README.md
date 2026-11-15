# behold changed cut (GitHub Action, with GitLab and Forgejo variants)

The sections below are the GitHub Action. "GitLab" and "Forgejo" further down
cover the same picture on those forges (INTENTIUS/behold#1064).

On each pull request this action draws the resources the pull request changed,
and their neighbours, as Mermaid in the job summary and in one comment that it
edits on every push. The SVG and the JSON are uploaded as artifacts. It reads
files out of git, so it works on a repository that has never used chant, next
to whatever plan tooling the repository already runs.

This folder is built inside the behold repository (INTENTIUS/behold#1062) and
moves to a `behold-action` repository when a maintainer creates it. See
"What moves" at the end.

## Use

```yaml
name: behold
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  draw:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: INTENTIUS/behold-action@v1   # until the repository exists: INTENTIUS/behold/action@<sha>
```

The action reads `<base sha>..<head sha>` from the pull request event with
`behold graph --changed`, at detail 3 so an edited attribute shows. Each push
edits the comment that carries the hidden marker `<!-- behold:changed -->`, so
the pull request keeps one behold comment. When the cut is over the node
budget (60 cards by default) the neighbours fold, and past that the comment is
a per-root table of counts. A comment is kept under 60,000 characters,
GitHub's reported limit being 65,536 (e2e/forge-limits/README.md; those
figures are provisional until the live check on #1065 is recorded).

The run's job summary holds the same diagram or table, the count line (for
example "4 changed, 9 neighbours, in 2 roots") and links to the artifacts.

Inputs are listed in `action.yml`. Outputs: `changed-count`, `comment-url`,
`comment-action`, `svg-artifact-url`, `json-artifact-url` and `out-dir`.

An SVG the painter refuses (it stops at 400 flat cards) and a directory
behold cannot read both count as a failed read: the step fails after writing
the reason to the summary. Set `fail-on-error: false` to report and continue.

## Pull requests from forks

On a fork's `pull_request` run `GITHUB_TOKEN` is read-only and no secrets are
passed, so the first workflow cannot comment. The action notices the fork,
makes no API call, still writes the job summary and uploads the artifacts, and
hands the finished comment to a second workflow that runs from the default
branch.

First workflow, on `pull_request`:

```yaml
name: behold
on: pull_request
permissions:
  contents: read
jobs:
  draw:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: INTENTIUS/behold-action@v1
        with:
          handoff: "true"
```

Second workflow, on `workflow_run` of the first (the file must be on the
default branch):

```yaml
name: behold comment
on:
  workflow_run:
    workflows: [behold]
    types: [completed]
permissions:
  pull-requests: write
  actions: read
jobs:
  comment:
    if: github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v7
        with:
          name: behold-changed-comment
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ github.token }}
          path: handoff
      - uses: INTENTIUS/behold-action@v1
        with:
          mode: post-comment
          handoff-dir: handoff
```

Why the second workflow is safe. It has a write token, so it never checks out
or runs anything from the pull request. The first workflow reads the head
commit's files through `git archive` and parses them: a Terraform file is read
as text, nothing in it is executed, and no install script of the repository
runs. What crosses between the two is data, `comment.md` and `pr.json`, and
the second workflow checks it before posting. The pull request number must be
an integer, the pull request's current head sha must be the commit the first
run read (a stale run is refused), `comment.md` must start with the marker and
stay under 60,000 characters. All it can do with them is write or edit one
marker comment on that one pull request. It does not read a fork's
`GITHUB_TOKEN` or secrets, since the first workflow has none.

The behold install in the first workflow runs `npm install` of
`@intentius/behold-graph` from the registry, not from the pull request.

## GitLab

GitLab has no action marketplace, so the same code runs from a CI template,
`gitlab/behold.gitlab-ci.yml`. A merge request pipeline runs
`src/main.mjs read` and `report` in a `node:24` job, writes the same SVG, JSON
and comment text, and keeps one note per marker: it lists the merge request's
notes, skips system notes, edits the one that carries `<!-- behold:changed -->`
and otherwise creates it (`src/gitlab.mjs`). Packaging the template as a CI/CD
Catalog component is not done; see "Waiting on the maintainer".

Setup:

1. Create a project access token (Settings, Access tokens) with the `api`
   scope and the Reporter role. `CI_JOB_TOKEN` is not used: whether it may
   create notes is not documented.
2. Store it as a CI/CD variable `BEHOLD_GITLAB_TOKEN`, masked, not protected
   (a protected variable is withheld from pipelines of unprotected branches).
3. Include the template pinned to a commit and give the same commit as
   `BEHOLD_ACTION_REF`; the job fetches the action's source at that commit.

```yaml
include:
  - remote: https://raw.githubusercontent.com/INTENTIUS/behold/<sha>/action/gitlab/behold.gitlab-ci.yml
variables:
  BEHOLD_ACTION_REF: <sha>
```

GitLab refuses a Mermaid block over 2,000 characters, and a page whose blocks
total more, and shows the source as text behind a Display button. The note
therefore uses the `gitlab` row of `FORGE_BUDGETS`: one block that fits, else
the count line, the per-root table and a link to the SVG in the job's
artifacts (`<job url>/artifacts/file/behold-changed/changed.svg`). The same
cut is one diagram on GitHub. A cut that folds to a table has no SVG to link.
The job log carries the text a job summary would, since GitLab has no summary
page, and `artifacts:expose_as` lists the artifact folder in the merge request
widget.

A merge request from a fork. GitLab runs it in the fork's project by default,
where this template's variables do not exist and the job does not start. When
a project runs fork pipelines in the parent project, the source project id
differs from the target's; the job then makes no API call, writes the log and
artifacts, and posts no note. There is no second job that posts for it, so a
fork's merge request gets no note until a maintainer runs the job on a branch
of the project.

## Forgejo

Forgejo Actions runs the GitHub Action as it is, through `forge: forgejo`
(auto-detected from `FORGEJO_ACTIONS`). The comment goes to
`/api/v1/repos/<owner>/<repo>/issues/<n>/comments` with the `token` scheme,
paged 50 at a time (`src/forgejo.mjs`), and the job summary is written to
`FORGEJO_STEP_SUMMARY` or `GITHUB_STEP_SUMMARY`, whichever the runner gives.
`forgejo/behold.yml` is the workflow to copy. It sets `upload: "false"` and
uploads `out-dir` with `forgejo/upload-artifact` (the v4 build that does not
refuse a Forgejo server), because `actions/upload-artifact` and its
`archive: false` are not available there; artifacts are zipped and are listed
on the run page.

The `forgejo` row of `FORGE_BUDGETS` is the provisional 20,000 characters and
250 edges until the live check (#1065) records what a Forgejo instance
renders. Gitea's default `MERMAID_MAX_SOURCE_CHARACTERS` is 50,000; Forgejo's
is not documented.

A fork's pull request. Forgejo gives it a read-only token and no secrets, so
the job writes the summary and uploads the artifacts and makes no API call.
Forgejo has no `workflow_run` event, so there is no second workflow to post
the comment, and `mode: post-comment` refuses to run there. Posting for forks
would need `pull_request_target`, which runs with a write token; that is a
separate design and is not built here.

## Tests

`action/test/action.test.ts` runs under the repository's vitest. It builds a
throwaway git repository, reads it through the real Terraform reader, and
answers every GitHub call from `action/test/fixtures` (bodies shaped after the
REST documentation: comment lists with a `Link` header, create, edit, a 403,
a pull request, event payloads). A call with no recorded answer fails the
test, so nothing reaches the network and nothing is posted to a real pull
request. `action/test/forges.test.ts` does the same for GitLab (`gitlab-*`
fixtures, merge request notes, CI variables) and Forgejo (`forgejo-*`
fixtures, Gitea-shaped comments and event payloads).

## What moves

When `behold-action` exists, move the whole `action/` folder to its root:

- `action.yml`, `src/`, `gitlab/`, `forgejo/` and `README.md`
- `test/` and its `fixtures/`, plus the vitest entry that runs them. The tests
  import `../../src/graph-package.ts` and `../../src/terraform-member.ts` from
  behold; in the new repository they import `@intentius/behold-graph` and run
  against a published version instead.
- the `action/**/*.test.ts` line in behold's `vitest.config.ts` is removed.
- a release workflow that tags `v1` and pins the same upload-artifact commit.

What stays in behold: the `graph --changed` cut, the Mermaid and SVG formats
and `@intentius/behold-graph` itself.

## Waiting on the maintainer

- creating the `behold-action` repository and moving this folder
- publishing `@intentius/behold-graph` to npm (the action installs it by version)
- the test-repository runs that the issue's Done-when names: a pull request
  that changes two resources, a second push, and a fork pull request through
  the two workflows above
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
