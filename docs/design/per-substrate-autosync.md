# Per-substrate auto-sync — design

**Issue:** #105 (design only, implementation deferred) · **Tracked under** #74 ·
**Relates** INTENTIUS/chant#1197

Auto-sync is the opt-in self-heal loop: when `--poll` sees the estate move,
behold triggers the project's own committed Op. This specifies how it behaves on
a mixed-substrate estate, so the CC lanes are not designing around a hole.

## The premise, corrected

#105 says auto-sync "is AWS-wired (`autosync.ts`)". It is not. Every piece of
behold's loop was read before writing this, and all three are substrate-neutral
already:

| Module | What it does | AWS-specific? |
|---|---|---|
| `src/poll.ts` | digests `id=_status` over the overlay IR and fires when it changes | no — chant paints `_status` per lexicon |
| `src/autosync.ts` | 29 lines; picks a committed Op by kind for a drift event | no — no substrate concept at all |
| `src/ops.ts` | classifies `*.op.ts` by matching `ApplyOp` / `ReconcileOp` / `AuditOp` | no — reads declared source |

behold holds no apply credentials and performs no cloud write. It triggers an Op
you committed; chant executes it. Everything provider-shaped — CloudFormation vs
`kubectl` vs ARM — is inside chant's `ApplyOp` `target`, and has been per-
substrate since before this issue was filed.

So there is no AWS wiring to generalize. There is a **different** hole, and it is
the one that matters.

## The actual hole: no attribution, no routing

Two assumptions hold only for a single-substrate estate.

**Detection is estate-wide.** `driftDigest` reduces the whole overlay to one
string. It answers *did anything move*, never *what moved*. A drifted k8s Service
and a drifted security group are the same event.

**Selection takes the first match.** `pickAutoSyncOp` is
`ops.find((o) => o.kind === kind)` — the first Op of the right kind, in
`localeCompare` order by name. A mixed estate whose halves are applied by
different Ops (a `cfn` ApplyOp for the cloud half, a `kubectl` ApplyOp for the
k8s half) heals whichever sorts first.

Together those mean: **on the canonical mixed example, drift in the k8s half can
trigger the AWS apply.** That is not a missing feature, it is a wrong action —
and it is silent, because the Op runs and succeeds without touching what drifted.
It has not bitten anyone because auto-sync is off by default and no mixed estate
has run it.

## The four questions

### 1. How does auto-sync detect drift per substrate?

It rides the same overlay it already polls; only the digest changes shape.

Every node in the overlay IR carries `lexicon`. Group by it and the estate-wide
digest becomes one digest per substrate:

```
driftDigest(ir)                  ->  "vpc=good\nsvc=accent\n…"          (today)
driftDigestsByLexicon(ir)        ->  { aws: "vpc=good\n…", k8s: "svc=accent" }
```

A tick then reports *which* substrates moved, not merely that something did. No
new read, no per-substrate drift surface, no dependency on chant#1202: the
information is already in the IR behold pulls every poll, and is being thrown
away by the reduction.

The digest is over nodes only, so the cross-substrate anchor edges #103 adds
never enter it — one substrate cannot appear to move because it is now connected
to another that did.

### 2. What triggers apply, and how is it gated?

Unchanged, and deliberately so. behold triggers a committed Op through
`chant run`; a gated (destructive) apply still pauses for Approve, and auto-sync
**never** approves — that is the invariant that makes an automatic loop
acceptable at all, and per-substrate routing must not weaken it.

What changes is *which* Op:

- Each substrate that moved routes to the Op that owns it.
- An Op is matched to a substrate by the `env`/target it declares, the same way
  `ops.ts` already scrapes `name:`, `signalName:` and `env:` from source. The
  natural key is `ApplyOp`'s `target` (`kubectl` / `cfn` / ARM), which chant
  already requires an author to state.
- **Ambiguity does not guess.** Where several Ops of a kind match one substrate,
  or none does, auto-sync declines and says so — the same discipline
  `soleManagedCluster` (#103) and `addValueMatchEdges` follow. A self-heal loop
  that guesses which half of an estate to rewrite is worse than one that stops.
- One Op runs at a time. The existing `running` guard stays: two substrates
  drifting in the same tick queue, they do not race.

### 3. How does git-source rollback interact with the loop?

Rollback is a source change, so it looks like ordinary drift to the loop — which
is exactly the trap.

Rollback (chant#873) opens a PR restoring source to a prior revision. Merging it
moves *source*, and the estate then differs from source until an apply. With
`mode: "apply"`, auto-sync sees that difference and heals the cloud toward the
newly-rolled-back source. **That is correct and is the intended completion of a
rollback** — chant's own rollback PR body says as much ("merge, then apply").

The danger is the opposite direction. With `mode: "pull-request"`, auto-sync
opens a ReconcileOp PR adopting live into source — which would re-introduce
precisely what the rollback removed, and if that PR is merged the two loops
fight. So:

- **Rollback and `pull-request` auto-sync are mutually exclusive on the same
  environment.** While a rollback PR is open, auto-sync must not open a reconcile
  PR for the substrates that rollback touches.
- The interlock is per-substrate too: a rollback of the cloud half does not need
  to suspend a k8s reconcile.
- Because both are per-substrate, the state to track is small: which substrates
  have an open rollback. That is readable from the branch name
  (`chant/rollback-<env>-<ref>`) plus the rolled-back `sourceDir`.

Note the sequencing gap this exposes: chant#1327 showed rollback only recently
began removing files added since the target revision, and a reconcile only ever
*adds* files. An auto-sync loop that reconciled and then rolled back would have
produced an empty rollback before that fix.

### 4. What in `autosync.ts` must generalize?

The file itself: almost nothing. `AutoSyncMode` and the off/running guards are
already substrate-free. The change is its **signature**, and it stays a pure
function:

```ts
// today
pickAutoSyncOp(mode, ops, running): OpInfo | null

// per-substrate
pickAutoSyncOps(mode, ops, running, movedLexicons): Array<{ lexicon: string; op: OpInfo }>
```

The work is not in this module. In rough order of size:

1. **`ops.ts` learns a substrate.** `OpInfo` gains an optional substrate,
   scraped from the Op's declared `target`. Optional because an Op that declares
   none is exactly the ambiguity case above.
2. **`poll.ts` keeps the grouping.** `driftDigest` → per-lexicon digests, and
   `onChange` carries which moved. Both pure and unit-testable, as now.
3. **The server threads it.** The loop passes moved substrates into the picker
   instead of calling it blind.
4. **The rollback interlock**, per question 3 — the only genuinely new state.

## What this deliberately does not do

Implementation is deferred (#105 is design-only). It is specified now so the
lanes do not build on the single-Op assumption, and so the correction above —
that behold's loop was never AWS-wired, but *was* estate-wide — is recorded
before someone generalizes the wrong thing.

Nothing here needs a chant change. The `lexicon` on every IR node and the
`target` on every `ApplyOp` are both already there.
