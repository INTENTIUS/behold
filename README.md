# behold

**A live control plane on [chant](https://github.com/INTENTIUS/chant).** Behold your
whole estate — every substrate (AWS, k8s, GCP, Azure, Fly) in one graph, coloured by
drift — then act through delegated, gated Ops.

Where Argo CD shows one cluster's tree, behold shows the mixed-substrate estate:
cloud drift on AWS, supply-chain drift on GitHub Actions, artifact presence on Helm —
each substrate's own kind of truth, in one picture.

```
chant source ──build/lint──▶ graph IR ──behold──▶ live graph + drift + (delegated) actions
              (deterministic)          (server + browser)
```

## Preview: your project, or the Loom-on-Floci demo (v0.1.0)

`behold preview` is the quick way to look at a chant project's graph in a
browser at one port. Plain, it just opens the project you point it at — no env,
no emulator:

```sh
npm install
npm run dev -- preview                # → http://localhost:4600, cwd as the project
npm run dev -- preview ../my-project  # → someone else's project
```

With no path, it opens the **current directory** — run it from inside your chant
project. Pass a path to look at another one.

behold also ships a turnkey **demo**: the whole live experience running Loom on a
local [Floci](https://github.com/lex00/floci) emulator, no cloud account and
nothing to configure. Opt in with `--emulator`:

```sh
npm run dev -- preview ../loomster --emulator   # → http://localhost:4600
```

`--emulator` injects the env Loom's own Floci setup expects
(`AWS_ENDPOINT_URL=http://localhost:4566`, dummy AWS creds, `LOOM_ENV=local`) and
locks the UI into previewMode (git/PR ops hidden, substrate strip scoped to
Docker+Floci, no arbitrary-project switching). If Floci isn't up, **Bring up** on
its substrate pill boots the emulator and deploys Loom. Needs Docker.

**What you can do (with `--emulator`):** explore the graph at every **zoom**
(components → logical → composites → resources → attributes, with an optional
radial layout — where _logical_ is a traditional AWS architecture diagram: nested
VPC/subnet ⊃ component boxes, CIDRs as labels, one headline resource per
composite), watch live per-component status, read the reconcile plan, inspect any
node, and **deploy to the emulator** — the full observe → reconcile → apply,
Apply all, and a one-click Reset.

**Not yet** (this demo is a preview of what's coming): any real cloud, and the
git/PR actions (Rollback, Sync, Adopt) — `--emulator` is Loom-on-Floci only. To
look at your own real infra, `preview`/`export` without `--emulator`, or `serve`
with your own `--env` and creds.

## Export & host — a shareable, interactive snapshot

`behold export` freezes whatever estate you're looking at into a **self-contained
static folder** that any static host can serve — a read-only but fully
interactive snapshot. Pan/zoom, the zoom dial (components → logical → composites →
resources → attributes), radial layout, the inspect pane, and the env/tier
pickers all work client-side; there's no live observe or deploy.

```sh
npm run dev -- export --out ./behold-export           # defaults to cwd, like preview
#   or someone else's project, with its live overlay:
#   npm run dev -- export <project> --env <name> --out ./behold-export
#   or the turnkey Loom-on-Floci demo:
#   npm run dev -- export ../loomster --emulator --out ./behold-export
npx serve ./behold-export                              # → open it, no backend running
```

Like `preview`, `export` defaults to the current directory and stays plain (no
env, no emulator) unless you ask. `--env <name>` turns on that project's live
overlay for the snapshot; `--emulator` injects the same turnkey Loom-on-Floci env
as `preview --emulator`, for exporting that demo.

It captures every read endpoint for the whole lens matrix (each env/tier × zoom ×
radial) in-process — the exact same handlers the live server runs, so a snapshot
is byte-identical to live. (The live app can't run on a Worker — it needs Docker +
Floci + a chant subprocess — but the pre-baked export can.)

The bundle is **deploy-ready for Cloudflare** — `behold export` writes an
assets-only `wrangler.jsonc` (no server code, pure static), so:

```sh
cd ./behold-export && npx wrangler deploy     # → https://<name>.<account>.workers.dev
```

Set the Worker name with `--name`, or edit `wrangler.jsonc`. Auth via
`wrangler login` or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (same as any
Workers deploy). Any other static host works too — GitHub Pages, S3, nginx, or
Cloudflare Pages (`wrangler pages deploy .`).

## Try it — your first apply, no cloud account

The bundled `example-writes` is one S3 bucket. `serve --local` boots *that
project's own* local emulator (Floci, via Docker, generically through
`chant emulator up` — chant #920), points behold's live overlay at it, and gives
you a **Run floci-apply** button that deploys to it — no AWS account, no creds, no
cost. This is `serve`'s generic mechanism, separate from `preview`/`export`'s
`--emulator` flag above, which is a Loom-specific turnkey demo path — see
`behold --help` for how the two relate:

```sh
npm install
npm run demo        # installs example-writes' deps, then serves it with --local
#   → http://localhost:4600
```

<sub>(or by hand: `npm install --prefix example-writes && npm run dev -- serve example-writes --local --env prod`)</sub>

1. The graph shows the bucket + its TLS policy — **blue** (declared, not yet deployed).
2. Click **Run floci-apply**. The now-line streams Build → Apply → Verify; the bucket
   is created in the emulator via the CloudFormation API.
3. The nodes flip **green (managed)** — behold's overlay observes the live emulator.

No Docker running? behold still serves the source graph and tells you to start it —
it never dies on you.

**Real AWS.** The same project's **Sync** button starts its `ApplyOp` against a real
account: `npm run dev -- serve example-writes --env prod` (needs AWS credentials).
Which buttons appear depends on what the project committed: **Sync** (`ApplyOp`),
**Adopt** per foreign node (`ReconcileOp`), **Run** (any other Op). A project with no
Ops (the default `example`) shows none — by design, not a bug. Full walkthrough:
**[example-writes/README.md](example-writes/README.md)**.

## Read-only core, delegated gated writes (the invariant)

**behold never mutates anything itself.**

- The vizes only read (`chant graph`, snapshots, Temporal history).
- Actions don't mutate directly. Sync starts your `ApplyOp`; Adopt starts your
  `ReconcileOp` (opens a PR a human merges). behold *triggers* Ops you committed,
  running on your executor — it holds no apply creds.
- Two write gestures, both human-confirmed: **Apply** (gate signal) and **Open PR**
  (merge). Authority stays in your source and your worker, never in behold.
- The first product is **read-only, full stop**: the mixed graph + drift + source
  deep-links. Writes are a later, opt-in layer.

## Why a Node service (not an edge function)

The live path (`chant graph --live --overlay`, `chant lifecycle plan`) shells
`kubectl`/`aws`/`az`/the Temporal client and holds cloud creds. That needs a real
process, so behold is a Node service you run where your creds live — like
`argocd-server`, not like a hosted SaaS. Read-only means it only needs **read**
roles (describe/list), so it's least-privilege to run.

## Agent-drivable, on chant's MCP

behold is drivable by an agent, and leans on chant's MCP rather than reinventing it:

- **Reads** — `lifecycle-diff`, `lifecycle-snapshot`, plus behold's own read API
  (the overlay graph as JSON, blast radius, frame diffs).
- **Delegated actions** — the writes *are* chant MCP Op tools: `op-run` starts an
  `ApplyOp`/`ReconcileOp`, `op-signal` approves a gate, `op-status`/`op-report`
  watch it. So an agent "syncing prod" is `op-run prod-apply` then
  `op-signal prod-apply approve-apply` — gated, durable, no creds in behold.

behold's value over raw MCP is the live spatial + temporal view and the coupling
between them; the underlying capabilities are chant's, exposed the same way to a
human and an agent. See [AGENTS.md](./AGENTS.md).

## Status

Bootstrap. `behold serve <project>` renders the **source** mixed-substrate graph
(cross-lexicon edges are real today — verified in chant core) in a browser, with
click-to-inspect and source deep-links.

Both read paths work: `/api/graph` (the source mixed-substrate graph) and
`/api/overlay` (the source-anchored **live drift** graph — declared topology kept,
nodes coloured managed/foreign/pending; needs chant ≥ 0.18.1 and cloud creds).

Not yet: the deployment-lanes timeline and the delegated actions. See the concept
notes and the issue set below.

## Usage

```sh
npm install
npm run dev -- serve ./path/to/chant-project             # source graph (tsx)
npm run dev -- serve ./path/to/chant-project --env prod  # + live drift overlay
# or, built:
npm run build && ./bin/behold.js serve ./path/to/chant-project --port 4600
```

Then open http://localhost:4600. With `--env`, the SPA shows the live overlay;
without it, the source graph.

**Live updates.** The server watches the served project's source and pushes a
refresh over SSE (`/api/events`) when a `.ts` file changes — edit your infra, the
graph updates, no reload. Add `--poll <secs>` (with `--env`) to also re-query live
drift on an interval and push updates when a node's status changes:

```sh
behold serve ./infra --env prod --poll 30   # watch source + poll drift every 30s
```

behold shells the **project's own** chant (resolved from the project's
`node_modules` first), so the project decides the chant version — pin it to
`@intentius/chant ^0.18.1` or later for the live overlay (`graph --live` observed
nothing before that fix).

## Layout

```
src/
  cli.ts       serve verb + arg parsing
  server.ts    Hono read-only API (/api/graph, /api/overlay) + static SPA
  chant.ts     shell-out to the chant bin (graph IR, live/overlay) — reads, never mutates
  render.ts    pinhole painter (layoutIr + renderSvg) — IR → SVG
  overlay.ts   _status → drift semantics (managed/foreign/pending)
web/
  index.html   SPA shell
  app.js       inlines pinhole's SVG + click-inspect by data-node-id
example/       a tiny AWS chant project for local dev + e2e
e2e/run.sh     end-to-end runner (install example chant → serve → assert the API)
```

## The painter

behold reuses [pinhole](https://github.com/INTENTIUS/pinhole)'s SVG painter as a
library — a mature renderer (themes, icons, `_status` drift colouring that already
speaks the overlay vocabulary managed/foreign/pending). The server lays the IR out
and paints it with `layoutIr` + `renderSvg` (`src/render.ts`); the SPA inlines the
SVG and wires click-inspect by `data-node-id` against the IR. pinhole's layout is
dagre — pure JS, no native dependency.

## Local development

`just` lists everything. The core loop:

```sh
just install               # behold's own deps
just check                 # tsc + unit tests + build (the fast gate)
just example-install       # install the example project's chant + aws lexicon (once)
just serve                 # serve example/ read-only → http://localhost:4600 (source graph)
just serve example prod    # same server, live drift overlay (needs AWS creds)
```

One server, one SPA: passing an env turns on the live overlay (`/api/overlay`),
omitting it shows the source graph (`/api/graph`). `serve` runs via `tsx` (no build
step); for the built binary, `just build` then `./bin/behold.js serve <project>`.

**Which chant runs.** behold does not bundle chant — it *shells* the chant binary
resolved from the served project's `node_modules` (falling back to behold's own dep).
So local testing means installing chant into a project, not into behold. The bundled
`example/` does exactly that; point `serve` at any real chant project the same way.

## E2E

```sh
just e2e
```

`e2e/run.sh` installs the example's chant (the **chant install under test**), builds
behold, serves the example, and asserts the read-only API against a live server. It
auto-detects AWS credentials:

- **no creds** → asserts `/api/graph` (the source mixed-substrate graph, offline).
- **AWS creds** → asserts `/api/overlay` (the source-anchored live overlay — queries
  CloudFormation and checks every node carries a drift status; all `pending` when
  nothing is deployed is a valid pass, since the point is the live path).

It's hermetic apart from the chant install and (optionally) the cloud read; the
server is torn down on exit. `BEHOLD_E2E_PORT` overrides the port.

## Unit tests

```sh
npm test    # vitest — pure units (graphFlags, _status mapping); no server, no cloud
```

## Related issues

- chant **#821** — source-anchored overlay (the linchpin: cross-substrate topology + live
  status) — done, shipped chant 0.18.31; behold adopted it in M4 (see `src/overlay.ts`).
- chant **#822** — diff two historical snapshots (feeds the timeline).
- chant **#513** — compose separate stacks into one IR — done; behold's `composeEstate`
  (`src/estate.ts`, #31) consumes pinhole's `composeStacks` built on it.
- pinhole **#82** — ship the painter as a library (done; behold consumes it).
- pinhole **#79/#80/#81** — drive `--live`/`--overlay`, first-class drift rendering, morph-over-time.
- Concept notes: `~/Documents/research/chant-live-control-plane.md`.
