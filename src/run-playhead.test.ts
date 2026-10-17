import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { opsToIr, type OpIr } from "./ops-lens.ts";
import { readRunLine, foldRunEvents, type StepView } from "./run-events.ts";
import {
  stepLine,
  parseGateLine,
  readRunStatus,
  initialRunState,
  runStarted,
  runEnded,
  runLost,
  runGate,
  joinRun,
  paintPlayhead,
  playheadNote,
  pendingGateCard,
  GATED_EXIT_CODE,
  type RunState,
} from "./run-playhead.ts";

// #679: these fixtures are the older stream (`--progress-json` StepRecords and
// the local `--json` envelope), which behold now reads only in degraded mode,
// through the same boundary as chant's run events (src/run-events.ts). behold
// keeps no copy of chant's record type: the shape below is only what these
// fixture files hold. The run-event path is src/run-events.test.ts.
type LegacyRecord = { phase: string; fn: string; status: "ok" | "fail" | "skipped"; durationMs: number; args?: Record<string, unknown>; error?: string };
type OpRunResult = { op: string; records: LegacyRecord[]; totalMs: number; ok: boolean };
/** One line of the older stream, read through the boundary, as steps. */
function parseRunProgressLine(line: string): StepView[] | null {
  const r = readRunLine(line);
  if (r?.kind !== "legacy") return null;
  const steps = foldRunEvents(r.events).steps;
  return steps.length ? steps : null;
}
const step = (r: LegacyRecord): StepView => parseRunProgressLine(JSON.stringify(r))![0];
const steps = (rs: LegacyRecord[]): StepView[] => rs.map(step);
const runRecord = (s: RunState, st: StepView): RunState => ({ ...s, steps: [...s.steps, st] });
/** A degraded-mode run: the older stream's exit-code rules. */
const legacyStarted = (op: string, at: string): RunState => runStarted(op, "local", at, "progress");

const HERE = dirname(fileURLToPath(import.meta.url));
const F = join(HERE, "__fixtures__", "ops-playhead");
const read = (name: string): string => readFileSync(join(F, name), "utf8");

