# plunge stack adopt --json, recorded

Recorded on 2026-10-26 for INTENTIUS/chant#4475 and behold#1007: plunge v0.1.0-dev.0 (pulumi-compatible v3.272.0),
built from INTENTIUS/plunge `integration/engine-ship` at 30806be26b, on a stock pulumi v3.272.0 stack of the
plunge corpus's aws-ts program (`tests/plunge-corpus/aws-ts`, stack `floci`) deployed to the floci emulator.
The DIY checkpoint root's local path is replaced with `/srv/rec-4475/state-adopt`.

- `would-adopt.json`: `plunge stack adopt --json --stack floci`, nothing written.
- `adopted.json`: the same with `--yes`.
- `already-adopted.json`: `--json` again after the adoption.
- `refused.json`: `--json` after a stock `pulumi refresh --yes` changed the checkpoint, refused with
  `adopted-from-another-checkpoint`.
- `unknown-fate.json` is written by hand: a fate no plunge prints, for behold's unknown-fate path.

Every AWS resource is classed `pending` at classification, since adoption loads no provider schema, and `stack`
is the name as given on the command line.
