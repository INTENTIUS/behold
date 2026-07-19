# M1.0 spike — the chant CLI contract for the component graph

Deliverable of #55. Every M1.x issue (#56–59) reads this. It records the exact
commands, the IR shapes, the component→stack correlation key, and the Floci
endpoint decision — verified against `~/checkouts/intentius/loomster` on Floci,
no AWS account.

Answers are **copy-pasteable**. Where an assumption turned out wrong, the note
says so and gives the workaround.

> **Environment gotcha that cost the spike a detour — read this first.**
> `~/checkouts` is a symlink to `~/Documents/checkouts`; both resolve to one
> checkout. Commands must run through a shell env where `chant.config.ts` loads
> (see Q1) and, for anything `--live`, with `LOOM_ENV=local` and the Floci env
> exported (Q3). `chant lint .` walks the git-ignored `vendor/` tree (the
> vendored Loom app, pulled by `npm run vendor`) — its EVL errors are **not**
> loomster's code; see Q1.

---

## TL;DR for the downstream issues

| Issue | Command it depends on | Status |
|---|---|---|
| **#56** render the DAG | `chant graph src --components --format ir` / `--format layout` | ✅ works **after a chant change** (shipped in this spike; see "chant changes") |
| **#57** live AWS status | per-component CFN stack status (`loom-<env>-<instance>-<component>`) | ⚠️ works via CFN stack status; chant's `--live` observation does **not** see loomster's multi-stack layout — see Q2 |
| **#58** CI projection | `chant build --components --generate gitlab` | ✅ works today, unchanged |
| **#59** unify + e2e | all of the above | join key across all three = **component name** |