/**
 * ## Fixture provenance
 *
 * Everything under `src/__fixtures__/ops-playhead/` came out of chant 0.52.1
 * (which contains chant#1676/#2004, tagged chant-v0.51.0), against a scratch
 * copy of this repo's own `example-writes` — the same method PR #315 used for
 * the ops-lens fixtures, so nothing in the checkout was touched:
 *
 *     cp -R example-writes $SCRATCH && cd $SCRATCH
 *     npm install --no-save @intentius/chant@0.52.1 \
 *       @intentius/chant-lexicon-aws@0.52.1 @intentius/chant-lexicon-temporal@0.52.1
 *
 * plus one extra Op, `ops/playhead-probe.op.ts`, written to be HARMLESS so a
 * real run needs no cloud, no emulator and no network egress — an npm build,
 * four `echo`s, and an httpCheck at a closed local port:
 *
 *     export default Op({
 *       name: "playhead-probe", overview: "...", taskQueue: "behold-writes",
 *       phases: [
 *         phase("Build",  [build(".", { script: "build" })]),
 *         phase("Deploy", [shell("echo deploy-a"), shell("echo deploy-b")]),
 *         phase("Fanout", [shell("echo left"), shell("echo right")], { parallel: true }),
 *         phase("Verify", [httpCheck("http://127.0.0.1:1/", { retries: 1, intervalMs: 50 })]),
 *         phase("Never",  [httpCheck("http://127.0.0.1:1/never", { retries: 1, intervalMs: 50 })]),
 *       ],
 *       onFailure: [phase("Rollback", [shell("echo rollback")])],
 *     });
 *
 * Then:
 *
 *  - `playhead-probe.op.json` — `chant build --lexicon temporal`'s emitted IR
 *    for that Op, verbatim. The declared track the playhead paints over.
 *  - `playhead-probe.local-run.json` — **a real run**: `chant run
 *    playhead-probe --json` on the local executor, its `OpRunResult` verbatim
 *    (exit 1: `Verify` genuinely failed against the closed port, and the
 *    onFailure phase genuinely ran).
 *  - `playhead-probe.progress.ndjson` — the durable path's stream, produced by
 *    **chant's own reconstructor**, on chant 0.52.1: chant's `extractStepRecords`
 *    (`cli/handlers/op-progress.ts`) driven over a well-formed workflow history
 *    for this same Op, four poll rounds deep, through chant's own poll-loop
 *    watermark (`run.ts`'s `emitNewRecords`) — i.e. the exact bytes `chant run
 *    playhead-probe --temporal --progress-json` wrote on 0.52.1. A live Temporal
 *    round-trip is the only part not reproduced; the record shapes and the
 *    stream framing are chant's. On 0.52.1 that watermark counted emitted
 *    records, and the terminal pass inserting `Never`'s `skipped` record ahead
 *    of `Rollback` shifted what the count pointed at, so `Rollback · shellCmd`
 *    shipped twice and `Never` never shipped at all (chant#2032). Fixed in
 *    chant 0.53.1 (chant PR #2041: dedup by declared-step identity, not a
 *    count) — this fixture now exists to pin the join's defense-in-depth
 *    against a repeated record, not to describe a live chant bug. See
 *    `playhead-probe.progress.fixed.ndjson` below for the same shape on the
 *    fixed emitter.
 *  - `playhead-probe.progress.fixed.ndjson` — the same driving method, on
 *    chant 0.53.1's fix: `extractIndexedStepRecords` + `stepRecordEmitter`
 *    from that version's `op-progress.ts`, called exactly as 0.53.1's
 *    `run.ts` calls them, over the SAME workflow history shape that produced
 *    the fixture above (an unreached main phase — `Never` — declared before
 *    an `onFailure` phase that ran — `Rollback` — the chant#2032 shape),
 *    through the same four growing poll snapshots, the terminal one used for
 *    both the regular and the `final: true` extraction. Every record ships
 *    exactly once: no repeat, `Never` lands correctly as `skipped`. Generated
 *    by a throwaway script importing chant 0.53.1's source directly from a
 *    local checkout — not committed, since it isn't part of behold's build;
 *    reproducible from `op-progress.ts`'s exported `extractIndexedStepRecords`
 *    / `stepRecordEmitter` and the durations in `playhead-probe.local-run.json`.
 *  - `run-status-gate-pending.txt`, `run-status-no-gate.txt`,
 *    `run-status-no-run.stderr.txt`, `gated-probe.progress.ndjson` and
 *    `run-approve-local.stderr.txt` — **real** chant 0.124.24 output (#459),
 *    from a scratch project holding only `gated-probe.op.ts.txt` (two echoes
 *    with `gate("approve-probe")` between them) and `chant.config.ts` with no
 *    lexicons, in a fresh git repo: `chant run gated-probe --progress-json`
 *    (exit 3, gated), `chant run status gated-probe` (stdout), `chant run
 *    approve gated-probe approve-probe` (stderr), `chant run gated-probe
 *    --progress-json` again (exit 0), `chant run status gated-probe` (stdout,
 *    the no-gate one), and `chant run status never-ran` (stderr, exit 0).
 *    ANSI colour included, because chant colours its output when it isn't a
 *    TTY, which is how behold gets it.
 *  - `run-status-local-mode.txt` / `run-status-no-client.txt` — real stderr
 *    from chant 0.52's temporal path, which chant no longer has; kept as the
 *    shape of an arbitrary non-zero refusal.
 */
const probe = JSON.parse(read("playhead-probe.op.json")) as OpIr;
const localRun = JSON.parse(read("playhead-probe.local-run.json")) as OpRunResult;
const streamLines = read("playhead-probe.progress.ndjson").trim().split("\n");
const fixedStreamLines = read("playhead-probe.progress.fixed.ndjson").trim().split("\n");

