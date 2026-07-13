# behold-example

A tiny AWS chant project behold serves in local dev and e2e. One `VpcDefault`
(a VPC + subnets), `prod` environment, chant-ownership marker.

Its `node_modules` (chant + the aws lexicon) are **not** committed — `just
example-install` (or `npm install` here) pulls published chant. That install is
part of the e2e: behold shells the project's own chant, so the project decides the
chant version.

- `behold serve example` → the source graph (offline, no creds).
- `behold serve example --env prod` → the live source-anchored overlay (queries
  CloudFormation; needs AWS credentials).
