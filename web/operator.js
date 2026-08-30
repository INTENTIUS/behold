/**
 * The operator strip and the converge gate card (#234 joins 3 + 1) — the SPA
 * half of src/operator.ts.
 *
 * Same discipline as web/run-playhead.js next door: everything this panel
 * DECIDES is a pure function that takes data and returns data, unit-tested in
 * operator.test.js; the DOM half at the bottom is smoke/ui-smoke.mjs's job. The
 * fetches, the poll and the SSE subscription all stay in app.js.
 *
 * What it renders, from the `operator` state the server broadcasts:
 *  - one line per ConvergeOp: the last tick's own log line, verbatim, honestly
 *    dated; the lease; the pending-gate count. ONE line, because chant's status
 *    surface exposes one tick and no history (chant#2029) — this is a strip, and
 *    there is deliberately no code path here that can render a second tick.
 *  - each pending converge gate as a card whose Approve button says what
 *    approving actually does: it records a fact, and the next tick acts on it.
 *    It does not release anything. That is the run gate, painted by the playhead
 *    panel next door, and the card names its loop so the two can't be confused.
 */
import { waitingFor } from "./run-playhead.js";

/** How a lease reads. `expired` is its own tone, not a shade of `free`: a lapsed
 * lease means the holder stopped renewing and the next round reclaims it, which
 * is a different statement from "nobody has ever held it". */
export const LEASE_COLOR = {
  held: "var(--managed)",
  expired: "var(--foreign)",
  free: "var(--muted)",
};

export const LEASE_LABEL = {
  held: "lease held",
  expired: "lease expired",
  free: "lease free",
};

/**
 * The one sentence the card must never soften — kept in step with
 * src/operator.ts's `APPROVE_SEMANTICS`, and re-stated here rather than only
 * trusted from the server so the card still tells the truth if an older server
 * omits the field.
 */
export const APPROVE_SEMANTICS =
  "Approving records a fact in the gate ledger; it does not unblock the dispatch. The next tick reads it.";

/** The past-tense half, for the toast right after the click. */
export const APPROVED_SEMANTICS = "recorded; the next tick acts on it";

/** Which loop a card belongs to, spelled out. behold draws two gate cards and
 * they resolve through different commands with different effects. */
export const CONVERGE_LOOP_LINE =
  "converge loop · chant approve — not the Temporal run gate, which is signalled and does release its run";

/** Does the served project declare an operating loop at all? The strip is gated
 * on the DECLARATION (read from the emitted op.json), never on whether a status
 * read happened to answer — so a declared loop behold couldn't read still shows,
 * saying why, instead of vanishing as if no loop existed. */
export function hasOperator(state) {
  return Boolean(state && Array.isArray(state.declared) && state.declared.length);
}

/** The refusal to state plainly, or null when the last read succeeded. */
export function operatorRefusal(state) {
  if (!state || !state.note) return null;
  return { code: state.code || "operator-status", text: state.note };
}

/**
 * One row per ConvergeOp, ready to paint.
 *
 * A loop that is declared but absent from the last status read still gets a row
 * — from its declaration alone, saying it has not been read. Dropping it would
 * make the strip undercount the loops the project runs, which is the one thing a
 * strip about "how many loops and what did they last do" must not do.
 */
export function operatorRows(state, now = Date.now()) {
  if (!hasOperator(state)) return [];
  const read = new Map(((state.strip && state.strip.rows) || []).map((r) => [r.op, r]));
  return (state.declared || []).map((d) => {
    const r = read.get(d.name);
    if (!r) {
      return {
        op: d.name,
        env: d.env || null,
        dial: d.dial || null,
        log: null,
        at: null,
        ago: null,
        lease: "free",
        leaseText: state.strip ? "not in the last status read" : "not read yet",
        pendingGates: 0,
      };
    }
    return {
      op: r.op,
      env: r.env || d.env || null,
      dial: d.dial || null,
      log: r.log,
      at: r.at,
      ago: r.at ? waitingFor(r.at, now) : null,
      lease: r.lease,
      leaseText: leaseText(r),
      pendingGates: r.pendingGates,
    };
  });
}

/** The lease, in words. The holder is always named when there is one — "held"
 * without a holder is a fact nobody can act on. */
export function leaseText(row) {
  if (row.lease === "free" || !row.leaseHolder) return LEASE_LABEL.free;
  const until = row.leaseExpiresAt ? ` until ${row.leaseExpiresAt}` : "";
  return row.lease === "expired"
    ? `lease expired (${row.leaseHolder}${until}) — the next round reclaims it`
    : `lease held by ${row.leaseHolder}${until}`;
}

/** The strip's own headline: how many loops, how many gates are owed a human. */
export function operatorHeadline(state) {
  if (!hasOperator(state)) return null;
  const n = state.declared.length;
  const gates = (state.gates || []).length;
  const head = `⟳ operating loop — ${n} ConvergeOp${n === 1 ? "" : "s"}`;
  return gates ? `${head} · ${gates} gate${gates === 1 ? "" : "s"} pending` : head;
}