describe("the real chant-emitted fixtures", () => {
  it("are the Op and the records they claim to be", () => {
    expect(probe.name).toBe("playhead-probe");
    expect(probe.formatVersion).toBe("1.0");
    expect(probe.phases.map((p) => p.name)).toEqual(["Build", "Deploy", "Fanout", "Verify", "Never"]);
    expect(probe.onFailure?.map((p) => p.name)).toEqual(["Rollback"]);
    expect(localRun.op).toBe("playhead-probe");
    expect(localRun.ok).toBe(false);
  });

  it("show the one shape difference between the two executors: `args`", () => {
    // chant's own doc on StepRecord.args — present locally, omitted on the
    // durable path because an activity's scheduled input isn't decoded from
    // workflow history. behold must not require it.
    expect(localRun.records[0].args).toEqual({ path: ".", script: "build" });
    for (const line of streamLines) expect(JSON.parse(line).args).toBeUndefined();
  });
});

describe("the older stream, read through the run-event boundary (degraded mode)", () => {
  it("reads one NDJSON StepRecord as one settled step", () => {
    expect(parseRunProgressLine(streamLines[0])).toEqual([
      { component: null, phase: "Build", step: "chantBuild", state: "ok", durationMs: 1000 },
    ]);
  });

  it("reads the whole OpRunResult envelope — the local executor's end-of-run print", () => {
    const records = parseRunProgressLine(read("playhead-probe.local-run.json").replace(/\n\s*/g, ""));
    expect(records).toHaveLength(localRun.records.length);
    expect(records?.[5]).toMatchObject({ phase: "Verify", step: "httpCheck", state: "failed" });
  });

  it("returns null for a line that isn't progress, so the raw-log fallback keeps it", () => {
    expect(parseRunProgressLine("> build")).toBeNull();
    expect(parseRunProgressLine("")).toBeNull();
    // Valid JSON, but not a record: chant's `{waves: [...]}` component-driver
    // progress, and anything an activity happens to print.
    expect(parseRunProgressLine(JSON.stringify({ type: "run-start", waves: [["web"]] }))).toBeNull();
    expect(parseRunProgressLine(JSON.stringify({ phase: "Build", fn: "x", status: "maybe", durationMs: 1 }))).toBeNull();
    expect(parseRunProgressLine(JSON.stringify({ phase: "Build", fn: "x", status: "ok" }))).toBeNull();
    // An envelope whose records are all unreadable is not progress either.
    expect(parseRunProgressLine(JSON.stringify({ op: "x", records: [{ nope: 1 }] }))).toBeNull();
  });

  it("never throws on hostile input", () => {
    for (const line of ["{", "[]", "null", "42", '"str"', " "]) {
      expect(() => parseRunProgressLine(line)).not.toThrow();
    }
  });
});

describe("stepLine", () => {
  it("narrates a settled step, so the structured stream costs no now-line output", () => {
    expect(stepLine(step(localRun.records[1]))).toBe("✓ Deploy · shellCmd: 5ms");
    expect(stepLine(step(localRun.records[0]))).toBe("✓ Build · chantBuild: 1.1s");
    expect(stepLine(step(localRun.records[5]))).toContain("✗ Verify · httpCheck");
    expect(stepLine(step({ phase: "Never", fn: "httpCheck", status: "skipped", durationMs: 0 }))).toBe("• Never · httpCheck: skipped");
  });
});

// ── the join ────────────────────────────────────────────────────────────────

const streamRecords = streamLines.flatMap((l) => parseRunProgressLine(l) ?? []);
const fixedStreamRecords = fixedStreamLines.flatMap((l) => parseRunProgressLine(l) ?? []);

