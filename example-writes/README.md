# Your first apply with behold

The smallest real thing: one S3 bucket, deployed from the browser by clicking
**Sync**. It exists to show where the delegated-write buttons come from and what
they do — behold never applies anything itself, it triggers the `ApplyOp` you
committed here, running `chant` on your machine.

```
src/bucket.ts        one S3 Bucket + a TLS-only policy (the whole "infra")
ops/apply.op.ts      ApplyOp "prod-apply" — code → real AWS (aws cloudformation deploy)
ops/floci.op.ts      Op "floci-apply" — code → local Floci (CloudFormation API), no account
ops/reconcile.op.ts  ReconcileOp "prod-reconcile" — cloud → code PR (the Adopt button)
chant.config.ts      lexicons [aws, temporal], environments [prod]
```

The **Sync** button appears because a project declares an `ApplyOp`. A project with
no `*.op.ts` (like `../example`) shows no Sync — that's expected, not a bug.

## Creds-free: deploy to a local emulator (`--local`)

No AWS account? Serve with `--local` and behold boots a local Floci emulator
(needs Docker), then the **floci-apply** Op deploys the bucket to it — the same
delegated-write path, zero cloud creds:

```sh
# from the behold repo root
npm run dev -- serve example-writes --local
#   → boots chant-floci, header shows "● local · chant-floci up"
```

Click **floci-apply** (or `curl -XPOST localhost:4600/api/ops/floci-apply/run`).
The now-line streams Build → Apply → Verify; the bucket is created in Floci via
the CloudFormation API (`awsApply`, no `aws` CLI). The emulator is torn down when
you Ctrl-C. Everything below uses real AWS instead.

## Prerequisites

- Node 20+, and **AWS credentials** in your environment (`aws sts get-caller-identity`
  should work). The apply creates a real S3 bucket via CloudFormation — a few cents,
  torn down at the end. behold holds no creds; `chant` uses yours on this machine.
- One edit: S3 bucket names are **globally unique**, so change `BucketName` in
  [`src/bucket.ts`](src/bucket.ts) to something of your own (e.g. include your AWS
  account id or a random suffix).

## Steps

```sh
# from this directory — installs the project's own chant + lexicons
npm install

# from the behold repo root — serve this project, with the prod overlay on
npm run dev -- serve example-writes --env prod
#   → behold → http://localhost:4600
```

1. Open **http://localhost:4600**. You see the declared graph. With `--env prod`,
   the bucket node is **blue (pending)** — declared, not deployed yet. (No AWS creds?
   drop `--env` for the plain source graph; Sync still works, you just won't see the
   colour flip.)
2. In the header, click **Sync**. The now-line streams the Op's phases:
   `▶ chant run prod-apply` → Build → Plan → **Apply** (`aws cloudformation deploy`).
   `prod-apply` is **ungated**, so it applies straight away — no approval step.
3. When it finishes, the `store` node flips **blue → green (managed)**. Click it: the
   inspect panel's **live** section shows the bucket's observed **physical id** and
   status. That's the hydration — the cloud's view of your declared resource.
4. Click **Refresh** any time to re-check drift and drop a lanes frame.

## What "gated" looks like

`prod-apply` here is additive and ungated, so Sync applies in one click. Make it
gated and Sync starts the Op but **pauses** at an approval gate — behold then shows
an **Approve** button that signals the gate (a durable Temporal wait). Authority for
the destructive step stays with a human:

```ts
ApplyOp({ name: "prod-apply", env: "prod", target: "cloudformation", delete: "gated" });
```

## Tear down

```sh
aws cloudformation delete-stack --stack-name prod
aws cloudformation wait stack-delete-complete --stack-name prod
```

Or try the **Adopt** button on a *foreign* node (one that's in the cloud but not in
source) — it triggers `prod-reconcile`, which opens a PR pulling live back into
typed source. behold never writes source directly; a human merges the PR.