/**
 * The one-tick caveat, said every time there is a tick to say it about.
 *
 * A reader must never take this strip for a shortened timeline: chant's
 * `operator status` keeps only the last ledger record and no CLI exposes the
 * rest (chant#2029), so one line is all there is, not one line behold chose.
 */
export const ONE_TICK_CAVEAT =
  "One tick per loop — chant's status surface exposes only the last one (chant#2029), so this is a strip, not a timeline.";

/** The converge gate cards, from the same state. Each already carries the
 * delegated write it performs; nothing here is derived from a graph. */
export function convergeGates(state) {
  return (state && state.gates) || [];
}

// ── the DOM half ─────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * Render the operator strip into `host` (cleared first — the whole subtree is
 * rebuilt per event, exactly as renderPlayhead does).
 *
 * `actions.approve(op, gate)` performs the delegated `chant approve`.
 */
export function renderOperator(host, state, actions = {}) {
  host.textContent = "";
  if (!hasOperator(state)) return host;

  host.appendChild(el("div", "operator-title", operatorHeadline(state)));

  const refusal = operatorRefusal(state);
  if (refusal) host.appendChild(el("div", "run-lost", `Operator status unavailable — ${refusal.text}`));

  const rows = operatorRows(state);
  const list = el("div", "operator-rows");
  for (const r of rows) {
    const row = el("div", "operator-row");
    const dot = el("span", "run-dot");
    dot.style.background = LEASE_COLOR[r.lease] || "var(--muted)";
    dot.title = r.leaseText;
    row.appendChild(dot);

    const body = el("div", "grow");
    const head = el("div", "operator-op", r.env ? `${r.op} (${r.env})${r.dial ? ` · dial ${r.dial}` : ""}` : r.op);
    body.appendChild(head);
    // chant's own log line, verbatim — behold re-words nothing about a tick.
    body.appendChild(el("div", "operator-log", r.log || "no tick recorded yet"));
    const when = r.at ? `last tick ${r.at}${r.ago ? ` (${r.ago} ago)` : ""}` : "never ticked";
    body.appendChild(el("div", "operator-meta", `${when} · ${r.leaseText}`));
    row.appendChild(body);

    if (r.pendingGates) {
      row.appendChild(el("span", "operator-gates", `${r.pendingGates} gate${r.pendingGates === 1 ? "" : "s"}`));
    }
    list.appendChild(row);
  }
  host.appendChild(list);

  if (rows.some((r) => r.at)) host.appendChild(el("div", "operator-caveat", ONE_TICK_CAVEAT));

  for (const gate of convergeGates(state)) host.appendChild(renderConvergeGateCard(gate, actions));
  return host;
}

/**
 * A pending converge gate.
 *
 * Three things this card says out loud, because getting any of them wrong would
 * make the button lie:
 *  - which loop it belongs to (converge, not the Temporal run gate next door);
 *  - that approving RECORDS A FACT and does not unblock the dispatch — chant's
 *    own gate-ledger doc, and what `chant approve` itself prints;
 *  - the exact command the button delegates to.
 *
 * And one thing it deliberately does not render: a link. A pending gate fact
 * carries no URL (chant#2028), and a placeholder link would invent a review
 * surface that does not exist.
 */
export function renderConvergeGateCard(gate, actions = {}) {
  const box = el("div", "run-gate operator-gate");
  box.appendChild(el("div", "run-gate-title", `⏸ converge gate — ${gate.gate}`));
  box.appendChild(el("div", "operator-loop", CONVERGE_LOOP_LINE));
  const waited = gate.since ? waitingFor(gate.since) : null;
  box.appendChild(
    el(
      "div",
      "run-gate-meta",
      `rule ${gate.rule} → ${gate.op}` +
        `${gate.convergeOp ? ` · recorded by ${gate.convergeOp}${gate.env ? ` (${gate.env})` : ""}` : ""}` +
        `${gate.since ? ` · gated ${waited ? `${waited} ago, ` : ""}${gate.since}` : ""}`,
    ),
  );
  box.appendChild(el("div", "operator-semantics", gate.semantics || APPROVE_SEMANTICS));

  const command = (gate.approve && gate.approve.command) || `chant approve ${gate.op} ${gate.gate}`;
  const approve = el("button", "approve", "Record approval");
  approve.title =
    `${(gate.approve && gate.approve.method) || "POST"} ${(gate.approve && gate.approve.path) || ""} — ` +
    `${command}. ${gate.semantics || APPROVE_SEMANTICS} behold never approves on its own.`;
  approve.addEventListener("click", () => actions.approve?.(gate.op, gate.gate));
  box.appendChild(approve);
  return box;
}
