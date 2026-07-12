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
click-to-inspect and source deep-links. The read-only core, first cell.

Not yet: the live/overlay drift colouring (needs chant #821, source-anchored
overlay), the deployment-lanes timeline, and the delegated actions. See the concept
notes and the issue set below.

## Usage

```sh
npm install
npm run dev -- serve ./path/to/chant-project      # dev (tsx)
# or, built:
npm run build && ./bin/behold.js serve ./path/to/chant-project --port 4600
```

Then open http://localhost:4600.

## Layout

```
src/
  cli.ts       serve verb + arg parsing
  server.ts    Hono read-only API (/api/graph) + static SPA; /api/overlay is a seam
  chant.ts     shell-out to the chant bin (graph IR) — behold reads, never mutates
  render.ts    pinhole painter (layoutIr + renderSvg) — IR → SVG
  overlay.ts   source-anchored-overlay seam (chant #821) + _status → drift semantics
web/
  index.html   SPA shell
  app.js       inlines pinhole's SVG + click-inspect by data-node-id
```

## The painter

behold reuses [pinhole](https://github.com/INTENTIUS/pinhole)'s SVG painter as a
library — a mature renderer (themes, icons, `_status` drift colouring that already
speaks the overlay vocabulary managed/foreign/pending). The server lays the IR out
and paints it with `layoutIr` + `renderSvg` (`src/render.ts`); the SPA inlines the
SVG and wires click-inspect by `data-node-id` against the IR. pinhole's layout is
dagre — pure JS, no native dependency.

## Develop

```sh
npm run tsc    # typecheck
npm test       # vitest
npm run build  # bundle to dist/cli.js
```

## Related issues

- chant **#821** — source-anchored overlay (the linchpin: cross-substrate topology + live status).
- chant **#822** — diff two historical snapshots (feeds the timeline).
- chant **#513** — compose separate stacks into one IR.
- pinhole **#82** — ship the painter as a library (done; behold consumes it).
- pinhole **#79/#80/#81** — drive `--live`/`--overlay`, first-class drift rendering, morph-over-time.
- Concept notes: `~/Documents/research/chant-live-control-plane.md`.
