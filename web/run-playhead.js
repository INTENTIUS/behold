/**
 * The run playhead's panel (#284 item 2) — the SPA half of src/run-playhead.ts.
 *
 * Same discipline as web/carve-steps.js, web/json-view.js and
 * web/layout-store.js: everything this panel DECIDES is a pure function that
 * takes data and returns data, unit-tested next door in run-playhead.test.js;
 * the DOM half at the bottom is smoke/ui-smoke.mjs's job. The fetches, the SSE
 * subscription and the graph re-pull all stay in app.js.
 *
 * What it renders, from the `runState` the server broadcasts:
 *  - one honest verdict line — and there is deliberately no wording for
 *    "probably finished". A stream that died says so.
 *  - the pending gate as a first-class card (#234): who is waiting, since when,
 *    what it holds back, and an Approve button that POSTs the EXISTING
 *    op-signal route. behold never signals on its own initiative.
 *  - the run's steps as chant's run events report them (#679): running,
 *    then how each settled (ok, failed, skipped with chant's reason, cached,
 *    gated, waiting), in the order they started.
 *  - where the steps came from, so a degraded run (a chant older than the
 *    run-events floor) says so.
 */

/** Settled-step tones, in the same token vocabulary the apply progress panel
 * uses (`APPLY_STATUS_COLOR` in app.js) so "green means it worked" reads the
 * same everywhere. */
import { barVarFor } from "./theme.js";

export const RUN_STEP_COLOR = {
  running: "var(--pending)",
  ok: "var(--managed)",
  cached: "var(--managed)",
  failed: "var(--degraded)",
  gated: "var(--pending)",
  waiting: "var(--pending)",
  skipped: "var(--muted)",
};

/** How the run as a whole reads. `lost` is its own tone, not a shade of
 * failure: behold does not know what happened, which is a different statement
 * from "it failed". */
export const RUN_STATUS_COLOR = {
  idle: "var(--muted)",
  running: "var(--pending)",
  ok: "var(--managed)",
  failed: "var(--degraded)",
  gated: "var(--pending)",
  waiting: "var(--pending)",
  lost: "var(--foreign)",
};

