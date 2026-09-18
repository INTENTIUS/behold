# example-terraform-estate

A multi-root Terraform estate, declared only. No cloud account, no Docker, no
`terraform` binary — behold reads the HCL through chant's terraform lexicon and
draws what it finds.

```sh
npx @intentius/behold demo terraform-estate
```

## What it declares

Two roots that are applied separately, plus the shared module both are built
on. 25 resources, drawing 37 cards and 31 edges at the `resources` zoom.

| directory | what it is |
|---|---|
| `envs/prod` | The environment root: a VPC with three subnets, a route table and an edge security group, an artifacts bucket with its versioning/public-access/encryption siblings, and two calls to the shared service module. |
| `platform` | The estate-wide root, applied separately: the permissions boundary every service role attaches, a deploy role, the KMS key and alias, an audit log group. It declares **no provider block** — it inherits one where it is used. |
| `modules/service` | The shared module `envs/prod` calls twice. An IAM role and inline policy, a log group, a work queue with its dead-letter queue, a task security group. |
| `backends` | A backend fragment, copied into a root when one is initialised. |
| `envs/dev` | Not built yet. A README and no `.tf`. |

## What each directory is there to show

Discovery has to tell five things apart, and this estate is built to be each of
them. A root is a directory with a `.tf` declaring a line-start `terraform {` or
`provider "` block beside a `resource`, `data` or `module` block, a regex probe
at depth, never an HCL parse.

**`envs/prod` is the obvious root.** Provider block, resources, module calls.

**`platform` is the root that has no provider block.** The naive reading of "a
root configures a provider" would miss it. It is a root because it declares
resources beside a `terraform` block, and it is applied on its own.

**`modules/service` is the case that defeats the probe.** Its `versions.tf` is
byte-for-byte `envs/prod/versions.tf`, the same `required_version`, the same
`required_providers`. Nothing in the file's content says which of the two is a
root. What separates them is that this one sits under a `modules/` segment,
Terraform's own standard module structure, and the roots that call it draw its
blocks already. Drawing it again would double every card in it.

**`backends` has a `terraform` block and nothing to draw.** No resource, no
data source, no module call. It is reported as skipped rather than drawn as an
empty box, a box with nothing in it is a question, and the note answers it.

**`envs/dev` is neither drawn nor reported.** It holds no `.tf` at all, so
there is nothing here that looks like Terraform and nothing to say about it.
Silence is the right answer; reporting it would be noise about every directory
in every repository.

The graph's status line says all of this:

```
2 roots — prod, platform; skipped backends (no resource, data or module block —
nothing to draw), modules/service (called as a module, never applied on its own)
```

## The edge that is not drawn

`platform` declares the KMS key and its alias. `envs/prod` reads it back:

```hcl
data "aws_kms_key" "estate" {
  key_id = "alias/${var.name}-estate"
}
```

That is a real cross-root reference, and it is how a multi-root estate is
actually wired — two roots applied separately, neither a module of the other,
joined by a name one publishes and the other looks up.

**behold draws no edge for it**, and that is deliberate. Both ends carry the
same unresolved `${var.name}` interpolation, so matching them would be a
coincidence of variable naming rather than a relationship either root states.
It was measured on a real estate and refused ([#381]). The data source card says
what it reads instead, which is a claim the estate does make.

Module calls *do* draw: each `module` block expands into its own contents under
`module.checkout/…`, with the reference edges chant's lexicon resolves from the
HCL.

## It needs the lexicon

behold parses no HCL and ships no HCL parser. The reading goes through
`@intentius/chant-lexicon-terraform`, which loads `@cdktf/hcl2json` underneath —
a ~1.8 MB wasm blob. Both are declared as optional peers and behold does not
install them, so that every user who serves an ordinary chant project does not
carry an HCL parser they will never run:

```sh
npm install --no-save @intentius/chant-lexicon-terraform @cdktf/hcl2json
```

Without them the demo refuses with that exact line and says where it looked.

## Not the carve demo

`behold demo carve` also involves Terraform and answers a different question.
This estate asks **what is in my Terraform** — draw it, box it by root, tell the
roots from the modules. The carve demo asks **what would it cost to leave**:
`chant carve advise` ranks each resource by peelability and the walkthrough
carves one across the line.

Nothing here is being migrated. There is no chant project beside it, no
peelability score on any card, and no stepper.

[#381]: https://github.com/INTENTIUS/behold/issues/381
