# Driving behold (for agents)

behold is a **read-only control plane** over a chant estate, with **delegated,
gated** writes. As an agent you drive it the same way a human does — and the
mutating capabilities are chant's MCP Op tools, not behold's, so nothing here holds
apply creds.

## The division of labour

- **behold** serves the live, mixed-substrate graph (and, later, the deployment-lanes
  timeline). It reads; it never mutates.
- **chant's MCP** is where the real capabilities live. Prefer it over shelling.
  - Reads: `lifecycle-diff`, `lifecycle-snapshot`, `build`, `lint`.
  - Actions (delegated writes): `op-run` (start an `ApplyOp`/`ReconcileOp`),
    `op-signal` (approve a gate), `op-status` / `op-report` (watch it).

## Getting a server

```sh
npx @intentius/behold serve <chant-project-dir> --port 4600   # or: preview / demo / doctor
```

`behold demo` needs no project at all — it copies the bundled example and serves
it against a local emulator (Docker). A directory that is not a chant project
gets a structured `{code: "no-project"}` error from `/api/graph`, not a blank
graph.

A running server offers the same catalog over HTTP (#268): `GET /api/demos`
lists every bundled demo with `{name, description, requires, satisfiable,
reason?, fetches, repo?, target, loaded}` — `satisfiable` is doctor's PATH probe
for that demo's `requires`, and `fetches` marks the one kind of entry that
reaches the network (a git demo is cloned). `POST /api/demos/open` with
`{name}` loads it and switches the served project to it: the same copy/clone →
install → setup the CLI runs, then an in-place switch. It takes a catalog
**name** and never a path, so it cannot be aimed outside the install; it is
preview-locked, and one load runs at a time (409 otherwise).

## The read loop

0. **discover** — GET `/api` lists every route with a one-line description,
   plus the server's version and a link back to this guide. Before the server
   exists (or when a route answers with an error you'd have to guess at), run
   `npx @intentius/behold doctor <dir> --json`: a read-only diagnosis of the
   project's kind, its own chant install and version, declared lexicons, the
   envs the picker will infer, the bound kube context versus the ambient one,
   substrate readiness and committed Ops. Each check is
   `{name, status: pass|warn|fail, detail, fix}`; the process exits non-zero
   iff something failed. It starts no server and changes nothing.
1. **observe** — GET `/api/graph` (JSON: `{ ir, svg, meta }`). The mixed graph
   of the project, every node with `id`/`kind`/`lexicon`/`attrs`/`sourceLoc`. Drift
   status, when present, is `attrs._status` (`good`=managed, `warn`=foreign,
   `accent`=pending, `neutral`=unobserved, `runtime`=runtime child). With
   `?env=`, `/api/overlay` is the live entity overlay; `/api/diff?env=` slices
   per-node observed state, drift and field ownership; `/api/reconcile?env=`
   summarizes the pending change set; `/api/substrates` reports substrate
   readiness; `/api/events` (SSE) pushes `changed`/`op`/`apply`/`run`/`pr`.
   With `?components=1&env=`, each component node carries `_liveStatus` (the
   `chant components status` verdict) and, when the release ledger recorded
   one, `_release` — `{runId, forge, originSource, url?, gitSha, digest,
   timestamp, actor, approver?}` (#165). `url` is present only when the record
   itself carries an address (chant#2045); `originSource: "inferred"` means
   behold read the id's spelling and nothing more, and a `forge: "unknown"` id
   is never resolved to a link on behold's guess.
   `?ops=1` is the ops lens — the project's declared Ops as a phase track, read
   from each emitted `dist/ops/<name>/op.json`, with the current run painted
   over it (`meta.run`, `meta.gate`); `/api/ops/<name>/status` reads that Op's
   durable run status and pending gate (`chant run status --temporal`). A
   `ConvergeOp` also gets one card per rule from its `convergeTick` step's
   `args.rules` (`attrs._step: "rule"`), carrying `when` (chant's JSON predicate,
   rendered as the condition it states), `then`, and the `why` chant requires of
   every rule, verbatim. `then: run(<op>)` is an edge to that Op's first step
   when the Op is in the rendered set, and `attrs.dangling` when it isn't.
   `meta.operator` on that same lens names the ConvergeOps the project declares
   (chant's own `searchAttributes.Converge === "true"`, read from op.json — no
   subprocess), and `/api/operator/status` fills the strip in from
   `chant operator status --json`.
2. **focus** — narrow with chant graph options as query params: `?detail=0..3`,
   `?components=1`, `?logical=1`, `?lens=blast:<id>&down=1`, `?lens=lexicon:aws`,
   `?env=`, `?stack=`, `?tier=`, `?target=`.
3. **inspect** — a node's `sourceLoc.file` is the typed source that declared it;
   edit there to change the estate (chant is the source of truth, not behold).

## The carve loop (Terraform → chant, #230)

`behold carve <report.json>` serves a `chant carve advise --json` peelability
report instead of a chant project. Same SPA, same `/api/graph` shape; `attrs.
_status` carries the band (`good` = carve now, `warn` = has boundary work,
`neutral` = leave in Terraform) and `attrs` carries the score arithmetic
(`score`, `arithmetic`, `inbound`, `outbound`, `tier`, `mapsTo`).
`GET /api/carve` returns the raw report verbatim.

To move a resource: confirm its band on `/api/carve`, then run chant's own
`carve emit --state` and `carve bridge` in the project. `terraform state rm` and
applying the generated survivor rewrites stay a human gate — behold has no
endpoint that writes Terraform, and adding one would break the invariant below.

### Carve state, from chant's manifests (#230 M3)

chant ≥ 0.52.2 writes `<address>.carve.json` into `carve emit --output`; `carve
bridge` and `carve apply` add their own records to the same file. behold reads
those and never writes one, so the progression is on disk rather than in a
session.

`GET /api/project`'s `carve.state` publishes it: `{manifests, progress:
{applied, bridged, emitted, inFlight, total, label, detail}, states[], apply:
{human, note}}`. Each entry carries `target`, `stage`
(`emitted`/`bridged`/`applied`), `graduated`, `note` and a retypeable
`applyCommand`. The same field appears on an ordinary `behold serve` whose
project directory carries a carveout — no report and no demo needed — and is
absent entirely when nothing has been carved.

In the graph, an `applied` address draws inside the chant member box (keeping
its Terraform address as its node id) instead of in a band; `emitted` and
`bridged` stay banded with `attrs._status: "accent"` and the stage in
`attrs.carve`. Only `applied` means ownership moved.

**There is no `/api/carve/apply`.** `chant carve apply` graduates ownership;
behold renders what the manifest records and echoes the command. Do not add the
endpoint — src/carve-manifest.ts `APPLY_IS_HUMAN` is the statement of it, and
src/carve-actions.ts and src/server.ts both carry the refusal where the route
would go.

### The walkthrough (`behold demo carve`, #254)

`behold demo carve` copies a bundled half-migrated estate (a chant project
beside a Terraform one), runs the advisor over the copy, and serves the same
carve view plus a six-step stepper on the panel's Carve tab: advise → pick →
emit → bridge → handoff → done.

Two of those steps are POST routes, and they exist **only** in a demo copy:

- `POST /api/carve/emit` — body `{select}`; runs `chant carve emit --state
  --select <addr> --output <copy>/app/carveout` and then `chant lint` on the
  result. Answers `{select, command, output, artifacts[], boundary, lint,
  buildCaveat}`.
- `POST /api/carve/bridge` — body `{select}`; runs `chant carve bridge`
  **without** `--apply-rewrites`. Answers `{select, command, output, runbook,
  proposals[]}`.

`GET /api/project`'s `carve.demo` says whether they can act (`runnable`, plus a
`reason` when not). `select` must name a resource the served report ranks;
anything else is a 400. Outside a demo copy both routes answer 403
`{code: "read-only"}`, and on an ordinary project serve they don't exist at all.

The gate the Emit step reports is `chant lint`, not `chant build` — chant#1637
means `build` fails on the emitted bucket. Don't read a lint pass as a build
pass.

There is still **no** endpoint that runs `terraform`. The handoff step hands
back the runbook's commands as text.

## The act loop (delegated, never direct)

behold does not apply. To change the estate:

1. Edit the chant `.ts` source (the node's `sourceLoc`), or
2. Trigger a committed Op via chant's MCP:
   - `op-run <name>` — start the project's `ApplyOp` (code→cloud) or `ReconcileOp`
     (cloud→code PR).
   - `op-signal <name> <gate>` — approve a gate (e.g. a destructive apply).
   - `op-status <name>` — watch phases; `op-report <name>` — the run report.

Every mutation is a gated, durable Temporal workflow with a human-confirmable gate
and saga rollback. There is no behold endpoint that mutates the cloud.

A run behold triggered is asked for structured per-step records (chant#1676:
`--progress-json` on the durable path, `--json` on the local one), so the ops
lens paints the run over the declared track and a pending gate renders as a card
with an Approve button. That button is `op-signal` — the same delegated write —
and nothing else about the run is behold's to decide: a stream that dies leaves
the playhead at the last settled step and says so, and a gate paints as pending
only when chant's `gateState` query named it.

### The executor contract (#165, #61)

`.behold.json` may designate which forge deploys an environment:

```json
{ "executor": { "prod": { "forge": "github", "workflow": "deploy-prod.yml" } } }
```

It designates the committed WORKFLOW, not just the forge: two environments'
generated pipelines carry identical job ids, so a picker cannot tell them
apart, and a contract that names prod must not sit on a guess. For a
designated env, `POST /api/apply` and a committed ApplyOp's `/api/ops/:name/run`
answer `409 {code: "executor-forge"}`, auto-sync declines out loud, and the
only deploy is `POST /api/ci/dispatch?env=<env>`, which runs the designated
workflow through the operator's own `gh` and follows it on the dial. Any
approval the workflow's environment requires is granted on the forge by a
GitHub identity behold does not have; the dial links the run's page and offers
nothing else. Fail-closed: a designation behold cannot honour (a typo'd forge,
a missing or non-dispatchable workflow, a forge with no trigger here) disables
Deploy for that env with the reason on `/api/project`'s `executor` block, and
never falls back to running it here. `/api/project` reports `{forge, workflow,
ok, reason?}` per designated env.

Without a designation, dispatch picks the committed workflow named for the env
(`chant-components-<env>`, chant ≥ 0.54.0); on the older job-overlap match it
refuses a tie rather than letting directory order choose, and a workflow named
for another env never stands in. `just e2e-ci-github` proves the contract
against the real forge (example-ci + `.github/workflows/behold-e2e-dispatch.yml`),
including the `lost` verdict, which `BEHOLD_CI_FOLLOW_TIMEOUT_MS` and
`BEHOLD_CI_POLL_FAIL_BUDGET` let a run force on purpose; a lost run is the one
`POST /api/ci/readopt` re-follows. The same e2e dispatches into an environment
with a required reviewer (`behold-e2e-gated`): the run holds at `waiting`, the
progress state carries `waiting: true` and the run's `url`, the now-line says
the approval is granted on the forge, and a cancellation lands as `failed`.

A dispatched run is followed honestly (#165 §6, PR #350): only GitHub's own
`completed` + conclusion paints `ok`/`failed`; a poll-failure budget or the
follow deadline promotes the run to `lost` (chips frozen at last-observed,
the run possibly still live at its own page), never to a verdict. The adopted
run id is persisted as one JSON per project under `~/.behold/ci-runs/` — the
operator's machine-state, outside the project tree, so the Invariant below
still names the whole in-project write surface. `GET /api/ci/run` reads the
record; `POST /api/ci/readopt` (also attempted once at boot) re-follows an
unconcluded run by its saved id, so a restart mid-deploy leaves the run a
reader instead of nothing.

## The operating loop (a strip, a timeline, and a gate that is not the run gate)

A project that declares a `ConvergeOp` gets an operator strip on the ops lens:
per loop, the last tick's own log line (verbatim, with its instant), the lease,
and how many gates are pending. **One** tick — `chant operator status` keeps only
`records.at(-1)` — so the strip is never a timeline, and it says so.

The timeline is its own read: `GET /api/operator/log` → `chant operator log
--json` (chant#2029), the tick records and the gate resolutions against them
merged oldest-first. It lives in a panel that grows from the strip, and two rules
hold it there. It is **pulled**, on the click that opens it and never on a timer.
And it is **bounded** — `--limit` on every invocation, 50 by default and 200 at
most, `--since` when asked — because the ledger grows one line per tick forever;
the answer reports the window it used, so a full one can't read as the end of
history. The route checks the project's chant version *before* it spawns: below
0.53.1, `chant operator log` resolves to `chant operator`, the tick daemon, and
behold reading a history must never become behold running an operator.

Since chant 0.53.1 (chant#2027) a tick record carries an `id` and the
per-component verdicts it derived, and both ride through to
`[].lastTick.{id,components}`. The strip line names the tick (truncated), and
the verdicts join onto the component DAG by component name — the same key the
live `chant components status` read is joined by. They join **under** that read:
a tick only ever feeds the last tier of `componentStatusColor` (the
reconciliation verdict), only on a node the live read left unpainted, and only
while the tick is younger than fifteen of chant's own operator rounds. Past
that it is named on the node, dated, and painted nothing — a graph fill has
nowhere to put "as of an hour ago". A chant older than 0.53.1 sends neither
field and every one of these paths is a no-op.

Two gate cards exist and they are **different acts**:

- The **run gate** — `POST /api/ops/:name/signal/:gate` → `chant run signal`.
  Releases the waiting Temporal workflow.
- The **converge gate** — `POST /api/operator/approve/:op/:gate` →
  `chant approve <op> <gate>`. **Records a fact and unblocks nothing.** chant's
  gate ledger says it outright: the local executor still refuses a gated op,
  resolution or not. The next tick reads the fact. The card says this in its
  body, and the toast after the click says "recorded; the next tick acts on it".

A gate fact carries its address since chant#2028, on both halves, and the card
links it under chant's own words — `approve at: <url>`. The field is optional by
design (a local tick with no PR behind it has none) and never synthesized, so a
fact without one renders no link and no placeholder for one, and a url behold
would not put behind an `href` reads as no address at all.

A gate someone already resolved simply leaves `pendingGates` — the status read
carries no `resolvedBy`/`when` — so the strip shows no resolved-by line rather
than attributing an approval to nobody. The timeline is where resolutions are
named, because there they are records rather than an inference.

An `OperatorStack` (chant#1940) declares the loop as a k8s estate, so it already
appears in the entity graph. behold names it there — the Namespace as the loop's
home, each CronJob as a converge tick — off chant's own
`app.kubernetes.io/component: converge-tick` labels, never a naming convention.

## Invariant

If a request would have behold write to a cloud or to source directly, it's wrong.
behold shows truth and triggers Ops. Authority stays in the committed source and the
executor.

### The exceptions, and their exact size

`POST /api/layout` (#228) writes **one** file in the served project:
`.behold/layout.json` — the hand-layout sidecar, `{version, lenses: {<lens>:
{<node id>: {dx,dy,dw,dh}}}}`. That is the whole of behold's write surface
inside a project, and it does not weaken the invariant above:

- It is **workspace metadata**, not estate truth. Deltas describe how *you* want
  the picture arranged on top of dagre's layout; the graph underneath stays
  chant's, and a delta for a node that left the estate is dropped on read.
- It **never touches the cloud and never touches your source**. No `.ts`, no
  `chant.config.ts`, no `.behold.json`. The path is `cfg.projectDir` + two
  constants — nothing from the request reaches the filesystem.
- It refuses politely when it shouldn't write: preview mode, a static-export
  capture, a read-only project directory, an oversized or malformed body.
- It is **per-user state**, unlike `.behold.json` (config, meant to be tracked).
  Projects should gitignore `.behold/`.

`GET /api/layout` reads it back; `GET /api/graph?layout=1` (and `/api/overlay`)
render with the deltas baked into the SVG, which is how `behold export` and
static snapshots honour a hand layout.

The second exception is the carve walkthrough's two steps above (#254), and it
is narrower still: they exist only when behold booted a `behold demo carve`
copy, they write only into `<copy>/app/carveout/`, and the directory they write
into is a scratch dir behold created inside a directory it copied for you a
minute earlier. `carve bridge` runs without `--apply-rewrites`, so the demo's
own Terraform is not edited either. The only request-derived value is `select`,
and it must be an address the served report already ranks — the value that
reaches the spawn's argv comes from a closed set read off disk. No cloud write,
no Terraform mutation, no edit to anyone's chant source.

## Changing behold (for agents working on this repo)

The sections above are about driving a running behold. This one is about
changing it — the working rules that used to live in a handoff note and now
live here, with the enforceable ones enforced.

- **Branches and merges.** Work on a branch off `main` (an isolated worktree
  when more than one agent is active). `main` is protected by a ruleset: every
  change arrives as a PR, and the `check` job in `ci.yml` must be green before
  it merges. A check that has merely settled is not a pass — read the lines.
  No `gh pr merge --auto`; merge one PR at a time, in order, and rebase the
  next onto what landed.
- **The local gate** is `just check` (tsc, tests, build). Every vitest run
  also writes `.vitest-last.json` (the json reporter, PR #351), and `just
  test` keeps the reporter's full output in `vitest.log` — both gitignored —
  because #334's one-shot first-run failures kept losing the failing file's
  name. If the suite fails once and passes on rerun, those two files from the
  first run are the evidence; attach them to #334 (`jq '.testResults[] |
  select(.status != "passed") | .name' .vitest-last.json` names the file).
- **Releasing** is `just release`, after the version-bump PR merged: it tags
  `behold-v<version>`, pushes the tag (which is what runs `release.yml`), and
  waits for npm to show the version. It refuses in every state where a tag
  push would be wrong. Never re-push a `behold-v*` tag by hand — a tag push
  re-fires publish. Tags absent from origin (behold-v0.10.0, 0.10.1) stay
  absent for that reason.
- **Scratch infrastructure** is governed by `src/scratch.ts`, asserted by
  `scratch.test.ts` across every boot site: anything behold boots is named
  `behold-*`, refuses if the name is taken, tears down only what it created,
  and never binds the shared emulator ports. The protected names — `floci*`,
  `chant-floci*`, the kubemicrovm and fountain k3d clusters, :4566 — are
  listed there, not in prose. A new boot site calls `assertScratch` before
  its spawn and gets a row in the test.
- **The write boundary** is the Invariant section above. Apply is never a
  button; `/api/carve/apply` does not exist and the route test asserts it
  stays that way.
- **chant's working rules** (its single-lane checkout, its release path) are
  chant's and live in chant's repo, not here.
