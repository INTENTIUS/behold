# Driving behold (for agents)

behold is a **read-only control plane** over a chant estate, with **delegated,
gated** writes. As an agent you drive it the same way a human does, and the
mutating capabilities are chant's MCP Op tools, not behold's, so nothing here holds
apply creds.

## The division of labour

- **behold** serves the live, mixed-substrate graph (and, later, the deployment-lanes
  timeline). It reads; every write it offers is a command it starts (an Op, a
  `chant run`, a forge dispatch), and on a terragucci or SQL Yodeler repo it
  starts none.
- **chant's MCP** is where the real capabilities live. Prefer it over shelling.
  - Reads: `lifecycle-diff`, `lifecycle-snapshot`, `build`, `lint`.
  - Actions (delegated writes): `op-run` (start an `ApplyOp`/`ReconcileOp`),
    `op-signal` (approve a gate), `op-status` / `op-report` (watch it).

## A declared workspace

A directory with a `chant.workspace.json` is a chant workspace (chant ≥ 0.81.0,
INTENTIUS/chant#2524). `behold serve <root>` serves it from chant's own member
list (`chant workspace ls --json`, read contract 1; any other contract is
refused), and reads each `chant`, `terraform` and `choudoufu` member through
`chant workspace graph --member <name>`. A `choudoufu` member takes its block
graph from it (the estate's own edges, each block's `file` and `line`) and
joins it onto choudoufu's `live-check` roster, which still names the cards,
the rungs and the cross-estate references: chant's graph is one node per
block, ownership is per instance, and chant carries no rung or reference
(src/choudoufu-workspace.ts, #465). The ids are the roster's, as before, so a
saved layout keeps matching. behold's own lexicon read of a choudoufu
directory stays for a loose view only. Node ids are `<member>/<id>` with the declared member name, the same
form chant composes. A member chant cannot read is drawn as one
`UnreadableMember` node carrying `attrs._unreadable: {code, message}` with
chant's reason code. An `other` member is listed on startup and in doctor and
draws nothing. A declaration with `members: []` (terragucci writes one for its
gates) declares nothing to draw, so serve, export and doctor read the
directory as they would without one, and say so (#489). `.behold.json`'s `members` are ignored beside a declaration;
`behold doctor --fix` writes the declaration for an estate that has only them.
Several directories on the command line (`behold serve a b c`) stay the loose
view behold composes itself.

Every workspace read goes through one module, `src/workspace-reader.ts`: one
chant call per read, the document handed back as chant printed it, any
contract but 1 refused. chant's reader conformance suite
(`@intentius/chant/workspace/conformance`) runs against that module in `npm
test` (`src/workspace-reader-conformance.test.ts`, #468), so a new workspace
read is added to the reader and to the suite's `commands`, never shelled from
somewhere else.

`GET /api/workspace/why?member=<name>` or `?node=<member>/<id>` (#471) answers
why a member or a card is the way it is, from `chant workspace graph --intent
<region> --json` (chant 0.102.0 or newer writes its `why`): the decisions
covering it in chant's order, the agent runs and the commits behind it, and the
gaps chant names. The region is the member's declared directory or the node id,
never a path from the caller. It takes seconds on a small workspace and tens of
seconds on a large one, so the inspect pane reads it only on a click, and it is
a scheduled read: it holds a slot in the read budget, has the read deadline,
and stops when the request does. `serve --hud <url>` (or `BEHOLD_HUD_URL`)
links a proposed decision to its review in hud.

## Chant version floors (behold#691)

behold shells each project's own chant, so a read can reach a chant that
predates it. Every read has one floor, and every floor lives in
`src/chant-floors.ts`:

- one constant per read, named after the read (`WHY_CHANT_FLOOR`) and set to the
  chant release that adds it;
- one entry in `CHANT_FLOORS` (the read in words, the floor, what adds it in
  chant), which is what `behold doctor` lists with the project's chant version
  and whether the floor is met;
- the code that makes the read checks the project's chant first (`floorMet`,
  `floorRefusal`) and never sends the read to a chant that would reject it.

On an older chant the pane that needs the read shows `floorRefusal`'s words
(the read, the chant that adds it, the project's version) and the rest of
behold works. The why route does this: `GET /api/workspace/why` refuses before
spawning the read. A new read adds its constant and entry in the issue that
adds the read, once the chant release is known, and reads through the read
contract (`src/workspace-reader.ts`), never chant's library.

## A pipeline's numbers, from Prometheus (behold#571)

`behold serve --prometheus <url>` (or `BEHOLD_PROMETHEUS_URL`) adds `GET
/api/metrics?project=<owner>/<name>[&commit=<sha>]` (src/prometheus-metrics.ts).
behold asks a FIXED set of named queries over terragucci's gauges (each a
constant string, nothing from the request in it), shares one read for 30 s,
and picks the repo's series out of the answers: one commit's tf-apply waves
(the wave job's own time first, then each root's init, plan and apply
seconds and any state lock wait, in milliseconds below a second on the
kiosk, the time an approval held the wave at
its gate, the changes it applied, when it started waiting) and the DORA four,
from terragucci estate's gauges or its `dora.json` beside the reports. It
answers numbers, never a proxy, and a public serve keeps it (GET). Without
an address it answers 404. The kiosk's "Pipeline metrics" pane
(web/kiosk-metrics.js) shows only what it returns, and no pane when it
returns nothing for the repo.

## Runs from chant's run index (behold#815)

`behold serve --ci-report-url <url>` (or `BEHOLD_CI_REPORT_URL`) points the
kiosk's runs pane at chant's run index, `<url>/runs/index.json`
(ci-run-index/v1, floor `CI_RUN_INDEX_CHANT_FLOOR`, 0.124.31), instead of the
forge's runs (src/ci-run-index.ts). The text goes through
`ciRunIndexOf` in src/workspace-reader.ts (contract 1), then the floor against
the index's own `chant`, then the vendored schema
(src/ci-run-index-schema/, chant commit in `CI_RUN_INDEX_SCHEMA_SOURCE`) with
its `status` and `job` enums left out, since v1 adds to them. An entry the
schema refuses, or whose key is not `<pr>/<commit>[/<member>]`, is dropped and
listed in `skipped`. `GET /api/chant/ci/runs` answers the runs in demo.runs/v1
shape; `GET /api/chant/ci/runs/:runId` reads that entry's
`pr-<job>.events.jsonl` and `pr-<job>.json` under its key only and builds the
log with `demoRunOf` (src/chant-demo.ts). No events file is one step saying
so. An apply refused with `plan-changed`, `not-approved` or a wave's
equivalent exited 3 and is drawn waiting with "the plan moved or waits:
re-plan and re-approve". So is an apply whose entry has `exitCode: 3` and a
failure that isn't another refusal (#818; the field follows chant#4165, not
merged, and isn't in the vendored schema; absent reads as before). `signer` shows only when it is a string; runOrigin's
URL is the link, named by its host, never by `forge`. The page learns of it
from `<meta name="kiosk-runs" content="chant-ci">` (web/kiosk-source.js
`pageRuns`); only the runs pane switches, the cycle and approval panel read
as before. #818: without the flag, a served workspace's declared
`ci.reportUrl` (s3:// or file://, read from the `workspace ls` behold already
makes, `declaredReportUrl` in src/workspace.ts, floor
`CI_REPORT_URL_CHANT_FLOOR`, 0.124.32, chant#4160) is used, a memberless
declaration included; the flag overrides it, and each answer's `urlFrom` says
`flag` or `declaration`. With neither, nothing changes.

## A plan job run locally (behold#685)

`POST /api/chant/ci/local` `{job: "plan", commit, pr, env?, base?, member?,
forge?}` starts `chant ci run plan --local --events-json --env <env> --base
<sha> --commit <sha> --pr <n> --forge <forge>` (src/ci-local-run.ts, floor
`CI_RUN_LOCAL_CHANT_FLOOR`, 0.124.32, chant#4161) in the workspace root or the
named member's declared directory. Each value is checked; the commit and base
are resolved by `git rev-parse` in the root, the base defaulting to where the
commit leaves the trunk, the forge to the one workflow directory present. It
runs through the runner's `track`, so it shares the one-command guard and the
now-line, and is refused like an Op run: preview `403`, a terragucci or SQL
Yodeler repo `409` (not allowlisted), `--public` `405` and its GETs `403`.
stdout lines cross `readRunLine`; stderr is the step output, filed under its
`[<phase>]`. `GET /api/chant/ci/local/:id` answers the run in demo.run/v1
(`from: "chant-ci-local"`) and `ci`, CI's run of the same job, commit and
member from the run index (`ciRunsRoutes`' lookup) when `--ci-report-url` is
set. The SSE `local-run` event names a run that moved. The page's **Local** tab
(web/local-run.js) draws both with kiosk-runs.js `renderRun`, and is not drawn
in a public view, an embed, a static export, preview or a guarded repo.

Apply is never started: `job: "apply"` answers `422 local-apply`.
`--local` does not make an apply safe (it still changes real infrastructure
and pushes release records and gate facts), and behold has no emulator notion
that holds for it: `ci run` gives the job a clean environment that keeps HOME,
so `serve --local`'s emulator env does not reach the job and the operator's
own credentials would. Cached-step marks wait on chant#4015.

## A terragucci estate, from its reports (#490)

`behold serve <repo> --terragucci <dir|s3://bucket/prefix|https://…>`
(`--terragucci-project <host/path>` when the bucket holds several projects
and none is the checkout's git remote) adds two reads, in
`src/terragucci-view.ts`:

- `GET /api/terragucci`: `{source, project, validation, read, reports, files,
  estate?, roots[], cards{}, waiting[], unmatched}`. `roots[]` is every
  Terraform root of the checkout with the newest `plan`, `drift` and `apply`
  run that held it; a missing stage means no report holds that root, which is
  not "no changes". `cards` maps a card id to its marks (`verdict: drift |
  plan | wave`, terragucci's words, the instance addresses, the run). Each
  mark's `values` gives each changed attribute's `before` and `after`, or
  `unknown: true` for a value known only after apply. A sensitive attribute
  is never there, and a value longer than 300 characters of JSON is left out
  with `long: true`. `applied` maps a card id to what its root's newest
  applied wave wrote. The kiosk's popover reads both (behold#571). Nothing
  sets `_status`: a report is never painted as live. `waiting[]` carries each
  wave's roots, destroys, and the `command` a person runs. `estate` is
  terragucci's own counts when the source has `estate.json`. A key such as a
  run's `report` opens at `files` + the key. Refusals are `422 {code:
  "terragucci-report"}`. `?fresh=1` skips the 30 s cache.
- `GET /api/terragucci/file?key=<key>`: one report file from the source,
  sandboxed.
- `GET /api/terragucci/timeline?root=<path>&limit=<n>` (#506): terragucci's
  audit record (`audit.jsonl` at the top of the prefix, one GET) as `{source,
  project, validation, read, record: {key, present}, absent?, files, root?,
  total, limit, entries[]}`, newest first, 200 by default and 1000 at most.
  An entry is `{id, kind, at, who, what, wave?, digest, result, roots[], run:
  {commit?, job_url?, run_id?, pull_request?, report?}, evidence, detail?}`;
  `run.report` opens at `files` + the key. An approval takes the roots and
  report of its wave's other entries (same gate and digest). No
  `audit.jsonl` is `present: false` plus an `absent` sentence, never an
  empty history; a bad line is the `422 terragucci-report` refusal naming it.
  #523: an S3 403 on an optional read (`audit.jsonl` here, `run.json` for
  `/api/terragucci/progress` and the estate's run views) is not a refusal:
  the source throws `TerragucciDenied` (`src/terragucci-source.ts`), and the
  answer carries `present: false`, `unreadable: true` and an `absent`
  sentence naming the key and `s3:GetObject` (or `s3:ListBucket`). A 403 on
  `index.json`, a report or `estate.json` still fails.
  `src/terragucci-timeline.ts` holds the read and the check (terragucci's
  `dist/audit.schema.json` when it resolves, structural otherwise). The SPA
  draws it in the Terragucci tab and, filtered to the card's root, in the
  inspect pane (`web/terragucci-timeline.js`); an export carries it as one
  snapshot and does not fail on it.
- `GET /api/terragucci/lifecycle` (#505): the repo's `chant/lifecycle` lane,
  `{branch, found, via, origin?, fetch: {ok, error?}, commit?: {sha,
  committed}, read: {at}, approval?, gates[], locks[], note}`. `gates[]` is one
  entry per wave gate (`wave-<k>`, chant op-waves' `<gate>-wave-<k>` or a
  product's `<name>-wave-<k>`: `WAVE_GATE`, #521) in `_gates/tf-apply.jsonl` and
  `_gates/tf-apply/applied.jsonl`, decided by chant's `decideGateApproval`
  (`@intentius/chant/gate-decision`, #520) with spent approvals left out, on
  lines parsed by chant's `parseGateLedger` and `parseAppliedGateLines`. The
  states:
  - `waiting`: no approval of the wave's digest counts; `command` is the
    approve line (`--sign` under `sealed`), or `chant workspace points answer
    <id>` when the pending fact carries `answer: {point, id}` (#521).
  - `expired`: the pending fact's `expiresAt` passed with none.
  - `refused`: an unspent approval stands for another digest
    (`refused: {digest, by, at}`); no approve line.
  - `approved`: an unspent approval of the digest counts, not applied yet.
  - `applied` / `failed`: a wave applied under that approval, and how the
    apply finished when terragucci recorded it. chant's op waves write no
    `finished` line: then `applied.result` is absent and the page says
    "applied (outcome not recorded)".
  - `refused-by-policy` (#521): a denial on `_gates/policy-override.jsonl`
    (chant's `recordedDenials`) newer than anything on the wave's gate, that
    no override counts for (chant's `decideOverride`, with the overriders at
    base: `.chant/overriders`, or terragucci's `policy.override`) and no run
    applied an override of since. `denials[]` carries each run, its plan and
    rules, and chant's `overrideCommand` line; no approve line. The wave is
    the one the denial's pending fact names (`wave: {number, name, op}`,
    typed on chant's `PendingGateRecord`, whose parser drops a wave of the
    wrong shape, chant#3887), else, for a fact an older chant wrote, the one
    whose pending fact lists the run.
  - `held` (#521): a pending fact on another gate (any `_gates/<op>.jsonl`)
    that names this op's wave (`wave: {number, name, op}`), with no approval
    of its digest that counts under the mode the fact records. `heldOn: {op,
    gate, digest, since, heldBy, description}`; `heldBy: {hook, moment,
    target?}` is the hook that holds the wave (chant#3886), and the card
    (`holderWords` in `web/terragucci-lifecycle.js`) names it from there,
    or from `description` for a fact an older chant wrote. `command`
    approves that gate (`chant approve <op> <gate> --plan`) or answers its
    decision point. A hold fact that names no wave is not read as a hold.
  Each entry also carries `digest`, `pending` (with `members` and
  `neverOverMcp` when recorded, `description`, `url`, `answer`), `approval`
  (by, at, `signed` when the seal has a signature, via (`review` for chant's
  `review: {pr, head, approvers}` line), pr, head, reviewers, relayedBy, note), `uncounted` (an
  approval of this digest the mode did not count, with chant's reason, such
  as an unsealed one under `sealed`), `spent` (an approval of another digest
  an apply used), `applied` (with `wave` and `review` when present), the kept
  reports under `_gates/tf-apply/wave-<k>/`, and `command`. `approval` on the
  answer is the rule read at base, the tip of origin's default branch fetched
  depth 1 into the same cache (`refs/behold/base`): `mode` from
  terragucci.yml's `approval:` key, else `sealed` when chant.workspace.json
  lists `identity.gates`, else `ledger`, and the signers read with chant's
  `gateSignersAt`. Each wave is decided under the approval mode its newest
  pending fact records (`approvalMode`, `withRecordedModes`), else the mode at
  base; the entry carries `approvalMode: {mode, from: "pending" | "base"}`,
  and `approval.inferred` is set only when some wave's fact records none. A
  gate `identity.gates` names at base is decided with `refuses` from chant's
  `identityGateAdmissionAt`, which checks the seal against the signers at
  base and, when the gate names a class, the role grants in
  `.chant/trust.json` at base, whatever the mode; the entry carries
  `identity: {class}`. A class a pinned package supplies is read by chant
  from `./workspace-principals` (chant#3888): a path pin's file at base, a
  package pin's from the package installed in the served checkout's
  node_modules (behold passes the checkout as `packages`, since the bare
  cache has none), at the pinned version. When that package is missing or
  at another version, a gate naming a domain class or `human` refuses every
  approval and chant's reason names the pin. Under `pr-review`, a spec's `headPlans` (the op-waves spec name)
  has the newest 50 `_wave-plans/<name>/<head>.json` records read with
  chant's `readHeadPlans` (`@intentius/chant/lifecycle/wave-plans`) through
  `ledgerPort`, a `LedgerReadPort` over the fetched commit. The op, ledger paths, gate names, approve line and
  mode reader are a `GateLaneSpec` (`TERRAGUCCI_LANE` is terragucci's), for
  another product's lane: `opWavesLane(op, over?)` gives one with chant's
  approve line, mode rule and overriders, and `readLifecycle(checkout, {spec})`
  reads it. `terragucciApproveCommand` is the one approve line the reports,
  the estate and the lane share, and `gatePolicyName` reads `on-destroy` as
  `on-destructive` (terragucci#863). `locks[]` is
  `_locks/tf-apply.json`, one per root (`pr, by, at, head, via?, stage?`).
  Every gate and lock carries `source: {commit, committed, path}`, the newest
  commit of the branch that changed its file. The branch is fetched from the
  checkout's origin URL into `<tmpdir>/behold-lifecycle-<hash of the URL>`, a
  bare repo behold owns (`assertScratch`), with the person's own git
  credentials and no prompt; the checkout is never fetched into and no ref of
  it moves. A failed fetch falls back to the checkout's own
  `refs/remotes/origin/chant/lifecycle`, read-only (`via: "checkout-ref"`,
  `fetch.error`); a remote without the branch is `found: false, via:
  "fetch"`, not an error. 30 s cache, `?fresh=1` skips it. Reader:
  `src/terragucci-lifecycle.ts`.
- `GET /api/lifecycle/history?op=<op>&gate=<gate>&limit=<n>` (#522): the
  gate ledgers' history on `chant/lifecycle`, for any product, registered
  whether or not `--terragucci` is given. Same bare cache and fallback as
  the lifecycle lane; per `_gates/<op>.jsonl` it runs `git log -p
  --unified=0 --no-renames` and hands the text to chant's
  `gateLedgerLinesFromLog`, then all ledgers to `deriveGateAudit`
  (`@intentius/chant/lifecycle/gate-audit`). behold parses no ledger line
  itself. Answer: `{branch, source: "ledger", found, via, origin?, fetch,
  commit?, read, ledgers[], op?, gate?, total, limit, entries[], gaps[],
  note}`, newest first, 200 by default and 1000 at most. An entry is `{id,
  kind, at, op, gate, wave?, digest?, actor?, seal?, note?, rules?, subject?,
  source: {path, line?, commit, committer, committed, change}, audit}`;
  `kind` is chant's (`approval-requested | approved | override-requested |
  override-recorded | revoked`), `audit` is chant's whole entry. A revocation
  is a line a commit removed, and its `actor` is that commit's author. The
  ledger holds no applies, so `applied` and `override-spent` appear only in
  a product's own record (terragucci's `audit.jsonl`). The Terragucci tab's
  Timeline draws it under the audit record, labelled "ledger"; when the
  source has no `audit.jsonl` the record's lane says so and the ledger is
  the history. An export carries it as one snapshot. Reader:
  `src/lifecycle-history.ts`.
- `GET /api/terragucci/events` (#505): SSE. While at least one page holds it
  open, a timer (`--terragucci-poll <secs>`, default 30, 0 off) asks
  whether `index.json` changed (`If-None-Match` with the last ETag for S3 and
  http, mtime for a directory) and fetches `chant/lifecycle` again. Events:
  `hello {pollSecs}`, `reports {at, tag}` (the page reads `/api/terragucci`
  again), `lifecycle <the whole answer>` when the read differs from the last,
  and `polled {at, reports, lifecycle}` after every tick. The last page
  leaving stops the timer (`src/terragucci-poll.ts`). Neither route writes,
  approves, locks or unlocks.
- `GET /api/terragucci/progress` (#511): a choudoufu wave's progress per
  resource from the run view of the newest commit `index.json` names a
  `tf-apply` run of (one GET of `index.json`, one of
  `<project dir>/runs/<commit>/run.json`, the directory taken from the index
  row's own path). `{source, kind, project, validation, read, run: {commit,
  key, present, updated?, html?} | null, absent?, files, watching, waves[],
  cards{}, unmatched[]}`. A wave is `{number, state, gate, read, counts,
  resources[]}`, a resource `{root, address, action, status: done | in-flight
  | waiting | not-applied, done_at?, card?}`. `cards` is keyed by the same ids
  as `/api/terragucci`'s marks (root path to `attrs.root`, instance to block),
  one entry per wave with the wave's records `read` time and the card's
  status (not applied, else in flight, else waiting, else done). It is a
  dated corner tag, never a fill. No `run.json` is `run.present: false` plus
  an `absent` sentence. `watching` is true while a wave is applying or a
  resource is in flight or waiting; only then does the poll ask whether that
  `run.json` changed (`If-None-Match`, mtime for a directory) and push a
  `progress` event with the whole answer, and `polled` carries `progress:
  {asked, key?, changed?, error?}`. Checked against `dist/run.schema.json`
  when `@intentius/terragucci` resolves, structurally otherwise; reader
  `src/terragucci-progress.ts`, page `web/terragucci-progress.js`.

The reads are `src/terragucci-reports.ts` (index, each run's report, estate;
terragucci's JSON Schemas when `@intentius/terragucci` resolves, a structural
check otherwise; the package is looked up on every read and the compiled
schemas cached by its path and files' mtimes, #500) and the join is `src/terragucci-overlay.ts` (root path to
`attrs.root`, instance address to block path). An S3 source shells the
operator's `aws s3 cp <key> -`. There is no approve route, by design: hand the
operator `waiting[].command`.

A control repo (#509), one whose terragucci config has `projects:` and whose
checkout declares no Terraform root (`controlRepo` in
`src/terragucci-estate.ts`), gets one more read, and `/api/project` carries
`terragucciControl: {config, projects}`:

- `GET /api/terragucci/estate`: `{source, kind, config, validation: {estate,
  run}, read, estate: {key, html, generated}, gets, projects[], edges[],
  files}`. It reads `estate.json` and each project's newest run view,
  `<project>/runs/<commit>/run.json`, one GET each (the commit is the
  project's `run_view.commit`, else its `apply.commit`). A project is
  `{project, status, index?, counts: {drifted, failed, waiting, dated},
  waiting[], run? | missing? | refused?, checkout?, configured}`. Every
  figure carries `dated: {key, at}`: estate.json's `generated`, or the run
  view's `updated`. `waiting[].command` is the run view's approve line when it
  holds that wave. `edges[]` is `{from, to, cross}`, `to` reading `from`'s
  state; a cross edge matches a root's `external` read to another project's
  root `state`, as terragucci's `estateGraph` does. A malformed run view is
  `refused: {code: "terragucci-report"}` on its project only; a missing or
  malformed `estate.json` is a 422. Not a control repo: 404 `code:
  "terragucci-not-control"`. Run views are checked against
  `@intentius/terragucci`'s `dist/run.schema.json` when it resolves, a
  structural check otherwise. The page (`web/terragucci-estate.js`) draws it
  in a layer over the graph area.

## Releases per environment, from the release ledger (#525)

`GET /api/lifecycle/releases[?fresh=1]` (src/lifecycle-releases.ts) reads
`<env>/releases.jsonl` on the served checkout's `chant/lifecycle` with chant's
own reader (`listReleaseEnvironments`, `readReleaseLedger`,
`latestPerComponent`, `recordsForDigest`). This one still imports
`@intentius/chant/lifecycle/release-ledger`: no read-contract command lists a
project's per-environment ledger outside a declared workspace (`workspace
status` needs a declaration, and `release list` lists cut releases, not the
`components release` records SQL Yodeler writes), so dropping the import would
blank the tab for every SQL Yodeler project. The trunk lane (#680) reads
releases through the contract only. The branch is fetched into the
same bare cache the terragucci lane uses (`fetchIntoCache` in
src/terragucci-lifecycle.ts). When that fetch fails, the checkout's
`refs/remotes/origin/chant/lifecycle` is fetched into a second cache of
behold's and read there (`via: "checkout-ref"`); the checkout is never
written. Reads are reused for 30s.

The answer: `environments` (wave order from `yodel-waves.json` when present,
`order: "waves"`, else by name), `components` (a tenant is
`<component>/<tenant>`, as SQL Yodeler records it), and `cells[]`, one per
component and environment that has a release: `digest`, `timestamp`,
`actor`, `approver?`, `gitSha`, `runId`, `runUrl?`, `source` (the newest
commit that changed that environment's ledger), and `differs: {from,
digest?, everHad}` when the environment before it holds another digest or
none. `/api/project` says `releaseLedger: true` for a checkout with a
`yodel.config.ts` or `yodel-waves.json`; the page then opens a Releases tab
(`web/releases.js`), and `behold export` captures the route as a snapshot.

## SQL Yodeler's report and drift, from files (#526)

`behold serve <dir> --yodel-report <file|dir>` adds `GET /api/yodel-report`
(`src/yodel-report.ts`). It reads one `yodel report --json` output and any
`yodel drift <env> --json` output in the same directory, written by the
person or their pipeline. behold never runs `yodel` and never connects to
the database.

- The answer is `{source, validation, report, environments[], drift[],
  marks[], ignored[]}`. Each environment carries its applied migrations, the
  rest with their state, its gaps and notes, dated by the report's
  `generatedAt`. Each mark is one object a drift file names (`changed` or
  `missing`), dated by the file's mtime (drift JSON has no time of its own)
  and named by its file.
- Every file is checked against SQL Yodeler's schemas: from
  `@intentius/sql-yodeler/schemas/` when the package resolves beside the
  served project or behold, otherwise from the copy pinned in
  `src/sql-yodeler-schemas/` (sql-yodeler 19ebbff). A file that fails is a
  422 with `code: "yodel-report"` naming the file, and nothing is drawn.
  Update the pinned copy by copying the three files from sql-yodeler's
  `schemas/` and changing `PINNED_COMMIT`.
- The page (`web/yodel-report.js`) joins a mark to the card whose id is the
  object's name, or ends in `/<name>` in a composed estate, and draws a
  corner tag with its age; never a fill. Objects no card is are listed in
  the SQL Yodeler tab, which also holds the environments and gaps.
- `audit[]` (#537) carries the report's audit entries with the report file
  they came from. The tab lists them under their environment, each dated by
  its own `at` and named by its source (a ledger's op and gate, or a history
  table's row and run).
- `behold export --yodel-report <file|dir>` (#537) captures `/api/yodel-report`
  as a snapshot, and a refusal fails the export, as `--terragucci` does. A
  SQL Yodeler repo's export also captures `/api/sql-yodeler/lifecycle` and
  `/api/lifecycle/history`, so the Pipeline lane draws in static mode,
  without its Read again button.

## A SQL Yodeler project: kinds and a lifecycle lane (#524)

A SQL Yodeler project is a chant project with `lexicons: ["sql"]` and a
`yodel.config.ts` (#517's detection, `productRepo` in src/terragucci-repo.ts).
Its graph draws from `chant graph` as any project's does. src/sql-kinds.ts
registers a pinhole pack for the `sql` lexicon: a line glyph per
`Postgres::*` and `ClickHouse::*` kind, and cards that lead with the kind in
words and the qualified name. A `REFERENCES ${other}` foreign key is a `ref`
edge; e2e/fixtures/sql-yodeler-fk holds a project with one, and
src/sql-yodeler-lane.test.ts graphs it. `@intentius/chant-lexicon-sql` is a
devDependency for that test; from 0.124.13 its lint rules use chant's own
TypeScript (chant#3864), so they run beside behold's TypeScript 7.

`GET /api/sql-yodeler/lifecycle[?fresh=1]` (src/sql-yodeler-lane.ts) reads
`chant/lifecycle` with `readLifecycle` and a spec per op, sharing one fetch:

- `opWavesLane("yodel-apply")` for the apply pipeline's
  `yodel-apply-wave-<k>` gates, with the mode at base from `yodel-waves.json`
  when every wave names the same `approval`. When they differ (#537) the
  rule carries `waves[]` and each wave is decided under its own mode
  (`waveRule`; a gate decided so carries `mode`). Under `pr-review` a gate not
  yet approved carries `headPlans[]`: the heads whose
  `_wave-plans/yodel-apply/<head>.json` (chant's HeadPlans, newest 50 read)
  name its digest.
- `migrateOpLane(env)` for each `migrate-<env>` op that `ops/` or
  `yodel-waves.json` names: its one gate `approve-migrate-<env>`, drawn as
  wave 1 of that op.

The answer is the lane's header (branch, via, commit, rule, note) with
`environments[]` in the order of applies (`yodel-waves.json`, then any
environment only `ops/` names), each with its wave (`k`, targets, gate
policy, approval) and `gates[]` (`kind: "wave" | "migrate"`, the GateEntry
of #520/#521). A waiting gate carries `npx yodel approve <env> --plan
<digest>` (`--sign` under sealed). Waves the spec does not name go in
`unplaced`. A served directory that is not SQL Yodeler gets 404 with
`code: "sql-yodeler"`. The page's Pipeline tab (`web/sql-yodeler-lane.js`)
draws it, with `/api/lifecycle/history` (#522) below. Reads are reused 30s.

A SQL Yodeler project that is a chant workspace member (#537) keeps its
records under `_members/<member>/` on `chant/lifecycle`. src/member-ledger.ts
asks chant's `resolveMemberLedger` (`@intentius/chant/lifecycle/member-ledger`)
for the prefix; the lane passes it as `GateLaneSpec.ledgerPrefix`, which
`readLifecycle` puts before every branch path, and `/api/lifecycle/releases`
hands it to chant's `listReleaseEnvironments` and `readReleaseLedger` as
`ledgerPrefix` (chant#3865), which list and read the environments under it. Both answers then carry
`member: { members, prefix, error? }`, and `yodel-waves.json` at base is read
in the project's own directory.

## Getting a server

```sh
npx @intentius/behold serve <chant-project-dir> --port 4600   # or: preview / demo / doctor
```

`behold demo` needs no project at all — it copies the bundled example and serves
it against a local emulator (Docker). A directory that is not a chant project
gets a structured `{code: "no-project"}` error from `/api/graph`, not a blank
graph.

In a checkout, `behold demo --list` prints a second block under the bundled
one: the eleven workbench entries from `workbench.json` (this repo's own
catalog of the internal estates behold is developed against), the same
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

0. **discover.** GET `/api` lists every route with a one-line description,
   plus the server's version and a link back to this guide. Before the server
   exists (or when a route answers with an error you'd have to guess at), run
   `npx @intentius/behold doctor <dir> --json`: a read-only diagnosis of the
   project's kind, its own chant install and version, declared lexicons, the
   envs the picker will infer, the bound kube context versus the ambient one,
   substrate readiness and committed Ops. Each check is
   `{name, status: pass|warn|fail, detail, fix}`; the process exits non-zero
   iff something failed. It starts no server and changes nothing.
1. **observe.** GET `/api/graph` (JSON: `{ ir, svg, meta }`). The mixed graph
   of the project, every node with `id`/`kind`/`lexicon`/`attrs`/`sourceLoc`. Drift
   status, when present, is `attrs._status` (`good`=managed, `warn`=foreign,
   `accent`=pending, `neutral`=unobserved, `runtime`=runtime child). With
   `?env=`, `/api/overlay` is the live entity overlay; `/api/diff?env=` slices
   per-node observed state, drift and field ownership; `/api/reconcile?env=`
   summarizes the pending change set; `/api/substrates` reports substrate
   readiness; `/api/events` (SSE) pushes `changed`/`op`/`apply`/`run`/`pr`,
   and `view` when an agent moves the tab (below).
   With `?components=1&env=`, each component node carries `_liveStatus` (the
   `chant components status` verdict) and, when the release ledger recorded
   one, `_release` — `{runId, forge, originSource, url?, gitSha, digest,
   timestamp, actor, approver?}` (#165). `url` is present only when the record
   itself carries an address (chant#2045); `originSource: "inferred"` means
   behold read the id's spelling and nothing more, and a `forge: "unknown"` id
   is never resolved to a link on behold's guess.
   `?stacks=1` is the apply-order lens (#426): the cross-stack ordering chant
   computes at synthesis and prints from `chant graph --stacks --json`, which
   behold read nowhere and re-derived a subset of. One card per stack (a
   lexicon partition), one box per wave, edges consumer to producer;
   `meta.stacks` carries `order`, `waves` and `cycles` verbatim. It is
   source-only (no env, no credentials, no substrate) and asks chant for the
   project ROOT, not `graphPath`, because `runStackGraph` only sees
   `ops/*.op.ts` from there (measured: `example-writes` answers `[aws,
   temporal]` from `.` and `[aws]` from `src`). Single project only: an estate
   is refused with `422 stacks-estate`, since `composeStacks` pools members
   into one bucket per bare lexicon name and two members' `aws` stacks are not
   one stack. A cycle is NOT a refusal — chant exits 1 with valid JSON and the
   entangled stacks absent from `order`/`waves`, so they are drawn unwaved in
   their own box and the note says so; nothing invents a wave number for a
   stack chant could not order. `/api/project`'s `stacksCapable` gates the
   stop. Note that `chant graph --stacks --json` is malformed today on two of
   chant's own examples (an edge with no `from`, a `null` in `order` and in a
   wave); `sanitizeStackGraph` treats `nodes` as the roster and drops anything
   named nowhere else.
   `?ops=1` is the ops lens: the project's declared Ops as a phase track, read
   from each emitted `dist/ops/<name>/op.json`, with the current run painted
   over it (`meta.run`, `meta.gate`); `/api/ops/<name>/status` reads that Op's
   newest run status and pending gate (`chant run status <name>`; chant
   removed `--temporal`, #459). A
   `ConvergeOp` also gets one card per rule from its `convergeTick` step's
   `args.rules` (`attrs._step: "rule"`), carrying `when` (chant's JSON predicate,
   rendered as the condition it states), `then`, and the `why` chant requires of
   every rule, verbatim. `then: run(<op>)` is an edge to that Op's first step
   when the Op is in the rendered set, and `attrs.dangling` when it isn't.
   `meta.operator` on that same lens names the ConvergeOps the project declares
   (chant's own `searchAttributes.Converge === "true"`, read from op.json, no
   subprocess), and `/api/operator/status` fills the strip in from
   `chant operator status --json`.
2. **focus.** Narrow with chant graph options as query params: `?detail=0..3`,
   `?components=1`, `?logical=1`, `?lens=blast:<id>&down=1`, `?lens=lexicon:aws`,
   `?env=`, `?stack=`, `?tier=`, `?target=`, `?collapse=1`.
   `?collapse=1` (#393) shuts every member box holding more than 40 cards: the
   box is drawn as ONE card carrying the count it was badged with (`301
   resources · 84 bound · 85 unowned · 132 neutral`, in the estate's own
   words), ids namespaced `box:<member>`, and the returned IR is the collapsed
   one so every count and note speaks about the picture on screen — except its
   NOTE, which is written about the expanded estate plus one collapse clause
   (#396): a shut box hides what the estate references rather than changing it.
   ⌘K → "Collapse large boxes" / "Expand all". Below the limit it changes
   nothing. **The toggle costs no live read** (#396): a member's overlay
   document is cached under its source stamp and the read's own options, the
   same key half `memberIr` and #404's plan cache use, so collapse and expand
   are re-renders of a document behold already holds. `src/overlay-ir.ts` is
   that cache and its header is the stated exception to src/member-ir.ts's
   "a live read is never cached"; it names everything that drops an entry —
   `POST /api/refresh` ("Re-check live"), `GET /api/overlay?plan=1`
   ("Re-check live with plan", which re-checks both halves), the capture that
   ends an Op run, and the member's source moving. A change made to the account
   by something that is not behold is what the re-check rows are for.
3. **inspect.** A node's `sourceLoc.file` is the typed source that declared it;
   edit there to change the estate (chant is the source of truth, not behold).
4. **find.** ⌘K also takes an ADDRESS (#393). Two characters in, the palette
   matches the ids and addresses of the graph the page is currently showing and
   offers up to twelve `node: <address>` rows, prefix matches first, each with
   its member and kind on a second line (two members of one estate can declare
   the same address). Enter takes the same path a click on the card does (the
   inspect pane and the highlight) and pans the graph onto it: `revealNode` in
   web/app.js drives the same viewBox the wheel, the drag and "⤢ fit" drive.
   Nothing here fetches, so it works in a static export too.

### The picture arrives in pieces (#422)

`GET /api/overlay?progressive=1` answers at once with the estate composed from
every member's SOURCE, each node carrying `attrs._pendingRead`, and then
broadcasts one `member` SSE frame per member as its own live read settles —
`{member, statuses: {<composed id>: <status>}, unobserved?}`, or `{error}` if
the pass itself failed. `meta.mode` is `progressive` and `meta.pending` names
the members not yet read.

**Opt-in, and never the default.** `/api/overlay` without the flag is byte-for-
byte what it was: the blocking, complete live answer this guide's read loop
names, which is what an agent GETs and what `src/export.ts` captures into a
static bundle. A route that answered with members it had not read would hand an
agent a half-picture it could not know was half, and freeze a bundle with
members permanently still-reading.

**Pending is a third claim.** `_unobserved` is "behold looked and could not
see"; `neutral` is "the plan did not mention it"; `_pendingRead` is "the read
has not finished". It rides its own attr rather than a fifth `_status` because
a fifth `_status` is not paintable — pinhole's painter takes a closed set and
falls back to `neutral` for anything else, which is `unobserved`, the exact
wrong answer. The SPA draws it dashed and dimmed, never filled: the fill is the
status channel and a pending card has no status yet.

No live result is cached to build the first picture and none is reused. A
pending member becomes a real one only when its own read completes, and the
live pass a progressive request starts is the same one per member under the
same budget: a progressive load costs the estate no extra spawn.

### What a read cost (#420, #421)

`GET /api/doctor` serves `diagnose()`, the same report `behold doctor` prints,
which until #421 only the CLI could ask for — with two extra blocks on it:

- `reads`, the ledger from `src/read-stats.ts`. Every scheduled chant read
  passes through `ReadScheduler`, so each one is filed there with its running
  time, its outcome, and which side of the source/live split it sits on. A bare
  `chant graph` is the member's own TypeScript evaluation; anything with
  `--live`/`--overlay`, and every other verb `isScheduledRead` allows, reaches
  past it. `shared` counts subscribers handed an in-flight spawn, work not
  done, never a run.
- `cache`, `memberIrCacheStats()`.

`GET /api/doctor?reads=1` is the same two blocks WITHOUT the diagnosis, and it
is what the SPA asks for. The split is the one #421 states: the full report is
for a person diagnosing and the panel line is for a person waiting. It is also a
cost split too: `diagnose()` probes docker, gh, helm and k3d through
src/substrates.ts, whose `probe` has no timeout and no kill, and the SPA asks
after every load settles. A static export asks for neither; `refreshReadCost`
returns on `staticMode` rather than relying on the bundle's own 404.

`reads.inFlight` is `{running, queued}` off the scheduler itself. The ledger
cannot answer it: a read still in flight has finished nothing, so it has filed
nothing. "What is queued now" is what someone watching a slow read wants.

Three things to know before reading a number off it. `queuedMs` is contention
**in the scheduler** (the HTTP-versus-poll-versus-capture competition #367
bounded) rather than the whole of what a member waits: the estate fan-out bounds
upstream through `mapPool` (src/estate.ts), so a three-member estate measured
3033/3035/2218 ms of running time with `queuedMs` 0 against 5.2 s of wall clock.
The gap is the upstream wait and #422 is where it gets measured.

`reads.unmeasured` counts the served members the ledger is BLIND to, and the
panel line prints it rather than quietly excluding them. Only reads that pass
`ReadScheduler` are filed, which is every chant read and therefore a terraform
member too (its `via.read` shells `chant graph`, src/terraform-member.ts). A
choudoufu member spawns its own binary through its own helper and is filed
nowhere, so on a chant+choudoufu estate the slowest card may be one that never
reached `recent` — "slowest 3s · 1 not measured" is the honest form of that, and
an unqualified "slowest 3s" is not.

And preview mode keeps the totals but drops `recent`, whose samples are keyed by
member directory.

The SPA asks once after each load settles and shows the answer on the loading
scrim the *next* time one goes up (`web/read-cost.js`, `#loading-cost`): the
slowest recent member, because an estate read finishes when its last member
does, so a sum would report a number nobody waits for.

### The behaviour overlay (#398, M1 of #397)

What the estate costs and where it runs out of headroom, on `/api/overlay`
only. **behold never calls a behavioural engine**, never holds its key, and
produces no figure of its own — it renders what a chant lexicon handed it, the
way it already renders drift and the carve score. The one arithmetic it does is
addition, and the result is named `sum` so nobody can read it as a bill.

The contract's source of truth is the comment titled "The behaviour block,
proposed" on INTENTIUS/behold#398 (chant#2356 is the writing half). Field names
here match it exactly; `src/behaviour.ts` is the implementation and the
validator.

Per entity, `attrs._behaviour` on the overlay IR node — the channel `_status`,
`_release` and `_carve` already ride: `{at: {traffic}, cost: {perHour,
currency}, headroom: {cpu?, latency?}, errorRate, resilience: {failure, verdict:
survives|degrades|fails, note?}, rightSize?: {suggestion, reason?}, provenance:
{engine, version, tolerance, basis: modeled|validated}}`. An entity nothing
priced carries **no `_behaviour` key at all**, never a zeroed block, and a
missing headroom axis is absent rather than 0. The block stays on the node and
there is deliberately no top-level `behaviour: {}` map: the SPA already walks
`ir.nodes` reading `attrs._status`, and a colour-by-cost mode is that same walk,
with no join.

Two sources, in this order:

1. `attrs._behaviour` on the nodes, as `chant graph --live --overlay` painted
   them, with `meta._behaviour` beside them for the graph-level half.
2. `behaviour.<env>.json` at a member's root — `{meta, entities: {<address>:
   block}}` — read **only** when no node of that member carries the attr and
   the member's read carried no `meta._behaviour` either (#402), and
   **only on the overlay** (`/api/graph` is the source graph; a prediction
   about a live account has no business on it). The file's keys are the
   member's own addresses; behold prefixes them to reach the composed id
   `<member>/<address>`.

`meta.behaviour` carries the graph-level half: `engine`, `version`, `at`, the
engine's own `total` when it stated one, else behold's `sum` and the same per
box under `boxes[<boxKey>]` (`{perHour, currency, priced, unpriced}`). Mixed
currencies produce no sum and a diagnostic — behold converts no currency. A
malformed block is dropped whole with its reason in `diagnostics`, never
half-rendered. A member with neither source gets `{absent: "…"}` naming both
places behold looked; that is an absence, not a refusal, because nothing was
configured.

`meta.behaviour.refusal` is `{reason, remedy}` in the lexicon's own words,
printed as it came, and it is present **instead of** everything above: a
refusal emits no entity block at all and strips any that had arrived. The drift
overlay is untouched either way: nothing in this pass reads or writes
`_status`. `?logical=1` projects a different picture and carries no behaviour
block in M1.

### Live versus declared (#402, M5)

With a traffic level, `/api/overlay` predicts each member twice and carries
both figures and their difference. The level is `?traffic=` on the request,
else `.behold.json`'s `{"behaviour": {"traffic": "100 rps, p50"}}`, else none;
with none nothing is asked for and the payload is exactly M1's. behold never
defaults a level, because every figure is *at* one.

`meta.behaviour` gains `live`, `declared` (each `{perHour, currency, basis}`,
where `basis` is `total` for a figure the engine stated and `sum` for behold
adding the engine's per-entity figures) and `delta` (`{perHour, currency}`,
live minus declared), plus the same three per member under `members[<name>]`.
A delta is only ever like with like: one currency, and two totals or two sums.
Anything else yields no delta and a line in `diagnostics` saying why. A node
also carries the file's block under `attrs._behaviourDeclared`, including a
node the account no longer holds, which has no `_behaviour` at all.

Who reads what is `src/behaviour-delta.ts`'s header. A chant member's live
half is its own overlay read with `--traffic` added (sent only to a chant at
0.75.0 or newer; an older one rejects the flag). A choudoufu member is not
read by chant, so behold predicts it through a generated reader project with
`binary: "choudoufu"` (the Terraform member's scratch project, under
`behold-chdf-*`), which needs the optional terraform lexicon. A terraform
member has no live half and so no delta.

The declared half goes through `memberIr` and is cached under the member's
source stamp plus the traffic level. The live half goes through `overlayIr`
and is dropped by whatever drops the overlay. With a level set, the
`behaviour.<env>.json` documents are not read at all: a fixture's figures
beside a real prediction would be two answers to one question.

`/api/graph?traffic=` (or the config default) paints the declared side alone
as `attrs._behaviour` with `meta.behaviour.declared`. The file is the only
estate that route has, so it carries no live half and no delta.

### Colour by drift, cost or headroom (#399, M2)

The SPA colours the graph by one of three modes. The mode is **client-side
state** — `web/app.js`'s `colourMode`, persisted under `behold.colourBy` the way
the theme is. It is deliberately NOT in `LENS_PARAMS`/`canonicalKey`: a lens
param means "a different snapshot comes back", and a mode change changes no
fetch at all. The block is already on every priced card, so a switch is a
repaint of the SVG on screen.

`drift` keeps the categorical fill and #393's vocabulary legend, unchanged. The
two behaviour modes replace the card's FILL only, so the drift bar underneath
keeps saying what chant observed. `cost` is a sequential scale over
`cost.perHour` between the estate's own min and max; `headroom` is absolute over
0..1 and reads **the lower of the axes present**. An entity with no block draws
the drift overlay's neutral (`pinTokensFor().neutralFill`) and is marked
`data-unpriced`, never the zero end of the scale — "nothing priced this" and
"this is free" are opposite claims.

Both ramps are derived from the active palette (`rampFor` in
`web/behaviour-scale.js`), the way #229 derives the chrome: cost is a single hue
off the accent walked in lightness away from the background — expensive is not a
verdict behold gets to paint, and headroom rides the three status hues the
drift overlay already anchors, degraded → foreign → managed.

One legend per mode, in the Model tab. The Scope tab carries a totals row per
box and per estate for the active mode: `cost` quotes `meta.behaviour.boxes[key]`
and `.sum`, or `meta.behaviour.total` when the ENGINE stated one (labelled
"engine total"); `headroom` has no server-side aggregate, since no engine states one —
so the SPA takes the scope's min and median itself and the row says "computed".
Every row carries `n priced · m unpriced`. In drift mode there is no row.

Everything either mode decides is pure in `web/behaviour-scale.js`, with
`web/behaviour-scale.test.js` beside it; the SPA owns the fetches and the SVG.

### Provenance on every figure, and the refusal (#401, M4)

Every figure the SPA shows, the totals rows, the legend, and the inspect pane's
`behaviour` section — carries `{engine} {version} · {tolerance} · {basis}`
beside it, never once per page. `modeled` is spelled out on hover as "modeled,
not billed": #397's one prohibition is a prediction presented as a bill, and the
badge is where that is prevented. Provenance is per ENTITY in #398's contract, so
a badge over a set (a box, the estate) says `mixed` on any field the set
disagrees on rather than picking one.

`meta.behaviour.refusal` disables both behaviour modes in the View tab and in
⌘K (visibly, with the lexicon's reason and remedy as their tooltip) and prints
those words verbatim where the legend would be. The drift overlay keeps
rendering; it never depended on an engine. `meta.behaviour.absent` disables the
same two modes with the absent line as their tooltip and prints **nothing**:
nothing was configured, so nothing refused. `meta.behaviour.diagnostics` render
in the Model tab under the legend.

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
project directory carries a carveout (no report and no demo needed) and is
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

## A chant search query: `q` and `GET /api/search` (#913)

`q` is a view key holding a query in chant's search grammar. In a link
(`?q=...`), a `behold:view` message, `POST /api/view` and `behold shot`, it
draws the same way: the cards chant matched are lit, the cards and edges on
each match's path (chant's `paths[].hops`) are drawn at full weight, and the
rest is dimmed, with nothing hidden. One line at the top left says the query,
the match count and chant's provenance line. A query with no matches dims
the whole graph, says "no matches" with the universe count, and outlines the
near-misses `--explain` names (hover one for the term it fails). A live read
that failed is said as a failure naming the lexicon, and its rows wear a
dashed ring. A query chant's grammar refuses lights and dims nothing and
shows chant's message and hint. A reload keeps `q`.

chant answers and behold draws. Every search goes through the workspace
reader (`src/workspace-reader.ts`, a fifth `BEHOLD_READS` entry held by
chant's reader conformance suite):

| Served | chant call |
|---|---|
| a declared workspace | `chant workspace search [flags] --json -- <q>` at the root (INTENTIUS/chant#4374). Ids are `<member>/<id>`, as `workspace graph` gives them. A member chant didn't search is named in a "not searched" line with chant's reason code, never shown as no matches |
| one chant project | `chant search [flags] --json -- <q>` in its directory |
| a bare Terraform folder | the same, in the scratch project behold graphs it through. Its cards are a one-member estate's, so behold puts chant's ids under that member's name in `draw`; chant's document is unchanged |
| a loose estate of several dirs | refused, `code: "search-estate"`: declare a workspace |

The mode follows the view: no `env` is the declared source, `env` is a live
read (`--live --env`), and `env` with `snapshot` replays a recorded snapshot
(`--snapshot <ref> --env`). `--explain` is always passed.

```
GET /api/search?q=->kind:aws_kms_key&env=&snapshot=&show=
-> 200 {q, env, snapshot,
        document: <chant's search document, unchanged>,
        draw: {lit, onPath, edges, unobserved, nearMisses, provenance, failure, notSearched},
        link}
```

A query chant refuses answers 400 `code: "query"` with chant's hint as the
remedy (and the document). A chant below 0.124.46 answers 422
`code: "chant-too-old"` (`SEARCH_CONTRACT_CHANT_FLOOR` in
`src/chant-floors.ts`). A `--public` serve answers declared queries and
refuses `env` and `snapshot` (403).

`behold export --q "<query>"` (repeatable) captures each query's answer for
the source graph and every environment, so the bundle draws it with no
backend. The manifest lists `queries`; a link's `q` that wasn't captured is
named, with the captured ones, and lights nothing.

## Moving the person's open tab (#914)

`POST /api/view` changes what every open tab of this serve draws. It is a
view change and writes nothing: no infrastructure, no project file, not
`.behold/layout.json`, and nothing kept on the server.

```
POST /api/view
{"view": {"q": "attr:internetFacing=true", "env": "prod", "snapshot": "latest", "zoom": "resources"},
 "by": "claude-code via behold mcp"}
```

`view` takes the URL's view keys (`member`, `zoom`, `env`, `tier`, `lens`,
`node`, `radial`, `alike`, `gates`, `focus`, `run`, `pull`) plus `q`, a
question in chant's search grammar, and `snapshot`, a recorded lifecycle
snapshot (`latest` or a ref) that needs an `env`. They are settled with the
same checks a link's query gets (`web/view-url.js`: `viewFromObject`,
`settleView`, `checkQuery`); an env the project doesn't declare, a `q` with a
control character or over 2000 characters, or a key that isn't a view key is
named in `refused` and the rest still moves. `at` is refused by name: in
chant's read contract it is a git revision, so a snapshot is `snapshot`.
behold does not parse `q`. The tab draws it through `GET /api/search`
(below): the matches lit, the rest dimmed.

The answer is `200 {id, movedAt, sent, link, view, refused}`, where `sent` is
the number of open tabs it reached and `link` opens the same view. With no
tab open it is `409 {code: "no-tab", link}`: hand the person the link. A
view with nothing that can be applied is `400 {code: "view", refused}`.

Each tab gets a `view` event `{id, movedAt, by, view}` on `/api/events`,
moves, and shows "Moved by an agent: `<by>` asked `<q>` at <time> (request
<id>)" with a Back button. An agent's move pushes a browser history entry, so
the banner's Back and the browser's Back both return to the view from before
it; up to 20 moves in a row stack this way. The person's own changes keep
replacing the entry they are on. An embedded frame with a host (`embed=1&host=`)
ignores the event, because its host owns its view (#476).

`by` is a label of at most 80 printable characters. Without one it is the
request's User-Agent product token. Anyone who can reach the serve can send
any name, so `by` says who the caller claims to be and is not authentication.

Refused: under `serve --public` (405 from the request guard, and 403 `code:
"public"` in the route itself), and under every `behold preview`, with or
without `--emulator` (403 `code: "preview"`). A terragucci or SQL Yodeler
repo allows it, since it writes nothing. A static export has no server, so no
route.

## A picture of a view (#915)

`behold shot "<query>" [project-dir] -o out.png` and `GET /api/shot` take a
PNG of a view and give the link to the same view. Both call `src/shot.ts`.
The page is behold's own, loaded in a headless browser with
`embed=1&bare=1&frame=matches`: it lights what the view asks for, dims the
rest, frames the lit cards with the kiosk's arithmetic (`web/kiosk-shot.js`),
draws one caption line (what was asked, from where, when), and sets
`data-behold-shot` on `<html>` to `drawn`, `no-matches` or `failed`. Nothing
is photographed until it does: a page that never reports ready within 60 s,
or one that draws no cards, is refused and no file is written.

```
GET /api/shot?node=aws_vpc.main&env=prod&width=1600&height=1000
-> 200 image/png, Behold-View-Link: http://127.0.0.1:4600/?env=prod&node=aws_vpc.main,
   Behold-Shot-State: drawn | no-matches | failed
```

The browser comes from `playwright-core`, an optional peer behold does not
install: the system Chrome first, then Playwright's `chromium-headless-shell`.
Without either the CLI exits 1 with the install line and the route answers
501 `code: "no-browser"`. `--env`/`env=` draws the env's live view, and
`--snapshot <ref>`/`snapshot=` a recorded snapshot of it (`at` is a git
revision and is not taken). The route answers bytes, never a path, and is
refused on `serve --public` (403), since each shot starts a browser. The CLI
uses the serve at `--url`, or starts behold's app for the project on a free
loopback port and stops it after; without `-o` the PNG goes under the OS temp
directory. Nothing is written in the served project.

A query's matches are lit and framed (#913). Without a query, a shot frames
the view's own `node` or `focus` (`behold shot "" --view node=<id>`).

## Over MCP: `behold mcp` (#916)

`behold mcp [project-dir] [--url <serve> | --port <n>]` is a stdio MCP server
with three tools, all clients of a running serve's HTTP API. `ask` calls
`GET /api/search` and returns chant's search document verbatim, with `link`
and `drawn: false` added after its own fields (a test holds it byte for byte
to what chant prints); it takes `query`, `env`, `snapshot` and `show`, and
never moves the tab. `show` calls
`POST /api/view` (its `by` is the MCP client's name plus "via behold mcp"),
and `shot` calls `GET /api/shot` and returns the PNG as MCP `image` content
followed by a text block `{link, state, serve}`. They take `query`, `env`,
`snapshot`, `member`, `zoom`, `focus` and `node`; `shot` also takes `width`
and `height`. Answers to estate questions come from chant's MCP tool
`workspace-search` (INTENTIUS/chant#4374), not from behold.

It finds the serve through `--url`/`--port`, then the per-user registry at
`<os.tmpdir()>/behold/serves/<pid>.json` (`{url, pid, projectDir, version,
startedAt}`, written by every serve at start, rewritten on a project switch,
removed at exit, a dead pid ignored; `BEHOLD_SERVES_DIR` moves it), then
`http://127.0.0.1:4600`. It confirms the serve through `GET /api/project`.
`show` refuses a serve of another project, naming both, and refuses with the
serve command when none runs. `ask` and `shot` with no serve of the project
start behold in their own process for the call (`src/shot-cli.ts`), and the
answer comes from the same route.

Arguments are checked against each tool's schema (`additionalProperties:
false`), a credential-named one is refused by name, and a refusal is an
`isError` result carrying the route's `{error, code, remedy}`. The server
refuses to start with a tool whose name holds a write word (deploy, apply,
approve, run, op, rollback, write and kin), and a call to an unlisted tool is
refused with the same words.

## The act loop (delegated, never direct)

behold does not apply. To change the estate:

1. Edit the chant `.ts` source (the node's `sourceLoc`), or
2. Trigger a committed Op via chant's MCP:
   - `op-run <name>` — start the project's `ApplyOp` (code→cloud) or `ReconcileOp`
     (cloud→code PR).
   - `op-signal <name> <gate>` — approve a gate (e.g. a destructive apply).
   - `op-status <name>` — watch phases; `op-report <name>`, the run report.

Every mutation is a gated, durable Temporal workflow with a human-confirmable gate
and saga rollback. There is no behold endpoint that mutates the cloud.

A run behold triggered is asked for chant's run events (#679, chant#4019:
`chant run <op> --events-json`, `chant run <target> --components --env <env>
--events-json`), so the ops lens and the dial show each step's start and settle,
a skip with chant's reason, a cache hit, and the gate or decision point a run
waits on, as they happen, and a pending gate renders as a card with an Approve
button. That button is `op-signal`, the same delegated write, and nothing else
about the run is behold's to decide: the verdict is the stream's own
`run-settle`, a stream that ends without one leaves the playhead at the last
settled step and says it was lost, and a gate paints as pending only when chant
named it (`gate-waiting`, or `chant run status`).

`src/run-events.ts` is the one boundary every run line crosses. It validates
each line against chant's `run-event.schema.json` (vendored in
`src/run-event-schema/` from @intentius/chant 0.124.28, its source commit in
`RUN_EVENT_SCHEMA_SOURCE`), since the line comes from the project's chant,
not behold's, and refuses a line that fails it; it folds the stream into what
the dial and the ops lens render. The event types are chant's own `RunEvent`
and `RunEventBody`, imported as types only. `src/run-events-chant.test.ts`
runs the whole path against a real chant when `BEHOLD_TEST_CHANT_BIN` is set.

A run behold did not start is followed when the status read names it: `chant
run events <run> --json --follow` replays what chant kept on this host and tails
it to `run-settle`. A run killed outright writes no settle, so a follow that is
silent for `BEHOLD_RUN_EVENTS_IDLE_MS` (60 s) asks `chant run status` whether it
still runs, and ends as lost when it does not or after
`BEHOLD_RUN_EVENTS_MAX_IDLE_MS` (30 min) of silence. A steward run keeps no
events here, and the playhead says so.

The read has a floor, `RUN_EVENTS_CHANT_FLOOR` (0.124.28). Below it behold
starts runs with the older `--progress-json` (degraded mode: settled steps
only, no skip reasons, cache hits or gate events, and no follow), translates
those lines at the same boundary, and the dial and the playhead say they are
degraded. A local pipeline run (gitlab-ci-local, a forgejo runner) is the one
path that still reads a log, because chant does not run it; the dial labels it
best-effort, and only its exit code is certain (src/ci-run.ts).

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
run id is persisted as one JSON per project under `~/.behold/ci-runs/`, the
operator's machine-state, outside the project tree, so the Invariant below
still names the whole in-project write surface. `GET /api/ci/run` reads the
record; `POST /api/ci/readopt` (also attempted once at boot) re-follows an
unconcluded run by its saved id, so a restart mid-deploy leaves the run a
reader instead of nothing.

## The operating loop (a strip, a timeline, and a gate that is not the run gate)

A project that declares a `ConvergeOp` gets an operator strip on the ops lens:
per loop, the last tick's own log line (verbatim, with its instant), the lease,
and how many gates are pending. **One** tick — `chant operator status` keeps only
`records.at(-1)`, so the strip is never a timeline, and it says so.

The timeline is its own read: `GET /api/operator/log` → `chant operator log
--json` (chant#2029), the tick records and the gate resolutions against them
merged oldest-first. It lives in a panel that grows from the strip, and two rules
hold it there. It is **pulled**, on the click that opens it and never on a timer.
And it is **bounded** — `--limit` on every invocation, 50 by default and 200 at
most, `--since` when asked, because the ledger grows one line per tick forever;
the answer reports the window it used, so a full one can't read as the end of
history. The route checks the project's chant version *before* it spawns: below
0.53.1, `chant operator log` resolves to `chant operator`, the tick daemon, and
behold reading a history must never become behold running an operator.

Since chant 0.53.1 (chant#2027) a tick record carries an `id` and the
per-component verdicts it derived, and both ride through to
`[].lastTick.{id,components}`. The strip line names the tick (truncated), and
the verdicts join onto the component DAG by component name, the same key the
live `chant components status` read is joined by. They join **under** that read:
a tick only ever feeds the last tier of `componentStatusColor` (the
reconciliation verdict), only on a node the live read left unpainted, and only
while the tick is younger than fifteen of chant's own operator rounds. Past
that it is named on the node, dated, and painted nothing: a graph fill has
nowhere to put "as of an hour ago". A chant older than 0.53.1 sends neither
field and every one of these paths is a no-op.

Two gate cards exist and they are **different acts**:

- The **run gate** — `POST /api/ops/:name/signal/:gate` → `chant run approve
  <op> <gate>` (chant#2121 renamed `chant run signal`, #459). Records the
  resolution; a runtime that parks a run is woken, and the local one reads it
  when the Op runs again (behold runs `chant run <op> --events-json`, which
  says `gate-waiting`, settles `gated` and exits 3).
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

A gate someone already resolved simply leaves `pendingGates`, the status read
carries no `resolvedBy`/`when`, so the strip shows no resolved-by line rather
than attributing an approval to nobody. The timeline is where resolutions are
named, because there they are records rather than an inference.

An `OperatorStack` (chant#1940) declares the loop as a k8s estate, so it already
appears in the entity graph. behold names it there, the Namespace as the loop's
home, each CronJob as a converge tick — off chant's own
`app.kubernetes.io/component: converge-tick` labels, never a naming convention.

## Who an approval is recorded as (#690)

chant never signs a person in (ws-052); the surface that does passes the person
to chant as `--actor` (ws-080). behold has no login, so `src/approver.ts` names
the person for each request, in this order:

- `--identity-header <name>` (BEHOLD_IDENTITY_HEADER, `.behold.json`
  `approver.header`): behold sits behind a proxy that signed the person in
  through the forge or OIDC, and the header names them. A bare login is an
  account on `--identity-forge` (github unless set). A request without the
  header approves nothing (`403 no-identity`). Refused at startup with a
  `--host` other than loopback, since anyone reaching the port could send it.
- `--as <principal>` (BEHOLD_APPROVER, `.behold.json` `approver.as`): one
  person runs behold and names themselves, `github:<login>` or a principal the
  signers file lists.
- Neither: chant's own fallback (GITHUB_ACTOR, GITLAB_USER_LOGIN, USER), and
  behold passes no `--actor`.

Without a trusted header, a request carrying a usual proxy identity header
(`PROXY_IDENTITY_HEADERS`, such as `X-Forwarded-User`) is refused with `403
identity-header` on every approve route, rather than recorded as someone else.
Every approve route (`/api/workspace/gates/approve`, the converge gate's
`/api/operator/approve`, the run gate's `/api/ops/:name/signal`) adds
`--actor` (`--approver` on `chant run approve`) and `--note "approved in
behold"`. chant's ledger has no channel for a surface (its `origin` is `cli`,
`mcp` or `acp`), so the note is where behold is named. A workspace gate that
status marks `signed` is approved with `--sign <key>` when behold holds the
person's key (`--signing-key` beside `--as`, or `.behold.json`'s
`approver.keys` by principal) and refused `422 signed` with the line to run
otherwise. The key path never reaches a page: `GET /api/workspace/gates`
carries `approverIdentity: {principal, source, forge, signs}`, or `approver:
null` and `approverRefusal`. `src/approver-chant.test.ts` runs the whole path
against chant with a throwaway key and workspace.

## The trunk lane (#680)

`GET /api/workspace/lane` (src/trunk-lane.ts) answers "what is in flight and
where is it?" for a served workspace, read through the reader on every request
and kept nowhere:

- `chant ci list --json` at the root: the trunk's commits within ci.green's
  window, each `green`, `revoked` or `undecided`, with its phases and runs
  and its work items (`work`, chant#4029). It reads local tags only, so a
  commit that failed without ever being green reads `undecided`.
- `chant workspace status <env> --json` once per environment, in the order the
  members' `promotionOrder` gives (merged in member order): the gates with
  `env` equal to that environment, with `gitSha`, `runId` and `changeSet`, and
  the deploy records.
- `chant release list --json` in each member whose promotion order is not
  empty: the releases, each with its commit and the environments that run it.

The answer: `trunk` (or `trunkRefusal`), `commits[]` with `where` (`runs` or
`waits` per environment), `environments[]` with `releases`, `deploys` (records
no release covers) and `waiting` (each gate with `commitState`),
`order` (`promotion`, or `env` when no member declares one), `releaseRefusals`,
and the gate strip's approver fields. Gates with no environment stay in the
gate strip. The three reads are `ci list` and `release list` through
`readTrunk` on the reader (they are contract 1 documents outside `chant
workspace`) and `status` through `read`; each has its floor in
src/chant-floors.ts (0.124.28), and the route refuses a chant below any of them
before spawning. The panel's Trunk tab (web/trunk-lane.js) reads it when opened
and approves through `POST /api/workspace/gates/approve`.

The release column (#692) sits between the commits and the environments:
`releases[]`, every release `release list` names, newest first, each with its
`commit`, `label` and digest, its newest `cut` (who, when, and chant's
`signatureCheck`), `runs` (environments in promotion order, with components),
`waits` (a release gate that binds it, or a gate of its member reached at its
commit; `pending`, or `superseded`), and `next`, the environment its member's
promotion order names after the last one that runs it (null in the last one,
and for a revoked release, which chant never promotes). Each commit carries
`cuts`, the releases cut from it.

`configOnly` is true when a release carries artifact digests and they equal
its previous release's. The previous release is the one of the same member
cut from the nearest older commit: releases are ordered by their commit's
place in the trunk list (first-parent, newest first), a commit older than the
list after every listed one, and ties (one commit, or commits outside the
list) by `release list`'s order, newest cut first. That is how `release cut`
reuses an unchanged artifact's digest. It is null for the oldest release and
for a release with no artifact digests (a member with no components).

The revoked fields ship in chant 0.124.29 (`RELEASE_COLUMN_CHANT_FLOOR`,
chant#4033, chant#4043): `revoked` on a `release list` release (the
ci/revoked tag, with `rollback`, the lines status gives for each component
running it), `superseded` on each environment (release gates chant reads as
superseded, never approvable), `rollback` on an environment's releases, and
`release` and `rollback` on a deploy record. `releaseColumn: {full, floor}`
says whether they were read. Below the floor nothing is refused: the column
comes from `release list` alone with no revoked mark, and the tab says which
chant would add it.

A mixed environment (#731): from chant 0.124.29
(`MIXED_ENVIRONMENT_CHANT_FLOOR`, chant#4035, chant#4072) status gives an
environment `mixed` when its components run different releases, or a
promote, rollback or redeploy left one `failed` or `gated` (its
`outcomes.jsonl` on chant/lifecycle). Each environment carries `mixed[]`, one
per member: `components` (each with its recorded `release`, `state` and the
`attempt` that left it unsettled), `redeploy` lines and the `rollback` line,
as chant wrote them. The tab heads the environment `(mixed)` and shows the
lines to copy, run in the member's directory; behold runs none of them.
`mixedEnvironments: {read, floor}` says whether it was read; below the floor
`mixed` is empty and the lane is drawn as before.

The fixtures in `src/__fixtures__/trunk-lane/` are recorded from chant main
in the workspace `src/trunk-lane-fixture.ts` makes (staging carries a deploy
outcome: v3's promote deployed api and failed on web), and
`src/trunk-lane-chant.test.ts` reads the same workspace through a real chant
when `BEHOLD_TEST_CHANT_BIN` names one.

## A gate's change set on the graph (#681)

`GET /api/workspace/change-set?gate=<member>/<op>/<gate>&env=<env>`
(src/change-set-overlay.ts) reads the gate from `chant workspace status <env>
--json`, never from the page, and the change set it binds (`changeSet`,
chant#4022) from `chant change-set show <digest> --member <member> --json`
(`readChangeSet` on the reader, floor `CHANGE_SET_SHOW_CHANT_FLOOR`,
0.124.28). The answer is that document keyed by graph node: `entries` (those
that change something, each with `bucket` create, change or delete and `node`,
or null where chant mapped none), `nodes` (`<member>/<id>` to the strongest
bucket and the actions on it), `counts`, `unchanged`, `gaps` (members that
failed to plan or have holes), `gate` (commit, run, `releaseDigest`) and
`planned` (a release gate's release and environment, chant#4045). An entry
with no node is kept and listed in the Change set tab, never dropped. The page
(web/change-set-overlay.js) outlines each card in the drift legend's tokens
(managed for create, foreign for update or replace, degraded for delete or
forget) with a tag above it, never a fill; it is opened from the "change set"
link on a Trunk tab gate card and turned off from its tab. A public view
refuses the route, as it refuses the lane.

## Feature flags on the graph (#683)

`GET /api/workspace/flags` (src/feature-flags.ts) reads each member's
`featureFlags` from `chant workspace status <env> --json` (chant#4024, floor
`FEATURE_FLAGS_CHANT_FLOOR`, 0.124.29): per flag its `param`, `owner`, `work`
with its state, `values` per environment and `stale`, the stale-flag lint's
verdict (WSP118). It reads status in each environment of the promotion order
for the waiting gates, and for each gate of a flagged member with a stored
change set, `chant change-set show`, keeping the entries whose attribute
`param:<param>` moves the flag's parameter (`waiting`, with before, after and
the node chant mapped, which is null for a release's `chant:component`
entry). chant names no graph node that reads a build parameter, so a flag
marks every card of its member (`nodes: "member"`); behold infers no finer
mapping. behold writes no flag record and has no flag write route: a waiting
flip opens #681's change-set overlay for its gate, and otherwise `turnOn`
carries the lines a person runs (`chant workspace records amend <id> --kind
<kind> --set -` with the new values, then `git commit` of the record). The
page (web/feature-flags.js) is the Flags tab and a tag under each flagged
card in the environment the tab picks. Below the floor the route answers the
refusal and `degraded`, and the graph draws no marks. A public view refuses
the route. `src/feature-flags-chant.test.ts` reads the workspace
`src/feature-flags-fixture.ts` makes through a real chant when
`BEHOLD_TEST_CHANT_BIN` names one.
## The why chain (#682)

From chant 0.124.29 the intent document `GET /api/workspace/why` reads carries
`trace` (chant#4023): for each commit chant walked, the work items its
`Chant-Record` or `Chant-Lease` trailer names (judged linked, unlinked, wrong
or merge), the work items whose window it fell in (listed apart, never a
link), its ci tag, the release cut from it or containing it, that release's
gate resolutions (who, channel, when, the plan and the change set stored
under it) and its deploys per environment. Every link names its source
record (`source: {ref, field, value}`: a commit, a tag ref, a work record's
file, or `chant/lifecycle:<path>`), and the pane gives each as the `git show`
line that opens it, with a copy button. A link chant found nothing for is
drawn as missing, with chant's reason where it gives one, and `trace.reasons`
(`ledger-unreadable`, `declaration-invalid`) as partial-read notices. behold
adds each commit's subject and each work item's title from the same
document's `nodes` and joins nothing: a commit names its release and deploys
by id in the same trace. A release gate's change set is shown as `chant
change-set show <digest> --member <member>`, since the overlay (#681) opens
only a gate still waiting.

The floor is `WHY_TRACE_CHANT_FLOOR` (0.124.29, read "why chain"). Below it
nothing is refused: the answer has `trace: null` and `chain: {full: false,
floor, note}`, and the pane shows the decisions, runs and commits it always
did with the note. `src/why-trace-schema/intent.schema.json` is chant's
intent schema at 5d33a48e7; `src/__fixtures__/why-trace/` was recorded from
chant main at that commit in the workspace `src/why-trace-fixture.ts` makes,
and `src/why-trace-chant.test.ts` reads the same workspace through a real
chant when `BEHOLD_TEST_CHANT_BIN` names one.

## Collision marks (#684)

`GET /api/workspace/collisions` (src/collision-marks.ts) reads `overlap` from
`chant workspace status <env> --json` (chant#4025, floor `OVERLAP_CHANT_FLOOR`,
0.124.29): the in-flight work items with a linked commit, and each pair of
them that changed one file or that a waiting gate's change set reaches at one
entry. An entry names its graph node (`<member>/<id>`), and that node is what
the graph marks (`nodes`, each with the items colliding there and the entries
behind it). Files two items both changed have no node, and neither does an
entry chant mapped to none: both go in a side list (`files`, `unplaced`).
`items` holds every in-flight item with `with`, the items it collides with
(empty for most). `overlap` absent is an older chant (`no-overlap`), and
`null` is no work kind declared or a failed read (`overlap-unavailable`); both
are refusals worded apart. One status read, through the read contract. behold
records, locks and refuses nothing. The page (web/collision-marks.js) is the
Collisions tab, a dashed ring and a tag under each marked card, and the
filter, "Show only colliding work": it hides every card that is not a marked
node and every edge with an unmarked end, and lists only the items that
collide. Below the floor the route answers the refusal and `degraded`, and
the graph draws no marks. A public view refuses the route.
`src/collision-marks-chant.test.ts` reads the workspace
`src/collision-fixture.ts` makes through a real chant when
`BEHOLD_TEST_CHANT_BIN` names one. `status.schema.json` in
src/trunk-lane-schemas/ is chant main at e9c996e93.

## Open decision points beside their gates (#472)

The approvals inbox is arugula's rail (arugula-salad/arugula#621); behold
draws open decision points and answers none. `GET /api/workspace/points`
(src/decision-points.ts) reads `chant workspace points --open --json` through
the reader's `readPoints` (floor `DECISION_POINTS_CHANT_FLOOR`, 0.107.0, the
chant where a gate can ask a point, chant#3170). chant's conformance suite
does not list `points`, so the read is not in `BEHOLD_READS`; the reader test
holds every other module to not naming it. Each open question carries its
point's question, who may answer (the quorum's count and roles), a model's
proposal when there is one, and chant's `points answer` line. A gate that
asks a point carries `answer` in `workspace status` (the open question's id,
its point and path), and its `approve` is that same `points answer` line. The
gate strip (web/decision-points.js, web/workspace-gates.js) puts a question
on the card of the gate whose `answer.id` names it and gives a question no
waiting gate names a card of its own, naming the gate from its
`gate:<op>/<gate>@<env>` subject when a gate asked it. Such a gate gets no
approve button, framed or not, and `POST /api/workspace/gates/approve`
refuses it with `422 decision-point`. Standalone, a point card shows the line
as text to copy; framed, it says to answer in the host's rail. There is no
write route. Below the floor the route answers the refusal and `degraded`,
and the strip says which chant adds points. A public view refuses the route.
`src/decision-points-chant.test.ts` reads the workspace
`src/decision-points-fixture.ts` makes through a real chant when
`BEHOLD_TEST_CHANT_BIN` names one; src/__fixtures__/decision-points/ is
chant 0.124.31's output for it.

## Runtime health and rotation (#825)

`GET /api/health?env=<env>` (src/health-overlay.ts) reads `chant lifecycle
health <env> --json` (chant#4177, floor `HEALTH_CHANT_FLOOR`, 0.124.33, read
"runtime health") once per chant project: the served project, or each chant
member of a workspace or an estate in its own directory with its own chant,
ids composed `<member>/<id>`. The read is the reader's `readHealth`
(src/workspace-reader.ts). Its document is `chant-health/v1`, not a contract 1
document, so it is checked against chant's schema, vendored unchanged in
src/health-schema/ (chant PR #4193 at d727944c4) and validated with ajv, with
a hole's `reason` loosened to any string; a document the schema refuses is
refused whole. A project with no lexicon that reads health is `none`, not a
failure. A member below the floor is refused before anything is spawned; when
every member is, the answer carries the refusal and `degraded`.

The answer is `nodes` (per id: `healthy`, `unhealthy` or `unknown` with
chant's `detail`, `observedAt` and `checkedAt`; `unobserved` with chant's
`reason`; or `absent`), `rotation`, `members` and `counts`. Rotation is
behold's (src/runtime-health.ts, `rotationOf`): a Route 53 record whose
`HealthCheckId` edge (or `$ref` attribute) names a declared check is out of
rotation only when that check is unhealthy, in rotation when it is healthy,
and `inRotation: null` with the reason in words otherwise. The edges come
from each member's cached source graph (`memberIr` at detail 2). The answer
is cached per environment for 30 s, `?fresh=1` reads again, and `POST
/api/refresh` drops it. A public view refuses the route (it reads the live
estate with behold's credentials), and `behold export` captures it once per
environment. The page (web/health-marks.js) draws a tag under each card, a
solid ring on an unhealthy one and a dashed ring on a hole, dims a record out
of rotation with its edges, counts the states in the Model tab and shows the
detail in the inspect pane. It never changes a card's fill.
`src/__fixtures__/health/` was recorded from chant main at cd9a90716 against
a floci whose health checks probe (lex00/floci#259); src/runtime-health.test.ts
names each file's provenance. A multi-stack document (a project that declares
`stacks`) is keyed `<member>/<stack>::<name>` (#824), the ids chant's live
overlay gives that project's nodes.

## The three-cloud demo (#824)

`example-three-cloud` is a chant workspace (`dns`, `aws`, `azure`, `gcp`) on
floci, floci-az and floci-gcp; docs/src/content/docs/using/three-cloud.mdx is
its page. `behold demo three-cloud` runs `scripts/emulators-up.sh` (the
emulators under chant's own container names, with the Docker socket, floci-az
running Container Apps unmocked), then serves with `--local --env local`.
`--local` on a workspace boots every chant member's emulators
(`emulatorDirs`/`emulatorsUp` in src/emulator.ts), not the first member's, and
tears down the same set. The `front-door` Op (`dns/ops/front-door.op.ts`)
runs `scripts/front-door.ts`: apply all four, deactivate the Azure revision,
wait for `azureCheck` to read unhealthy, then `behold export --open-env local
--open-zoom composites --note …`. `--note` (`settleNote` in src/export.ts) is
one line under 200 characters, written to the manifest as `note` and drawn at
the foot of a static page by web/export-note.js, backticked spans as code.

## Invariant

If a request would have behold write to a cloud or to source directly, it's wrong.
behold shows truth and triggers Ops. Authority stays in the committed source and the
executor.

The commands behold starts run with behold's own environment, so Deploy (`POST
/api/apply`, chant's local executor) applies with the credentials of whoever
started it. On a terragucci repo (a `terragucci.yml` in the served directory or
above it, up to the git root) behold starts nothing: every POST that deploys,
approves or starts a run answers `409` with `code: "terragucci"` and names the
pipeline (`src/terragucci-repo.ts`, #489), `/api/project` carries `terragucci`
so the page offers no write, and auto-sync declines. The boundary is an
allowlist (#500): every request whose method is not GET, HEAD or OPTIONS, on
any path, answers that `409` unless `TERRAGUCCI_ALLOWED_WRITES` names its
method and route, and that list holds only the exceptions below (the layout
sidecar, project open and reveal, demo open, refresh, and the four carve
steps), plus `POST /api/view`, which moves the open tabs and writes nothing
(#914). A new write route is refused on a terragucci repo until it is added
there. `src/terragucci-repo.test.ts` walks every non-GET route of the real
app (`app.routes`, built plain, with a carve report and with `--terragucci`)
and asserts each one is allowlisted or answers 409, and that every allowlist
entry is a registered route. `TERRAGUCCI_REFUSED_WRITES` only words the
refusal for known routes. The remedy names `npx terragucci approve wave-<k>
--plan <digest>`, the digest from the wave's gate card.

A SQL Yodeler repo (a `yodel.config.ts` in the served directory or above it,
up to the git root) is guarded the same way (#517): the same allowlist, the
same refused routes, auto-sync declined, and `/api/project` carries
`sqlYodeler` so the page offers no write. The refusal is `409` with `code:
"sql-yodeler"`, and its remedy names `npx yodel approve <env> --plan <digest>`
(with `--sign` when the environment's gate is sealed) and `yodel apply <env>`
in the project's pipeline. `productRepo()` in `src/terragucci-repo.ts` looks
for terragucci's config along the whole walk first, so a yodel project nested
inside a terragucci repo is refused as terragucci.

Op discovery (`src/ops.ts`) reads a gate from `signalName: "<name>"` or from
`gate("<name>", ...)`, the form chant's op builder and SQL Yodeler write, so
a gated Op is never listed or run as ungated on any repo (#517).

A policy denial is never approved from behold (#519, `src/policy-override.ts`).
`GET /api/workspace/gates` gives a gate of op `policy-override` an `override`
field `{subject, rules, plan, digest, state, spentAt, product, command,
source}`: the rules and denied plan come from `chant/lifecycle:_gates/
policy-override.jsonl` (read with `git show`, the local branch then
`origin/chant/lifecycle`), `state` is `waiting`, `overridden` (status says an
override counts) or `spent` (a line in `_gates/policy-override/applied.jsonl`
for its digest), and `command` is the product's (`npx terragucci override`,
`npx yodel override`) or chant's `chant approve policy-override <subject>
--rule <id> --reason "<why>" --plan <digest>`. The card shows that command and
no button, and `POST /api/workspace/gates/approve` answers such a gate `422`
with `code: "override"`. The ledger lines are parsed by chant's
`@intentius/chant/override-gate` (`recordedDenials`, `parseAppliedOverrides`,
`overrideCommand`) and `parseGateLedger`, and the product is `productRepo()`
from `src/terragucci-repo.ts` (#537).

### The exceptions, and their exact size

These are also the only writes a guarded product repo answers: terragucci
(`terragucci.yml` and its siblings) and SQL Yodeler (`yodel.config.ts`), both
listed in `TERRAGUCCI_ALLOWED_WRITES`.

`POST /api/layout` (#228) writes **one** file in the served project:
`.behold/layout.json`, the hand-layout sidecar, `{version, lenses: {<lens>:
{<node id>: {dx,dy,dw,dh}}}}`. That is the whole of behold's write surface
inside a project, and it does not weaken the invariant above:

- It is **workspace metadata**, not estate truth. Deltas describe how *you* want
  the picture arranged on top of dagre's layout; the graph underneath stays
  chant's, and a delta for a node that left the estate is dropped on read.
- It **never touches the cloud and never touches your source**. No `.ts`, no
  `chant.config.ts`, no `.behold.json`. The path is `cfg.projectDir` + two
  constants; nothing from the request reaches the filesystem.
- It refuses politely when it shouldn't write: preview mode, a static-export
  capture, a read-only project directory, an oversized or malformed body.
- It is **per-user state**, unlike `.behold.json` (config, meant to be tracked).
  Projects should gitignore `.behold/`.

`GET /api/layout` reads it back; `GET /api/graph?layout=1` (and `/api/overlay`)
render with the deltas baked into the SVG, which is how `behold export` and
static snapshots honour a hand layout.

A declared workspace (#464) keeps that file in the workspace root, the
directory holding `chant.workspace.json`, rather than in its first member.

`behold doctor --fix` (#464, ws-015) is the third exception, and it runs only
when you type the flag: for an estate root whose members are listed in
`.behold.json`, it writes `chant.workspace.json` in that root (never over an
existing one) and moves the saved `.behold/layout.json` from the first member to
the root with its node ids rewritten. It then runs `chant workspace check`. The
old layout file and `.behold.json` are left as they were.

The fourth exception is the carve walkthrough's two steps above (#254), and it
is narrower still: they exist only when behold booted a `behold demo carve`
copy, they write only into `<copy>/app/carveout/`, and the directory they write
into is a scratch dir behold created inside a directory it copied for you a
minute earlier. `carve bridge` runs without `--apply-rewrites`, so the demo's
own Terraform is not edited either. The only request-derived value is `select`,
and it must be an address the served report already ranks, the value that
reaches the spawn's argv comes from a closed set read off disk. No cloud write,
no Terraform mutation, no edit to anyone's chant source.

`behold export --publish s3://<bucket>/<prefix>/views/<name>` (#491) is the
one write to a cloud, and it is not a server route: an export, asked for it on
the command line, uploads the bundle it just wrote, signed with the AWS
credentials in the environment (src/s3-object.ts). `publishTarget` refuses
any destination that is not a `views/<name>` directory, terragucci's reserved
viewer prefix, so the bundle's `index.html` can never land on a page behold did
not make. `publishBundle` (src/export.ts, #500) uploads every other file
first, then `manifest.json`, then `index.html`. Snapshot names carry the first
16 hex digits of their SHA-256 (`CONTENT_ADDRESSED`) and go up with
`Cache-Control: public, max-age=31536000, immutable`; everything else gets
`no-cache`. It GETs the previous `manifest.json` under the prefix before
uploading (no list call) and, after `index.html`, deletes the
`snapshots/<name>` files that manifest named and this export did not write.
Nothing outside the prefix is deleted. A refused delete stops the sweep with
a warning naming `s3:DeleteObject`, and the publish still succeeds.

Since #510 the bundle goes to `<prefix>/<commit>/` (the checkout's HEAD, or
`--commit`), with publishBundle's order and sweep one level down, and
`src/publish-snapshots.ts` then writes, in order, `history.json` (newest
first, `{commit, at, project, generated}`, one GET of the old one),
`latest.json` (`{commit}`) and the root `index.html`, a no-cache page that
opens `<latest>/index.html`, so old links keep working. `--keep <n>` (30)
drops older commits from `history.json` and then deletes their files as each
commit's `manifest.json` lists them (`files`, which runExport now writes,
plus `keyToFile`), best effort with the same `s3:DeleteObject` warning. A
view from before the layout keeps its files; only its `index.html` is
replaced. With `--publish` the default `--reports-base` is `../../../`. The
view's history picker (`web/history-picker.js`) reads `../history.json` and
only navigates.

A choudoufu estate member (#366) adds no exception. A move there is one tag
write through choudoufu's own `live-mv`, and behold never makes it: `GET
/api/choudoufu/split` (also answered as `/api/choudoufu/moves`, its name before
the split rename) reads a plan (`split.json`, or the workbench's `carve.json`)
from inside a served member,
previews each move with choudoufu's `live-mv -json -dry-run` (the only spelling
of `live-mv` in the tree, src/choudoufu-moves.ts `dryRunArgs`, asserted by
test), hands the lines back with copy buttons, and `?receipt=1` reads the
listing after a person ran them. **There is no `/api/choudoufu/mv`**, and
src/choudoufu-route.test.ts asserts it stays absent, for the same reason
`/api/carve/apply` does not exist.

## Changing behold (for agents working on this repo)

The sections above are about driving a running behold. This one is about
changing it, the working rules that used to live in a handoff note and now
live here, with the enforceable ones enforced.

- **Branches and merges.** Work on a branch off `main` (an isolated worktree
  when more than one agent is active). `main` is protected by a ruleset: every
  change arrives as a PR, and the `check` job in `ci.yml` must be green before
  it merges. A check that has merely settled is not a pass — read the lines.
  No `gh pr merge --auto`; merge one PR at a time, in order, and rebase the
  next onto what landed.
- **The local gate** is `just check` (tsc, tests, build). Every vitest run
  also writes `.vitest-last.json` (the json reporter, PR #351), and `just
  test` keeps the reporter's full output in `vitest.log`, both gitignored —
  because #334's one-shot first-run failures kept losing the failing file's
  name. If the suite fails once and passes on rerun, those two files from the
  first run are the evidence; attach them to #334 (`jq '.testResults[] |
  select(.status != "passed") | .name' .vitest-last.json` names the file).
- **Releasing** is `just release`, after the version-bump PR merged: it tags
  `behold-v<version>`, pushes the tag (which is what runs `release.yml`), and
  waits for npm to show the version. It refuses in every state where a tag
  push would be wrong. Never re-push a `behold-v*` tag by hand: a tag push
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

1. A `registerMemberKind({ kind, probe, expects, via, passes })` call in
   `src/member-kind.ts`, the `probe` is sync, read-only and runs no code (a
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
   fork per kind; a kind's differences live inside its `read` or its `passes`.

   `passes` (#427) is the render-time half, and it exists because the read-time
   one could not hold it: the Terraform kind's third pass takes the request's
   zoom, so it cannot run where the reader runs. `applyMemberPasses(ir,
   {detail})` is the one call the six render sites make, and `memberPassNote(run,
   dirs)` the line they return, each kind handed only the served dirs that are
   its own, so a route never names a kind. Three rules a `passes` holds. It
   mutates IN PLACE, because the existing passes do and their callers depend on
   it. It self-guards on the IR's own CONTENT and never on the served members'
   kinds. A chant project may declare a kind's lexicon; a chant project
   declaring `terraform` is what `src/terraform-route.test.ts`'s first block
   serves, and `memberKindOf` says `chant` there, so membership dispatch would
   silently stop rendering it. And a run is carried forward, never re-run: a
   pass that already elided its cards returns an empty elision the second time,
   which drops the note on every composed estate. A test that re-registers a
   kind to stub its reader spreads the real spec (`{ ...terraformSpec, via: … }`)
   or it drops the passes with it.
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
   asserts chant members still go through exactly the calls they did, and its
   "#427" block for the render passes; the
   kind's own reader off recorded documents in `src/__fixtures__/`, with
   provenance in prose above the load.

`.behold.json` names a kind as `{ "dir": "x", "kind": "<kind>" }`; a bare
string is `chant`. Anything behold boots for a kind goes through
`assertScratch` first.

**What the first screen owes a non-chant member (#393).** Three chant-shaped
things used to be offered to every member whatever it was, and a new kind gets
all three answered for free:

- `/api/project` publishes `memberKinds`, the served members' kinds, in
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
answers where they are decided rather than per kind in a route.

### The workbench catalog

`demos.json` is the catalog that ships. `workbench.json`, read beside it and
deliberately absent from package.json's `files`, is the catalog of internal
estates this checkout is developed against (#386, #388). Four rules, and
src/demos.ts holds them:

1. A third source, `local`, and a second file. A local entry's `path` is
   relative to the directory of the catalog file that named it, the intentius
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
| `chant-getting-started` | chant's own getting-started example from `../chant`, in place: the source graph, 8 nodes, no substrate. The one-second answer to "did I break plain chant reading?" | that example's own `node_modules`, nothing is installed in your chant tree |
| `chant-local-cloud-trio` | chant's local-cloud-trio, in place: one project declaring across aws, azure and gcp, 8 nodes and 2 edges of source | the same |
| `fountain-ops` | `../fountain-ops` in place with `--env local`, the mature estate on your working checkout | docker, k3d, kubectl, jq, just. **The one entry whose setup runs in your working copy**: the checkout's own `just up`, a five-minute k3d cluster, and it switches your kubectl context. `just down` there removes it; behold never does |
| `choudoufu-workbench` | the live-mv workbench's four estates copied out of `../choudoufu`, composed with `--env live`: 42 cards — 24 bound, the 12 team cards reading `owned by tlmig-sample-monolith`, 6 neutral | docker, choudoufu |
| `choudoufu-cohort-s3` | `estate-gen`'s `s3` cohort rendered into the target, a sidecar-declared estate (#387): 6 cards, all neutral, because the apply stops where floci answers S3 Control tag reads on a hostname that does not resolve | docker, choudoufu, go, terraform |
| `choudoufu-cohort-iam-ecr` | the same for `iam-ecr`, the one cohort floci implements end to end: 6 cards, all 6 bound | the same |
| `choudoufu-cohort-ec2-networking` | the same for `ec2-networking`: 49 cards, the widest roster, all neutral (floci refuses a transit gateway call and the apply stops) | the same |
| `terralith-1` | `terralith-gen` at scale 1 plus the `estate.chdf.hcl` sidecar it omits, applied by choudoufu from nothing: 79 cards, all 79 bound | docker, choudoufu, go |
| `terralith-4` | the same at scale 4: 301 cards, all 301 bound. The estate behold is sized against | the same |
| `terralith-4-adopt` | scale 4 again, but STOCK terraform applies it first, so nothing wears a marker: 301 cards — 85 UNOWNED, 84 bound by derived identity alone, 132 neutral. One `choudoufu live-import` line, which the up script prints and you run, and all 301 read bound | docker, choudoufu, go, terraform |
| `waterpark` | `../waterpark/access` in place as a bare Terraform directory (#384): five roots as boxes, 58 cards, 49 edges, nothing written under the estate | `@intentius/chant-lexicon-terraform` + `@cdktn/hcl2json` beside behold, dependencies of behold since #909 |

**The scratch, by name and port.** Each emulator is the entry's own, booted by
its up script and removed by the `scripts/down.sh` that script wrote into the
target rather than by pattern.

| entry | container | host port |
|---|---|---|
| `choudoufu-workbench` | `behold-wb-choudoufu-workbench` | 4651 |
| `choudoufu-cohort-s3` | `behold-wb-choudoufu-cohort-s3` | 4652 |
| `choudoufu-cohort-iam-ecr` | `behold-wb-choudoufu-cohort-iam-ecr` | 4653 |
| `choudoufu-cohort-ec2-networking` | `behold-wb-choudoufu-cohort-ec2-networking` | 4654 |
| `terralith-1` | `behold-wb-terralith-1` | 4655 |
| `terralith-4` | `behold-wb-terralith-4` | 4656 |
| `terralith-4-adopt` | `behold-wb-terralith-4-adopt` | 4657 |
| `chant-*`, `waterpark` | none (source reads, no substrate |) |
| `fountain-ops` | the k3d cluster `fountain-local`, which is the checkout's, not behold's | — |

The port is the floci's host binding and the entry's `serve.spawnEnv`
`AWS_ENDPOINT_URL` at once, so the estate's own applies and the choudoufu
behold spawns talk to the same emulator.

**The e2e** is `just e2e-workbench` (`e2e/workbench-e2e.sh`, #391): every entry
loaded through `behold demo <entry> <tmp target> --port <p>` on its own port
from 4720 up, `/api/graph` asserted to carry nodes and a live entry's
`/api/overlay?env=live` to answer with its bound/unowned/neutral split, timings
per entry; eight entries and 553s on the machine this was written on.

Time is asserted, not only printed (#423). Each entry carries a ceiling at
roughly twice its own measured value, and the run carries one too, because
#419's whole subject was a number nobody was watching: the ratio could not
regress silently and the duration could. The measured figures the ceilings come
from are in the script beside them; `BEHOLD_E2E_SECS_<entry>` and
`BEHOLD_E2E_RUN_SECS` override. A live entry also asserts #422's shape: the
progressive overlay answers with every member marked pending and does so before
the blocking read returns, so the estate cannot quietly regress to
all-or-nothing. Where the blocking read is already sub-second there is nothing
to beat, and the run reports the two numbers rather than claiming a pass.

`terralith-4-adopt` is asserted twice — 85 UNOWNED, then the
`live-import` line the up script printed, run by the script itself in the
target the way a person would, then 301 bound, because that write is the
person's, never behold's (#372). `waterpark` is checked for an untouched
checkout afterwards. `missingRequirements` decides what runs: a missing binary,
an unchecked-out sibling, an uninstalled chant example or the absent Terraform
lexicon each print `skip: <entry>: needs …`, so in CI every entry skips and the
run exits 0. `fountain-ops` is skipped by name everywhere, for the reason in
the table. A `behold-wb-*` container left standing at the end fails the run.

The seeded catalog (#389) found one thing missing in src/: a LONE choudoufu
estate (every generated entry is one) served the no-project card, because the
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
other. behold parses no HCL itself, the same posture `src/carve-lens.ts`
states for the carve report (#378). The parser chant uses is installed with
behold since #909, below.

Three passes turn what arrives into a picture (`src/terraform-lens.ts`), in this
order, guarded on the IR carrying terraform entities so every other estate gets
the identical object back:

1. **`normalizeTerraformNodes`.** A node's `kind` arrives as the entity class
   (`Terraform::Resource`), not the resource type, so every card would be titled
   and iconed the same. The type moves out of `attrs.address` into `kind` and
   the block class lands in `attrs.block`. That is the shape a carve node
   already has, which is why one presentation pack serves both.
2. **`groupTerraformByRoot`.** Roots are a Terraform project's only grouping.
   It retires itself when chant#2266 groups upstream. A node sits in exactly one
   box, so a box every node has left is dropped rather than drawn empty (#393):
   a served directory arrives composed, `composeStacks` boxes the whole member,
   and the root boxes then take those same nodes, which is what put an empty
   box named `access` on water park's canvas. What the member box was there to
   say moves into the root box's title, which is `<member>/<root>` whenever the
   estate holds more than one member and the bare root name when it does not
   (two members with a root apiece named `prod` would otherwise merge silently).
3. **`filterTerraformCards`.** What is a card, below.

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
without it (a cross-root read by name) was measured and refused (#381): both
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

1. **The reader ships with behold, and is still probed.** chant resolves the
   lexicon from the config file's own location, so the generated project has to
   see it, and chant core (not the lexicon) imports `@cdktn/hcl2json` from its
   own real path; neither package declares the parser. #384 made both optional
   peers to keep a ~1.8 MB wasm blob out of chant-only installs. #909 reversed
   that so `npx @intentius/behold serve .` on a folder of `.tf` files is one
   command: `@intentius/chant-lexicon-terraform` and `@cdktn/hcl2json` are
   **dependencies** in package.json (the only place their versions are named;
   the refusal reads them from there). The maintainer accepted the cost on #909:
   +8.3 MB on a 195 MB install, six packages. The lexicon's range starts at
   behold's chant floor so its chant peer dedupes against behold's chant, and
   npm hoists both beside chant, which is where the scratch project's
   `node_modules` symlink and chant's parser import look. They are still probed
   at serve and doctor time and refused with the one install line and where
   behold looked, because an install that pruned them reaches a chant that
   warns, exits 0 and prints an empty graph. The lexicon's own chant peer is
   what moved behold's `@intentius/chant` floor to `^0.61.0`: chant 0.54 loads
   no published version of it (`applyLineage is not a function`).
2. **Roots are discovered, and the skips are reported.** A root is a directory
   with a `.tf` declaring a line-start `terraform {` or `provider "` block
   beside a `resource`, `data` or `module` block, a regex probe at the depth
   the choudoufu probe uses, no HCL parsed. #384 proposed the first half alone
   ("what a root has and a called module does not") and the estate refuted it:
   water park's `modules/persona` is a shared module called by three roots and
   its `versions.tf` is `baseline`'s byte for byte. So two exclusions stand
   beside the probe, a directory under a `modules/` segment (Terraform's own
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
   free, so a Terraform root composes in an estate beside a chant project and a
   choudoufu estate at no extra cost. `src/terraform-member.ts` is the whole of
   it; `detectProjectShape` answers a directory that is its own member with
   `membersFrom: "probe"`, which is what retired #384's `no chant.config.ts
   here` dead end.

The scratch project is `<tmpdir>/behold-tf-<hash of the estate path>`:
`behold-*` and cleared through `assertScratch` (src/scratch.ts), one directory
per estate reused across runs, asserted to be outside the estate before a byte
is written. It holds the generated `chant.config.ts`, a `package.json` that
declares it an ES module (chant's compiled CLI, 0.124.14 on, otherwise reads a
config tsx compiled as CommonJS as `{default: config}` and finds no lexicon:
INTENTIUS/chant#3897), and two symlinks —
`node_modules` to behold's own, which is how the config resolves the lexicon,
and `estate` to the served directory, which is how each root's `dir` is spelled.
The second is not decoration: the lexicon sets a root's module boundary to the
root's own directory when its `dir` resolves outside the project root, so
absolute paths cost every `../modules/x` call the estate makes — 72 nodes and 6
resources on water park, against 247 and 43 through the symlink. Nothing in the
answer mentions the scratch path (a terraform entity carries `attrs.file`
relative to its root, and no `sourceLoc`).

### A choudoufu member's overlay is ownership; attribute drift is the plan (#404)

**Read a green choudoufu card as "this is ours", never as "nothing changed".**
The overlay is composed from `live-ls -json` and `live-plan -json`, and those
two documents answer one question — bound, unowned, omitted, or invisible to
the listing. Neither of them ever compares an attribute VALUE. A resource whose
tag, path or mutability was changed out of band still carries its markers, so
it is still bound, and it is still green.

The other half of the terminal's answer ("would a plan change anything?") is
a **separate, opt-in read**: `choudoufu plan -input=false -out=<tmp>` then
`choudoufu show -json <tmp>`, whose `resource_changes[].change.{actions,before,
after}` name the attributes and both their values. (`choudoufu plan -json` is
NOT this: on 0.16.0 it prints choudoufu's own ownership document, the same
shape as `live-plan -json`, with no attribute values in it at all. The
measurement is in src/choudoufu-plan.ts's header.) The plan file is written to
a scratch directory of behold's own and removed after rather than inside the served
member, which would be a write into someone's source.

It is opt-in because it costs differently: the ownership read is answered out
of the tagging index and is flat in the estate's size, while `plan` refreshes
every resource, one provider read per card, 301 of them on `terralith-4`. So:

- **Never on an ordinary overlay read.** `GET /api/overlay?plan=1` and
  `GET /api/diff?plan=1` are the only things that spawn one, and the palette's
  **"Re-check live with plan (attribute drift)"** row is the only thing in the
  SPA that sends the flag. The cheap **"Re-check live (refresh drift)"** row is
  deliberately left alone — it is `POST /api/refresh`, a primary-only re-observe
  that captures a lanes frame and never composes the estate.
- **Cached under the member's source stamp**, the same key half `memberIr`
  uses. A read that did NOT ask is served that stored answer, so a reload after
  a refresh keeps showing the drift without paying for a second pass; a read
  that DID ask always re-plans, because "re-check" means re-check.
- **The ownership verdict stays the card's colour.** A bound card that drifted
  is still painted bound and still counted `bound`; it gains `attrs._planDrift`
  and wears a dashed `--degraded` edge plus a `~ n attributes` corner glyph
  (web/app.js `markDriftedCards`, the same post-render stamp as the carve and
  operator marks). A card that is not bound is never marked: an unowned
  object's planned `create` is an ownership fact the overlay already paints,
  and `planDrift` drops creates for that reason.
- **`/api/overlay`'s meta carries `drift`**: `{read: false}` or `{read: true,
  drifted: n}`. The two are different answers — "nobody looked" versus "looked,
  nothing drifted", and the legend prints a count only for the second.

### A stock Terraform root's plan comes from chant (#910)

`GET /api/graph?plan=1` (palette: **"Read the plan on the Terraform roots"**)
reads each stock Terraform member's roots at chant's plan depth
(INTENTIUS/chant#4358): behold's own chant over the member's scratch project,
`CHANT_TERRAFORM_OBSERVE=plan chant graph . --live --overlay --env behold-plan
--format ir --detail 3` (src/terraform-plan.ts). The plan runs with
`-lock=false`, its file under the OS temp directory. Each resource or data card
gains `attrs._plan` (`source`, `action`, `reason`, `replacePaths`,
`forcedFrom`, `afterUnknown`, `changes`, `drift`), and the card's rows lead with
`plan`, `forced by`, `from` and `read`. `GET /api/terraform/plan` answers the
same facts per card as JSON.

- **Which read answered is per root**, parsed from chant's notes: `plan`,
  `state` (the plan failed, for missing credentials or a provider error) or
  `none` (declared only). A card in a root that fell back says `plan: not read`
  and which read answered. Never "no changes" unless the plan said `no-op`.
- **Sensitive values arrive redacted** by chant, at any depth and every copy;
  behold copies plan facts only, never a block's other attributes.
- **Floor**: `TERRAFORM_PLAN_CHANT_FLOOR` (0.124.46) for behold's chant and the
  lexicon; below it the read is refused with the upgrade line.
- **A planned create has no facts**: it reads absent at the plan depth
  (chant#4372), so its card carries nothing from the plan.
- **choudoufu members keep #404's read** (src/choudoufu-plan.ts). chant reads a
  live root at the plan depth since chant#4371 (`sources: "live+plan"`), but
  behold reads choudoufu ownership itself (src/choudoufu-live.ts), and taking
  only the plan from chant would add a third refresh and a second `live-plan`.
  Both move together in #924. A path flagged sensitive on either side is
  redacted on both, and so is any attribute holding a flagged string: a
  choudoufu plan flags a sensitive variable's value on `after` only.

### A lexicon behold draws but cannot aim (#430)

`behold doctor`'s **targets** line. `SUBSTRATE_TARGET_VARS` (src/targets.ts)
names four lexicons against the nine behold draws, deliberately — it withholds
one until chant can actually be pointed at an emulator for it. That module also
names the cost: a landed chant change leaves a stale omission "until someone
notices", which happened once (#125) and left behold showing a floci-gcp pill it
could not aim a read at. This is the line someone reads instead.

`NO_AMBIENT_TARGET` (same module) is what stops it being noise: k8s and temporal
are not withheld, they are finished — they bind from `chant.config` rather than
an ambient variable, so there is nothing to override and nothing for a picker.
Those report as settled, not as a gap.

What the line CANNOT say, stated because the gap is the point: the honest
question is "chant can route this and behold does not list it", and behold
cannot ask it. Since chant 0.61 the endpoint variable is declared by the LEXICON
PLUGIN (`endpointEnvVarsFor`), not by a table in core, and behold installs no
lexicon plugins; the served project does. No chant CLI reports them either
(`lifecycle whoami --json` answers identity and says nothing about endpoints).
So the check warns on the weaker question it can answer and says it may be
over-reporting. The real fix is upstream, and #430 records the ask.

### A card with no live half is not an unobserved one (#429)

pinhole's painter takes a closed `_status` set and falls back to `neutral` for
anything else, `undefined` included. So on a mixed overlay a member with no live
half, a Terraform root, whose `live`/`overlay`/`env` are stripped in
src/terraform-member.ts — painted exactly like a card behold looked at and could
not see, while the legend counted only the latter. Measured on
`serve example-writes example-terraform-estate --env prod`: 37 Terraform cards
carrying no `_status`, 2 chant cards carrying `neutral`, one fill between them.

Those cards now carry `data-no-live` and the legend gives them their own row.
Named rather than folded into `unobserved`, because "I looked and could not see"
and "there is nothing here to look at" are different claims, the same argument
#399 makes for an unpriced card, and the same answer: mark it, do not merely
colour it. The mark is overlay-only; on the source graph no card has a status
and marking every one of them would say nothing.

This is presentation, not vocabulary. `statusVocabulary` gets no terraform row:
there is no status to name. See #429 for the measurement that established it.

### An adoptable row is painted like an unowned one, plus its evidence (#413)

A `NEEDS_DISCOVERY` omission paired with an `adoptable[]` row at the same
address paints `warn` with `ownership: "foreign"`, the same verdict the UNOWNED
branch gives and for the same reason: the live object carries no marker for
this estate. On its own, `NEEDS_DISCOVERY` stays neutral — the declaration
names no identity, and with nothing found that is a "could not answer" rather
than an action.

The card leads with `attrs.adopt`, which is choudoufu's own `adopt_command`
here rather than the marker pair an unowned row carries. `adoptLine`'s
composed-command branch had no real caller until this. behold composes no
command of its own: the API that writes a tag differs per resource type.

`attrs.matchedOn` is the difference in kind. An unowned row needs no evidence
because the identity IS the match; here choudoufu asserts that a live object is
a declaration because their identity-bearing arguments agree, and a person
about to stamp two tags onto somebody's resource is owed the list.

`web/app.js` renders both through the one copyable row, and its tooltip says
whether the line is a command or a pair of tags.

### The adoption sweep is off unless a serve asks (#412)

`live-plan -json` carries `adoptable[]` (live resources the estate-wide sweep
matched to a declared instance by content) and `swept` (the types it listed in
full). Both are empty on a run that did not ask the account-inventory question,
and behold does not ask by default.

The opt-in is `TOFU_LIVE_COLLECT_UNCLAIMED=1` (`ADOPTION_SWEEP_VAR`,
src/choudoufu-live.ts), carried through `serve.spawnEnv`, the seam
`setChoudoufuSpawnEnv` already feeds every choudoufu spawn. The env var rather
than `-adoption-only`, because that flag suppresses the resource diff the
overlay needs. Off by default because the sweep is bounded by the ACCOUNT rather
than the estate, and behold polls. `0` means no, which is choudoufu's own
spelling, not a truthiness test.

**Content matching is a closed per-type table**, and that is what decides
whether a declaration can ever produce an `adoptable[]` row. `matchTable`
(choudoufu's internal/live/foreign/classify.go) lists eleven types against the
identity-bearing arguments a match may use — `aws_vpc` on `cidr_block`,
`aws_security_group`/`aws_lb`/`aws_sns_topic` and friends on `name`,
`aws_subnet` on `cidr_block` + `availability_zone`, `aws_acm_certificate` on
`domain_name`. A type absent from it, in the table's own words, "can never
produce a bind candidate". `aws_iam_role` is absent, which is why #412's first
attempt measured a shape that cannot match rather than a gap. A resource with a
`count`/`for_each` key is skipped too, so a fixture wants a scalar.

`src/__fixtures__/choudoufu-live-plan-adoptable.json` is the real thing,
recorded off floci: one scalar `aws_vpc` declaring a static `cidr_block`, its
unmarked live twin created out of band, and the run asked with the opt-in. It
carries the pairing M2 is about, a `NEEDS_DISCOVERY` omission and an
`adoptable[]` row at the same address — plus `matched[]` naming what was
compared and choudoufu's own `adopt_command`.

### A choudoufu estate's own references (#393)

`choudoufu live-check -json` states the roster and `references[]`, and that
second list is *cross-estate by construction* — data sources filtered on
another estate's marker tags. So a 301-resource terralith of roles, policies
and attachments drew no edge at all and the graph asserted "nothing in this
estate references anything else", which is false about every one of them.

The references were never missing; nothing was reading them. **A choudoufu
member's read now also runs the terraform kind's reader over its own
directory**, one root, the estate directory itself, through the same scratch
project machinery above (nothing written under the estate), and joins the two
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
assert, and the lexicon's version is in the member's cache stamp, so
installing it invalidates the edgeless IR rather than serving it forever.

The layout half is `packBoxComponents` (src/render.ts). src/edgeless.ts wraps a
box whose cards reference *nothing*; a box that has edges is never wrapped, so
`terralith-4` came back as a 110996 x 628 strip the day the join landed —
dagre lays 42 connected components side by side on three ranks. The pass packs
a box's components into shelves and resizes the box around them, re-laying each
component on its own first (inside a cluster dagre interleaves them: a six-card
cluster's bounding box spanned 46598 units) and wrapping a component that is a
strip either way: the DNS fan is 19564 x 400 upright and 900 x 10046 on its
side. A box under 4:1 is left exactly as it laid out. Measured: `terralith-4`
7660 x 5162 with 266 edges, waterpark 3536 x 3138 at detail 2 and 7142 x 6974
at detail 3 (from 4.2:1 and 15.1:1, the case #393's wrap did not answer).
