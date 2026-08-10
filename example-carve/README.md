# example-carve — the mixed estate the peeling demo runs on

A migration caught half-done. `app/` is chant; `legacy-tf/` is Terraform; both
describe one AWS account, and the walkthrough carves one more resource across
the line while the camera is running.

Run it:

```sh
behold demo carve          # copies this directory, installs, advises, serves
```

The boot does three things before a port opens: `npm install` in `app/` (whose
chant every step of the walkthrough shells), `@cdktf/hcl2json` into the copy's
root `node_modules` (chant lazy-loads the HCL parser from its own install
upward, so `<copy>/node_modules` is where it resolves — not beside the `.tf`
files), and `chant carve advise --report` over the copy's own Terraform. If any
of that fails, the committed `carve-report.json` is served instead and the
reason is on screen; a blank graph is the one outcome that's never allowed.

```
example-carve/
  app/                     a small chant project — the pieces already carved
    carveout/              where Emit and Bridge write, in a copy (gitignored)
  legacy-tf/               the Terraform half, still Terraform-owned
    terraform.tfstate      synthetic state (fake account, fake ARNs)
    floci-override.tf.disabled   provider endpoints for the --live tier, inert
    modules/cdn/           a local module, so module.cdn resolves offline
  carve-report.json        the committed `carve advise` output
```

`carveout/` sits INSIDE `app/` rather than beside it, and that is load-bearing:
the emitted source imports `@intentius/chant-lexicon-aws`, and Node resolves
that from the file's own directory upward. From `app/carveout/src/assets.ts` it
reaches `app/node_modules`; from a sibling `carveout/` it would reach nothing,
and the Emit step's `chant lint` would fail on an install problem rather than
on the source.

## The estate is mixed from the first frame

`app/src/carved.ts` holds a CloudWatch log group and an SSM parameter that came
out of `legacy-tf/` last month. The source says so, and `legacy-tf/cdn.tf` still
carries the other half of that carve: a `data "aws_ssm_parameter"` block reading
back the value chant now owns. That is the data-source rewrite `carve bridge`
generates, sitting in the estate a month later and working.

So the estate view opens on a chant box beside a Terraform box. The morph at the
end of the walkthrough has somewhere to land.

## Bands

Real output, from `chant carve advise` at chant 0.44.7. Reproduce it with:

```sh
npm install -D @cdktf/hcl2json          # once, anywhere on your PATH resolution
chant carve advise --from example-carve/legacy-tf \
                   --state example-carve/legacy-tf/terraform.tfstate
```

| score | address | band | why | role in the script |
|---|---|---|---|---|
| 100 | `aws_cloudwatch_log_group.worker` | clean leaf | clean 1:1 native map, no boundary edges | the free first move: named, not carved |
| 84 | `aws_s3_bucket.assets` | clean leaf | 1 inbound, 1 output | **the star** — the resource we carve on camera |
| 71 | `module.cdn` | carvable w/ edits | 1 outbound, tier 2, data present | one module, so module scoring appears |
| 69 | `aws_iam_role.api` | carvable w/ edits | 1 inbound, 1 outbound, tier 2 | what an inbound edge costs |
| 69 | `aws_vpc_endpoint.ssm` | carvable w/ edits | 4 outbound, tier 2 | outbound edges are cheap, but they add up |
| 61 | `aws_lambda_function.api` | carvable w/ edits | 1 output, 5 outbound, tier 2 | the honest yellow: next month, not today |
| 43 | `aws_security_group.lambda` | leave in Terraform | 2 inbound, 2 outbound, tier 2, data present | |
| 42 | `aws_subnet.private_a` | leave in Terraform | 3 inbound, 1 output, 2 outbound, data present | |
| 42 | `aws_subnet.private_b` | leave in Terraform | 3 inbound, 1 output, 2 outbound, data present | |
| 32 | `aws_vpc.main` | leave in Terraform | 5 inbound, 1 output, 1 outbound | the grey anchor: this stays, and that's fine |
| 0 | `aws_network_acl.private` | leave in Terraform | no known native mapping | |
| 0 | `random_pet.suffix` | leave in Terraform | no known native mapping | the long tail, stated plainly |

