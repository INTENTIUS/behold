/**
 * A chant pull-request stage's run events (chant#4007, run-event/v1), read
 * while the stage runs: what `pr-plan` and `pr-apply` stream under
 * `--events-json` and, from chant 0.124.29 (chant#4083), upload under
 * `--report-url` after every wave-settle, component-settle and run-settle
 * (`pr-<stage>.events.jsonl`, overwritten each time, then a final upload).
 *
 * Folded here into per-wave and per-component state, so the components view
 * can show waves landing instead of one "running" for the whole merge.
 *
 * What the stream says, and what is worked out:
 *
 * - `run-start.waves`: every component the stage will attempt, by wave.
 * - `wave-start.components`: the components the wave dispatches. A
 *   component of the wave missing from it was skipped because something it
 *   depends on failed (chant's fan-out blocks a failed component's
 *   dependents and nothing else).
 * - `component-settle.status`: ok, failed, gated or waiting; from 0.124.29
 *   also `blocked` (with `blockedBy`), right after the wave whose failure
 *   held it back, and `already-applied` (a resume's skip), after run-start
 *   and before the first wave. Neither has a component-start. An
 *   already-applied settle's `wave` is the one it had in the earlier
 *   attempt, which a resumed fan-out may have re-layered, so a component is
 *   placed by name: in run-start's waves, else the components graph's
 *   (`componentWaves`), never by that number. When they are absent, a component
 *   that never started is blocked once its wave started without it or the
 *   run settled, and its blocker is the failed component its dependencies
 *   lead back to (`dependsOn`, from the components graph's edges); without
 *   the edges the blocker stays unnamed.
 * - The error a failed component shows: `component-settle.error` when chant
 *   writes one, else its last failed step's `error`.
 *
 * Each line crosses the same boundary as every run event behold reads
 * (src/run-events.ts `readRunLine`, chant's schema, vendored with the two
 * additive statuses). A refused line is counted and left out.
 *
 * Pure: no reads. The reader (src/chant-pr.ts) fetches the object.
 */
import { readRunLine, RUN_EVENT_SCHEMA_ID } from "./run-events.ts";

/** The run-event contract chant writes (`run-event.schema.json`, `$id`). */
export const RUN_EVENT_SCHEMA: string = RUN_EVENT_SCHEMA_ID;

/**
 * A stage's file under `--report-url` (chant#4083, chant's `reportKey`):
 * `<pr>/<commit>[/<member>]/<file>`, `<pr>` being `unknown` when chant found
 * no pull request, and `<member>` a workspace member's loop (`--member`).
 */
export function chantReportKey(pr: number | null, commit: string, file: string, member?: string): string {
  return [pr === null ? "unknown" : String(pr), commit, ...(member ? [member] : []), file].join("/");
}
/** A stage's events file: one per stage, since a fast-forward merge runs both on one commit. */
export const eventsFileOf = (stage: "plan" | "apply"): string => `pr-${stage}.events.jsonl`;

/** A component's state in the stage, as far as the events say. */
export type PrLiveState =
  /** In the run, not started yet. */
  | "waiting"
  /** Planning (a `plan` phase step running). */
  | "planning"
  /** Planned; in pr-apply, waiting for its wave. */
  | "planned"
  /** Its deploy composition is running. */
  | "running"
  | "applied"
  | "failed"
  /** Never ran: something it depends on failed. */
  | "blocked"
  /** A resume skipped it: an earlier attempt applied it. */
  | "already-applied"
  /** Stopped at a gate of its own, or a decision point. */
  | "gated"
  /** The run settled before it started, with nothing it depends on failing (a refusal, or a stop the events don't explain). */
  | "not-run";

export interface PrLiveComponent {
  component: string;
  /** Its wave in run-start's waves; for a component run-start does not list (a resume's already-applied), the graph's (`waveFrom: "graph"`). */
  wave: number | null;
  waveFrom?: "graph";
  /** Its wave in the components graph, when the reader was given the graph's waves: the number its box shows. */
  graphWave?: number;
  state: PrLiveState;
  /** Failed: what failed, from the event. */
  error?: string;
  /** In `plan` when it failed to plan, else in its deploy. */
  failedIn?: "plan" | "apply";
  /** Blocked: the failed component it waits on, when known. */
  blockedBy?: string;
  /** Where blockedBy came from: chant's own `blocked` status, or behold's walk of the graph's edges. */
  blockedFrom?: "event" | "graph";
  startedAt?: string;
  settledAt?: string;
}

export type PrLiveWaveState = "waiting" | "running" | "applied" | "failed" | "gated" | "blocked" | "not-run";

