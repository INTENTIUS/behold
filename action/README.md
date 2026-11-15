# behold changed cut (GitHub Action)

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

## Tests

`action/test/action.test.ts` runs under the repository's vitest. It builds a
throwaway git repository, reads it through the real Terraform reader, and
answers every GitHub call from `action/test/fixtures` (bodies shaped after the
REST documentation: comment lists with a `Link` header, create, edit, a 403,
a pull request, event payloads). A call with no recorded answer fails the
test, so nothing reaches the network and nothing is posted to a real pull
request.

## What moves

When `behold-action` exists, move the whole `action/` folder to its root:

- `action.yml`, `src/` and `README.md`
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
