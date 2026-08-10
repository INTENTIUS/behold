# behold

**A live control plane on [chant](https://github.com/INTENTIUS/chant).** Behold your
whole estate — every substrate (AWS, k8s, GCP, Azure, Fly) in one graph, coloured by
drift — then act through delegated, gated Ops.

📖 **[Documentation](https://intentius.io/behold/)** — starts with an agent prompt that
gets you to a running graph without reading anything else first.

Where Argo CD shows one cluster's tree, behold shows the mixed-substrate estate:
cloud drift on AWS, supply-chain drift on GitHub Actions, artifact presence on Helm —
each substrate's own kind of truth, in one picture.

```
chant source ──build/lint──▶ graph IR ──behold──▶ live graph + drift + (delegated) actions
              (deterministic)          (server + browser)
```

## Quick start (npm)

No chant project yet? The bundled demo is the five-minute path — an S3 bucket +
policy served against a local emulator, no cloud account, no credentials
(needs Docker):

```sh
npx @intentius/behold demo            # copies the example to ./behold-demo, installs, serves
# → http://localhost:4600 — blue = declared; click Deploy, watch it turn green
```

The copied project is yours: edit its source and watch the graph change live.
There's a whole catalog — `behold demo --list` names the rest (`behold demo
k8s` stands the same loop up on a throwaway k3d cluster: runtime Pods, field
ownership; `behold demo argo-estate` needs nothing at all — a three-project
Argo CD estate, declared only, so it runs where Docker doesn't; `behold demo
carve` is the Terraform peel walkthrough, below). Every loaded demo lands in
the panel's recents, so switching between them is the Scope tab.

The catalog is in the panel too (#268): the Scope tab's switcher lists every
bundled demo under your recents, one click to copy, install and serve it —
demos whose prerequisites are missing stay visible, disabled, saying what to
install, and one that would clone from the network says so on the button.

Already have a chant project?

```sh
cd my-chant-project
npx @intentius/behold doctor          # will this project serve well? (read-only)
npx @intentius/behold preview         # → http://localhost:4600, this project's graph
npx @intentius/behold serve . --env prod --poll 30   # live drift overlay
```

`behold doctor` is the first thing to run on a project behold hasn't seen: one
line each for the project's kind, its own chant install and version, declared
lexicons, the envs the picker will infer, the kube context chant binds versus
your ambient one, substrate readiness and committed Ops — pass/warn/fail with
a one-line fix. It starts nothing and changes nothing; it exits non-zero only
when something would actually stop behold serving the project well, so CI can
gate on it. `--json` for scripts and agents.

Driving it from an agent or script? `GET /api` lists every JSON route;
[AGENTS.md](./AGENTS.md) (shipped in the package) is the read/act contract.

## Preview: your project, or the Loom-on-Floci demo (v0.1.0)

`behold preview` is the quick way to look at a chant project's graph in a
browser at one port. Plain, it just opens the project you point it at — no env,
no emulator. From a repo checkout the same commands run through `npm run dev`:

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
you a **▶ Deploy (floci-apply)** button in the header that deploys to it — no AWS
account, no creds, no cost. This is `serve`'s generic mechanism, separate from `preview`/`export`'s
`--emulator` flag above, which is a Loom-specific turnkey demo path — see
`behold --help` for how the two relate:

```sh
npm install
npm run demo        # installs example-writes' deps, then serves it with --local
#   → http://localhost:4600
```

<sub>(or by hand: `npm install --prefix example-writes && npm run dev -- serve example-writes --local --env prod`)</sub>

1. The graph shows the bucket + its TLS policy — **blue** (declared, not yet deployed).
2. Click **▶ Deploy (floci-apply)** in the header (or ⌘K → "Deploy: Sync"). The
   now-line streams Build → Apply → Verify; the bucket is created in the emulator
   via the CloudFormation API.
3. The nodes flip **green (managed)** — behold's overlay observes the live emulator.

No Docker running? behold still serves the source graph and tells you to start it —
it never dies on you.

**Real AWS.** The same project's **▶ Deploy** button starts its `ApplyOp` against a
real account: `npm run dev -- serve example-writes --env prod` (needs AWS
credentials). What the header offers depends on what the project committed: a
committed `ApplyOp` gets the **▶ Deploy (<op>)** button (plus **Approve** when
gated); a project with only components gets **▶ Deploy…**, which opens the dial's
component picker; **Adopt** appears per foreign node (`ReconcileOp`); every other
Op runs from ⌘K (**Run: \<name\>**). Full walkthrough:
**[example-writes/README.md](example-writes/README.md)**.

## The k3d demo — the Kubernetes counterpart to Loom-on-Floci

`npm run demo:k8s` is the k8s analogue of the Floci demo above: it brings up a
local, single-node [k3d](https://k3d.io) cluster (Docker only, no cloud
account), then serves the bundled `example-k8s` — an nginx Deployment +
Service — with `--local`. Same mechanism, same shape: declared-not-deployed
(blue) → click **Run** on `k3d-apply` → managed (green), server-side applied
with chant's own field manager. Ctrl-C tears the cluster back down.

Beyond the AWS demo's single flip, this one also demonstrates Kubernetes'
two additional tiers (epic #84): zoom into the Deployment to see its **Pods**
as **runtime children** (owned by the cluster, never declared, never drift);
induce an out-of-band `kubectl scale`/`kubectl label` and refresh to see
**managed-fields drift** (chant's field manager vs. a competing one); and
switch away from the bound kubectl context to see an **unobserved** refusal
(an honest "did not look," never a false "all gone"). Full walkthrough,
including the exact commands and what each state looks like over the API:
**[example-k8s/README.md](example-k8s/README.md)**.

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

## Terraform carve-out: `behold carve <report.json>`

`chant carve advise` ranks a Terraform estate by **peelability** — how cleanly
each resource could be carved into native chant source. `behold carve` draws
that ranking: one card per resource, three panels (carve now / boundary work /
leave in Terraform) on the same `attrs._status` drift palette every other view
uses, and the score arithmetic behind each rank in the inspect pane.

```sh
chant carve advise --from ./terraform --report carve.json
behold carve carve.json                      # → http://localhost:4600
curl localhost:4600/api/carve                # the raw report, for agents
```

behold parses no HCL and needs no Terraform tooling: the report **is** the
contract. A file that isn't a peelability report is refused with a structured
`{error, code: "carve-report", remedy}` — in the terminal, and from the routes —
never a blank graph. See `docs/using/carve` and issue #230 for the roadmap
(the post-emit diff, then Terraform as an estate member).

### The walkthrough: `behold demo carve`

```sh
npx @intentius/behold demo carve      # no Docker, no cloud, no terraform binary
```

Copies a half-migrated estate — a small chant project beside a Terraform one,
both describing the same AWS account — installs the chant it will shell, runs
`chant carve advise` over the copy, and opens the banded graph with a six-step
stepper on the panel's **Carve** tab:

1. **Advise** — the bands, with what each one means.
2. **Pick** — click a green card. The inspect pane shows the score arithmetic;
   the step names the boundary the cut crosses.
3. **Emit** — runs `chant carve emit --state --select <addr>` into
   `app/carveout/` in the copy, then shows the emitted chant source and the
   `chant lint` result.
4. **Bridge** — runs `chant carve bridge` (never `--apply-rewrites`) and renders
   the proposed data source, the rewired survivors and the patch.
5. **Handoff** — the runbook's commands with copy buttons, and **not** a button:
   `terraform state rm` and `terraform apply` change who owns a live resource,
   so they stay yours to run. The panel says so.
6. **Done** — the card is marked chant-owned at the observe position;
   `terraform import` reverses all of it.

The Emit step reports `chant lint`, not `chant build`: chant#1637 means `build`
fails on the emitted bucket even though the advisor scored it 88, and the panel
links the reason. `example-carve/README.md` has the estate's full story, the
band table, and the offline/`--live` split.

behold writes only into the demo copy it made — `app/carveout/`, and nothing
else. Your Terraform is never edited; see AGENTS.md, "Invariant".

## Configuration — `.behold.json`

An optional `.behold.json` in the served project's root is **behold's own**
config — kept separate from `chant.config.ts` so behold's concerns (like the
tier picker) don't leak into chant's. Today it declares one thing: the
project's deploy-**tier** axis, a dimension orthogonal to `environment` (chant
has no native tier concept — it's entirely a project convention, e.g. Loom's
components branching on an env-conditioned `namingParams.tier`):

```json
{
  "tiers": {
    "envVar": "LOOM_TIER",
    "values": ["light", "production", "production-ha"]
  }
}
```

- `envVar` — the env var name the project's source branches on; behold sets it
  for the chant shell-out whenever a tier is picked (`?tier=` → this var, never
  a chant CLI flag).
- `values` — the tier picker's options.

**No `.behold.json` (or no `tiers` key) → no tier axis:** the picker doesn't
render and the graph loads with no tier selected — the default for any project
that doesn't opt in. There's no other tier config surface (not
`chant.config.ts`, not an env var behold guesses the name of).

### The hand-layout sidecar — `.behold/layout.json`

dagre places your nodes; you can move them. Drag a card, resize a containment
box, and the offsets are remembered per project + lens — in `localStorage`
first, and (when the served project is writable) in a `.behold/layout.json`
sidecar beside it, so a layout is shareable, reviewable in a diff, and honoured
by `behold export`:

```json
{ "version": 1, "lenses": { "components": { "src/api#Component": { "dx": 40, "dy": -25 } } } }
```

This is the **only** file behold writes inside a served project. It stores
deltas, never absolute positions — the graph stays chant's and your layout sits
on top of it — and a delta whose node has left the estate is dropped silently.
`POST /api/layout` refuses politely in preview mode, during a static-export
capture, on a read-only directory, and above its size caps. `↺ layout` in the
graph clears the current lens on both tiers.

**Gitignore it.** `.behold.json` (above) is config and belongs in the repo;
`.behold/` is per-user state — one person's arrangement of the picture — so add
it to the served project's `.gitignore` unless you actually want to share and
review a layout:

```gitignore
.behold/
```

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

Where an official mark exists, a node paints it instead of a generic glyph — a
Deployment gets the Kubernetes wheel-and-helm heptagon, a Kustomization the
Flux mark, a `Helm::Release` the Helm wheel. The corpus is vendored under
`web/icons/` (30 kubernetes/community SVGs, 3 cncf/artwork marks for
Flux/Argo/Helm, licensing in `THIRD_PARTY.md`) and mapped kind by kind in
`src/icon-packs.ts`; a kind with no official icon falls through to pinhole's
keyword heuristic rather than a wrong picture.

dagre's layout is a good first draft, not a final one: drag a card to move
it, grab a containment box's corner to resize it, and both survive a reload.
What persists is a delta — `{dx,dy}` for a card, `{dw,dh}` for a box, never
an absolute position — keyed by `behold.layout.<project>.<lens>`
(`web/layout-store.js`), so the graph stays chant's and the arrangement on
top of it is yours. `↺ layout` sits beside `⤢ fit` and shows up only once
something on the current lens is hand-placed.

Every JSON value the UI shows goes through one renderer (`web/json-view.js`):
2-space pretty printed, objects and arrays collapsible (the first tier open,
anything deeper or wider than a dozen entries folded), long strings truncated
with an expander, and a `copy` on every node that yields that subtree's raw
JSON. Enter or Space toggles the focused node. It paints with `--fg` and
`--muted` and nothing else, so all 552 palettes keep it readable. That covers
the inspect pane's declared attributes, observed live state, drift pairs and
field ownership, the op log's JSON lines, and the payload behind an `/api`
error card.

Type splits by purpose: mono (system stacks — ui-monospace, SF Mono,
Cascadia, JetBrains, IBM Plex) carries node ids, ARNs, statuses and counts;
sans carries labels only. Colour comes from 552 Ghostty terminal palettes run
through an OKLCH-derived token pipeline (`src/theme.ts`), so a theme switch
re-derives the whole chrome, not just the graph — and a node whose drift
status just changed pulses once in the colour it became, off under
`prefers-reduced-motion`.

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