**The one join key that ties it together:** the component-DAG nodes (#56), the
live status (#57), and the CI jobs (#58) are all keyed by **component name**
(`shared-foundation`, `loom-db`, …). No cross-substrate overlay (chant #821) is
needed — the spine is the component DAG from source; status and CI facets hang
off each node by name. This is exactly the epic's design.

---

## Q1 — the component-graph IR (blocks #56)

### Command

```bash
# from the served project root (behold's graphPath() passes <project>/src)
chant graph src --components --format ir       # component DAG as GraphIR JSON
chant graph src --components --format layout    # dagre node positions (pinhole)
chant graph src --components --format mermaid    # wave-laned flowchart (diagnostics)
```

`--components` **with a view format** now projects the *component DAG* into that
format. Without a format it prints the same waves/edges as text; with a format
but without `--components` you get the AWS *entity* graph (all resources) — a
different thing. behold wants the component projection: one node per component.

### IR shape (paste sample)

```json
{
  "nodes": [
    { "id": "shared-foundation", "kind": "Component", "lexicon": "chant", "attrs": { "wave": 1 } },
    { "id": "loom-backend",      "kind": "Component", "lexicon": "chant", "attrs": { "wave": 3 } }
    // 7 total: the 6 components + downstream-stub
  ],
  "edges": [
    { "from": "downstream-stub", "to": "shared-foundation", "kind": "ref" },
    { "from": "loom-backend",    "to": "loom-db",           "kind": "ref" }
    // 9 total — dependsOn, consumer → producer
  ],
  "groups": {
    "byWave": {
      "wave-1": ["loom-cognito", "shared-foundation"],
      "wave-2": ["downstream-stub", "loom-db", "loom-frontend"],
      "wave-3": ["loom-backend"],
      "wave-4": ["loom-agents"]
    }
  }
}
```

- **nodes** = components. `id` = component name (the join key). `attrs.wave` =
  1-based wave, so a renderer can lane by it without reading `groups`.
- **edges** = `dependsOn`, `from` (consumer) → `to` (producer). Matches the
  committed `.gitlab/components.yml` `needs:` exactly.
- **groups.byWave** = `wave-N → [component ids]`, the parallel-safe deploy waves.
  `IRGroups.byWave` is new (added this spike); a wave-laned renderer reads it the
  way it reads `byStack`. `--format layout` also honours it via dagre ranks.

Waves and edges match loomster's `src/gitlab-pipeline.test.ts` expectations
exactly (4 waves; the 9 dependsOn edges).

### The blocker this spike had to clear (why #56 would have failed cold)

behold renders via `chant graph … --format ir/layout`. Two things made that
refuse against loomster, **neither of them loomster's fault**:

1. **`chant graph … --format ir` had no component-DAG output at all.** Every view
   format emitted the AWS *entity* graph; `--components` only changed the *text*
   output. There was no renderable component DAG. → Fixed by a chant feature
   (below).
2. **The lint gate refused to emit.** `chant graph --format ir` gates on
   `chant lint`, and lint (a) walked the git-ignored `vendor/` tree (the vendored
   Loom app — ordinary TS full of dynamic access the EVL rules forbid) and (b)
   when scoped to `src`, dropped loomster's project-root-relative
   `lint.overrides` (`src/lib/**`, `src/local/**`), resurfacing false positives.
   → Fixed by two chant changes (below).

It is **not** a chant version regression (core is byte-identical 0.18.25→0.18.26)
and **not** a loomster defect (its `chant.config.ts` already disables those EVL
rules for the right paths; CI is green because CI lints without `vendor/`
present).

---

## Q2 — live AWS status per component (blocks #57)

### Correlation key: component ↔ CFN stack

loomster deploys **one CloudFormation stack per component**, named:

```
<ownership.stack>-<env>-<instance>-<component>
```

On Floci (`LOOM_ENV=local`, instance `a`) that is:

```
loom-local-a-shared-foundation
loom-local-a-loom-cognito
loom-local-a-loom-db
loom-local-a-loom-frontend
loom-local-a-downstream-stub
loom-local-a-loom-backend
loom-local-a-loom-agents
```

So the **correlation key is the CFN stack name**: match a live stack to its
component by the suffix after `<stack>-<env>-<instance>-`. Robust approach for
behold: `list-stacks` filtered to prefix `loom-<env>-` and map suffix → component
(don't hard-code the instance letter).

All 7 stacks read `CREATE_COMPLETE` on a fresh `just local-up`.

### ⚠️ chant's `--live` observation does NOT see loomster's stacks on Floci

Both `chant graph src --live --env local` (**0 nodes**) and
`chant components status local --live --json` ("nothing observed live" for all 7)
fail to surface the provisioned resources. Root cause, in
`@intentius/chant-lexicon-aws/src/plugin.ts` (`describeResources`, ~L496):

```js
// single-stack convention is the stack named after the environment (#932).
const stackName = options.stack ?? `${options.environment}`;
```

The AWS lexicon assumes **one stack named after the env**. loomster is
**multi-stack, per-component**, so the observer queries a non-existent stack
`local` and finds nothing. `chant components status --live` therefore reflects
only the **release ledger** (`chant run --components` auto-records a digest), and
only the two image-publishing components (`loom-backend`, `loom-frontend`) get a
record — the other five show `unrecorded`. So neither built-in path gives usable
per-component live status on this layout today.

### Recommended M1.1 data path (for #57)

Color each component-DAG node by its **CFN stack status**:

```bash
# per component, or one list-stacks + client-side suffix match
aws cloudformation describe-stacks --stack-name loom-<env>-<instance>-<component> \
  --query "Stacks[0].StackStatus"     # CREATE_COMPLETE=green, *_IN_PROGRESS=amber, *_FAILED/ROLLBACK=red
```

This works on Floci today (verified: all 7 `CREATE_COMPLETE`) and needs no
overlay. **Open decision for #57 dispatch** (see the epic thread): behold is
meant to shell chant, not raw `aws`. Options —
(a) behold shells `aws cloudformation` for stack status (fastest, but not
"shell chant only"); (b) a third chant change so `chant components status --live`
resolves per-component stack names from the component→stack naming and observes
each (correct, larger — an aws-lexicon fix, sibling to the two shipped here);
(c) `chant graph --live` gains a per-component-stack mode. Recommend (b) as a
follow-up chant issue; #57 can start against (a) to unblock, keyed by component
name either way.

**Do not** use `chant graph --live --overlay` / `sourceAnchoredOverlay` — it
throws (chant #821), and the epic forbids the cross-substrate overlay. Status is
single-substrate AWS per component, joined to the node by component name.

---

## Q3 — the Floci endpoint (single source of truth)

**Decision: loomster's `just local-up` Floci is the single source of truth
(`localhost:4566`). behold serves against it WITHOUT `--local`, inheriting the
endpoint from the environment.**

Why not `--local`: behold's `--local` runs `chant emulator up`, which boots a
**second** Floci named `chant-floci` and maps host `:4566` — a port clash with
loomster's `floci` container (behold #52 stops it from killing the shared one,
but two emulators is still the wrong model here).

Run loop:

```bash
# 1. loomster brings up Floci (:4566) and provisions all components
cd ~/checkouts/intentius/loomster && just local-up

# 2. behold serves against that Floci — note: NO --local; export the Floci env,
#    and LOOM_ENV=local so loomster's chant.config `environments:[LOOM_ENV??"dev"]`
#    accepts `--env local` (otherwise `--env local` is rejected as unknown).
cd ~/checkouts/intentius/behold
LOOM_ENV=local \
AWS_ENDPOINT_URL=http://localhost:4566 \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
  npm run dev -- serve ~/checkouts/intentius/loomster --env local
# → http://localhost:4600
```

behold's chant shell-outs inherit `process.env`, so the exported
`AWS_ENDPOINT_URL` + `LOOM_ENV` reach every `chant` call. `--env local` turns on
behold's live path.

> **`just local-up` note:** steps 1–3 (Floci + synth + `chant run --components
> all`) succeed and provision all 7 stacks — enough for #56/#57. Step 5 (app-tier
> `.env` from stack outputs) currently fails (exit 254) on this machine; it wires
> the browsable Loom app tier, not the AWS graph, so it does not block the graph
> or the live status. Track separately if the demo app tier is needed.

---

## chant changes this spike shipped

These land in `~/checkouts/intentius/chant` (`packages/core`). tsc clean; 970
tests pass in the touched areas (15+ new). **They are not yet published** —
loomster/behold consume `@intentius/chant@^0.18.26` from npm. Delivery: publish
a chant patch (e.g. 0.18.27) and bump both pins; interim for local work is the
running checkout / a node_modules patch.

1. **Lint respects `.gitignore`** (`cli/commands/lint.ts`): the file scan drops
   git-ignored paths via `git check-ignore`, so `vendor/`, `dist/`, etc. never
   gate the graph. Non-git trees filter nothing.
2. **Lint config anchors on the project root** (`lint/config.ts` `findProjectRoot`
   + `cli/commands/lint.ts`): a scoped lint (`chant lint src`, the `graph
   --format ir` gate) now finds the root `chant.config.ts` and matches
   `lint.overrides` globs relative to the root — so `src/lib/**` applies whether
   you lint `.` or `src`.
3. **Component-DAG view** (`cli/handlers/graph.ts` `runComponentGraphView`,
   `graph-ir.ts` `IRGroups.byWave`, `graph-mermaid.ts`, `graph-dot.ts`):
   `chant graph --components --format ir|layout|mermaid|dot` projects the
   component DAG (nodes=components, `byWave` groups, dependsOn edges) — the graph
   behold renders. Lint-gated like the entity view.

Still open (candidate follow-up chant issue): multi-stack per-component **live
observation** so `chant components status --live` reflects Floci (Q2).

---

## Handoff order

`#55 (this) → #56 → (#57 ∥ #58) → #59`. #56 is unblocked by the chant changes
above. #57 and #58 are independent once #56 lands; #57 carries the open live-
status decision (Q2). #59 unifies and proves e2e — the join key throughout is the
component name.
