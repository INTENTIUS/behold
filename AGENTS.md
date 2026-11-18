# behold for agents

Working in the INTENTIUS workspace, `../agents/shared.md` applies too.

behold is a read-only control plane over a chant estate. It draws the live,
mixed-substrate graph and starts delegated, gated commands; it never holds
apply credentials. This file ships in the npm package and `GET /api` links to
it, so the first half is for agents driving a running behold and the second
for agents changing this repo. Route and feature detail lives in
docs/src/content/docs/using/ (agents.mdx first) and in `GET /api`, not here.

## Driving a running behold

- Before a server exists, or when a route errors: `npx @intentius/behold doctor <dir> --json`. Read-only, exits non-zero if a check failed, each check carries a `fix`.
- Start one with `npx @intentius/behold serve <dir> --port 4600`. `GET /api` lists the routes with a one-line description each.
- Read with `GET /api/graph` (`{ir, svg, meta}`) and `GET /api/overlay?env=<env>`, the live entity overlay. Each node's `sourceLoc.file` is the source that declared it. A failed precondition answers `{code, error, remedy}`; branch on `code`.
- To change the estate, edit that chant source or run a committed Op through chant's MCP (`op-run`, `op-signal`, `op-status`). behold's own mutating routes only start Ops the project committed; none writes a cloud or Terraform directly, and none should be added.

## Changing behold

### The write boundary

behold writes nothing in a served project. Its own state (hand layout,
per-user settings, CI run ids, the serve registry) goes in the user's cache,
home or temp directory, keyed by project. The only exceptions are
`behold doctor --fix` writing `chant.workspace.json`, the carve demo steps
writing inside the demo copy behold made, and `behold export --publish`.
There is deliberately no `/api/carve/apply` and no `/api/choudoufu/mv`;
route tests assert they stay absent.

On a terragucci repo (`terragucci.yml`) or SQL Yodeler repo
(`yodel.config.ts`), every non-GET route answers 409 unless it is listed in
`TERRAGUCCI_ALLOWED_WRITES` (src/terragucci-repo.ts). A new write route is
refused there until you add it; src/terragucci-repo.test.ts walks every route.

### Reading chant

- Every chant read goes through src/workspace-reader.ts. chant's reader conformance suite runs against it in `npm test` (src/workspace-reader-conformance.test.ts). Do not shell chant from elsewhere or import chant's library for something a read-contract command answers.
- behold runs the project's own chant, which may be older. Each read gets one floor in src/chant-floors.ts: a `<READ>_CHANT_FLOOR` constant, an entry in `CHANT_FLOORS` (what doctor prints), and a `floorMet`/`floorRefusal` check before spawning.
- When the chant behold follows changes, edit `CHANT_RELEASE` in src/chant-release.ts and run `npx tsx scripts/chant-release.ts`; `--check` lists files out of step.
- behold computes nothing chant answers. It parses no HCL, invents no edges, and paints an unknown status or read as neutral with a label, never a guessed colour.

### Adding a member kind

src/member-kind.ts is the one table (`registerMemberKind`, `MEMBER_KINDS`).
A probe is sync, read-only and runs no code. Routes never branch on kind:
differences live in the kind's `via.read` or `passes`. A `passes` function
mutates in place, guards on the IR's content rather than the served kinds,
and must not re-run. A test that stubs a kind's reader spreads the real spec
or it loses the passes. Add a pack in src/render.ts, a row in
src/status-vocabulary.ts if the kind has its own words, a doctor check if it
needs a binary, and tests in src/project.test.ts and src/estate.test.ts.

### Scratch infrastructure

Anything behold boots goes through `assertScratch` (src/scratch.ts): named
`behold-*`, refuses a taken name, tears down only what it created, never
binds :4566. Protected names are listed in `PROTECTED_INFRA`. A new boot site
gets a row in src/scratch.test.ts.

### Tests and checks

- The local gate is `just check` (tsc, tests, build). The docs site has its own: `npm run build` in docs/ lints the agent prompts and checks every link.
- src/test-env.ts strips CHOUDOUFU_BIN, PLUNGE_BIN and similar from the test environment. A test that needs one sets it and restores it.
- Tests against a real chant run only when `BEHOLD_TEST_CHANT_BIN` is set; k3d tests only with `BEHOLD_K3D_TESTS=1`.
- src/render.ts and its imports must bundle for the browser, so no `node:` imports (`npm run check:browser-bundle` names the chain). After `web/icons` changes, run `npm run generate:icons`.
- src/graph-package.ts (built to dist/index.js, used by the action and the VS Code extension) stays free of hono, the MCP SDK and the Kubernetes client; src/read-graph-imports.test.ts holds it. The Kubernetes client is an optional peer, loaded by dynamic import.
- The emulator e2e recipes run their script under e2e/lib/safe-env.sh, which keeps real cloud credentials out; e2e/README.md lists the variables. A new emulator recipe does the same. `just e2e` (real AWS when it finds credentials) and `just e2e-ci-github` (your gh login) run without it.

### Merging

main has a merge queue. Open the pull request with the local gate passing
and queue it with `gh pr merge <n> --auto --squash`; the queue tests it on
top of main and merges it. `--delete-branch` is refused while the queue is
on.

### Workbench and release

workbench.json lists internal estates used for development; `just example
<entry>` serves one. Paths are siblings (`../chant`, `../choudoufu`); a
missing sibling just marks the entry unsatisfiable. `fountain-ops` runs its
setup in your working checkout and switches your kubectl context, so avoid it
unless asked.

behold's products are released with `chant release`, as one release train:
the npm package (release/behold), kubectl-behold, the Headlamp plugin, the
Backstage dynamic-plugin image, the Argo CD extension and the VS Code
extension are the members of chant.workspace.json, each with its own
chant.config.ts, version and tag (`behold-v`, `kubectl-behold-v`,
`headlamp-behold-v`, `backstage-plugin-behold-v`, `argocd-behold-v`,
`vscode-behold-v`). The root chant.config.ts
declares the train, and `just release-workflow` renders
.github/workflows/release.yml from it; never edit that file by hand. `just
release` dispatches it from main: it cuts main's head once its checks are
green, releases each product that changed at a label past every version it
has, stamps that label into the product's manifests (no version-bump PR), and
publishes; mcp-registry.yml then lists a new behold in the MCP Registry. `just
release-plan` prints what the next train would cut. Files that pin a published
release (the plugin and action pins, krew/behold.yaml, artifacthub-pkg.yml)
move in a pull request of their own after it is out. Never push a release tag
by hand. Pull requests that touch a surface run its checks in
.github/workflows/surfaces.yml.