describe("joinRun", () => {
  it("lands the durable stream on the very node ids the ops lens drew", () => {
    const join = joinRun(probe, streamRecords, null);
    expect(Object.fromEntries([...join.byNode].map(([id, r]) => [id, r.status]))).toEqual({
      "playhead-probe/Build/chantBuild": "ok",
      "playhead-probe/Deploy/shellCmd": "ok",
      "playhead-probe/Deploy/shellCmd#2": "ok",
      "playhead-probe/Fanout/shellCmd": "ok",
      "playhead-probe/Fanout/shellCmd#2": "ok",
      "playhead-probe/Verify/httpCheck": "failed",
      "playhead-probe/Rollback/shellCmd": "ok",
    });
    // Every id is a card the lens actually draws — the join is to the picture,
    // not to a parallel id space.
    const drawn = new Set(opsToIr([probe]).nodes.map((n) => n.id));
    for (const id of join.byNode.keys()) expect(drawn.has(id)).toBe(true);
  });

  it("drops a repeated record into `unplaced` instead of shifting the track — the pre-fix chant#2032 stream, kept as the regression case", () => {
    // This fixture's stream ends with `Rollback · shellCmd` TWICE: it's
    // chant 0.52.1's actual output for this Op, from before chant#2032 was
    // fixed (chant PR #2041, chant 0.53.1). chant's `emitNewRecords` sliced by
    // an emitted-count watermark on a list it assumed was append-only, but the
    // terminal `final: true` pass INSERTS a `skipped` record for the
    // never-reached `Never` phase — shifting the tail, so the last record was
    // re-emitted and the skipped one never shipped. That bug no longer occurs
    // on current chant (see the `.fixed.ndjson` fixture below) — this is
    // defense-in-depth, proven against the exact stream that used to need it:
    // a blind append would paint every later step one position early, so the
    // positional per-(phase, fn) join drops the repeat instead, whatever
    // emitted it.
    expect(streamLines.filter((l) => JSON.parse(l).phase === "Rollback")).toHaveLength(2);
    const join = joinRun(probe, streamRecords, null);
    expect(join.unplaced).toEqual([{ component: null, phase: "Rollback", step: "shellCmd", state: "ok", durationMs: 1000 }]);
    expect(join.byNode.get("playhead-probe/Rollback/shellCmd")?.records).toBe(1);
    // And the phase the run never reached stays unpainted rather than green.
    expect(join.byNode.has("playhead-probe/Never/httpCheck")).toBe(false);
  });

  it("lands every record on current chant with nothing left unplaced — chant#2032 is fixed", () => {
    // Same Op, same chant#2032 shape (Never unreached, declared before the
    // Rollback that ran) — this time driven through chant 0.53.1's fixed
    // emitter (extractIndexedStepRecords + stepRecordEmitter, dedup by
    // declared-step identity). No repeat ships, so nothing lands in
    // `unplaced`: the assertion the pre-fix stream above could never make.
    expect(fixedStreamLines.filter((l) => JSON.parse(l).phase === "Rollback")).toHaveLength(1);
    const join = joinRun(probe, fixedStreamRecords, null);
    expect(join.unplaced).toEqual([]);
    expect(join.byNode.get("playhead-probe/Rollback/shellCmd")?.records).toBe(1);
    // Never's `skipped` record now arrives at all (on 0.52.1 the bug dropped
    // it outright) and lands correctly, distinct from having settled.
    expect(join.byNode.get("playhead-probe/Never/httpCheck")).toMatchObject({ status: "skipped", records: 1 });
  });

  it("lands the local executor's records on the same ids — one playhead, two executors", () => {
    const join = joinRun(probe, steps(localRun.records), null);
    expect([...join.byNode.keys()].sort()).toEqual(
      [...joinRun(probe, streamRecords, null).byNode.keys()].sort(),
    );
    expect(join.byNode.get("playhead-probe/Verify/httpCheck")).toMatchObject({
      status: "failed",
      error: "httpCheck failed for http://127.0.0.1:1/: fetch failed",
    });
    expect(join.unplaced).toEqual([]);
  });

  it("puts the playhead on the next declared step, labelled reached-not-settled", () => {
    const partial = streamRecords.slice(0, 3); // Build, Deploy a, Deploy b
    const join = joinRun(probe, partial, null);
    expect(join.at).toBe("playhead-probe/Fanout/shellCmd");
    expect(join.atReason).toBe("reached, not settled yet");
  });

  it("has no playhead at all before anything settles — nothing is 'in flight' on evidence-free", () => {
    const join = joinRun(probe, [], null);
    expect(join.at).toBeNull();
    expect(join.byNode.size).toBe(0);
  });

  it("never puts the playhead on a compensation step", () => {
    // Every main-track step settled; the only thing after them is `Rollback`,
    // which is an onFailure phase, so there is no next main-track position.
    const join = joinRun(probe, streamRecords, null);
    expect(join.at).toBeNull();
  });

  it("a named pending gate wins the position outright — it is the one confirmed one", () => {
    const gated = JSON.parse(read("../ops-example-writes/prod-promote.op.json")) as OpIr;
    const gate = { signalName: "approve-promote", description: "Approve the prod promotion", since: "2026-08-29T18:00:12.000Z" };
    const join = joinRun(gated, steps([{ phase: "Plan", fn: "lifecycleDiff", status: "ok", durationMs: 900 }]), gate);
    expect(join.at).toBe("prod-promote/Approve/gate:approve-promote");
    expect(join.atReason).toBe("waiting for approve-promote since 2026-08-29T18:00:12.000Z");
  });

  it("an effect card absorbs its receipt reads/writes and nested steps, worst status winning", () => {
    // Hand-built: no Op in this repo declares an effect. The shape is
    // chant#1834's, exactly as src/ops-lens.ts's OpIrEffectStep declares it,
    // and the synthesized `receiptRead`/`receiptWrite` step names are chant's
    // own (its temporal serializer; op-progress.ts duplicates the constants for
    // the same lexicon-free reason this module does).
    const withEffect: OpIr = {
      name: "eff",
      phases: [
        {
          name: "Converge",
          steps: [
            { kind: "effect", receipt: "bucket", steps: [{ kind: "activity", fn: "awsApply" }] },
            { kind: "activity", fn: "httpCheck" },
          ],
        },
      ],
    };
    const join = joinRun(
      withEffect,
      steps([
        { phase: "Converge", fn: "receiptRead", status: "ok", durationMs: 10 },
        { phase: "Converge", fn: "awsApply", status: "fail", durationMs: 200, error: "boom" },
        { phase: "Converge", fn: "receiptWrite", status: "ok", durationMs: 5 },
      ]),
      null,
    );
    expect(join.byNode.get("eff/Converge/effect:bucket")).toEqual({
      status: "failed",
      durationMs: 215,
      error: "boom",
      records: 3,
    });
    // A failure inside must not read green because the write after it succeeded.
    expect(join.byNode.get("eff/Converge/httpCheck")).toBeUndefined();
    expect(join.at).toBe("eff/Converge/httpCheck");
  });
});

