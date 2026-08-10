# example-carve — the mixed estate the peeling demo runs on

A migration caught half-done. `app/` is chant; `legacy-tf/` is Terraform; both
describe one AWS account, and the walkthrough carves one more resource across
the line while the camera is running.

This directory is the fixture only. The stepper, the server wiring and the
`demos.json` entry land with the walkthrough PR (behold #254 part 2).

```
example-carve/
  app/                     a small chant project — the pieces already carved
  legacy-tf/               the Terraform half, still Terraform-owned
    terraform.tfstate      synthetic state (fake account, fake ARNs)
    floci-override.tf.disabled   provider endpoints for the --live tier, inert
    modules/cdn/           a local module, so module.cdn resolves offline
  carve-report.json        the committed `carve advise` output
```

## The estate is mixed from the first frame

`app/src/carved.ts` holds a CloudWatch log group and an SSM parameter that came
out of `legacy-tf/` last month. The source says so, and `legacy-tf/cdn.tf` still
carries the other half of that carve: a `data "aws_ssm_parameter"` block reading
back the value chant now owns. That is the data-source rewrite `carve bridge`
generates, sitting in the estate a month later and working.

So the estate view opens on a chant box beside a Terraform box. The morph at the
end of the walkthrough has somewhere to land.

## Bands

Real output, from `chant carve advise` at chant 0.44.4. Reproduce it with:

```sh
npm install -D @cdktf/hcl2json          # once, anywhere on your PATH resolution
chant carve advise --from example-carve/legacy-tf \
                   --state example-carve/legacy-tf/terraform.tfstate
```

| score | address | band | why | role in the script |
|---|---|---|---|---|
| 100 | `aws_cloudwatch_log_group.worker` | clean leaf | clean 1:1 native map, no boundary edges | the free first move: named, not carved |
| 88 | `aws_s3_bucket.assets` | clean leaf | 1 inbound | **the star** — the resource we carve on camera |
| 71 | `module.cdn` | carvable w/ edits | 1 outbound, tier 2, data present | one module, so module scoring appears |
| 69 | `aws_iam_role.api` | carvable w/ edits | 1 inbound, 1 outbound, tier 2 | what an inbound edge costs |
| 69 | `aws_vpc_endpoint.ssm` | carvable w/ edits | 4 outbound, tier 2 | outbound edges are cheap, but they add up |
| 65 | `aws_lambda_function.api` | carvable w/ edits | 5 outbound, tier 2 | the honest yellow: next month, not today |
| 46 | `aws_subnet.private_a` | leave in Terraform | 3 inbound, 2 outbound, data present | |
| 46 | `aws_subnet.private_b` | leave in Terraform | 3 inbound, 2 outbound, data present | |
| 43 | `aws_security_group.lambda` | leave in Terraform | 2 inbound, 2 outbound, tier 2, data present | |
| 36 | `aws_vpc.main` | leave in Terraform | 5 inbound, 1 outbound | the grey anchor: this stays, and that's fine |
| 0 | `aws_network_acl.private` | leave in Terraform | no known native mapping | |
| 0 | `random_pet.suffix` | leave in Terraform | no known native mapping | the long tail, stated plainly |

Bands: 80-100 carve now, 50-79 carve with boundary edits, 0-49 leave in Terraform.

The scoring model is `100 - 12*inbound - 4*outbound - 15*(tier-1) - 10*dynamic
- 3*(instances-1)`, clamped, with unmapped types pinned at 0. Every number
above is that arithmetic on the edges in `legacy-tf/`, which is why the estate
is shaped the way it is:

- The bucket has exactly one inbound edge, `aws_lambda_function.api`'s
  `ASSETS_BUCKET` environment variable. One edge, one patch, 88.
- `aws_s3_bucket_versioning.assets` and `aws_s3_bucket_public_access_block.assets`
  share the bucket's name, so they fold into its carve set. They are not ranked
  separately and their edges to the bucket are not counted against it.
- Five resources point at the VPC. Carving it would mean patching all five at
  once, and 36 says so.
- The subnets and the security group each read a data source, which costs 10.
  That is what pushes them under the line rather than sitting awkwardly in the
  middle band next to the star.

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

## The six beats

1. **The green star.** The estate view, banded. Two resources are green; the
   100 is a log group nobody will miss, so the eye lands on the 88 next to it.
2. **The arithmetic.** Open `aws_s3_bucket.assets`: 100 minus 12 for one
   inbound edge. The score is not a vibe, it is a subtraction, and the inspect
   pane shows the terms.
3. **The cut edge.** Highlight the one dependency the carve severs:
   `aws_lambda_function.api` reads the bucket name. One line of Terraform.
4. **Emit.** `carve emit --from legacy-tf --state legacy-tf/terraform.tfstate
   --select aws_s3_bucket.assets` adopts the bucket from state into typed chant
   source, folds both sub-resources into the carve set, and writes a boundary
   report. Nothing is applied, nothing is destroyed, and `chant lint` on the
   result exits clean.
5. **The bridge.** One `data "aws_s3_bucket" "assets"` block in the surviving
   Terraform, and `aws_lambda_function.api` reads from that instead. The
   surviving plan is whole again.
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

## Known rough edge in emit

`carve emit --state --select aws_s3_bucket.assets` reports "Folded in:
`aws_s3_bucket_public_access_block.assets`, `aws_s3_bucket_versioning.assets`"
and then emits a `Bucket` carrying neither. Only `bucket` and `tags` are in the
AWS carve-out table's field map for `aws_s3_bucket`; versioning, public-access
block and the state's server-side encryption block come out in the "unmapped
Terraform attributes" comment instead. `chant lint` on the emitted project
passes with warnings, but `chant build` fails on two AWS policy rules
(`PublicAccessBlockConfiguration` missing, no TLS-deny bucket policy) even
though the Terraform declared the first of those.

Verified against chant 0.44.4. The walkthrough's Emit beat should show `lint`,
not `build`, until the fold is applied as well as reported.

## Values

Every name here is a boring-realistic stand-in for a small production estate,
because the video pauses on the inspect pane. There is no `foo` and no `bar`.
The account id is `000000000000` and every ARN, id and hostname is fake; the
state file says so in its `_fixture_note` output.
