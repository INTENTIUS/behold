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

In a checkout, `behold demo --list` prints a second block under the bundled
one: the eleven workbench entries from `workbench.json`, this repo's own
catalog of the internal estates behold is developed against — the same
`behold demo <entry>` load, `just example name="<entry>"` to serve one, and
"The workbench catalog" below for what each is and what it boots.

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
   `?env=`, `?stack=`, `?tier=`, `?target=`, `?collapse=1`.
   `?collapse=1` (#393) shuts every member box holding more than 40 cards: the
   box is drawn as ONE card carrying the count it was badged with (`301
   resources · 84 bound · 85 unowned · 132 neutral`, in the estate's own
   words), ids namespaced `box:<member>`, and the returned IR is the collapsed
   one so every count and note speaks about the picture on screen. ⌘K →
   "Collapse large boxes" / "Expand all". Below the limit it changes nothing.
3. **inspect** — a node's `sourceLoc.file` is the typed source that declared it;
   edit there to change the estate (chant is the source of truth, not behold).
4. **find** — ⌘K also takes an ADDRESS (#393). Two characters in, the palette
   matches the ids and addresses of the graph the page is currently showing and
   offers up to twelve `node: <address>` rows, prefix matches first, each with
   its member and kind on a second line (two members of one estate can declare
   the same address). Enter takes the same path a click on the card does — the
   inspect pane and the highlight — and pans the graph onto it: `revealNode` in
   web/app.js drives the same viewBox the wheel, the drag and "⤢ fit" drive.
   Nothing here fetches, so it works in a static export too.

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

A choudoufu estate member (#366) adds no exception. A move there is one tag
write through choudoufu's own `live-mv`, and behold never makes it: `GET
/api/choudoufu/moves` reads a plan (`carve.json`) from inside a served member,
previews each move with choudoufu's `live-mv -json -dry-run` (the only spelling
of `live-mv` in the tree, src/choudoufu-moves.ts `dryRunArgs`, asserted by
test), hands the lines back with copy buttons, and `?receipt=1` reads the
listing after a person ran them. **There is no `/api/choudoufu/mv`**, and
src/choudoufu-route.test.ts asserts it stays absent, for the same reason
`/api/carve/apply` does not exist.

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

### Adding a member kind

An estate member has a kind (#368): what a directory has to look like, what
tool answers reads for it, and how it becomes a `GraphIR`. `src/member-kind.ts`
is the one table; `chant` is the first row and every member was that row
until the table existed. A new kind is:

1. A `registerMemberKind({ kind, probe, expects, via })` call in
   `src/member-kind.ts` — the `probe` is sync, read-only and runs no code (a
   file's presence, a regex over a root file, or either: the choudoufu probe
   takes the `estate.chdf.hcl` sidecar, choudoufu's leading form, OR a `live {`
   block in a root *.tf, #387); `via.tool` stamps the binary and
   version that would answer, which is the version half of `memberIr`'s
   cache key; `via.read` is the one uncached read, source or live per `opts`.
   The module imports nothing from the read path at runtime (src/chant.ts
   imports src/project.ts, which imports it); a kind's `via` closes over its
   own tool module.
   Add the word to `MEMBER_KINDS`. A word in the vocabulary that no row
   registers is a doctor fail with the reason, never silently chant.
2. Nothing in `src/estate.ts`: `composeEstate`, `composeEstateOverlay` and
   `estateNamespaceScopes` already dispatch through `memberKindOf(dir)`.
   The two routes that render an estate — `/api/graph`'s estate branch and
   `/api/overlay`'s — run the same passes in the same order and must not
   fork per kind; a kind's differences live inside its `read`.
3. A `registerPack({ lexicon, iconFor, fields })` in `src/render.ts`, or the
   kind's cards lead with the alphabetically first two short attrs. A `fields`
   function takes the box the card is drawn in as its second argument, so a
   row the box already carries can be left off (#393 item 9,
   `src/card-face.ts`).
4. A row in `statusVocabulary` (`src/status-vocabulary.ts`) when the kind has
   its own words for the four overlay colours — choudoufu's `bound` is not
   chant's `managed`, and a legend that says `managed` over a card carrying no
   marker is a claim behold has no right to make. The colours never move; only
   the naming does, and an estate of several kinds keeps chant's words and says
   so in the legend's tooltip.
5. A `DoctorCheck` line when the kind needs a tool on PATH or a per-member
   precondition (a version floor checked before the spawn, the way
   `carveStatusReader` does; a PATH probe the way `src/demos.ts` does).
6. Tests: the probe and the object form in `src/project.test.ts`; dispatch
   in `src/estate.test.ts`'s "#368" block, which registers a fake kind and
   asserts chant members still go through exactly the calls they did; the
   kind's own reader off recorded documents in `src/__fixtures__/`, with
   provenance in prose above the load.

`.behold.json` names a kind as `{ "dir": "x", "kind": "<kind>" }`; a bare
string is `chant`. Anything behold boots for a kind goes through
`assertScratch` first.

**What the first screen owes a non-chant member (#393).** Three chant-shaped
things used to be offered to every member whatever it was, and a new kind gets
all three answered for free:

- `/api/project` publishes `memberKinds` — the served members' kinds, in
  composition order. The SPA opens on the `resources` zoom when none of them is
  `chant`, because `components` is a projection of a chant project's own
  component DAG and a member without one opens on "the components lens doesn't
  apply to a composed estate yet". #182's zero-node fallback still covers a
  chant project that declares no components.
- `/api/project` publishes `runtimeCapable`, and the palette and the View tab
  offer `zoom: runtime` only then. The tier below the declaration boundary is
  the owner-referenced children chant stamps `runtimeOwner` on, and only a
  Kubernetes read has an owner chain to resolve — `RUNTIME_LEXICONS` in
  `src/server.ts` is the one word (`k8s`), read off the members' DECLARED
  lexicons so the stop exists or not before anyone picks it.
- A chant-only facet answers emptily rather than 500ing for a non-chant
  primary: `/api/resources` returns `{byComponent: {}}`, the shape carve mode
  already returns and the SPA already reads as "no resource facet here".

A kind that grows components, or a substrate with an owner chain, changes those
answers where they are decided — never per kind in a route.

### The workbench catalog

`demos.json` is the catalog that ships. `workbench.json`, read beside it and
deliberately absent from package.json's `files`, is the catalog of internal
estates this checkout is developed against (#386, #388). Four rules, and
src/demos.ts holds them:

1. A third source, `local`, and a second file. A local entry's `path` is
   relative to the directory of the catalog file that named it — the intentius
   checkouts are siblings, so the workbench writes `../choudoufu`,
   `../waterpark`, `../chant`, and the file stays committed and reproducible.
   An entry whose path is not checked out is unsatisfiable exactly as a
   missing binary is: `--list` and `/api/demos` say so, CI stays clean.
   `BEHOLD_WORKBENCH=<file>` names a catalog elsewhere; a workbench name that
   collides with a bundled one is dropped with a stderr line.
2. In place or copied, said explicitly. `inPlace: true` serves `path` where it
   sits; the default copies to `behold-demos/<name>` with the bundled filter.
   Anything whose setup writes into the tree — `init`, `apply`, a rendered
   generator — is copied or generated into the target, never run in a
   checkout, which is how #366's "behold never runs `choudoufu init` in a
   served project" survives. An `inPlace` entry with a `setup` says so in its
   description.
3. A generator is a source. An entry with no `path` at all renders its estate
   into an empty target through its own `setup`, which runs with cwd = the
   target and two extra variables: `BEHOLD_WORKBENCH_DIR` (the catalog file's
   directory, so a script can reach `../choudoufu`) and `BEHOLD_DEMO_NAME`.
   The up script writes the matching down script into the target, the way the
   bundled choudoufu demo ships `scripts/choudoufu-down.sh`.
4. `CHOUDOUFU_BIN`. `choudoufuBinary()` (src/choudoufu-member.ts) names the
   binary and every spawn, the doctor probe and the demo requirement check go
   through it; the doctor line prints which binary answered. Workbench scripts
   spell the same fallback, `${CHOUDOUFU_BIN:-choudoufu}`.

`just example name="<entry>"` serves one. Scratch discipline is unchanged: an
emulator a workbench entry boots is `behold-wb-<entry>` on its own port, and
the up scripts (`workbench/<entry>/up.sh`, helpers in `workbench/lib/`) assert
the `behold-wb-` prefix and the not-4566 rule themselves, in bash, because they
are the boot site. Each writes the matching `scripts/down.sh` into its target.

**The eleven entries**, in catalog order. The counts are measured, not
estimated — every entry the e2e below can reach on a developer machine prints
its own graph and overlay counts as it runs.

| entry | what it serves | needs |
|---|---|---|
| `chant-getting-started` | chant's own getting-started example from `../chant`, in place: the source graph, 8 nodes, no substrate. The one-second answer to "did I break plain chant reading?" | that example's own `node_modules` — nothing is installed in your chant tree |
| `chant-local-cloud-trio` | chant's local-cloud-trio, in place: one project declaring across aws, azure and gcp, 8 nodes and 2 edges of source | the same |
| `fountain-ops` | `../fountain-ops` in place with `--env local` — the mature estate on your working checkout | docker, k3d, kubectl, jq, just. **The one entry whose setup runs in your working copy**: the checkout's own `just up`, a five-minute k3d cluster, and it switches your kubectl context. `just down` there removes it; behold never does |
| `choudoufu-workbench` | the live-mv workbench's four estates copied out of `../choudoufu`, composed with `--env live`: 42 cards — 24 bound, the 12 team cards reading `owned by tlmig-sample-monolith`, 6 neutral | docker, choudoufu |
| `choudoufu-cohort-s3` | `estate-gen`'s `s3` cohort rendered into the target — a sidecar-declared estate (#387): 6 cards, all neutral, because the apply stops where floci answers S3 Control tag reads on a hostname that does not resolve | docker, choudoufu, go, terraform |
| `choudoufu-cohort-iam-ecr` | the same for `iam-ecr`, the one cohort floci implements end to end: 6 cards, all 6 bound | the same |
| `choudoufu-cohort-ec2-networking` | the same for `ec2-networking`: 49 cards, the widest roster, all neutral (floci refuses a transit gateway call and the apply stops) | the same |
| `terralith-1` | `terralith-gen` at scale 1 plus the `estate.chdf.hcl` sidecar it omits, applied by choudoufu from nothing: 79 cards, all 79 bound | docker, choudoufu, go |
| `terralith-4` | the same at scale 4: 301 cards, all 301 bound. The estate behold is sized against | the same |
| `terralith-4-adopt` | scale 4 again, but STOCK terraform applies it first, so nothing wears a marker: 301 cards — 85 UNOWNED, 84 bound by derived identity alone, 132 neutral. One `choudoufu live-import` line, which the up script prints and you run, and all 301 read bound | docker, choudoufu, go, terraform |
| `waterpark` | `../waterpark/access` in place as a bare Terraform directory (#384): five roots as boxes, 58 cards, 49 edges, nothing written under the estate | `@intentius/chant-lexicon-terraform` + `@cdktf/hcl2json` beside behold — optional peers behold declares and does not install |

**The scratch, by name and port.** Each emulator is the entry's own, booted by
its up script and removed by the `scripts/down.sh` that script wrote into the
target — never by pattern.

| entry | container | host port |
|---|---|---|
| `choudoufu-workbench` | `behold-wb-choudoufu-workbench` | 4651 |
| `choudoufu-cohort-s3` | `behold-wb-choudoufu-cohort-s3` | 4652 |
| `choudoufu-cohort-iam-ecr` | `behold-wb-choudoufu-cohort-iam-ecr` | 4653 |
| `choudoufu-cohort-ec2-networking` | `behold-wb-choudoufu-cohort-ec2-networking` | 4654 |
| `terralith-1` | `behold-wb-terralith-1` | 4655 |
| `terralith-4` | `behold-wb-terralith-4` | 4656 |
| `terralith-4-adopt` | `behold-wb-terralith-4-adopt` | 4657 |
| `chant-*`, `waterpark` | none — source reads, no substrate | — |
| `fountain-ops` | the k3d cluster `fountain-local`, which is the checkout's, not behold's | — |

The port is the floci's host binding and the entry's `serve.spawnEnv`
`AWS_ENDPOINT_URL` at once, so the estate's own applies and the choudoufu
behold spawns talk to the same emulator.

**The e2e** is `just e2e-workbench` (`e2e/workbench-e2e.sh`, #391): every entry
loaded through `behold demo <entry> <tmp target> --port <p>` on its own port
from 4720 up, `/api/graph` asserted to carry nodes and a live entry's
`/api/overlay?env=live` to answer with its bound/unowned/neutral split, timings
per entry; eight entries and 475s on the machine this was written on.
`terralith-4-adopt` is asserted twice — 85 UNOWNED, then the
`live-import` line the up script printed, run by the script itself in the
target the way a person would, then 301 bound — because that write is the
person's, never behold's (#372). `waterpark` is checked for an untouched
checkout afterwards. `missingRequirements` decides what runs: a missing binary,
an unchecked-out sibling, an uninstalled chant example or the absent Terraform
lexicon each print `skip: <entry>: needs …`, so in CI every entry skips and the
run exits 0. `fountain-ops` is skipped by name everywhere, for the reason in
the table. A `behold-wb-*` container left standing at the end fails the run.

The seeded catalog (#389) found one thing missing in src/: a LONE choudoufu
estate — every generated entry is one — served the no-project card, because the
single-project read is `chant graph <dir>` and such a directory has no lexicon
for it to read. `servesAsEstate` (src/member-kind.ts) is the predicate that
routes one directory of a non-chant kind through the estate compose path, where
the member's own kind reads it. One member composes exactly as four do, ids
namespaced under the member's short name, so the graph, the pane and the morph
agree on what a node is called.

### Rendering a Terraform estate

A Terraform estate reaches behold through chant.
`@intentius/chant-lexicon-terraform` reads the HCL an estate already has and
emits one entity per block, so **a Terraform estate is a chant project whose
only lexicon is a reader** and `chant graph --format ir` serves it like any
other. behold parses no HCL and ships no HCL parser — the same posture
`src/carve-lens.ts` states for the carve report (#378).

Three passes turn what arrives into a picture (`src/terraform-lens.ts`), in this
order, guarded on the IR carrying terraform entities so every other estate gets
the identical object back:

1. **`normalizeTerraformNodes`** — a node's `kind` arrives as the entity class
   (`Terraform::Resource`), not the resource type, so every card would be titled
   and iconed the same. The type moves out of `attrs.address` into `kind` and
   the block class lands in `attrs.block`. That is the shape a carve node
   already has, which is why one presentation pack serves both.
2. **`groupTerraformByRoot`** — roots are a Terraform project's only grouping.
   It retires itself when chant#2266 groups upstream. A node sits in exactly one
   box, so a box every node has left is dropped rather than drawn empty (#393):
   a served directory arrives composed, `composeStacks` boxes the whole member,
   and the root boxes then take those same nodes — which is what put an empty
   box named `access` on water park's canvas. What the member box was there to
   say moves into the root box's title, which is `<member>/<root>` whenever the
   estate holds more than one member and the bare root name when it does not
   (two members with a root apiece named `prod` would otherwise merge silently).
3. **`filterTerraformCards`** — what is a card, below.

**What is a card (#382).** Measured on a real estate: 247 nodes for 43
resources, four fifths of it not infrastructure.

| tier | blocks | why |
|---|---|---|
| default (detail 0-2) | `resource`, `data`, `module` | the estate: what is declared, what it reads, what it composes |
| attributes (detail 3) | + `output`, `variable` | its interface — real, but a second question |
| never | `terraform`, `provider`, `locals` | settings, not estate |

Nothing is dropped silently: `terraformElisionNote` says what is not drawn and
where to see it, the way `edgelessNote` says why a view has no edges.

**The note, at every zoom and in a 260px strip (#393).** The roots note and the
elision note are built by one function in `/api/graph` and returned by all three
of its branches, the logical lens included — it was the lens that most needed
the line and the only one that dropped it. Both routes send `note` and, when
there is a shorter true form, `noteShort` (`5 roots · 2 skipped · 189 blocks not
drawn`). The strip shows the short one with the long one on its tooltip, and the
panel's Model tab prints it whole. The server writes both: the SPA does not
author notes, and truncating this one on a sentence boundary would keep the list
of root names and drop the counts.

**Do not invent edges.** They arrive from chant or not at all: the fixtures here
were recorded when a Terraform IR carried none, and lexicon 0.61.0 (chant#2265,
which resolves a block's `"${…}"` references) draws 390 over water park's five
roots with no change on this side. The one relationship that looked derivable
without it — a cross-root read by name — was measured and refused (#381): both
ends carry the same unresolved interpolation, so a match would be a coincidence
of variable naming. A data source says what it reads as a row instead.

**Serving a directory that declares nothing (#384).** Every estate this lane
exists to draw is a directory of `.tf` files and nothing else, and #378 chose
not to ask one for a `chant.config.ts` of its own — INTENTIUS/waterpark#88 was
withdrawn because the estate is more useful untouched. So `behold serve
<terraform-dir>` generates the reader config itself, outside the estate, and
points chant at it. The Invariant's one in-project write stays
`.behold/layout.json`; nothing is written under the served directory, and
`src/terraform-member.test.ts` asserts the estate's source stamp is unchanged
across a read. Three decisions, each a trade #384 left open and each measured on
water park's `access/` before it was taken:

1. **The lexicon is opt-in.** chant resolves the lexicon from the config file's
   own location, so the generated project has to see it — and making it a
   dependency would put `@cdktf/hcl2json`, a ~1.8 MB wasm blob, in the install
   of every user who serves a chant project. `@intentius/chant-lexicon-terraform`
   and `@cdktf/hcl2json` are therefore **optional peers**: declared in
   package.json (the only place their versions are named — the refusal reads
   them from there), never installed by behold, probed at serve and doctor time,
   and refused with the one install line and where behold looked. The same gate
   `behold demo` puts on a binary it does not ship. The lexicon's own chant peer
   is what moved behold's `@intentius/chant` floor to `^0.61.0`: chant 0.54
   loads no published version of it (`applyLineage is not a function`).
2. **Roots are discovered, and the skips are reported.** A root is a directory
   with a `.tf` declaring a line-start `terraform {` or `provider "` block
   beside a `resource`, `data` or `module` block — a regex probe at the depth
   the choudoufu probe uses, no HCL parsed. #384 proposed the first half alone
   ("what a root has and a called module does not") and the estate refuted it:
   water park's `modules/persona` is a shared module called by three roots and
   its `versions.tf` is `baseline`'s byte for byte. So two exclusions stand
   beside the probe — a directory under a `modules/` segment (Terraform's own
   standard module structure; the roots that call it draw its blocks already)
   and one with nothing to draw (`access/backends` is two backend fragments) —
   and both are named in the graph's note with their reason, the way
   `terraformElisionNote` names what a zoom left out. Measured on `access/`:
   five roots (`envs/prod`, `identity`, `github`, `baseline`,
   `satellites/waterpark-runner`), two skipped, `envs/dev` neither drawn nor
   reported because it holds only a README.
3. **A `terraform` member kind, after chant and choudoufu.** #378 said there is
   no such kind and meant it about *reading*: behold parses no HCL and the
   render goes through chant. A kind whose `read` shells `chant graph` against a
   generated config is a scaffold, not a second reader, and it inherits the
   probe, the cache stamp, the doctor line and estate composition (#368) for
   free — so a Terraform root composes in an estate beside a chant project and a
   choudoufu estate at no extra cost. `src/terraform-member.ts` is the whole of
   it; `detectProjectShape` answers a directory that is its own member with
   `membersFrom: "probe"`, which is what retired #384's `no chant.config.ts
   here` dead end.

The scratch project is `<tmpdir>/behold-tf-<hash of the estate path>`:
`behold-*` and cleared through `assertScratch` (src/scratch.ts), one directory
per estate reused across runs, asserted to be outside the estate before a byte
is written. It holds the generated `chant.config.ts` and two symlinks —
`node_modules` to behold's own, which is how the config resolves the lexicon,
and `estate` to the served directory, which is how each root's `dir` is spelled.
The second is not decoration: the lexicon sets a root's module boundary to the
root's own directory when its `dir` resolves outside the project root, so
absolute paths cost every `../modules/x` call the estate makes — 72 nodes and 6
resources on water park, against 247 and 43 through the symlink. Nothing in the
answer mentions the scratch path (a terraform entity carries `attrs.file`
relative to its root, and no `sourceLoc`).

### A choudoufu estate's own references (#393)

`choudoufu live-check -json` states the roster and `references[]`, and that
second list is *cross-estate by construction* — data sources filtered on
another estate's marker tags. So a 301-resource terralith of roles, policies
and attachments drew no edge at all and the graph asserted "nothing in this
estate references anything else", which is false about every one of them.

The references were never missing; nothing was reading them. **A choudoufu
member's read now also runs the terraform kind's reader over its own
directory** — one root, the estate directory itself, through the same scratch
project machinery above (nothing written under the estate) — and joins the two
documents by address. behold still parses no HCL: `src/choudoufu-refs.ts` is
two lists of strings and the rules that match them, and its header is the
argument for each. In short: the lexicon names *blocks* in a path of module
*calls* (`estate/module.team_pod/aws_iam_role.pod_role`) and choudoufu names
*instances* in a path of module *instances*
(`module.team_pod["pod-a"].aws_iam_role.pod_role[0]`), so one lexicon edge is a
product — kept inside one module instance (Terraform's scoping, not a guess),
joined key to key when both ends expand over the same keys (266 true edges on
`terralith-4` against 666 of which ~400 would be false), landing on a module
call's whole interior, and dropped whole when either end is a `var`, a
`locals` or anything else the roster declares no card for.

Every edge is `inferred` and carries the lexicon's own attribute name (`role`,
`policy_arn`), so the card says what made the reference. **Without the
lexicon there are no edges and the note says so** — carrying the terraform
kind's own install line rather than the sentence behold has no reader to
assert — and the lexicon's version is in the member's cache stamp, so
installing it invalidates the edgeless IR rather than serving it forever.

The layout half is `packBoxComponents` (src/render.ts). src/edgeless.ts wraps a
box whose cards reference *nothing*; a box that has edges is never wrapped, so
`terralith-4` came back as a 110996 x 628 strip the day the join landed —
dagre lays 42 connected components side by side on three ranks. The pass packs
a box's components into shelves and resizes the box around them, re-laying each
component on its own first (inside a cluster dagre interleaves them: a six-card
cluster's bounding box spanned 46598 units) and wrapping a component that is a
strip either way — the DNS fan is 19564 x 400 upright and 900 x 10046 on its
side. A box under 4:1 is left exactly as it laid out. Measured: `terralith-4`
7660 x 5162 with 266 edges, waterpark 3536 x 3138 at detail 2 and 7142 x 6974
at detail 3 (from 4.2:1 and 15.1:1, the case #393's wrap did not answer).