/** `1062` is `1.1s`. */
export function took(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * How long a gate has been waiting, from its ISO `since`. Coarse on purpose —
 * an approval that has been pending "3h" is the fact; the second it started
 * is on the card as the raw instant.
 */
export function waitingFor(since, now = Date.now()) {
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * The one-line verdict, or null when there is nothing to say at all.
 *
 * Every branch states what behold KNOWS. `lost` never borrows the word
 * "finished", and an adopted run (the gate query answered for a run this
 * session didn't start) doesn't claim zero settled steps as if it had watched.
 */
export function runVerdict(run) {
  if (!run || !run.op) return null;
  const n = (run.steps || []).filter((s) => s.state !== "running").length;
  const settled = `${n} step${n === 1 ? "" : "s"} settled`;
  if (run.status === "idle") {
    return { text: `${run.op}: no per-step events; this session didn't start the run`, tone: "idle" };
  }
  if (run.status === "running") {
    return {
      text: `${run.op}: ${run.following ? "running (followed)" : "running"}, ${settled}`,
      tone: "running",
    };
  }
  if (run.status === "ok") return { text: `${run.op}: settled ok, ${settled}`, tone: "ok" };
  if (run.status === "failed") return { text: `${run.op}: a step failed, ${settled}`, tone: "failed" };
  if (run.status === "gated") return { text: `${run.op}: stopped at a gate, ${settled}; approve it, then run the Op again`, tone: "gated" };
  if (run.status === "waiting") return { text: `${run.op}: waiting on a decision point, ${settled}; answer it, then run the Op again`, tone: "waiting" };
  return { text: `${run.op}: stream lost, frozen at ${settled}`, tone: "lost" };
}

/**
 * How one step reads in its row: `running`, a duration, `skipped (receipt)`,
 * `cached`, `gated`, `waiting`. chant's skip reasons are said in words a
 * person reads, with chant's own term kept in brackets.
 */
export const SKIP_WORDS = {
  receipt: "already applied (receipt)",
  resumed: "carried from an earlier run (resumed)",
  refused: "refused (refused)",
  "not-run": "not run: an earlier step stopped the run (not-run)",
};
export function stepTook(s) {
  if (s.state === "running") return "running";
  if (s.state === "skipped") return s.skip ? `skipped: ${SKIP_WORDS[s.skip] || s.skip}` : "skipped";
  if (s.state === "cached" || s.state === "gated" || s.state === "waiting") return s.state;
  return typeof s.durationMs === "number" ? took(s.durationMs) : s.state;
}

/** The run's steps, in the order they started (or settled), as rows. */
export function stepRows(run) {
  return (run?.steps || []).map((s) => ({
    label: `${s.component ? `${s.component} · ` : ""}${s.phase} · ${s.step}`,
    status: s.state,
    took: stepTook(s),
    error: s.error || s.message || null,
    approvedBy: s.approvedBy || null,
  }));
}

/**
 * Where a run's progress came from, as one line beside it (#679), or null
 * when there is nothing to qualify. `source` is the server's: `events`
 * (chant's run events), `progress` (an older chant, degraded), `classifier`
 * (a pipeline chant did not run, read from its log), `forge` (a forge's own
 * job states). `note` is the server's own reason when it gave one.
 */
export function sourceLabel(source, note) {
  if (source === "events") return { text: "from chant's run events", tone: "ok" };
  if (source === "progress") return { text: note || "degraded: an older chant's progress stream, with no step starts, skip reasons, cache hits or gate events", tone: "lost" };
  if (source === "classifier") {
    return { text: "best-effort: chant did not run this pipeline, so its steps are read from the runner's log; only the exit code is certain", tone: "lost" };
  }
  if (source === "forge") return { text: "job states from the forge, not chant's run events", tone: "idle" };
  return note ? { text: note, tone: "idle" } : null;
}

/**
 * One component's chip on the dial (#679): its name, the step it is on and
 * how that step stands, then the component's own state. `c` is the server's
 * ApplyComponentState (src/apply.ts).
 */
export function applyChipText(name, c) {
  const where = [c.phase, c.step].filter(Boolean).join(" · ");
  const how = c.stepState ? stepTook({ state: c.stepState, skip: c.skip, durationMs: null }) : null;
  const detail = where ? ` · ${where}${how && how !== c.status ? ` ${how}` : ""}` : "";
  return `${name}${detail} (${c.status})`;
}

/** What a component run waits on, from chant's `gate-waiting`, or null. */
export function waitingLine(w) {
  if (!w) return null;
  const on = w.gate ? `gate ${w.gate}` : `decision point ${w.point}`;
  return `waiting on ${on}${w.component ? ` (${w.component})` : ""} since ${w.since}${w.message ? `: ${w.message}` : ""}`;
}

/** The decision point a run waits on, as a line, or null. */
export function pointLine(run) {
  if (!run || !run.point) return null;
  return `waiting on decision point ${run.point.id} since ${run.point.since}${run.point.message ? `: ${run.point.message}` : ""}; answer it with chant workspace points answer ${run.point.id}`;
}

/**
 * The pending gate card (#234), from the run state alone.
 *
 * `guards` and `node` come from the graph's own answer (`meta.gate`, built by
 * src/run-playhead.ts's `pendingGateCard`) when the ops lens has been loaded;
 * this is the fallback so the card still appears on the Deploy tab of a session
 * that never opened the lens. `approve` is stated, not implied — it is the same
 * delegated write the existing gate button performs.
 */
export function gateCardFrom(run) {
  if (!run || !run.op || !run.gate) return null;
  return {
    op: run.op,
    signalName: run.gate.signalName,
    description: run.gate.description || undefined,
    since: run.gate.since,
    approve: {
      method: "POST",
      path: `/api/ops/${encodeURIComponent(run.op)}/signal/${encodeURIComponent(run.gate.signalName)}`,
    },
  };
}

/** Does the panel have anything to show at all? */
export function hasPlayhead(run) {
  return Boolean(run && (run.op || (run.steps && run.steps.length)));
}

// ── the DOM half ─────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * Render the playhead panel into `host` (cleared first — the whole subtree is
 * rebuilt per event, exactly as renderDial() does).
 *
 * `card` is the graph's richer pending-gate answer when one has been loaded,
 * else null. `actions.approve(op, signalName)` performs the delegated signal.
 */
export function renderPlayhead(host, run, card, actions = {}) {
  host.textContent = "";
  const verdict = runVerdict(run);
  if (!verdict) return host;

  const line = el("div", "run-verdict", verdict.text);
  line.style.color = RUN_STATUS_COLOR[verdict.tone] || "var(--muted)";
  host.appendChild(line);

  // #679: where the steps came from; a degraded run's reason is its label,
  // and any other reason (a steward run, a run with no kept events) follows it.
  const from = sourceLabel(run.source, run.source === "progress" ? run.sourceNote : null);
  if (from) {
    const src = el("div", "run-source", from.text);
    src.style.color = RUN_STATUS_COLOR[from.tone] || "var(--muted)";
    host.appendChild(src);
  }
  if (run.sourceNote && run.source !== "progress") host.appendChild(el("div", "run-source", run.sourceNote));
  if (run.lost) host.appendChild(el("div", "run-lost", run.lost));
  if (run.gateNote) host.appendChild(el("div", "run-lost", `Gate state unavailable: ${run.gateNote}`));
  const point = pointLine(run);
  if (point) host.appendChild(el("div", "run-gate-meta", point));

  const gate = card || gateCardFrom(run);
  if (gate) host.appendChild(renderGateCard(gate, actions));

  const rows = stepRows(run);
  if (rows.length) {
    const list = el("div", "run-steps");
    for (const r of rows) {
      const row = el("div", "run-step");
      const dot = el("span", "run-dot");
      dot.style.background = RUN_STEP_COLOR[r.status] || "var(--muted)";
      // behold#571: the step's left bar, in its status.
      if (row.style.setProperty) row.style.setProperty("--bar", barVarFor(RUN_STEP_COLOR[r.status]));
      row.appendChild(dot);
      row.appendChild(el("span", "grow", r.label));
      row.appendChild(el("span", "run-took", r.took));
      if (r.error || r.approvedBy) row.title = [r.error, r.approvedBy ? `approved by ${r.approvedBy}` : null].filter(Boolean).join("; ");
      list.appendChild(row);
    }
    host.appendChild(list);
  }
  return host;
}

/**
 * The pending-approval card. Its button is the delegated write, and the card
 * says so out loud: behold triggers Ops and signals gates a human presses; it
 * never approves anything on its own initiative.
 */
export function renderGateCard(gate, actions = {}) {
  const box = el("div", "run-gate");
  box.appendChild(el("div", "run-gate-title", `⏸ waiting for approval — ${gate.signalName}`));
  if (gate.description) box.appendChild(el("div", "run-gate-desc", gate.description));
  const waited = waitingFor(gate.since);
  box.appendChild(
    el("div", "run-gate-meta", `${gate.op} · pending ${waited ? `${waited} ` : ""}since ${gate.since}`),
  );
  if (gate.guards) box.appendChild(el("div", "run-gate-meta", `holds back: ${gate.guards}`));

  // #477: framed in a host, the host approves; the gate is drawn, not offered.
  if (!actions.approve) {
    box.appendChild(el("div", "run-gate-meta", NO_APPROVE[actions.why] || NO_APPROVE.host));
    return box;
  }
  const approve = el("button", "approve", actions.approver ? `Approve ${gate.signalName} as ${actions.approver}` : `Approve ${gate.signalName}`);
  approve.title = `${gate.approve.method} ${gate.approve.path} — the same delegated write as chant run approve ${gate.op} ${gate.signalName}. behold never approves on its own.`;
  approve.addEventListener("click", () => actions.approve?.(gate.op, gate.signalName));
  box.appendChild(approve);
  return box;
}

// #477: why a gate card has no approve button.
const NO_APPROVE = {
  host: "approve in the host that framed this graph",
  preview: "approving is off in preview",
  public: "a public view: approving is off",
  static: "a snapshot: approve where behold runs",
};