// ── the paint ───────────────────────────────────────────────────────────────

describe("paintPlayhead", () => {
  const declared = opsToIr([probe]);

  it("returns the declared track untouched when there is no run data", () => {
    const join = joinRun(probe, [], null);
    expect(paintPlayhead(declared, join, null)).toBe(declared);
  });

  it("paints settled steps in the drift palette and leaves unreached ones declared", () => {
    const painted = paintPlayhead(declared, joinRun(probe, streamRecords, null), null);
    const by = new Map(painted.nodes.map((n) => [n.id, n.attrs]));
    expect(by.get("playhead-probe/Build/chantBuild")).toMatchObject({ _status: "good", run: "ok · 1.0s" });
    expect(by.get("playhead-probe/Verify/httpCheck")).toMatchObject({
      _status: "warn",
      run: "failed · 15.0s",
      error: "Command failed: exit 1\n",
    });
    // Never reached: still exactly as the lens declared it.
    const before = declared.nodes.find((n) => n.id === "playhead-probe/Never/httpCheck");
    const after = painted.nodes.find((n) => n.id === "playhead-probe/Never/httpCheck");
    expect(after).toEqual(before);
    expect(after?.attrs._status).toBe("neutral");
  });

  it("marks the playhead position accent and says it isn't settled", () => {
    const join = joinRun(probe, streamRecords.slice(0, 1), null);
    const painted = paintPlayhead(declared, join, null);
    const here = painted.nodes.find((n) => n.id === "playhead-probe/Deploy/shellCmd");
    expect(here?.attrs).toMatchObject({ _status: "accent", _playhead: true, run: "reached, not settled yet" });
  });

  it("a pending gate keeps `warn` and names who it waits on — a human decision, not a step in flight", () => {
    const gated = JSON.parse(read("../ops-example-writes/prod-promote.op.json")) as OpIr;
    const gate = { signalName: "approve-promote", description: "Approve the prod promotion", since: "2026-08-29T18:00:12.000Z" };
    const ir = opsToIr([gated]);
    const painted = paintPlayhead(ir, joinRun(gated, [], gate), gate);
    const card = painted.nodes.find((n) => n.id === "prod-promote/Approve/gate:approve-promote");
    expect(card?.attrs).toMatchObject({
      _status: "warn",
      _playhead: true,
      run: "waiting for approval since 2026-08-29T18:00:12.000Z",
      gateDescription: "Approve the prod promotion",
    });
  });

  it("does not mutate the IR it was given", () => {
    const snapshot = JSON.stringify(declared);
    paintPlayhead(declared, joinRun(probe, streamRecords, null), null);
    expect(JSON.stringify(declared)).toBe(snapshot);
  });
});

