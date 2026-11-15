# behold changed cut

> Your infrastructure repo as a graph, from the files. Draws Terraform roots, no state needed.

Draw the resources a pull request changed, and their neighbours, as a diagram
in the job summary and in one comment that is edited on each push. It reads
the files in git, so it works on a repository that has never used chant,
next to whatever plan tooling the repository already runs.

## What it reads

Files only. The action reads `<base sha>..<head sha>` out of git with
`git archive`, parses the Terraform it finds, and draws the roots that changed.
It runs no `terraform` binary, needs no plan, no state file and no cloud
credentials, and runs nothing from the repository it reads. The only token it
uses is the repository's own `GITHUB_TOKEN`, to write the comment. It installs
`@intentius/behold-graph` from the npm registry on each run.

## Minimal workflow

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
      - uses: INTENTIUS/behold-action@v1
```

## What the comment holds

The cut is `<base sha>..<head sha>` from the pull request event, read with
`behold graph --changed`, at detail 3 so an edited attribute shows. Each push
edits the comment that carries the hidden marker `<!-- behold:changed -->`, so
the pull request keeps one behold comment. When the cut is over the node
budget (60 cards by default) the neighbours fold, and past that the comment is
a per-root table of counts. A comment is kept under 60,000 characters,
GitHub's reported limit being 65,536; that figure is provisional until the
live check on INTENTIUS/behold#1065 is recorded.

The run's job summary holds the same diagram or table, the count line (for
example "4 changed, 9 neighbours, in 2 roots") and links to the artifacts.

An SVG the painter refuses (it stops at 400 flat cards) and a directory
behold cannot read both count as a failed read: the step fails after writing
the reason to the summary. Set `fail-on-error: false` to report and continue.

## Inputs

All inputs are optional.

| Input | Default | What it does |
|---|---|---|
| `mode` | `changed` | `changed` draws the cut for a pull request. `post-comment` is the second workflow of the fork recipe. |
| `github-token` | `github.token` | Token for the comment. |
| `forge` | `auto` | `github`, `forgejo` or `auto`. |
| `api-url` | empty | API base URL when the forge's own variable is wrong for the job. |
| `base` | pull request base sha | Base commit. |
| `head` | pull request head sha | Head commit. |
| `path` | `.` | Directory to read, relative to the workspace. |
| `depth` | behold's default | Hops from a changed card that are kept. |
| `budget` | 60 | Cards a cut may hold before it folds. |
| `theme` | behold's default | SVG theme, `light` or `dark`. |
| `comment` | `auto` | `auto` posts one comment on a pull request; `false` writes the job summary and artifacts only. |
| `marker` | `behold:changed` | The hidden marker that finds the comment to edit. Change it to keep two comments, one per directory. |
| `upload` | `true` | Upload the SVG and JSON as artifacts. |
| `artifact-name` | `behold-changed` | Prefix of the artifact names. Names are unique per run, so give each use of the action its own. |
| `retention-days` | repository default | Artifact retention, 1 to 90. |
| `handoff` | `false` | Also upload `comment.md` and `pr.json` as one artifact, for the fork recipe. |
| `handoff-dir` | empty | `post-comment` mode: the folder the handoff artifact was downloaded to. |
| `behold-version` | `latest` | Version of `@intentius/behold-graph` to install. |
| `fail-on-error` | `true` | Fail the step when the read fails. |

## Outputs

| Output | What it holds |
|---|---|
| `changed-count` | Cards added, removed or changed. |
| `comment-url` | The comment the action posted or edited, when it did. |
| `comment-action` | `created`, `updated`, `unchanged`, `denied`, `fork` or `skipped`. |
| `svg-artifact-url` | Artifact URL of the SVG. Needs a signed-in viewer. |
| `json-artifact-url` | Artifact URL of the JSON. |
| `out-dir` | Folder holding `changed.json`, `changed.svg`, `comment.md` and `pr.json`. |

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
Catalog component is not done.

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
250 edges until the live check (INTENTIUS/behold#1065) records what a Forgejo instance
renders. Gitea's default `MERMAID_MAX_SOURCE_CHARACTERS` is 50,000; Forgejo's
is not documented.

A fork's pull request. Forgejo gives it a read-only token and no secrets, so
the job writes the summary and uploads the artifacts and makes no API call.
Forgejo has no `workflow_run` event, so there is no second workflow to post
the comment, and `mode: post-comment` refuses to run there. Posting for forks
would need `pull_request_target`, which runs with a write token; that is a
separate design and is not built here.

## About behold

> behold draws your infrastructure repo as a graph, from the files. Run it in a folder of Terraform and it finds each root and draws it as a box of resources, with an edge for each reference the configuration states. It needs no state file or cloud account, and it runs no terraform binary. It writes nothing into the folder it reads. Terraform roots are what it draws from files today. Kubernetes manifests in a plain directory and the edges between tools are coming. behold works beside the tools a repo already uses.

To try it on a checkout first, run `npx @intentius/behold serve .`.
