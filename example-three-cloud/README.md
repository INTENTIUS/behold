# three-cloud

A small website in AWS, Azure and GCP behind Route 53, as a chant workspace on
the floci emulators, its four members on three engines: chant, choudoufu and
plunge. It is behold's `three-cloud` demo, and its exported page asks one
question: turn Azure off, and where does traffic go?

```
chant.workspace.json        the workspace: dns and gcp (chant), azure (choudoufu), aws (pulumi, on plunge)
chant.config.json           names azure as the terraform lexicon's `azure` root, for its activities
dns/src/route53.ts          hosted zone, and a latency entry per cloud (HostnameEntry, AddressEntry)
dns/src/records.component.ts  dns's components: azure (reads the estate's outputs) and records
dns/ops/front-door.op.ts    the Op that rebuilds the page
aws/index.ts, Pulumi.yaml   a Pulumi program on plunge: ECS on Fargate behind a load balancer, in its VPC
azure/main.tf, site.tf      a choudoufu estate: a Container Apps site and its network, through azurerm
gcp/src/site.ts             Cloud Run behind a global load balancer (PublicCloudRun, PrivateEgressNetwork)
*.component.ts              one component per chant member: how it deploys
scripts/emulators-up.sh     boots floci, floci-az (with TLS) and floci-gcp, then `choudoufu init` in azure
scripts/front-door.ts       the Op's steps: apply, turn Azure off, wait, export; plan, apply a
                            planned set, and an out-of-band edit per member
```