export interface PrLiveWave {
  wave: number;
  state: PrLiveWaveState;
  components: string[];
  /** How many of its components ended each way, for the box's words. */
  counts: { applied: number; failed: number; blocked: number; alreadyApplied: number; running: number; waiting: number };
}

export interface PrLive {
  stage: "plan" | "apply";
  contract: "run-event/v1";
  /** The object or file it was read from. */
  source: string;
  runId: string | null;
  chant: string | null;
  gitSha: string | null;
  /** The last event's seq and time. */
  seq: number;
  at: string | null;
  /** Whether run-settle arrived. */
  settled: boolean;
  /** run-settle's status, once settled. */
  status: "ok" | "failed" | "gated" | "waiting" | null;
  error?: string;
  /** The gate phase, when the stream reached it. */
  gate?: { state: "waiting" | "resolved"; by?: string; message?: string };
  /** run-start's waves, numbered as run-start numbers them (on a resume, re-layered over what is left; not the graph's numbers). */
  waves: PrLiveWave[];
  components: Record<string, PrLiveComponent>;
  /** Lines that named the run-event schema and failed it, left out; the first one's reason. */
  refused?: { lines: number; reason?: string };
  /**
   * Every change of a component's or a wave's state, in stream order, so a
   * viewer can play a run that settled faster than it was read (the kiosk's
   * pacing, web/chant-live-pace.js). Only states the events gave; the
   * blocks worked out once the run settled come last, at its final seq.
   */
  timeline: PrLiveStep[];
}

export interface PrLiveStep {
  seq: number;
  at: string | null;
  kind: "component" | "wave";
  /** The component's name, for a component's step. */
  component?: string;
  /** The wave, in run-start's numbering: a wave's own, or the component's when it has one. */
  wave: number | null;
  state: PrLiveState | PrLiveWaveState;
}

type Ev = Record<string, unknown> & { type: string };

