// behold#571: what a log line in the kiosk is, in a newcomer's words. One
// entry per kind of line terragucci, chant (and the tools they call) print in
// a pipeline's log: the pattern that knows it, the tool and the feature it
// belongs to, one sentence on what it means, the docs page that explains the
// feature, and where the line is printed (`repo:path:line`, read at the
// tool's main branch). `sample` is a line a real run printed (or, where
// marked, one made from the source); the test runs every pattern against its
// sample and against the fixture runs, and fails if a pattern stops matching
// its sample or two patterns match one line.
//
// The kiosk draws an outlined chip (the tool and the feature) on the first
// line of each feature in a job and a faint dot on the later ones; pointing
// at either, or tapping it, opens the note with a link to the docs.

/** Where each tool's docs live. A docs path is relative to its tool's base. */
export const DOCS_BASES = {
  terragucci: "https://intentius.io/terragucci",
  chant: "https://intentius.io/chant",
  behold: "https://intentius.io/behold",
  choudoufu: "https://intentius.io/choudoufu",
};

/** The tools in the order the features strip lists them. */
export const PRODUCTS = ["terragucci", "chant", "choudoufu", "behold"];

/**
 * The lines a kiosk with nobody at it opens by itself, one at a time, as they
 * scroll into view: the waves, a late plan, the digest, the gate, the hold,
 * the approval spent, a plan that changed after its approval, and an output
 * nobody reviewed.
 */
export const TOUR = ["T04", "T05", "T07", "T08", "T09", "T12", "T14", "T17", "T20", "T21"];