The composites are the lexicons' own. Each chant member is one component. gcp
runs its member's apply from `scripts/front-door.ts` (`apply-gcp`) until its
lexicon has deploy steps of its own (chant#4273). dns has three components.
`azure` and `aws` stand for those members: each one's step, `member-outputs`,
reads the member's outputs through its engine and applies nothing.
`records` builds the dns template with `build-dns`, which fills in
gcpEndpoint from what is applied and points each health check at the
emulator that answers for it, then deploys it with `cfn-deploy`, its
azureEndpoint and awsEndpoint parameters wired to `stackOutput("azure",
"azureEndpoint")` and `stackOutput("aws", "awsEndpoint")`.

aws is a Pulumi program (INTENTIUS/behold#1000) with the resources the aws
member declared when it was a chant member (VpcDefault and FargateAlb), in
TypeScript on pulumi-aws 7.51.1, pinned as plunge's corpus pins it.
`Pulumi.yaml` names plunge's record backend over `aws/.plunge`
(`plunge+file://./.plunge`), which is also how chant knows the member runs
on plunge. Its provider is explicit and goes to floci at AWS_ENDPOINT_URL
(default http://localhost:4566) with floci's fake key pair; the program
refuses an endpoint that is not on this machine. `apply-aws` runs `plunge
up` on the stack `local` and then `plunge stack export` into
`aws/stack-export.json`, which is what chant draws the member's graph from
(the graph read never runs the program). That export, `aws/.plunge` and the
stack file `Pulumi.local.yaml` (only its encryption salt) are that
machine's state and stay untracked, so a fresh checkout draws aws with no
cards until it has applied once.

azure is a choudoufu estate (INTENTIUS/choudoufu#2246), the resources the
azure lexicon's ContainerAppNetwork and ContainerAppSite declared, written in
HCL with a `live` block. Its provider block reaches floci-az the way
choudoufu's own floci-az estates do, every endpoint and credential stated.
`apply-azure` plans it with the terraform lexicon's `choudoufuPlanSet`, run
as a step of a one-step Op (chant#4483), and applies that set with
`choudoufuWaveApply`, under the same floci-az endpoint lock. Published chant
0.124.52 has no such Op activity, so with it the script calls the same
function directly. Its records stay in `azure/.tofu-records`.

Each cloud publishes its endpoint as an output (`output()` in aws and gcp, an
`output` block in azure) and `dns` reads it as a parameter of the same name.
azure's reaches dns through chant (INTENTIUS/chant#4455): dns lists
`terraform` among its lexicons, since the terraform lexicon is what reads a
choudoufu member's outputs, and names the estate as its one
`terraform.roots` entry, `azure`, so a change under `azure/` puts the azure
component, and dns with it, in the change. When azure's plan creates or
replaces the Container App, azureEndpoint is known only after azure applies:
dns's plan lists `azure` under its unresolved inputs and
`azure.azureEndpoint` under its unknown inputs, and dns applies after azure,
planned again against the value it applied as. aws reaches dns the same way,
through the pulumi lexicon, which dns lists too: `plunge stack output --json
--show-secrets=false` for the applied value and `plunge preview --json` for
the planned one. gcp still reaches dns through `build-dns`.

## A local chant build

The `azure` and `aws` components need a chant with `member-outputs`
(chant#4455), and the aws member needs `@intentius/chant-lexicon-pulumi`
(chant#4453). Both are on chant's main branch and in no release yet;
0.124.52, which this directory installs, has neither, and the pulumi lexicon
is not published at all. Until a release carries them, install a local
build of chant, packed the way a release packs it. A symlink to chant's
source is not the same thing: it has no `dist/` and runs `bin/chant` from
source. In a checkout of chant main (`CHANT` below):

```sh
cd "$CHANT" && npm ci && scripts/ci-lexicon-artifacts.sh --steps generate,bundle
# Stamp the packages' versions, uncommitted, at the coming release: behold's
# CHANT_RELEASE (src/chant-release.ts), which is chant's NEXT_RELEASE. 0.124.53
# meets every ^0.124.52 here and every floor in behold. behold's exact pins
# name 0.124.52 until that release (behold#1015); its demos re-pin their copy.
for pj in packages/*/package.json lexicons/*/package.json; do
  node -e 'const f=process.argv[1];const p=require(f);if(!String(p.name).startsWith("@intentius/"))process.exit(0);p.version="0.124.53";require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$PWD/$pj"
done
mkdir -p /tmp/chant-local && npm pack -w packages/core -w lexicons/terraform -w lexicons/pulumi --pack-destination /tmp/chant-local
git checkout -- '*package.json'
# Here:
npm install && npm install --no-save /tmp/chant-local/*.tgz
```

Each `npm pack` runs that package's own prepack, which is the build a release
ships. The workspace pins both lexicons by path (`node_modules/@intentius/...`),
so the pin reads whichever build is installed there and sets no version a
local build can't meet. `npm run front-door` and `npm run change-set` need
the local build too, since they run dns's components and the pulumi part.
A later plain `npm install` here puts the npm release back, so run the
`--no-save` install again after one. scripts/front-door.ts loads the pulumi
lexicon only for the aws plan, so the other subcommands (`apply-azure` among
them) run after a plain `npm ci`. Once that chant release is published,
behold's `CHANT_RELEASE` flips (src/chant-release.ts) and this directory pins
and depends on both lexicons by version instead.

## One change set

```sh
npm run change-set     # writes .front-door/change-set.json, applies nothing
```

That plans the four members into one change-set document under one digest,
a part per member in its engine's terms: a chant part each for dns and gcp
(`chant lifecycle plan local --json`), a choudoufu part for azure
(the `choudoufuPlanSet` Op activity), and a pulumi part for aws (`plunge preview --json`, read
by the pulumi lexicon's `pulumiPreviewPart`).

```sh
npx tsx scripts/front-door.ts apply --change-set .front-door/change-set.json
```

applies that set and nothing else. It plans the four members again first,
and when any part's plan moved, in any engine, it refuses the whole set
before anything applies: `.front-door/apply-verdict.json` says `refused` and
names each moved part with chant's reason (`planCoveredBy`), and it exits 3,
chant's code for a moved plan.

## Out-of-band edits

```sh
npx tsx scripts/front-door.ts oob-edit dns     # the hosted zone's comment
npx tsx scripts/front-door.ts oob-edit gcp     # a label on the Cloud Run service
npx tsx scripts/front-door.ts oob-edit azure   # a tag on the Container App
npx tsx scripts/front-door.ts oob-edit aws     # the log group's retention, 7 days to 14
```

Each changes one live resource straight on the emulator, so each member's
own engine has to notice it: chant's live read for dns and gcp, choudoufu's
plan for azure, `plunge drift` for aws. In behold the edited card turns from
in sync to drifted when the member's drift is read.

## Run it

```sh
npx @intentius/behold demo three-cloud
```

Or by hand, from this directory (needs Docker, choudoufu on PATH or named by
CHOUDOUFU_BIN, and plunge on PATH or named by PLUNGE_BIN, with the nodejs
language host beside it; on a Mac, the floci-az certificate choudoufu's
`scripts/floci-az-mac-cert.sh` makes, trusted once):

```sh
npm install
npm run emulators      # floci :4566, floci-az :4577, floci-gcp :4588
npm run front-door     # apply, turn Azure off, wait for Route 53, export to ./export
npx serve export
```

`cd dns && npx chant run front-door` runs the same steps as an Op.

Needs the local chant build (see above).
