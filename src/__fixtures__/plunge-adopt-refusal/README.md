# plunge stack adopt --json, a per-resource refusal (to be recorded)

behold#1007 needs one recorded `plunge stack adopt --json` refusal whose refusals name resources by URN.
`src/pulumi-adoption.test.ts` ("reads a recorded per-resource refusal ...") reads it and is skipped until it
is here. The recording is an epic-ready task for epic:engine-ship round 2. Nobody writes or edits the file by hand.

## The file

`refused-pending-operations.json` in this directory: the stdout of one real run, byte for byte, with nothing
replaced (the checkpoint path included). The test requires:

- `"adopt": "v1"` and `"status": "refused"`;
- at least one refusal with code `pending-operations`, and every such refusal carrying a `urn`
  (`urn:pulumi:<stack>::<project>::<type>::<name>`).

Other refusals in the same document are fine; the test checks behold keeps all of them in plunge's order.

## How to record it

On scratch pinned floci only (choudoufu `live/floci-image`), with `PULUMI_BACKEND_URL=file://<scratch dir>`
and `PULUMI_SKIP_UPDATE_CHECK=true`, never a real cloud or the machine's default backend:

1. Deploy the plunge corpus's aws-ts program (`tests/plunge-corpus/aws-ts`, stack `floci`) with stock pulumi
   v3.272.0, as the recordings in `../plunge-adopt-30806be26b/` were made.
2. Leave a pending operation in the checkpoint from a real run: start a stock `pulumi up` that creates a new
   resource and kill the process (SIGKILL) while the create is in flight, so the checkpoint keeps a
   `pending_operations` entry. Do not add the entry to an exported checkpoint by hand.
3. Run `plunge stack adopt --json --stack floci > refused-pending-operations.json` with plunge built from
   plunge main (or a later integration commit). It exits 1 and writes nothing.
4. Add a line below naming the plunge commit, the pulumi version and the date.

## Recorded

Recorded on 2026-10-26 for epic:engine-ship round 2: plunge v0.1.0-dev.0 (pulumi-compatible v3.272.0), built
from INTENTIUS/plunge `integration/engine-ship` at d7653de7f5, against a stock pulumi v3.272.0 stack of
`tests/plunge-corpus/aws-ts` from the same plunge commit (stack `floci`, `corpus:prefix` set to `rec-r2-1007`),
deployed to pinned floci (`ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec`)
with `PULUMI_BACKEND_URL=file://<scratch>/state-1007`. The second stock `pulumi up` raised `corpus:workerCount`
from 3 to 10 and was killed with SIGKILL as soon as the checkpoint showed a pending operation, which left seven:
`updating` on `db-password` and `creating` on worker-3, -4, -5, -7, -8 and -9. Then
`plunge stack adopt --json --stack floci` with `PULUMI_BACKEND_URL=plunge+file://<scratch>/state-1007` exited 1,
wrote nothing, and printed this file. The checkpoint path in `checkpoint.source` is the recorder's real scratch path.