export const ANNOTATIONS = [
  {
    id: "T01", product: "terragucci", feature: "Affected roots",
    pattern: String.raw`^(?:wave \d+: compose: )?affected: \d+ of \d+ (?:roots|units) against \S+, \d+ dependents after them$`,
    note: "The pull request plans the roots its change touches against the base branch, and the roots that depend on them too.",
    docs: { product: "terragucci", path: "/reference/report/#running-it" },
    source: "terragucci:packages/terragucci/src/report/stage.ts:1915",
    sample: "affected: 2 of 4 roots against origin/main, 1 dependents after them",
  },
  {
    id: "T02", product: "terragucci", feature: "Affected roots",
    pattern: String.raw`^(?:wave \d+: compose: )?affected: (\S+) reads the state of (.+)$`,
    note: "This root is planned because it reads the state of a changed root, so a change upstream can change its plan.",
    docs: { product: "terragucci", path: "/guides/track-cross-state-edges/" },
    source: "terragucci:packages/terragucci/src/report/stage.ts:1913",
    sample: "affected: edge reads the state of app",
  },
  {
    id: "T03", product: "terragucci", feature: "Parallel planning",
    pattern: String.raw`^(?:wave \d+ of \d+: )?planning (?:up to \d+ roots at once|one root at a time) \((.+)\)$`,
    note: "How many roots the job plans side by side, and the setting or backend that set that limit.",
    docs: { product: "terragucci", path: "/reference/scale/" },
    source: "terragucci:packages/terragucci/src/report/stage.ts:1096",
    sample: "planning up to 4 roots at once (the s3 backend)",
  },
  {
    id: "T04", product: "terragucci", feature: "Waves",
    pattern: String.raw`^wave (\d+) of (\d+): planning (?!up to \d+ roots at once|one root at a time)(.+)$`,
    note: "The apply job starts planning the roots in this wave; waves run in order, so a root plans after the roots it depends on apply.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#waves" },
    source: "terragucci:packages/terragucci/src/apply.ts:1688",
    sample: "wave 1 of 3: planning network, other",
  },
  {
    id: "T05", product: "terragucci", feature: "Late planning",
    pattern: String.raw`^wave \d+ of \d+: (\S+) plans on the state (.+) applied$`,
    note: "This root is planned only after the waves it reads from applied, so its plan sees their real state.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#plans-are-made-late" },
    source: "terragucci:packages/terragucci/src/apply.ts:1444",
    sample: "wave 2 of 3: app plans on the state network (wave 1) applied",
  },
  {
    id: "T06", product: "terragucci", feature: "Cost estimate",
    pattern: String.raw`^(?:wave \d+ of \d+: )?cost: (?:(\S+): )?[+-]?\d+\.\d+ [A-Z]{3} a month(?: over \d+ of \d+ roots)?$`,
    note: "The cost estimator's guess at the monthly cost change of one root or of the whole run.",
    docs: { product: "terragucci", path: "/guides/estimate-cost/" },
    source: "terragucci:packages/terragucci/src/report/cost.ts:136",
    sample: "cost: network: 0.00 USD a month",
  },
  {
    id: "T07", product: "terragucci", feature: "Set digest",
    pattern: String.raw`^wave \d+ of \d+: set digest (jcs1-sha256:[0-9a-f]{64}), \d+ changes?, \d+ destroys?$`,
    note: "One digest over every plan in the wave; an approval names this digest, so it covers exactly these plans.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#approval-binding" },
    source: "terragucci:packages/terragucci/src/apply.ts:1773",
    sample: "wave 1 of 3: set digest jcs1-sha256:2e1cfef37c06a0cc7b3c287739bfa6bbd0cc141122bb4def1211782592d45011, 1 change, 0 destroys",
  },
  {
    id: "T08", product: "chant", feature: "Gate check",
    pattern: String.raw`^wave \d+ \(([^)]+)\): gate (\S+) \(read at [0-9a-f]{12}(?:, where the wave is absent)?\), digest (\S+): not-required$`,
    note: "The gate policy, read at the base commit, lets this wave apply with no approval because its plans match no rule that needs one.",
    docs: { product: "terragucci", path: "/reference/stages/#gate-policy" },
    source: "chant:packages/core/src/op/op-waves-run.ts:1546",
    sample: "wave 1 (wave-1): gate on-destructive (read at d3aaee4bf231), digest jcs1-sha256:2e1cfef37c06a0cc7b3c287739bfa6bbd0cc141122bb4def1211782592d45011: not-required",
  },
  {
    id: "T09", product: "chant", feature: "Gate check",
    pattern: String.raw`^wave \d+ \(([^)]+)\): gate (\S+) \(read at [0-9a-f]{12}(?:, where the wave is absent)?\), digest (\S+): approved by (\S+)(?: \(review of #\d+\))?(?:; held by (.+))?$`,
    note: "The wave's gate needed an approval, and one recorded for this exact digest lets the wave apply.",
    docs: { product: "terragucci", path: "/reference/stages/#gate-policy" },
    source: "chant:packages/core/src/op/op-waves-run.ts:1546",
    sample: "wave 2 (wave-2): gate on-destructive (read at d3aaee4bf231), digest jcs1-sha256:95b79f4946fffd67b2d3da8971084852c4182623d8223b4a307f7067375fe37a: approved by terragucci-admin",
  },
  {
    id: "T10", product: "terragucci", feature: "Approval mode",
    pattern: String.raw`^wave \d+ of \d+: approval (ledger|pr-review|sealed) \((.+)\)$`,
    note: "Which kind of approval this wave accepts (a ledger record, a pull request review or a signed record) and where that setting came from.",
    docs: { product: "terragucci", path: "/guides/approve-a-wave/#approval-modes" },
    source: "terragucci:packages/terragucci/src/apply.ts:2912",
    sample: "wave 2 of 3: approval ledger (the default)",
  },
  {
    id: "T11", product: "terragucci", feature: "Waiting for approval",
    pattern: String.raw`^wave \d+ of \d+ waits for an approval of digest (jcs1-sha256:[0-9a-f]{64})\. Read its plans above, then approve it with:$`,
    note: "The wave stops here until someone reads its plans and approves this digest with the command printed below.",
    docs: { product: "terragucci", path: "/guides/approve-a-wave/" },
    source: "terragucci:packages/terragucci/src/apply.ts:3000",
    sample: "wave 2 of 3 waits for an approval of digest jcs1-sha256:95b79f4946fffd67b2d3da8971084852c4182623d8223b4a307f7067375fe37a. Read its plans above, then approve it with:",
  },
  {
    id: "T12", product: "chant", feature: "Waiting for approval",
    pattern: String.raw`^Nothing in wave \d+ or after it ran\. (?:Read the plans, then|It waits on .+\.) approve: (chant approve \S+ \S+ --plan \S+) \(with --resume, the approval also starts this job again\)$`,
    note: "The job ends at this wave; the printed chant approve command records the approval and can restart the job.",
    docs: { product: "chant", path: "/guide/op-waves/#resume-the-waiting-job" },
    source: "chant:packages/core/src/op/op-waves-run.ts:1587",
    sample: "Nothing in wave 2 or after it ran. Read the plans, then approve: chant approve tf-apply wave-2 --plan jcs1-sha256:95b79f4946fffd67b2d3da8971084852c4182623d8223b4a307f7067375fe37a (with --resume, the approval also starts this job again)",
  },
  {
    id: "T13", product: "terragucci", feature: "Approved",
    pattern: String.raw`^wave \d+ of \d+: approved by (\S+) for this digest$`,
    note: "The wave goes ahead and applies because an approval of its exact digest exists.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#approval-binding" },
    source: "terragucci:packages/terragucci/src/apply.ts:2918",
    sample: "wave 2 of 3: approved by terragucci-admin for this digest",
  },
  {
    id: "T14", product: "chant", feature: "Approval spent",
    pattern: String.raw`^wave \d+ \(([^)]+)\) applies under the approval by (\S+) at (\S+), which is now spent$`,
    note: "The wave applies under this approval, and the approval is used up so it cannot apply the same plans a second time.",
    docs: { product: "chant", path: "/guide/op-waves/#spend-an-approval" },
    source: "chant:packages/core/src/op/op-waves-run.ts:2185",
    sample: "wave 2 (wave-2) applies under the approval by terragucci-admin at 2026-10-15T20:55:19.422Z, which is now spent",
  },
  {
    id: "T15", product: "chant", feature: "Approval spent",
    pattern: String.raw`^wave \d+ \(([^)]+)\): the approval of (\S+) by (\S+) at (\S+) is spent: a wave applied under it at (\S+)\. Applying it again needs a new approval`,
    note: "This approval was already used by an earlier apply, so applying these plans again needs a new approval.",
    docs: { product: "chant", path: "/guide/op-waves/#spend-an-approval" },
    source: "chant:packages/core/src/op/op-waves-run.ts:1802",
    sample: "wave 1 (wave-1): the approval of jcs1-sha256:365a4f0d54d735250162c4befe19115733f758d572b030af2bfcc1dd0578d5a0 by terragucci-admin at 2026-10-15T19:54:16.269Z is spent: a wave applied under it at 2026-10-15T19:54:22.333Z. Applying it again needs a new approval",
  },
  {
    id: "T16", product: "terragucci", feature: "Approval spent",
    pattern: String.raw`^wave \d+ of \d+: the approval of (\S+) by (\S+) was used by the apply of those plans, so these plans need an approval of their own$`,
    note: "An earlier apply used up the approval of these same plans, so this run waits for a fresh approval.",
    docs: { product: "chant", path: "/guide/op-waves/#spend-an-approval" },
    source: "terragucci:packages/terragucci/src/apply.ts:2796",
    sample: "wave 2 of 3: the approval of jcs1-sha256:50e8e91d611adfb47150a6785803089d642c769aad050b18cc397e4afcc692f6 by terragucci-admin was used by the apply of those plans, so these plans need an approval of their own",
  },
  {
    id: "T17", product: "terragucci", feature: "Changed after approval",
    pattern: String.raw`^wave \d+ changed after it was approved, so nothing in it was applied\. approved: (\S+); planned now: (\S+)\. `,
    note: "The wave planned to a different digest than the one approved; the new plan needs its own approval.",
    docs: { product: "terragucci", path: "/guides/fix-a-refused-wave/" },
    source: "terragucci:packages/terragucci/src/apply.ts:2983",
    sample: "wave 1 changed after it was approved, so nothing in it was applied. approved: jcs1-sha256:c7d57fcf0bf559242e2104f4d0ed562888f6bd99ed8c5af350db462771169877; planned now: jcs1-sha256:0be8353d2143e463577e05eca00b62cabd51791aaa383051930e384340812052. Read the new plan, then approve it: terragucci approve wave-1 --plan jcs1-sha256:0be8353d2143e463577e05eca00b62cabd51791aaa383051930e384340812052",
  },
  {
    id: "T18", product: "terragucci", feature: "Changed after approval",
    pattern: String.raw`^wave \d+ of \d+: approved by (\S+), but these roots planned differently since: (.+)$`,
    note: "Names the roots whose plans differ from the approved ones, so the wave needs a new approval.",
    docs: { product: "terragucci", path: "/tutorial/changed-wave/" },
    source: "terragucci:packages/terragucci/src/apply.ts:2984",
    sample: "wave 1 of 3: approved by terragucci-admin, but these roots planned differently since: network",
  },
  {
    id: "T19", product: "chant", feature: "Step hold",
    pattern: String.raw`^(\S+) hook (\S+)(?: \([^)]*\))? exited (\d+), so wave \d+ \(([^)]+)\) waits for an approval of its set digest$`,
    note: "A step set to hold on failure exited non-zero, so the wave waits for an approval whatever its gate says.",
    docs: { product: "terragucci", path: "/guides/run-steps/#step-failures" },
    source: "chant:packages/core/src/op/op-waves-run.ts:939",
    sample: "after-plan hook held exited 1, so wave 1 (wave-1) waits for an approval of its set digest",
  },
  {
    id: "T20", product: "terragucci", feature: "Unreviewed outputs",
    pattern: String.raw`^wave \d+ of \d+: nobody reviewed the plan it made on those outputs, so it waits for an approval of it(?: although gate is \S+)?$`,
    note: "This wave planned on outputs that got their values during the apply, so a person approves it even when its gate would let it through.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#linked-roots" },
    source: "terragucci:packages/terragucci/src/apply.ts:2562",
    sample: "wave 1 of 3: nobody reviewed the plan it made on those outputs, so it waits for an approval of it although gate is on-destructive",
  },
  {
    id: "T21", product: "terragucci", feature: "Unreviewed outputs",
    pattern: String.raw`^wave \d+ of \d+: (\S+) read (.+), unknown in (.+) and known only once wave (\d+) applied it$`,
    note: "A root read an output that was unknown at plan time and only got a value when an earlier wave applied.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#linked-roots" },
    source: "terragucci:packages/terragucci/src/unknown-reads.ts:185",
    sample: "wave 1 of 3: app read subnet_id of network, unknown in wave 1's plan of network in this job and known only once wave 1 applied it",
  },
  {
    id: "T22", product: "terragucci", feature: "Unreviewed outputs",
    pattern: String.raw`^wave \d+ of \d+: (\S+) reads? no output of (\S+) that (.+) left unknown$`,
    note: "Every output this root reads was known when it was planned, so its plan holds only reviewed values.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#linked-roots" },
    source: "terragucci:packages/terragucci/src/unknown-reads.ts:142",
    sample: "wave 2 of 3: app reads no output of network that wave 1's plan of network in this push (2026/10/e8863ee426177316d84499a5b8401c4b6adfb546/tf-apply-wave-1) left unknown",
  },
  {
    id: "T23", product: "terragucci", feature: "Linked roots",
    pattern: String.raw`^(\S+): plans on the planned outputs of (\S+)(?:, (.+) known once it applies)?$`,
    note: "In a pull request this root plans against the planned outputs of its upstream, so the note shows the combined effect before anything applies.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#linked-roots" },
    source: "terragucci:packages/terragucci/src/planned-outputs.ts:84",
    sample: "app: plans on the planned outputs of network",
  },
  {
    id: "T24", product: "terragucci", feature: "Composed run",
    pattern: String.raw`^(?:wave \d+: )?compose: (.+) (?:apply|plan) as one composed run in wave \d+(?: \((\S+)\))?$`,
    note: "These roots are planned or applied together as modules of one generated root instead of one at a time.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#a-composed-run" },
    source: "terragucci:packages/terragucci/src/report/stage.ts:1433",
    sample: "compose: app, edge, network plan as one composed run in wave 1",
  },
  {
    id: "T25", product: "terragucci", feature: "Composed run",
    pattern: String.raw`^wave \d+ of \d+: (\S+): (.+) across \d+ roots, composed digest (jcs1-sha256:[0-9a-f]{64})$`,
    note: "The combined plan of the composed run and the single digest an approval of it must name.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#a-composed-run" },
    source: "terragucci:packages/terragucci/src/apply.ts:2020",
    sample: "wave 1 of 3: compose:wave-1: Plan: 5 to add, 0 to change, 0 to destroy. across 3 roots, composed digest jcs1-sha256:e9a35e2f68482bb1dc6c874a0918b2b85bcc53b77c1379b5d1d487d812afbe2d",
  },
  {
    id: "T26", product: "terragucci", feature: "Unreviewed outputs",
    pattern: String.raw`^wave \d+ of \d+: (\S+) reads (.+), unknown at plan time and computed in this apply$`,
    note: "Inside a composed run this root reads a value computed during the apply.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#approval" },
    source: "terragucci:packages/terragucci/src/apply.ts:2022",
    sample: "wave 1 of 3: app reads subnet_id of network, unknown at plan time and computed in this apply",
  },
  {
    id: "T27", product: "terragucci", feature: "Composed run",
    pattern: String.raw`^wave \d+ of \d+: (\S+) \((\S+)\): (?:applied|no-changes|[a-z-]+), \d+ of \d+ changes; its state (written|as it was|not written.*)$`,
    note: "The outcome for one root inside the composed run, and whether its own state file was written back.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#the-composed-root" },
    source: "terragucci:packages/terragucci/src/apply.ts:2056",
    sample: "wave 1 of 3: network (module.network): applied, 1 of 1 changes; its state written",
  },
  {
    id: "T28", product: "terragucci", feature: "Apply result",
    pattern: String.raw`^applied (\S+): Resources: \d+ added, \d+ changed, \d+ destroyed$`,
    note: "The resource counts Terraform reported when it finished applying this root.",
    docs: { product: "terragucci", path: "/concepts/how-it-works/#a-change-start-to-finish" },
    source: "terragucci:packages/terragucci/src/apply.ts:798",
    sample: "applied other: Resources: 0 added, 0 changed, 0 destroyed",
  },
  {
    id: "T29", product: "terragucci", feature: "State version",
    pattern: String.raw`^(\S+): state (\S+)(?:, versions (on|off|unknown)(?: \((.+)\))?| version (\S+))$`,
    note: "Where the root's state lives after the apply and which stored version holds it, so you can find or restore it later.",
    docs: { product: "terragucci", path: "/guides/find-a-state-version/" },
    source: "terragucci:packages/terragucci/src/apply.ts:3480",
    sample: "network: state s3://demo-terraform-state/network.tfstate, versions off (bucket versioning is off for demo-terraform-state, so it keeps only the latest state)",
  },
  {
    id: "T30", product: "terragucci", feature: "Apply result",
    pattern: String.raw`^wave \d+ of \d+ applied$`,
    note: "Every root in this wave applied, so the next wave can start.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#waves" },
    source: "terragucci:packages/terragucci/src/apply.ts:1850",
    sample: "wave 1 of 3 applied",
  },
  {
    id: "T31", product: "chant", feature: "Apply failed",
    pattern: String.raw`^wave \d+ \(([^)]+)\): apply failed, so none of (.+) counts as applied$`,
    note: "The wave's apply failed. Its roots and the later waves wait for a re-run.",
    docs: { product: "terragucci", path: "/reference/responses/#apply-failed" },
    source: "chant:packages/core/src/op/op-waves-run.ts:2092",
    sample: "wave 2 (wave-2): apply failed, so none of app counts as applied",
  },
  {
    id: "T32", product: "terragucci", feature: "Run report",
    pattern: String.raw`^wave \d+: report in terragucci-report/, slowest root (\S+) \(([\d.]+)s\)$`,
    note: "The wave's report was written to terragucci-report/, and this root took longest to run.",
    docs: { product: "terragucci", path: "/reference/report/" },
    source: "terragucci:packages/terragucci/src/apply.ts:1560",
    sample: "wave 1: report in terragucci-report/, slowest root network (0.25s)",
  },
  {
    id: "T33", product: "terragucci", feature: "Reports bucket",
    pattern: String.raw`^wave \d+: report copied to (\S+?)(?:, at (\S+))?$`,
    note: "The wave's report was uploaded to the reports bucket under this prefix, so it outlives the CI job.",
    docs: { product: "terragucci", path: "/guides/keep-reports-in-a-bucket/" },
    source: "terragucci:packages/terragucci/src/apply.ts:1566",
    sample: "wave 1: report copied to demo/forgejo:3000/terragucci-admin/demo/2026/10/e8863ee426177316d84499a5b8401c4b6adfb546/tf-apply-wave-1",
  },
  {
    id: "T34", product: "terragucci", feature: "Run view",
    pattern: String.raw`^wave \d+: run view at (\S+)/run\.html$`,
    note: "Where the page showing this whole run, wave by wave, was written in the reports bucket.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#the-run-view" },
    source: "terragucci:packages/terragucci/src/apply.ts:1483",
    sample: "wave 1: run view at demo/forgejo:3000/terragucci-admin/demo/runs/e8863ee426177316d84499a5b8401c4b6adfb546/run.html",
  },
  {
    id: "T35", product: "terragucci", feature: "Reports bucket",
    pattern: String.raw`^copied to the bucket under (\S+); index rewritten at (.+)$`,
    note: "The plan report was uploaded to the bucket and the index that lists every run was updated.",
    docs: { product: "terragucci", path: "/guides/keep-reports-in-a-bucket/" },
    source: "terragucci:packages/terragucci/src/cli.ts:478",
    sample: "copied to the bucket under demo/forgejo:3000/terragucci-admin/demo/2026/10/3660bae82703755ab670502bb0bf7e48b599fe80/tf-plan; index rewritten at demo/forgejo:3000/terragucci-admin/demo/index.json and demo/index.json",
  },
  {
    id: "T36", product: "terragucci", feature: "Apply from a comment",
    pattern: String.raw`^terragucci comment-apply: apply pull request (\d+)'s merge commit ([0-9a-f]{8})(?: through wave \d+)? for (\S+)$`,
    note: "A comment on a merged pull request asked to apply its merge commit, and the job goes ahead on behalf of that user.",
    docs: { product: "terragucci", path: "/guides/re-plan-from-a-comment/#apply-a-merged-pull-request" },
    source: "terragucci:packages/terragucci/src/comment-apply.ts:255",
    sample: "terragucci comment-apply: apply pull request 1086's merge commit e8863ee4 for terragucci-admin",
  },
  {
    id: "T37", product: "terragucci", feature: "Plan note",
    pattern: String.raw`^terragucci plan-note: posted the plan note on pull request (\d+)$`,
    note: "The plan summary was posted as a comment on the pull request.",
    docs: { product: "terragucci", path: "/reference/report/#the-plan-note" },
    source: "terragucci:packages/terragucci/src/plan-note.ts:180",
    sample: "terragucci plan-note: posted the plan note on pull request 1086",
  },
  {
    id: "T38", product: "terragucci", feature: "Plan note",
    pattern: String.raw`^terragucci plan-note: terragucci/plan is (\S+) on ([0-9a-f]{8}): (.+)$`,
    note: "terragucci set the terragucci/plan commit status on the pull request's head with a one-line count of what the plan does.",
    docs: { product: "terragucci", path: "/reference/pipeline/#statuses-and-stale-plans" },
    source: "terragucci:packages/terragucci/src/plan-note.ts:191",
    sample: "terragucci plan-note: terragucci/plan is success on 3660bae8: 3 roots, 3 groups, 0 destroys",
  },
  {
    id: "T39", product: "chant", feature: "Plan grouping",
    pattern: String.raw`^\d+ (?:members?|roots?|units?|instances?): \d+ groups?, .*\d+ (?:destroy or replacement|destroys or replacements)(?:, .+)?\.$`,
    note: "The plan summary's first line counts the planned roots and how many groups and destroys they add up to.",
    docs: { product: "terragucci", path: "/concepts/why-plans-are-grouped/#grouping" },
    source: "chant:packages/core/src/plan-summary.ts:684",
    sample: "3 members: 3 groups, 0 destroys or replacements.",
  },
  {
    id: "T40", product: "chant", feature: "Plan grouping",
    pattern: String.raw`^Group [0-9a-f]+: \d+ \S+(?: of \S+)? \(outlier\)`,
    note: "This group's change differs from what similar roots do, so it is flagged for a closer look.",
    docs: { product: "terragucci", path: "/tutorial/one-note/" },
    source: "chant:packages/core/src/plan-summary.ts:690",
    sample: "Group 46b88a607c5f: 1 member (outlier), change:",
  },
  {
    id: "T41", product: "chant", feature: "Plan grouping",
    pattern: String.raw`^Destroys and replacements \(\d+\):$`,
    note: "The plan summary lists every resource the plans destroy or replace before anything else.",
    docs: { product: "terragucci", path: "/concepts/why-plans-are-grouped/" },
    source: "chant:packages/core/src/plan-summary.ts:726",
    sample: "Destroys and replacements (1):",
  },
  {
    id: "T42", product: "terragucci", feature: "Validate",
    pattern: String.raw`^valid (\S+)$`,
    note: "The check job ran validate on this root and it passed.",
    docs: { product: "terragucci", path: "/reference/stages/#check" },
    source: "terragucci:packages/terragucci/src/check.ts:187",
    sample: "valid app",
  },
  {
    id: "T43", product: "terragucci", feature: "Tips",
    pattern: String.raw`^(.+): (opened|open) (https?://\S+) \((terragucci/tip/\S+): (.+)\)$`,
    note: "terragucci opened (or found already open) a small pull request that applies one of its setup tips, such as adding a canary wave.",
    docs: { product: "terragucci", path: "/reference/responses/#tips-fmt-and-release-notes" },
    source: "terragucci:packages/terragucci/src/respond/index.ts:151",
    sample: "Add a canary wave: app: opened http://forgejo:3000/terragucci-admin/demo/pulls/1087 (terragucci/tip/canary: terragucci.yml)",
  },
  {
    id: "T44", product: "terragucci", feature: "Eligible approvers",
    pattern: String.raw`^wave \d+ of \d+: (\S+) (.+), so \1's (approval|review) doesn't count$`,
    note: "This person worked on the change, so the gate counts approvals from someone else.",
    docs: { product: "terragucci", path: "/guides/approve-a-wave/#eligible-approvers" },
    source: "terragucci:packages/terragucci/src/involved.ts:175",
    sample: "wave 2 of 3: demo-author opened pull request 1086, so demo-author's review doesn't count", // made from the source, no run printed it yet
  },
  {
    id: "T45", product: "terragucci", feature: "Eligible approvers",
    pattern: String.raw`^wave \d+ of \d+: an approval counts only from someone who had no hand in the change, so not from (.+)$`,
    note: "The people named here worked on the change, so the gate counts approvals from someone else.",
    docs: { product: "terragucci", path: "/guides/approve-a-wave/#eligible-approvers" },
    source: "terragucci:packages/terragucci/src/apply.ts:3001",
    sample: "wave 2 of 3: an approval counts only from someone who had no hand in the change, so not from demo-author", // made from the source, no run printed it yet
  },
  {
    id: "T46", product: "terragucci", feature: "Changed after approval",
    pattern: String.raw`^Wave \d+ applies nothing: its plans changed after the approval \(approved [0-9a-f]{12}, now [0-9a-f]{12}\)\.$`,
    note: "The reply terragucci posts on a refused wave. Its plans changed after the approval, and it gives both short digests.",
    docs: { product: "terragucci", path: "/reference/responses/#wave-refused" },
    source: "terragucci:packages/terragucci/src/respond/refused.ts:79",
    sample: "Wave 1 applies nothing: its plans changed after the approval (approved c7d57fcf0bf5, now 0be8353d2143).",
  },
  {
    id: "T47", product: "terragucci", feature: "Composed run",
    pattern: String.raw`^(\S+): in the composed run as (\S+): (.+)$`,
    note: "In the pull request plan, this root's changes as a module of the composed run.",
    docs: { product: "terragucci", path: "/concepts/waves-and-approvals/#a-composed-run" },
    source: "terragucci:packages/terragucci/src/report/stage.ts:1575",
    sample: "network: in the composed run as module.network: Plan: 1 to add, 0 to change, 0 to destroy.",
  },
  {
    id: "T48", product: "terragucci", feature: "Apply result",
    pattern: String.raw`^all roots applied$`,
    note: "The apply job finished every group of roots with no failure.",
    docs: { product: "terragucci", path: "/concepts/how-it-works/#a-change-start-to-finish" },
    source: "terragucci:packages/terragucci/src/render.ts:1146",
    sample: "all roots applied",
  },
];