/** The events in a JSON Lines text, in seq order, and the lines refused at the schema (a torn last line is not JSON, and is skipped). */
export function parseRunEvents(text: string): { events: Ev[]; refused: number; reason?: string } {
  const events: Ev[] = [];
  let refused = 0;
  let reason: string | undefined;
  for (const line of text.split("\n")) {
    const r = readRunLine(line);
    if (!r) continue;
    if (r.kind === "event") {
      events.push(r.event as unknown as Ev);
      continue;
    }
    if (r.kind === "refused") {
      refused++;
      reason ??= r.reason;
    }
  }
  // seq orders them, in case an upload was stitched.
  events.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  return { events, refused, ...(reason ? { reason } : {}) };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const PLAN_PHASE = "plan";

/**
 * The failed component `name`'s dependencies lead back to, or undefined:
 * a failed dependency itself, else a blocked one's blocker, the nearest
 * first, as chant blames the root rather than the nearest edge.
 */
export function blockerOf(name: string, dependsOn: Record<string, readonly string[]> | undefined, comps: Record<string, PrLiveComponent>): string | undefined {
  if (!dependsOn) return undefined;
  const seen = new Set<string>();
  const walk = (n: string): string | undefined => {
    for (const d of dependsOn[n] ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      const c = comps[d];
      if (c && c.state === "failed") return d;
      if (c && c.state === "blocked" && c.blockedBy) return c.blockedBy;
      const up = walk(d);
      if (up) return up;
    }
    return undefined;
  };
  return walk(name);
}

/**
 * Fold one stage's events. `dependsOn` is component -> the components it
 * depends on (the components graph's edges), used only when chant's events
 * carry no `blocked` status.
 */
export function foldPrEvents(
  events: readonly Ev[],
  opts: { stage: "plan" | "apply"; source: string; dependsOn?: Record<string, readonly string[]>; componentWaves?: Record<string, number> },
): PrLive | null {
  if (!events.length) return null;
  const first = events[0]!;
  const live: PrLive = {
    stage: opts.stage,
    contract: "run-event/v1",
    source: opts.source,
    runId: str(first.runId) ?? null,
    chant: str(first.chant) ?? null,
    gitSha: str(first.gitSha) ?? null,
    seq: 0,
    at: null,
    settled: false,
    status: null,
    waves: [],
    components: {},
    timeline: [],
  };
  const comps = live.components;
  const waveOf = new Map<number, { state: PrLiveWaveState; components: string[]; started: Set<string> | null }>();
  const comp = (name: string, wave: number | null): PrLiveComponent => {
    let c = comps[name];
    if (!c) c = comps[name] = { component: name, wave, state: "waiting" };
    if (c.wave === null && wave !== null) c.wave = wave;
    return c;
  };
  const wave = (n: number) => {
    let w = waveOf.get(n);
    if (!w) waveOf.set(n, (w = { state: "waiting", components: [], started: null }));
    return w;
  };
  /**
   * A component by name: its wave in run-start, else the graph's. A
   * component run-start does not list joins none of `waves`, which number
   * run-start's (re-layered on a resume) waves, not the graph's.
   */
  const place = (name: string): PrLiveComponent => {
    for (const [n, w] of waveOf) if (w.components.includes(name)) return comp(name, n);
    const g = opts.componentWaves?.[name];
    const c = comp(name, null);
    if (c.wave === null && typeof g === "number" && Number.isInteger(g)) {
      c.wave = g;
      c.waveFrom = "graph";
    }
    return c;
  };
  /** Errors from failed steps, by component, for a settle that carries none. */
  const stepError = new Map<string, { error: string; phase: string }>();
  const notStarted = (c: PrLiveComponent) => c.state === "waiting" || c.state === "planned" || c.state === "planning";
  const block = (c: PrLiveComponent, by?: string, from: "event" | "graph" = "graph") => {
    c.state = "blocked";
    if (by) {
      c.blockedBy = by;
      c.blockedFrom = from;
    }
  };

  // The timeline: what each event changed, recorded after it.
  const lastComp = new Map<string, PrLiveState>();
  const lastWave = new Map<number, PrLiveWaveState>();
  const record = (seq: number, at: string | null) => {
    for (const c of Object.values(comps)) {
      if (lastComp.get(c.component) === c.state) continue;
      lastComp.set(c.component, c.state);
      live.timeline.push({ seq, at, kind: "component", component: c.component, wave: c.wave, state: c.state });
    }
    for (const [n, w] of waveOf) {
      if (lastWave.get(n) === w.state) continue;
      lastWave.set(n, w.state);
      live.timeline.push({ seq, at, kind: "wave", wave: n, state: w.state });
    }
  };
  for (const e of events) {
    live.seq = Number(e.seq) || live.seq;
    live.at = str(e.at) ?? live.at;
    switch (e.type) {
      case "run-start": {
        const ws = Array.isArray(e.waves) ? (e.waves as unknown[]) : [];
        ws.forEach((names, i) => {
          if (!Array.isArray(names)) return;
          const w = wave(i + 1);
          for (const n of names) {
            if (typeof n !== "string") continue;
            if (!w.components.includes(n)) w.components.push(n);
            comp(n, i + 1);
          }
        });
        break;
      }
      case "wave-start": {
        const n = Number(e.wave);
        const w = wave(n);
        w.state = "running";
        const dispatched = Array.isArray(e.components) ? (e.components as unknown[]).filter((x): x is string => typeof x === "string") : [];
        w.started = new Set(dispatched);
        for (const d of dispatched) {
          if (!w.components.includes(d)) w.components.push(d);
          comp(d, n);
        }
        // This wave's components it left out, and any earlier wave's still
        // waiting (a wave whose every component was blocked emits nothing),
        // were skipped: blocked.
        for (const [k, other] of waveOf) {
          if (k > n) continue;
          for (const name of other.components) {
            const c = comps[name];
            if (c && notStarted(c) && !(k === n && dispatched.includes(name))) block(c);
          }
        }
        break;
      }
      case "component-start": {
        const c = comp(String(e.component), Number(e.wave) || null);
        c.state = "running";
        c.startedAt = str(e.at);
        break;
      }
      case "component-settle": {
        const s0 = String(e.status);
        // blocked and already-applied have no component-start, and an
        // already-applied wave is the earlier attempt's: placed by name.
        const c = s0 === "blocked" || s0 === "already-applied" ? place(String(e.component)) : comp(String(e.component), Number(e.wave) || null);
        c.settledAt = str(e.at);
        const s = String(e.status);
        // What chant says settles it, over a block behold inferred.
        if (s !== "blocked") {
          delete c.blockedBy;
          delete c.blockedFrom;
        }
        if (s === "ok") c.state = "applied";
        else if (s === "failed") {
          c.state = "failed";
          c.failedIn = "apply";
          const err = str(e.error) ?? stepError.get(c.component)?.error;
          if (err) c.error = err;
        } else if (s === "blocked") block(c, str(e.blockedBy), "event");
        else if (s === "already-applied") c.state = "already-applied";
        else if (s === "gated" || s === "waiting") c.state = "gated";
        break;
      }
      case "wave-settle": {
        const w = wave(Number(e.wave));
        const s = String(e.status);
        w.state = s === "ok" ? "applied" : s === "failed" ? "failed" : "gated";
        break;
      }
      case "step-start": {
        if (e.phase === PLAN_PHASE && typeof e.component === "string") {
          const c = comp(e.component, null);
          if (c.state === "waiting") c.state = "planning";
        }
        break;
      }
      case "step-settle": {
        const name = typeof e.component === "string" ? e.component : null;
        if (!name) break;
        if (e.status === "failed") stepError.set(name, { error: str(e.error) ?? "", phase: String(e.phase) });
        if (e.phase === PLAN_PHASE) {
          const c = comp(name, null);
          if (e.status === "failed") {
            c.state = "failed";
            c.failedIn = "plan";
            if (str(e.error)) c.error = str(e.error);
          } else if (e.status === "ok" && c.state === "planning") c.state = "planned";
        }
        break;
      }
      case "gate-waiting": {
        if (e.component === null) live.gate = { state: "waiting", ...(str(e.message) ? { message: str(e.message)! } : {}) };
        break;
      }
      case "gate-resolved": {
        if (e.component === null) live.gate = { state: "resolved", ...(str(e.resolvedBy) ? { by: str(e.resolvedBy)! } : {}) };
        break;
      }
      case "run-settle": {
        live.settled = true;
        const s = String(e.status);
        live.status = s === "ok" || s === "failed" || s === "gated" || s === "waiting" ? s : null;
        if (str(e.error)) live.error = str(e.error);
        break;
      }
    }
    record(Number(e.seq) || 0, str(e.at) ?? null);
  }

  // A failure with no error of its own takes its last failed step's, once all are read.
  for (const c of Object.values(comps)) {
    if (c.state === "failed" && !c.error) {
      const se = stepError.get(c.component);
      if (se && se.error) c.error = se.error;
    }
  }

  // Once the run settled, what never started was blocked when a dependency
  // failed, else it simply did not run. Walk the waves in order, so a
  // blocked dependency's blocker is known before its dependents'.
  const ordered = [...waveOf.entries()].sort(([a], [b]) => a - b);
  for (const [, w] of ordered) {
    for (const name of w.components) {
      const c = comps[name];
      if (!c) continue;
      if (c.state === "blocked" && !c.blockedBy) {
        const by = blockerOf(name, opts.dependsOn, comps);
        if (by) {
          c.blockedBy = by;
          c.blockedFrom = "graph";
        }
      } else if (live.settled && notStarted(c) && opts.stage === "apply") {
        const by = blockerOf(name, opts.dependsOn, comps);
        if (by) block(c, by);
        else if (live.status === "failed" && !opts.dependsOn && Object.values(comps).some((x) => x.state === "failed")) block(c);
        else c.state = "not-run";
      }
    }
  }
  // Components the stream named outside any wave (a plan-phase step only) join no wave.

  for (const [n, w] of ordered) {
    const counts = { applied: 0, failed: 0, blocked: 0, alreadyApplied: 0, running: 0, waiting: 0 };
    for (const name of w.components) {
      const s = comps[name]?.state;
      if (s === "applied") counts.applied++;
      else if (s === "failed") counts.failed++;
      else if (s === "blocked") counts.blocked++;
      else if (s === "already-applied") counts.alreadyApplied++;
      else if (s === "running") counts.running++;
      else if (s !== "gated" && s !== "not-run") counts.waiting++;
    }
    let state = w.state;
    // A wave chant never started: every component blocked, or each already applied on a resume.
    if (state === "waiting" && w.components.length) {
      if (counts.blocked === w.components.length) state = "blocked";
      else if (counts.alreadyApplied + counts.applied === w.components.length) state = "applied";
      else if (counts.blocked + counts.alreadyApplied === w.components.length) state = "blocked";
      else if (live.settled && opts.stage === "apply") state = "not-run";
    }
    live.waves.push({ wave: n, state, components: [...w.components], counts });
  }
  // What the settle worked out (a block, a run that never reached a component), at the last seq.
  record(live.seq, live.at);
  if (opts.componentWaves) {
    for (const c of Object.values(comps)) {
      const g = opts.componentWaves[c.component];
      if (typeof g === "number") c.graphWave = g;
    }
  }
  return live;
}

/** The text of a `pr-<stage>.events.jsonl` folded, or null when it holds no run event. */
export function readPrLive(text: string | undefined, opts: Parameters<typeof foldPrEvents>[1]): PrLive | null {
  if (!text) return null;
  const p = parseRunEvents(text);
  const live = foldPrEvents(p.events, opts);
  if (live && p.refused) live.refused = { lines: p.refused, ...(p.reason ? { reason: p.reason } : {}) };
  return live;
}
