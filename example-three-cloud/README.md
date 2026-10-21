# three-cloud

A small website in AWS, Azure and GCP behind Route 53, as a chant workspace on
the floci emulators. It is behold's `three-cloud` demo, and its exported page
asks one question: turn Azure off, and where does traffic go?

```
chant.workspace.json      the workspace: dns, aws, azure, gcp
dns/src/route53.ts        hosted zone, a health check and a latency CNAME per cloud
dns/ops/front-door.op.ts  the Op that rebuilds the page
aws/src/site.ts           ECS on Fargate behind a load balancer (FargateAlb)
azure/src/site.ts         a Container Apps environment and app
gcp/src/site.ts           Cloud Run (CloudRunServiceComposite)
scripts/emulators-up.sh   boots floci, floci-az and floci-gcp
scripts/front-door.ts     the Op's steps: apply, turn Azure off, wait, export
```

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

Needs chant 0.124.35 or newer.