Bands: 80-100 carve now, 50-79 carve with boundary edits, 0-49 leave in Terraform.

The scoring model is `100 - 12*inbound - 4*outbound - 4*outputs - 15*(tier-1) -
10*dynamic - 3*(instances-1)`, clamped, with unmapped types pinned at 0. The
`outputs` term is chant#1638 (chant 0.44.7): an `output` block that reads a
resource is a boundary edge too now, `bridge: "tf-output-rewrite"`, because
carving that resource means rewriting the output the same way carving a
resource with an inbound reference means adding a data source. Every number
above is that arithmetic on the edges in `legacy-tf/`, which is why the estate
is shaped the way it is:

- The bucket has one inbound edge — `aws_lambda_function.api`'s
  `ASSETS_BUCKET` environment variable — and, since `outputs.tf`'s
  `assets_bucket` reads it too, one output edge. Two edges, two rewrites, 84.
  `assets_bucket` is deliberate: a downstream consumer of this state reads the
  bucket name today, so the carve has a second thing to bridge, not just the
  lambda's env var.
- `aws_s3_bucket_versioning.assets` and `aws_s3_bucket_public_access_block.assets`
  share the bucket's name, so they fold into its carve set. They are not ranked
  separately and their edges to the bucket are not counted against it.
- Five resources point at the VPC, and its existing `vpc_id` output reads it
  too. Carving it would mean patching all five survivors and rewriting the
  output, and 32 says so.
- The subnets and the security group each read a data source, which costs 10.
  The subnets also feed `private_subnet_ids`, an existing output, which costs
  4 more apiece and drops them under the security group's 43 — the one place
  the outputs term reorders the table, not just re-scores it.

No resource uses `count` or `for_each`, so the instance-count penalty is zero
and `--state` produces byte-identical scores to a `.tf`-only parse. The bands do
not move depending on which way the walkthrough invokes the advisor.

### carve-report.json

`carve-report.json` is the `--report` output of exactly the command above,
committed so the walkthrough and #252's carve lens have an artifact to read
without shelling anything. JSON carries no comments, so this is its header:
regenerate it, unchanged, with

```sh
chant carve advise --from example-carve/legacy-tf \
                   --state example-carve/legacy-tf/terraform.tfstate \
                   --report example-carve/carve-report.json
```

from the repository root, so the `from` field stays a relative path.