/** A runner's timestamp at the start of a line, as Forgejo and GitHub print it. */
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;

/** The line without its runner timestamp. */
export function stripStamp(line) {
  return typeof line === "string" ? line.replace(STAMP, "") : "";
}

let compiled = null;
const rules = () => (compiled ||= ANNOTATIONS.map((a) => ({ a, re: new RegExp(a.pattern) })));

/** The entry a line matches, the first in the catalogue's order; null for a line none knows. */
export function annotationOf(line) {
  const text = stripStamp(line);
  if (!text) return null;
  for (const { a, re } of rules()) if (re.test(text)) return a;
  return null;
}

/** Every entry a line matches (the test's: one at most). */
export function annotationsOf(line) {
  const text = stripStamp(line);
  return text ? rules().filter(({ re }) => re.test(text)).map(({ a }) => a) : [];
}

/** The entry with this id, or null. */
export function annotationById(id) {
  return ANNOTATIONS.find((a) => a.id === id) || null;
}

/** The docs page's address. */
export function docsUrl(a) {
  const base = DOCS_BASES[a.docs.product] || DOCS_BASES[a.product];
  return `${base}${a.docs.path}`;
}

/** A feature's key: its tool and its name. */
export const featureKey = (a) => `${a.product}|${a.feature}`;

