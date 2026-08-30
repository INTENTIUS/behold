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
 *  - the settled steps, in the order they settled.
 */

/** Settled-step tones, in the same token vocabulary the apply progress panel
 * uses (`APPLY_STATUS_COLOR` in app.js) so "green means it worked" reads the
 * same everywhere. */
export const RUN_STEP_COLOR = {
  ok: "var(--managed)",
  fail: "var(--degraded)",
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
  lost: "var(--foreign)",
};

/** `1062` → `1.1s`. */
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
  const n = (run.records || []).length;
  const settled = `${n} step${n === 1 ? "" : "s"} settled`;
  if (run.status === "idle") {
    return { text: `${run.op}: no per-step records — this session didn't start the run`, tone: "idle" };
  }
  if (run.status === "running") {
    return {
      text:
        run.mode === "local"
          ? `${run.op}: running on the local executor — steps arrive together when it ends`
          : `${run.op}: running — ${settled}`,
      tone: "running",
    };
  }
  if (run.status === "ok") return { text: `${run.op}: exited cleanly — ${settled}`, tone: "ok" };
  if (run.status === "failed") return { text: `${run.op}: a step failed — ${settled}`, tone: "failed" };
  return { text: `${run.op}: stream lost — frozen at ${settled}`, tone: "lost" };
}

/** The settled steps, in arrival order, as rows. */
export function stepRows(run) {
  return (run?.records || []).map((r) => ({
    label: `${r.phase} · ${r.fn}`,
    status: r.status,
    took: r.status === "skipped" ? "skipped" : took(r.durationMs),
    error: r.error || null,
  }));
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
  return Boolean(run && (run.op || (run.records && run.records.length)));
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

  if (run.lost) host.appendChild(el("div", "run-lost", run.lost));
  if (run.gateNote) host.appendChild(el("div", "run-lost", `Gate state unavailable — ${run.gateNote}`));

  const gate = card || gateCardFrom(run);
  if (gate) host.appendChild(renderGateCard(gate, actions));

  const rows = stepRows(run);
  if (rows.length) {
    const list = el("div", "run-steps");
    for (const r of rows) {
      const row = el("div", "run-step");
      const dot = el("span", "run-dot");
      dot.style.background = RUN_STEP_COLOR[r.status] || "var(--muted)";
      row.appendChild(dot);
      row.appendChild(el("span", "grow", r.label));
      row.appendChild(el("span", "run-took", r.took));
      if (r.error) row.title = r.error;
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

  const approve = el("button", "approve", `Approve ${gate.signalName}`);
  approve.title = `${gate.approve.method} ${gate.approve.path} — the same delegated signal as chant run signal ${gate.op} ${gate.signalName}. behold never approves on its own.`;
  approve.addEventListener("click", () => actions.approve?.(gate.op, gate.signalName));
  box.appendChild(approve);
  return box;
}