`app/` pins chant ^0.44.7 and that floor is load-bearing, not housekeeping, in
two layers. The advisor only publishes a top-level `version: 1` and
per-resource `boundary` edge lists from 0.44.6 (chant#1636) — run the same
command on 0.44.4 and every score is identical but no resource carries a
`boundary` field at all, so the Pick step falls back to naming inbound/outbound
COUNTS instead of naming the edges the carve severs. 0.44.7 adds a second
layer on top: `output` blocks read as boundary edges (chant#1638), so the
bucket scores 84 instead of 88 and the report's `patchOnCarve` list names
`output.assets_bucket` alongside `aws_lambda_function.api`; and `carve emit`'s
fold is applied, not just reported (chant#1637), so the emitted bucket actually
carries `VersioningConfiguration` and `PublicAccessBlockConfiguration` instead
of leaving them in an "unmapped attributes" comment. The committed report above
is byte-identical to what 0.44.7 regenerates, which is why the demo's fallback
path and its fresh-run path show the same picture.

## The six beats

These are the six steps on the panel's Carve tab. behold runs beats 4 and 5
itself, into `app/carveout/` in the copy; beat 6 is copy buttons, on purpose.

1. **The green star.** The estate view, banded. Two resources are green; the
   100 is a log group nobody will miss, so the eye lands on the 84 next to it.
2. **The arithmetic.** Open `aws_s3_bucket.assets`: 100 minus 12 for the
   inbound edge, minus 4 more for the output block that reads it. The score is
   not a vibe, it is a subtraction, and the inspect pane shows the terms.
3. **The cut edge.** Highlight the two dependencies the carve severs:
   `aws_lambda_function.api` reads the bucket name, and the `assets_bucket`
   output reads it too. Two one-line rewrites, not one.
4. **Emit.** `carve emit --from legacy-tf --state legacy-tf/terraform.tfstate
   --select aws_s3_bucket.assets` adopts the bucket from state into typed chant
   source, folds both sub-resources into the carve set AS native props
   (chant#1637's fold, applied), and writes a boundary report. Nothing is
   applied, nothing is destroyed, and `chant lint` on the result exits clean.
5. **The bridge.** One `data "aws_s3_bucket" "assets"` block in the surviving
   Terraform; `aws_lambda_function.api` and the `assets_bucket` output both
   read from that instead. The surviving plan is whole again.
6. **The handoff.** Two commands: `terraform state rm aws_s3_bucket.assets`,
   then chant takes the observe position. `terraform plan` shows no destroy.

Then the box slides out of the Terraform half and into `app/`, beside the log
group and the SSM parameter that made the same trip last month. Around two
minutes end to end.

## Two tiers

**Offline is the default.** The synthetic `terraform.tfstate` is committed, so
`carve advise` and `carve emit --state` run with no Docker, no terraform binary,
no AWS account and no network. The only dependency beyond this directory is
`@cdktf/hcl2json`, which chant lazy-loads and names in its error if absent. This
tier guarantees the first thirty seconds of the video.

**`--live` is the full video.** Boot a scratch Floci, arm
`legacy-tf/floci-override.tf.disabled` (see its header), and `terraform apply`
the estate into it, so the state is one terraform really wrote. Then the observe
beats become footage rather than caption: after Emit, `chant lifecycle diff
--live` reads the bucket out of Floci, clean, while Terraform still owns it; the
handoff runs a real `terraform plan` showing no destroy; and behold's overlay
flips the bucket green afterwards. The line it exists for is "Terraform forgot
it, chant adopted it, and it never blinked."

The live tier needs `docker` and `terraform` on PATH, boots its own throwaway
Floci and deletes it after, and never touches an existing `floci*` container.
Floci's emulation bounds it: S3 and CloudWatch Logs, the two types the
walkthrough actually carves, are covered (chant's `just carve-emit-e2e` is the
prior art). The VPC, lambda and CloudFront blocks are scenery for the advisor's
grey band, so expect `-target` rather than one apply of the whole estate.

## Why build still fails

`carve emit --state --select aws_s3_bucket.assets` reports "Folded in:
`aws_s3_bucket_public_access_block.assets`, `aws_s3_bucket_versioning.assets`",
and as of chant 0.44.7 (chant#1637, chant PR #1640) the emitted `Bucket`
actually carries both: `VersioningConfiguration` and
`PublicAccessBlockConfiguration` come out as native props, not an "unmapped
Terraform attributes" comment. That used to be the rough edge here — a fold
that was reported but not applied, so `chant build` failed two AWS policy
rules on source the advisor called clean. It is fixed now.

`chant lint` on the emitted project passes with warnings. `chant build` still
fails, but on one rule: WAW042, no bucket policy denying non-TLS requests.
That is not a carve-tooling gap — grep `legacy-tf/` for
`aws_s3_bucket_policy` and there isn't one. The Terraform never declared a
TLS-deny policy for this bucket, in any form; chant's post-synth checks
noticed the moment the resource had a native representation to check. Nothing
here would show up scanning the `.tf` by eye, because there is nothing to
find — only an absence.

Verified against chant 0.44.7. The walkthrough's Emit beat still shows `lint`,
not `build` — the step's "why lint and not build?" note says why on screen —
but the reason changed: `build` doesn't fail because the fold is incomplete
anymore, it fails because the estate really does have a policy gap. "chant
found a policy gap Terraform never noticed" is the honest line to close the
video on.

## Values

Every name here is a boring-realistic stand-in for a small production estate,
because the video pauses on the inspect pane. There is no `foo` and no `bar`.
The account id is `000000000000` and every ARN, id and hostname is fake; the
state file says so in its `_fixture_note` output.