/** The chip's words: the tool and the feature. */
export const chipWords = (a) => `${a.product} · ${a.feature}`;

/**
 * The marks of one job's log, its steps in order: for each annotated line
 * (`<step index>:<line number>`), its entry and whether it is the first line
 * of its feature in the job (a chip) or a later one (a dot). Line numbers are
 * the log's, after a kept log's cut (`truncated`). `hide(line)` leaves a line
 * out, as the page does.
 */
export function jobMarks(steps, { hide = null } = {}) {
  const marks = new Map();
  const seen = new Set();
  (steps || []).forEach((s, i) => {
    const from = s.truncated || 0;
    (s.log || []).forEach((line, j) => {
      if (hide && hide(line)) return;
      const a = annotationOf(line);
      if (!a) return;
      const key = featureKey(a);
      marks.set(`${i}:${from + j + 1}`, { a, first: !seen.has(key) });
      seen.add(key);
    });
  });
  return marks;
}

/**
 * The features a run's logs show, by tool in PRODUCTS' order, each feature
 * once with the first line that shows it: `[{ product, features: [{ feature,
 * a, job, step, n }] }]`. Jobs in the order given (the page's), steps and
 * lines in the log's order. Only the features some line matched.
 */
export function runFeatures(jobs, { hide = null } = {}) {
  const first = new Map();
  for (const job of jobs || []) {
    (job.steps || []).forEach((s, i) => {
      const from = s.truncated || 0;
      (s.log || []).forEach((line, j) => {
        if (hide && hide(line)) return;
        const a = annotationOf(line);
        if (!a || first.has(featureKey(a))) return;
        first.set(featureKey(a), { feature: a.feature, a, job: job.name, step: i, n: from + j + 1 });
      });
    });
  }
  const all = [...first.values()];
  return PRODUCTS.map((product) => ({ product, features: all.filter((f) => f.a.product === product) })).filter((g) => g.features.length);
}

/**
 * The first line of a run's logs that an entry of `ids` knows and `pick`
 * accepts (`pick(text, a)`): `{ a, job, step, n, text }`, or null.
 */
export function findLine(run, ids, pick = () => true) {
  for (const job of (run && run.jobs) || []) {
    const steps = job.steps || [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const from = s.truncated || 0;
      const log = s.log || [];
      for (let j = 0; j < log.length; j++) {
        const a = annotationOf(log[j]);
        if (a && ids.includes(a.id) && pick(stripStamp(log[j]), a)) return { a, job: job.name, step: i, n: from + j + 1, text: stripStamp(log[j]) };
      }
    }
  }
  return null;
}
