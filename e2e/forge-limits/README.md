# GitHub forge limits, check by hand (#1065)

Inputs and a workflow for measuring, on a public test repository, what GitHub
renders and accepts. Nothing here runs in behold's own CI. The Mermaid emitter
(#1060) and the action (#1062) take their `github` budget from the numbers this
check records.

Files:

- `gen.mjs` writes the fixtures (`node e2e/forge-limits/gen.mjs <outdir>`, no
  dependencies). `manifest.json` in the output lists characters and edges of each.
- `forge-limits.yml` is the workflow to copy into the test repo.

## What GitHub documents

| Question | Documented answer | Source |
| --- | --- | --- |
| Where Mermaid renders | Issues, Discussions, pull requests, wikis and Markdown files. Job summaries and comments are not named. No size or complexity limit is stated. | https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams |
| Mermaid version GitHub runs | Not stated; the page says to post a `mermaid` block containing `info` to see it. Fixture `info` does that. | same page |
| Mermaid defaults | `maxTextSize` 50000, `maxEdges` 500, `securityLevel` "strict". These are Mermaid's defaults, GitHub's overrides are not published. | https://mermaid.js.org/config/schema-docs/config.html |
| Job summary size | 1 MiB per step; an oversize step fails its upload with an error annotation. At most 20 step summaries are displayed per job. Mermaid in a summary is not mentioned. | https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands |
| Comment body size | No limit is stated in the REST reference. The 65,536 figure is third-party only. | https://docs.github.com/en/rest/issues/comments |
| Image attach limits | 10 MB for images and gifs, 25 MB for most other files; SVG, PNG, GIF, JPEG supported. | https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files |
| `gh pr comment --attach` | Flag exists: "Attach an image or video file, in '<file>#<image alt text>' format". Nothing about which token works. | https://cli.github.com/manual/gh_pr_comment |
| Artifacts | 500 artifacts per job, names unique per run, 90 days default retention (1 to 90 settable), `archive: false` takes a single file, `artifact-url` needs a signed-in viewer. Per-artifact size is not stated; storage is per plan (Free 500 MB). | https://github.com/actions/upload-artifact and https://docs.github.com/en/actions/reference/limits |
| Fork `pull_request` runs | "The `GITHUB_TOKEN` has read-only permissions in pull requests from forked repositories"; secrets are not passed. Whether a job summary is written is not stated. | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows |
| `workflow_run` | Runs from the default branch with access to secrets and write tokens, only if the workflow file is on the default branch. | same page |

## Budgets to use until the live check confirms

For #1060 and #1062. Each sits well under the lowest figure any source gives, so
a diagram that fits will render whichever value GitHub actually sets.

| Forge | Mermaid block, characters | Edges | Basis |
| --- | --- | --- | --- |
| gitlab | 2,000 | 30 `&` chains, 50 blocks per page | GitLab's renderer constants, as in #1060 |
| github | 20,000 | 250 | under 50,000 and 500, the Mermaid defaults |
| forgejo | 20,000 | 250 | Gitea's default `MERMAID_MAX_SOURCE_CHARACTERS` is 50,000; Forgejo's is unknown |

Whole comment body: stay under 60,000 characters including the marker, the count
line and the fence (the limit is reported as 65,536). The job summary has a
1 MiB ceiling, so the 20,000 character block fits it with room. When the budget
is exceeded, post the per-root table from #1062 instead of a diagram.

## What the maintainer runs

1. Create a public test repo (for example `behold-forge-limits`). On `main`, add
   `forge-limits/gen.mjs` and `.github/workflows/forge-limits.yml` (from this
   folder) and push.
2. On a branch, change any file and open a pull request. Note its number. The
   `pull_request` run is the same-repo control for the fork probe.
3. Summaries: the `summary` matrix runs on that pull request and on dispatch.
   Open each of its 16 jobs. For each fixture, record whether the block drew a
   diagram or an error, and the error text. `info` shows the Mermaid version.
4. Comments and attach:

       gh workflow run forge-limits.yml -R <owner>/<repo> -f pr=<number> --ref <branch>

   The `comment` job posts every fixture as its own comment and prints a table
   of HTTP status and message. Open the pull request and, for each Mermaid
   comment, record whether it drew. The `attach` job posts two comments and
   prints exit codes.
5. Fork: from another account, fork the repo, change a file, open a pull
   request against it. Open the `fork` job's run and check whether its job
   summary was written and what the comment call returned.
6. Optionally repeat steps 3 and 4 on a private repo and on a GitHub Enterprise
   host if the action must work there.

## What to record on #1065

One comment on the issue, with a link to each run:

- Largest `edges-N` that drew in a comment, and in a summary, with the error text
  of the first that did not (edges series: 50, 200, 499, 500, 501, 1000).
- Largest `chars-N` that drew in a comment, and in a summary, with the error text
  of the first that did not (1000 to 60000; the 50000 and 50001 pair tests
  `maxTextSize`). Whether the limit counts the fence is visible in
  `manifest.json` (`diagramChars` and `commentChars`).
- Mermaid version from `info`.
- Comment limit: the HTTP status and message for `ascii-65535`, `ascii-65536`,
  `ascii-65537`, and whether `twobyte-65536` was accepted (characters or bytes).
- `--attach` with `GITHUB_TOKEN`: exit code, output, and whether the image
  showed in the comment, for the SVG and the PNG, plus the `gh --version`.
- Fork run: whether the summary was written, and the comment call's result.
- The resulting `github` budget, in characters and edges, for #1060 and #1062.

Delete the test comments afterwards if the repo is kept.
