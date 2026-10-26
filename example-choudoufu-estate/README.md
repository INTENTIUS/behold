# choudoufu-estate — behold's tag-owned estate demo (#366)

Four [choudoufu](https://github.com/INTENTIUS/choudoufu) estates served as one
composed estate. choudoufu is an OpenTofu fork whose ownership lives on the
resource as two AWS tags, `tofu-estate` and `tofu-address`; the state file is a
cache that is allowed to be stale, and an estate is split by retagging. The
estates here are the live-mv workbench's own fixture (`examples/live-mv-workbench`
in the choudoufu repo), copied:

- **monolith/.** The terralith: three teams' IAM roles, policies, inline
  policies, attachments and log groups in one estate. `scripts/choudoufu-up.sh`
  applies it, so every one of its 21 resources is live and marked
  `tofu-estate = tlmig-sample-monolith`.
- **team-a/**, **team-b/**, **team-c/** are the estates the teams would own.
  Each declares its own seven resources, which are the monolith's: served
  live, every card reads *owned by tlmig-sample-monolith*, with a dashed
  edge to the monolith's card of the same address. team-a also declares a VPC
  the monolith does not, and team-b reads it through a data source filtered
  on team-a's marker tags, the cross-estate reference `live-check -json`
  states, drawn as an edge between the two boxes.
- **monolith/split.json.** The split plan: team-a's five taggable resources move to
  `tlmig-sample-team-a`. The scope panel shows each move with the
  `choudoufu live-mv` line to run and a link to the morph; behold never runs
  the write.

```sh
npx @intentius/behold demo choudoufu-estate      # needs Docker and choudoufu on PATH
```

What the demo does: boots a scratch floci (`behold-choudoufu-floci` on
127.0.0.1:4650), runs `choudoufu init` in each estate copy (behold's own copy,
never a served project), applies the monolith, and serves the four estates
with `--env live`.

Then, by hand, in `team-a/` (with the same `AWS_ENDPOINT_URL` the demo
printed):

```sh
choudoufu live-mv -from-estate=tlmig-sample-monolith aws_iam_role.team_a aws_iam_role.team_a
```

Reload the overlay: the role and its two followers are green in team-a's box,
the monolith's card for it reads *owned by tlmig-sample-team-a*, and
`/api/choudoufu/split?plan=split.json&receipt=1` says `moved`. Apply team-a
afterwards to bring its VPC up, and team-b's read resolves.

`chant.workspace.json` pins the terraform lexicon at the chant on npm
(0.124.52) until the chant release behold waits on is out (`CHANT_RELEASE` in
src/chant-release.ts, behold#1015), and the demo copy is re-pinned at whichever
lexicon is installed beside behold. Streaming drift card by card and the drift
record overlay need chant 0.124.53, a local build of chant until that release:
the tarballs "A local chant build" in example-three-cloud/README.md packs,
installed in behold's checkout with `npm install --no-save`. On the published
chant the stream start is refused with the version it needs.

`bash scripts/choudoufu-down.sh` removes the container. The `.terraform/`
directories and the record stores are gitignored.
