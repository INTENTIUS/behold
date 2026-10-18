/**
 * A chant pull-request stage's run events (chant#4007, run-event/v1), read
 * while the stage runs: what `pr-plan` and `pr-apply` stream under
 * `--events-json` and, from chant 0.124.29, upload under `--report-url`
 * after every wave-settle, component-settle and run-settle (one
 * `events.jsonl`, overwritten each time, then a final upload).
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
 *   also `blocked` (with `blockedBy`) and `already-applied` (a resume's
 *   skip). Both are read when present. When they are absent, a component
 *   that never started is blocked once its wave started without it or the
 *   run settled, and its blocker is the failed component its dependencies
 *   lead back to (`dependsOn`, from the components graph's edges); without
 *   the edges the blocker stays unnamed.
 * - The error a failed component shows: `component-settle.error` when chant
 *   writes one, else its last failed step's `error`.
 *
 * Each line crosses the same boundary as every run event behold reads
 * (src/run-events.ts `readRunLine`, chant's schema). The one exception is a
 * component-settle whose status is one of 0.124.29's two additive ones,
 * which the vendored 0.124.28 schema's closed set refuses: it is read, and
 * any other refused line is counted and left out.
 *
 * Pure: no reads. The reader (src/chant-pr.ts) fetches the object.
 */
import { readRunLine, RUN_EVENT_CONTRACT, RUN_EVENT_SCHEMA_ID } from "./run-events.ts";

/** The run-event contract chant writes (`run-event.schema.json`, `$id`). */
export const RUN_EVENT_SCHEMA: string = RUN_EVENT_SCHEMA_ID;
/** component-settle statuses chant 0.124.29 adds within contract 1 (chant#4007). */
export const ADDITIVE_SETTLE = new Set(["blocked", "already-applied"]);

/** Where the stage uploads its events under `--report-url`: `<url>/<pr>/<commit>/<file>`. One place, since chant has not fixed the keys yet. */
export function chantReportKey(pr: number, commit: string, file: string): string {
  return `${pr}/${commit}/${file}`;
}
/** The events file's name under the stage's key. */
export const EVENTS_FILE = "events.jsonl";

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
  wave: number | null;
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
  waves: PrLiveWave[];
  components: Record<string, PrLiveComponent>;
  /** Lines that named the run-event schema and failed it, left out; the first one's reason. */
  refused?: { lines: number; reason?: string };
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
      let o: Ev | null = null;
      try {
        o = JSON.parse(line.trim()) as Ev;
      } catch {
        o = null;
      }
      if (o && o.type === "component-settle" && o.contract === RUN_EVENT_CONTRACT && ADDITIVE_SETTLE.has(String(o.status))) {
        events.push(o);
        continue;
      }
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
export function foldPrEvents(events: readonly Ev[], opts: { stage: "plan" | "apply"; source: string; dependsOn?: Record<string, readonly string[]> }): PrLive | null {
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
        const c = comp(String(e.component), Number(e.wave) || null);
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
  return live;
}

/** The text of an events.jsonl folded, or null when it holds no run event. */
export function readPrLive(text: string | undefined, opts: Parameters<typeof foldPrEvents>[1]): PrLive | null {
  if (!text) return null;
  const p = parseRunEvents(text);
  const live = foldPrEvents(p.events, opts);
  if (live && p.refused) live.refused = { lines: p.refused, ...(p.reason ? { reason: p.reason } : {}) };
  return live;
}
