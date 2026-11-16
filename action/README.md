# behold changed cut

> Your infrastructure repo as a graph, from the files. Draws Terraform roots, no state needed.

This action draws what a Terraform pull request changed, plus the resources beside it. The diagram goes into the job summary and into a single comment that each push edits. The same cut is uploaded as an SVG and as JSON.

## What it reads

Files only. The action reads `<base sha>..<head sha>` out of git with `git archive` and parses the Terraform it finds. It runs no `terraform` binary, and it needs neither a plan nor a state file nor cloud credentials. Nothing from the repository is executed. Posting the comment uses the repository's own `GITHUB_TOKEN`. Each run installs `@intentius/behold` from the npm registry and runs its `behold graph` command.

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
      - uses: INTENTIUS/behold@behold-v0.33.2
```

The action lives in the behold repository, and its tags are behold's release tags (`behold-v<version>`). A tag can be moved, so for a workflow that has write access pin the full commit sha of the release instead, with the tag in a comment: `uses: INTENTIUS/behold@<40-character sha> # behold-v0.33.2`.

## What the comment holds

It starts with a count line ("4 changed, 9 neighbours, across 2 roots"). The Mermaid diagram follows, then the artifact links. The hidden marker `<!-- behold:changed -->` lets the next push find the comment and edit it, so a pull request keeps one behold comment.

![The comment on a pull request that changed three resources](https://raw.githubusercontent.com/INTENTIUS/behold-sandbox/main/docs/comment.png)

This is a real comment, from [a pull request in the test repository](https://github.com/INTENTIUS/behold-sandbox/pull/2).

A cut with more cards than the `budget` input allows (60 by default) folds its neighbours first. If the diagram still exceeds the forge's Mermaid limit, a table of counts per root replaces it. The job summary carries the same text.

If the SVG painter refuses a graph (it stops at 400 flat cards), or behold cannot read the directory, the step fails after writing the reason to the summary. Set `fail-on-error: false` to report and carry on.

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
| `comment` | `auto` | `auto` posts one comment on a pull request. `false` writes the job summary and artifacts only. |
| `marker` | `behold:changed` | The hidden marker that finds the comment to edit. Change it to keep two comments, one per directory. |
| `upload` | `true` | Upload the SVG and JSON as artifacts. |
| `artifact-name` | `behold-changed` | Prefix of the artifact names. Names are unique per run, so give each use of the action its own. |
| `retention-days` | repository default | Artifact retention, 1 to 90. |
| `handoff` | `false` | Also upload `comment.md` and `pr.json` as one artifact, for the fork recipe. |
| `handoff-dir` | empty | `post-comment` mode: the folder the handoff artifact was downloaded to. |
| `behold-version` | `latest` | Version of `@intentius/behold` to install. Any npm spec after the `@` works. |
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

On a fork's `pull_request` run the token is read-only and no secrets are passed, so that run cannot comment. The action notices this and makes no API call. It still writes the summary and uploads the artifacts. The comment is posted by a second workflow that runs from the default branch.

The first workflow runs on `pull_request`.

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
      - uses: INTENTIUS/behold@behold-v0.33.2
        with:
          handoff: "true"
```

The second runs on `workflow_run` of the first, and its file must be on the default branch.

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
      - uses: INTENTIUS/behold@behold-v0.33.2
        with:
          mode: post-comment
          handoff-dir: handoff
```

The second workflow has a write token, so it never checks out or runs anything from the pull request. The first reads the head commit's files as text through `git archive`. No install script of the repository runs. Two files pass from one to the other, `comment.md` and `pr.json`, and the second checks them before it posts. The pull request number must be an integer. The pull request's current head sha must be the commit the first run read. The file `comment.md` must start with the marker and stay under 262,144 characters, the most GitHub accepted in a live check. At most it writes or edits one marker comment on that pull request.

## GitLab

GitLab has no action marketplace. A CI template runs the same code in merge request pipelines and keeps one note per marker. Create a project access token with the `api` scope and the Reporter role. Store it as the masked CI/CD variable `BEHOLD_GITLAB_TOKEN`. Then include the template pinned to a commit, and set `BEHOLD_ACTION_REF` to that commit:

```yaml
include:
  - remote: https://raw.githubusercontent.com/INTENTIUS/behold/<sha>/action/gitlab/behold.gitlab-ci.yml
variables:
  BEHOLD_ACTION_REF: <sha>
```

A Mermaid block over 2,000 characters is refused there. A note therefore holds one block that fits. Otherwise it holds the count line and the per-root table. The SVG is linked from the job artifacts. A merge request from a fork gets no note.

## Forgejo

Forgejo Actions runs this action as it is. The `forge` input resolves to `forgejo` when the runner sets `FORGEJO_ACTIONS`. Copy `forgejo/behold.yml` as a starting workflow. It sets `upload: "false"` and uploads `out-dir` with `forgejo/upload-artifact`, because `actions/upload-artifact` is not available there. A fork's pull request gets the summary and artifacts but no comment, since Forgejo has no `workflow_run` event.

## About behold

> behold draws your infrastructure repo as a graph, from the files. Run it in a folder of Terraform and it finds each root and draws it as a box of resources, with an edge for each reference the configuration states. It needs no state file or cloud account, and it runs no terraform binary. It writes nothing into the folder it reads. The same command draws a Pulumi program and the Kubernetes manifests in a plain directory, since their lexicons come with the install. behold works beside the tools a repo already uses.

To try it on a checkout first, run `npx @intentius/behold serve .`.
