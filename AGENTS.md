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
   `?ops=1` is the ops lens — the project's declared Ops as a phase track, read
   from each emitted `dist/ops/<name>/op.json`, with the current run painted
   over it (`meta.run`, `meta.gate`); `/api/ops/<name>/status` reads that Op's
   durable run status and pending gate (`chant run status --temporal`).
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
