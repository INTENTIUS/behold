# three-cloud

A small website in AWS, Azure and GCP behind Route 53, as a chant workspace on
the floci emulators. It is behold's `three-cloud` demo, and its exported page
asks one question: turn Azure off, and where does traffic go?

```
chant.workspace.json        the workspace: dns, aws, azure, gcp
dns/src/route53.ts          hosted zone, and a latency entry per cloud (HostnameEntry, AddressEntry)
dns/ops/front-door.op.ts    the Op that rebuilds the page
aws/src/site.ts             ECS on Fargate behind a load balancer (FargateAlb)
azure/src/site.ts           a Container Apps site and its network (ContainerAppSite, ContainerAppNetwork)
gcp/src/site.ts             Cloud Run behind a global load balancer (PublicCloudRun, PrivateEgressNetwork)
*.component.ts              one component per member: how it deploys
                            (aws/ at its root, beside its stacks; the others in src/)
scripts/emulators-up.sh     boots floci, floci-az and floci-gcp
scripts/front-door.ts       the Op's steps: apply, turn Azure off, wait, export
```

The composites are the lexicons' own. Each member is one component. aws
deploys with `cfn-deploy`. azure and gcp run their member's apply from
`scripts/front-door.ts` (`apply-azure`, `apply-gcp`) until their lexicons have
deploy steps of their own (chant#4273). dns runs `apply-dns`, which points
each health check at the emulator that answers for it.

Each cloud publishes its endpoint with `output()` and `dns` reads it as a
parameter of the same name.

## Run it

```sh
npx @intentius/behold demo three-cloud
```

Or by hand, from this directory (needs Docker):

```sh
npm install
npm run emulators      # floci :4566, floci-az :4577, floci-gcp :4588
npm run front-door     # apply, turn Azure off, wait for Route 53, export to ./export
npx serve export
```

`cd dns && npx chant run front-door` runs the same steps as an Op.

Needs chant 0.124.39 or newer.