// ── `chant run status` ──────────────────────────────────────────────────────

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

describe("readRunStatus", () => {
  it("reads a pending gate off the Gate line (real chant 0.124 stdout, #459)", () => {
    const r = readRunStatus("gated-probe", ok(read("run-status-gate-pending.txt")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read).toMatchObject({
      op: "gated-probe",
      runtime: "local",
      runId: "local-1792192277209",
      status: "gated",
      startedAt: "2026-10-16 23:11:17",
      endedAt: "2026-10-16 23:11:17",
      gate: { signalName: "approve-probe", since: "2026-10-16T23:11:17.223Z" },
    });
  });

  it("reads no Gate line as no gate pending", () => {
    const r = readRunStatus("gated-probe", ok(read("run-status-no-gate.txt")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.gate).toBeNull();
    expect(r.read.status).toBe("completed");
  });

  it("refuses with no-run on chant's exit-0 'No run of Op … is recorded' (real chant stderr)", () => {
    const r = readRunStatus("never-ran", { code: 0, stdout: "", stderr: read("run-status-no-run.stderr.txt") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("no-run");
    expect(r.refusal.error).toContain('No run of Op "never-ran" is recorded on the "local" runtime.');
    expect(r.refusal.error).not.toContain("\u001b");
    expect(r.refusal.remedy).toContain("Start the Op");
  });

  it("surfaces chant's refusal of the removed flag verbatim, and never suggests it", () => {
    const r = readRunStatus("floci-apply", {
      code: 1,
      stdout: "",
      stderr: '\u001b[31merror\u001b[0m: Unknown flag: --temporal\nRun "chant --help" to see supported flags.\n',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("run-status");
    expect(r.refusal.error).toBe("chant run status floci-apply failed: Unknown flag: --temporal");
    expect(r.refusal.remedy).toBe("Run `chant run status floci-apply` in the project to see the whole error.");
  });

  it("surfaces anything else verbatim rather than guessing at it", () => {
    const r = readRunStatus("x", { code: 1, stdout: "", stderr: "error: connection refused: 127.0.0.1:7233" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe("run-status");
    expect(r.refusal.error).toContain("connection refused: 127.0.0.1:7233");
  });

  it("strips the ANSI chant writes when its stdout isn't a TTY", () => {
    const r = readRunStatus("prod-promote", ok(read("run-status-gate-pending.txt")));
    expect(r.ok && JSON.stringify(r.read)).not.toContain("\u001b");
  });
});

describe("parseGateLine", () => {
  it("reads a gate with no description", () => {
    expect(parseGateLine("approve-probe (pending since 2026-10-16T23:11:17.223Z)")).toEqual({
      signalName: "approve-probe",
      since: "2026-10-16T23:11:17.223Z",
    });
  });

  it("still reads the pre-chant#2121 spelling, with its description", () => {
    expect(parseGateLine("approve-promote — Approve the prod promotion (waiting since 2026-08-29T18:00:12.000Z)")).toEqual({
      signalName: "approve-promote",
      description: "Approve the prod promotion",
      since: "2026-08-29T18:00:12.000Z",
    });
  });

  it("yields nothing rather than half a gate — a card naming the wrong signal sends the wrong approval", () => {
    expect(parseGateLine("approve-promote")).toBeNull();
    expect(parseGateLine("")).toBeNull();
    expect(parseGateLine(" (waiting since now)")).toBeNull();
  });
});

// ── the reducer ─────────────────────────────────────────────────────────────

const AT = "2026-08-29T18:00:00.000Z";
const AT2 = "2026-08-29T18:05:00.000Z";

describe("the run state", () => {
  it("starts blank and clears the previous run's terminal state", () => {
    expect(initialRunState.status).toBe("idle");
    const done = runEnded(legacyStarted("a", AT), 0, AT2);
    expect(runStarted("b", "local", AT2)).toMatchObject({ op: "b", status: "running", steps: [], gate: null, source: "events" });
    expect(done.status).toBe("ok");
  });

  it("on the older stream, a clean exit is the only thing that reads as completion", () => {
    let s = legacyStarted("playhead-probe", AT);
    for (const r of streamRecords) s = runRecord(s, r);
    expect(runEnded(s, 0, AT2).status).toBe("ok");
  });

  it("a non-zero exit with a failed step in the stream reads as failed — the stream said so", () => {
    let s = legacyStarted("playhead-probe", AT);
    for (const r of streamRecords) s = runRecord(s, r);
    const ended = runEnded(s, 1, AT2);
    expect(ended.status).toBe("failed");
    expect(ended.lost).toBeNull();
  });

  it("a stream that dies mid-run is `lost`, frozen at last-settled, never completion", () => {
    let s = legacyStarted("playhead-probe", AT);
    for (const r of streamRecords.slice(0, 3)) s = runRecord(s, r);
    const ended = runEnded(s, 137, AT2);
    expect(ended.status).toBe("lost");
    expect(ended.steps).toHaveLength(3);
    expect(ended.lost).toContain("3 settled steps");
    expect(ended.lost).toContain("does not know");
    // The join off that state still stops where the records stopped.
    expect(joinRun(probe, ended.steps, null).byNode.size).toBe(3);
  });

  it("an outright dead stream carries the caller's reason", () => {
    const s = runLost(runStarted("a", "local", AT), "the chant process was killed", AT2);
    expect(s).toMatchObject({ status: "lost", lost: "the chant process was killed" });
    // And a run that already ended isn't re-labelled by a late signal.
    expect(runLost(runEnded(legacyStarted("a", AT), 0, AT2), "late", AT2).status).toBe("ok");
  });

  it("folds a gate answer, and a refusal's reason instead of a silent 'no gate'", () => {
    const s = runStarted("gated-probe", "local", AT);
    const withGate = runGate(s, readRunStatus("gated-probe", ok(read("run-status-gate-pending.txt"))));
    expect(withGate.gate?.signalName).toBe("approve-probe");
    const refused = runGate(s, readRunStatus("gated-probe", { code: 1, stdout: "", stderr: read("run-status-local-mode.txt") }));
    expect(refused.gate).toBeNull();
    expect(refused.gateNote).toContain("not available in local mode");
  });

  it("reads chant's exit 3 as gated, not lost, and folds the real gated stream (#459)", () => {
    let s = legacyStarted("gated-probe", AT);
    for (const line of read("gated-probe.progress.ndjson").trim().split("\n")) {
      for (const r of parseRunProgressLine(line) ?? []) s = runRecord(s, r);
    }
    expect(s.steps.map((r) => `${r.phase} ${r.step} ${r.state}`)).toEqual([
      "Before shellCmd ok",
      "Approve gate:approve-probe skipped",
    ]);
    const ended = runEnded(s, GATED_EXIT_CODE, AT2);
    expect(ended).toMatchObject({ status: "gated", endedAt: AT2, lost: null });
    expect(playheadNote(ended, null)).toContain("stopped at a gate");
    // A failed step outranks the exit code: a run that failed is not "gated".
    expect(runEnded(runRecord(s, step({ phase: "X", fn: "y", status: "fail", durationMs: 1 })), GATED_EXIT_CODE, AT2).status).toBe("failed");
  });
});

// ── the sentence and the card ───────────────────────────────────────────────

describe("playheadNote", () => {
  it("says plainly that nothing has run", () => {
    expect(playheadNote(initialRunState, null)).toContain("No run state");
  });

  it("never says 'finished' about a lost stream", () => {
    let s = legacyStarted("playhead-probe", AT);
    for (const r of streamRecords.slice(0, 2)) s = runRecord(s, r);
    const note = playheadNote(runEnded(s, 9, AT2), joinRun(probe, s.steps, null));
    expect(note).toContain("stream lost");
    expect(note).not.toMatch(/complete|finished/i);
  });

  it("names the gate and says who does the approving", () => {
    let s = runStarted("gated-probe", "local", AT);
    s = runGate(s, readRunStatus("gated-probe", ok(read("run-status-gate-pending.txt"))));
    const note = playheadNote(s, null);
    expect(note).toContain("waiting on gate approve-probe");
    expect(note).toContain("chant run approve");
    expect(note).toContain("behold never approves on its own");
  });

  it("says when the gate could not be asked at all", () => {
    let s = runStarted("playhead-probe", "local", AT);
    s = runGate(s, readRunStatus("playhead-probe", { code: 1, stdout: "", stderr: read("run-status-no-client.txt") }));
    expect(playheadNote(s, null)).toContain("gate state unavailable");
  });

  it("owns up to steps it could not place", () => {
    let s = legacyStarted("playhead-probe", AT);
    for (const r of streamRecords) s = runRecord(s, r);
    const note = playheadNote(runEnded(s, 1, AT2), joinRun(probe, streamRecords, null));
    expect(note).toContain("1 step matched no declared step");
  });

  it("names where the run state came from: chant's run events, or the older stream in degraded mode (#679)", () => {
    expect(playheadNote(runStarted("floci-apply", "local", AT), null)).toContain("from chant's run events");
    const old = runStarted("floci-apply", "local", AT, "progress", "degraded: this project's chant (0.124.24) is older than 0.124.28");
    expect(playheadNote(old, null)).toContain("older progress stream (degraded)");
    expect(playheadNote(old, null)).toContain("degraded: this project's chant (0.124.24)");
  });

  it("doesn't count zero steps as a watched run when only the gate query answered", () => {
    // The `noteGate`-adopted case: a run behold didn't start, so there are no
    // records to have missed — and the note must not read as "0 steps settled".
    const adopted = runGate(
      { ...initialRunState, op: "gated-probe", mode: "local" },
      readRunStatus("gated-probe", ok(read("run-status-gate-pending.txt"))),
    );
    const note = playheadNote(adopted, null);
    expect(note).toContain("didn't start the run");
    expect(note).toContain("waiting on gate approve-probe");
    expect(note).not.toContain("0 steps settled");
  });
});

describe("pendingGateCard", () => {
  const gated = JSON.parse(read("../ops-example-writes/prod-promote.op.json")) as OpIr;
  const gate = { signalName: "approve-promote", description: "Approve the prod promotion", since: "2026-08-29T18:00:12.000Z" };

  it("is #234's shape, and its approve is the EXISTING delegated op-signal write", () => {
    expect(pendingGateCard("prod-promote", gate, opsToIr([gated]))).toEqual({
      op: "prod-promote",
      signalName: "approve-promote",
      description: "Approve the prod promotion",
      since: "2026-08-29T18:00:12.000Z",
      node: "prod-promote/Approve/gate:approve-promote",
      guards: "awsApply",
      approve: { method: "POST", path: "/api/ops/prod-promote/signal/approve-promote" },
    });
  });

  it("still renders a gate the declared track doesn't know about — the run is the authority", () => {
    const card = pendingGateCard("prod-promote", { signalName: "approve-other", since: "x" }, opsToIr([gated]));
    expect(card.node).toBeUndefined();
    expect(card.approve.path).toBe("/api/ops/prod-promote/signal/approve-other");
  });

  it("escapes names into the signal path", () => {
    const card = pendingGateCard("a b", { signalName: "c/d", since: "x" }, { nodes: [], edges: [], groups: {} });
    expect(card.approve.path).toBe("/api/ops/a%20b/signal/c%2Fd");
  });
});
