# three-cloud

A small website in AWS, Azure and GCP behind Route 53, as a chant workspace on
the floci emulators. It is behold's `three-cloud` demo, and its exported page
asks one question: turn Azure off, and where does traffic go?

```
chant.workspace.json        the workspace: dns, aws and gcp (chant), azure (choudoufu)
chant.config.json           names azure as the terraform lexicon's `azure` root, for its activities
dns/src/route53.ts          hosted zone, and a latency entry per cloud (HostnameEntry, AddressEntry)
dns/src/records.component.ts  dns's components: azure (reads the estate's outputs) and records
dns/ops/front-door.op.ts    the Op that rebuilds the page
aws/src/site.ts             ECS on Fargate behind a load balancer (FargateAlb)
azure/main.tf, site.tf      a choudoufu estate: a Container Apps site and its network, through azurerm
gcp/src/site.ts             Cloud Run behind a global load balancer (PublicCloudRun, PrivateEgressNetwork)
*.component.ts              one component per chant member: how it deploys
                            (aws/ at its root, beside its stacks; the others in src/)
scripts/emulators-up.sh     boots floci, floci-az (with TLS) and floci-gcp, then `choudoufu init` in azure
scripts/front-door.ts       the Op's steps: apply, turn Azure off, wait, export; and plan
```

The composites are the lexicons' own. Each chant member is one component. aws
deploys with `cfn-deploy`. gcp runs its member's apply from
`scripts/front-door.ts` (`apply-gcp`) until its lexicon has deploy steps of
its own (chant#4273). dns has two components. `azure` stands for the azure
member: its one step, `member-outputs`, reads the estate's outputs through
choudoufu and applies nothing. `records` builds the dns template with
`build-dns`, which fills in awsEndpoint and gcpEndpoint from what is applied
and points each health check at the emulator that answers for it, then
deploys it with `cfn-deploy`, its azureEndpoint parameter wired to
`stackOutput("azure", "azureEndpoint")`.

azure is a choudoufu estate (INTENTIUS/choudoufu#2246), the resources the
azure lexicon's ContainerAppNetwork and ContainerAppSite declared, written in
HCL with a `live` block. Its provider block reaches floci-az the way
choudoufu's own floci-az estates do, every endpoint and credential stated.
`apply-azure` plans it with the terraform lexicon's `choudoufuPlanSet` and
applies that set with `choudoufuWaveApply`, under the same floci-az endpoint
lock. Its records stay in `azure/.tofu-records`.

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
planned again against the value it applied as. aws and gcp still reach dns
through `build-dns`.

The `azure` component needs a chant with `member-outputs` (chant#4455, on
chant's `integration/choudoufu-engine`). No released chant has it yet, and
0.124.52, which this directory installs, does not. Until one does, link
chant and its terraform lexicon from a checkout of that branch: `npm link` in
its `packages/core` and `lexicons/terraform`, then `npm link @intentius/chant
@intentius/chant-lexicon-terraform` here after `npm install`. `npm run front-door`
needs it too, since it runs dns's components.

## One change set

```sh
npm run change-set     # writes .front-door/change-set.json, applies nothing
```

That plans the four members into one change-set document under one digest: a
chant part each for dns, aws and gcp (`chant lifecycle plan local --json`),
and a choudoufu part for azure (`choudoufuPlanSet`).

## Run it

```sh
npx @intentius/behold demo three-cloud
```

Or by hand, from this directory (needs Docker, and choudoufu on PATH or
named by CHOUDOUFU_BIN; on a Mac, the floci-az certificate choudoufu's
`scripts/floci-az-mac-cert.sh` makes, trusted once):

```sh
npm install
npm run emulators      # floci :4566, floci-az :4577, floci-gcp :4588
npm run front-door     # apply, turn Azure off, wait for Route 53, export to ./export
npx serve export
```

`cd dns && npx chant run front-door` runs the same steps as an Op.

Needs a chant with `member-outputs` (see above).
