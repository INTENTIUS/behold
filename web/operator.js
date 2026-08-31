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
 *    dated; the lease; the pending-gate count. ONE line, because that is what
 *    `chant operator status` answers with — there is deliberately no code path
 *    here that can render a second tick onto the strip.
 *  - each pending converge gate as a card whose Approve button says what
 *    approving actually does: it records a fact, and the next tick acts on it.
 *    It does not release anything. That is the run gate, painted by the playhead
 *    panel next door, and the card names its loop so the two can't be confused.
 *    When the gate fact names where approval happens (chant#2028) the card links
 *    it, under chant's own words — `approve at:`. When it doesn't, the card is
 *    exactly the card it was before that field existed.
 *  - the history, when a human opens it: the converge timeline chant#2029's
 *    `operator log` reads, ticks and gate resolutions interleaved. It grows from
 *    the strip and is fetched on the click, never on a timer — the strip is the
 *    at-a-glance line, the timeline is the thing you go and look at.
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

/** The words a gate's address is offered under — chant's own. `chant operator
 * status`'s human render prints `approve at: <url>` beneath the pending gate, so
 * the card labels the same fact the same way. */
export const APPROVE_AT = "approve at:";

/** The resolved half's label. Same field, chant#2028's other end
 * (`GateResolutionRecord.url`): where the approval DID happen, so the tense
 * changes — a resolution's link is a record, not an invitation. */
export const RESOLVED_AT = "resolved at:";

/**
 * The address behold will put behind an `href`, or null.
 *
 * Re-checked here rather than only trusted from the server, exactly as
 * APPROVE_SEMANTICS is re-stated above: an absolute http/https URL becomes a
 * link, anything else reads as no address at all and the card renders without
 * one. A `javascript:` string that reached a ledger must not become a link
 * because a server was older than this file.
 */
export function approvalLink(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

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
        tickId: null,
        tick: null,
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
      // chant#2027's tick id: whole (so the hover can quote it in full) and
      // truncated (so the line stays a line). Both null on a chant that
      // recorded none, and the row then reads exactly as it did before the
      // field existed.
      tickId: r.tickId || null,
      tick: shortTickId(r.tickId),
      lease: r.lease,
      leaseText: leaseText(r),
      pendingGates: r.pendingGates,
    };
  });
}

/**
 * How much of a tick id to show.
 *
 * chant mints one with `randomUUID()` (chant#2027), so the first block of a
 * canonical UUID is already the part a human reads out and the part that
 * distinguishes two ticks in the same ISO second — which is the whole reason
 * the field exists. Anything shorter than the cut is shown whole rather than
 * padded: behold never invents characters chant didn't write.
 */
export const TICK_ID_CHARS = 8;

/** A tick id, short enough to sit on a strip line. Null in, null out — a chant
 * older than 0.53.1 recorded no id, and the strip says nothing rather than
 * showing a placeholder for an identity that doesn't exist. */
export function shortTickId(id) {
  if (typeof id !== "string" || !id) return null;
  return id.length > TICK_ID_CHARS ? id.slice(0, TICK_ID_CHARS) : id;
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
 * A reader must never take this strip for a shortened timeline: `chant operator
 * status` keeps only the last ledger record per loop, so one line is all this
 * read has, not one line behold chose. The rest of the history is a different
 * command (chant#2029) and a different click — which the caveat now points at,
 * because "this is not a timeline" without saying where the timeline IS would be
 * the strip keeping a secret.
 */
export const ONE_TICK_CAVEAT =
  "One tick per loop — `chant operator status` answers with only the last one. The rest is its own read (chant#2029): open the history below.";

/** What the history disclosure is called, closed and open. */
export const HISTORY_LABEL = "converge history";

/** The converge gate cards, from the same state. Each already carries the
 * delegated write it performs; nothing here is derived from a graph. */
export function convergeGates(state) {
  return (state && state.gates) || [];
}

// ── the timeline (chant#2029) ────────────────────────────────────────────────

/** The rows of a loaded history, or [] for one that hasn't been read. */
export function timelineRows(history) {
  return (history && history.data && history.data.entries) || [];
}

/**
 * The history's own headline: how much of the ledger this is, and whether there
 * is more behind it.
 *
 * The window is stated on screen rather than implied. behold asks for the newest
 * n (never the whole ledger — it grows one line per tick forever), so a full
 * window means "and older ticks before these", and a reader who isn't told that
 * would read the oldest row as the beginning of history.
 */
export function historyHeadline(history) {
  const data = history && history.data;
  if (!data) return null;
  const n = data.entries.length;
  const head = `${n} ${n === 1 ? "entry" : "entries"}`;
  const window = data.window || {};
  const bits = [`newest ${window.limit}`];
  if (window.since) bits.push(`since ${window.since}`);
  if (data.more) bits.push("older ticks before these");
  return `${head} · ${bits.join(" · ")}`;
}

/**
 * The unreadable-line count, in words, or null when every line read.
 *
 * chant counts the ledger lines it could not parse rather than throwing, so a
 * corrupted ledger renders a SHORTER timeline. Surfacing the count is the
 * difference between "3 lines of this ledger are unreadable" and a quiet gap the
 * reader takes for a quiet loop.
 */
export function historyMalformedNote(history) {
  const m = (history && history.data && history.data.malformed) || null;
  if (!m) return null;
  const total = (m.converge || 0) + (m.gates || 0);
  if (!total) return null;
  return (
    `${total} ledger line${total === 1 ? "" : "s"} were unreadable and are missing from this timeline ` +
    `(converge: ${m.converge || 0}, gates: ${m.gates || 0}).`
  );
}

/**
 * One timeline row, in words — chant's own `operator log` render is the model.
 *
 * A tick reads as its op, its id and the log line chant wrote, verbatim; a
 * resolution reads as who resolved which gate. Nothing here rewords a fact:
 * behold's job on this surface is ordering and legibility, not narration.
 */
export function timelineText(row) {
  if (!row) return "";
  if (row.kind === "gate-resolution") {
    return `gate resolved · ${row.op}/${row.gate} by ${row.resolvedBy}`;
  }
  // Bracketed, the way chant's own `operator log` render prints it, and cut by
  // the strip's own {@link shortTickId} so one tick reads the same in both.
  const id = shortTickId(row.id) ? ` [${shortTickId(row.id)}]` : "";
  return `${row.op}${row.env ? `@${row.env}` : ""}${id}`;
}

/** One gated outcome within a tick, in chant's own `operator log` words. */
export function gatedText(gate) {
  return `gated ${gate.rule} → ${gate.op || "?"} gate "${gate.gate}"`;
}

// ── the DOM half ─────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** An `approve at: <url>` link, or null for a fact carrying no address behold
 * will link. Never a placeholder: the absent case renders nothing at all. */
function approveAtLink(url, label = APPROVE_AT) {
  const href = approvalLink(url);
  if (!href) return null;
  const a = el("a", "operator-url", `${label} ${href}`);
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  a.title = `${href} — the address the gate fact itself records (chant#2028). behold never invents this link.`;
  return a;
}

/**
 * Render the operator strip into `host` (cleared first — the whole subtree is
 * rebuilt per event, exactly as renderPlayhead does).
 *
 * `actions.approve(op, gate)` performs the delegated `chant approve`;
 * `actions.history()` toggles the timeline below the strip and is what triggers
 * its one read. Omit it (a static export has no server to ask) and no history
 * affordance is drawn at all.
 *
 * `history` is the caller's own `{open, loading, error, data}` — this module
 * decides what the panel SAYS, app.js owns the fetch and the open/closed bit,
 * the same split every other panel here keeps.
 */
export function renderOperator(host, state, actions = {}, history = null) {
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
    // `· tick <id>` only when chant wrote one (chant#2027) — a tick becomes a
    // thing you can point at, and an older chant's line is unchanged.
    const when = r.at ? `last tick ${r.at}${r.ago ? ` (${r.ago} ago)` : ""}${r.tick ? ` · tick ${r.tick}` : ""}` : "never ticked";
    const meta = el("div", "operator-meta", `${when} · ${r.leaseText}`);
    if (r.tick) meta.title = `tick id ${r.tickId || r.tick}`;
    body.appendChild(meta);
    row.appendChild(body);

    if (r.pendingGates) {
      row.appendChild(el("span", "operator-gates", `${r.pendingGates} gate${r.pendingGates === 1 ? "" : "s"}`));
    }
    list.appendChild(row);
  }
  host.appendChild(list);

  if (rows.some((r) => r.at)) host.appendChild(el("div", "operator-caveat", ONE_TICK_CAVEAT));
  if (actions.history) host.appendChild(renderHistory(history, actions));

  for (const gate of convergeGates(state)) host.appendChild(renderConvergeGateCard(gate, actions));
  return host;
}

/**
 * The history disclosure and, when it is open, the timeline.
 *
 * Closed is the default and costs nothing: the read happens on the click that
 * opens it, and there is no interval anywhere on this path. The strip above ages
 * on its own — a tick lands whether or not anyone is looking — but a ledger's
 * past does not change while you read it, so re-fetching it on a timer would be
 * spending a chant process per interval to be told the same thing.
 */
function renderHistory(history, actions) {
  const box = el("div", "operator-history");
  const open = !!(history && history.open);
  const toggle = el("button", "operator-history-toggle", `${open ? "▾" : "▸"} ${HISTORY_LABEL}`);
  toggle.title =
    "The converge timeline: ticks and gate resolutions from the chant/lifecycle ledger " +
    "(chant operator log, chant#2029). Read when you open it — behold never polls the history.";
  toggle.addEventListener("click", () => actions.history());
  box.appendChild(toggle);
  if (!open) return box;

  if (history.error) {
    box.appendChild(el("div", "run-lost", `Converge history unavailable — ${history.error}`));
    return box;
  }
  if (history.loading || !history.data) {
    box.appendChild(el("div", "operator-meta", "reading the converge ledger…"));
    return box;
  }

  box.appendChild(el("div", "operator-history-head", historyHeadline(history)));
  const malformed = historyMalformedNote(history);
  if (malformed) box.appendChild(el("div", "run-lost", malformed));

  const rows = timelineRows(history);
  if (!rows.length) {
    box.appendChild(el("div", "operator-meta", "No converge ticks recorded in this window."));
    return box;
  }

  const list = el("div", "operator-timeline");
  for (const row of rows) {
    // Oldest first, exactly as chant merged them — a timeline reads forward.
    const entry = el("div", `operator-entry operator-entry-${row.kind}`);
    entry.appendChild(el("div", "operator-meta", `${row.at} · ${timelineText(row)}`));
    if (row.kind === "tick") {
      // chant's own log line, verbatim — the strip's rule, on every row.
      entry.appendChild(el("div", "operator-log", row.log));
      for (const gate of row.gated) {
        const line = el("div", "operator-gated", gatedText(gate));
        const link = approveAtLink(gate.url);
        if (link) line.appendChild(link);
        entry.appendChild(line);
      }
    } else {
      if (row.note) entry.appendChild(el("div", "operator-log", row.note));
      const link = approveAtLink(row.url, RESOLVED_AT);
      if (link) entry.appendChild(link);
    }
    list.appendChild(entry);
  }
  box.appendChild(list);
  return box;
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
 * And the fourth, since chant#2028: where approval happens, when the gate fact
 * says so. `approve at: <url>` — chant's own words from `operator status`'s
 * human render — linking the PR/MR the gated tick knew about. A fact with no
 * address renders no link and no placeholder for one: the url is optional by
 * design (a local tick with no PR behind it genuinely has none), and inventing a
 * review surface would be worse than the shell command it replaces.
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
  const at = approveAtLink(gate.url);
  if (at) box.appendChild(at);

  const command = (gate.approve && gate.approve.command) || `chant approve ${gate.op} ${gate.gate}`;
  const approve = el("button", "approve", "Record approval");
  approve.title =
    `${(gate.approve && gate.approve.method) || "POST"} ${(gate.approve && gate.approve.path) || ""} — ` +
    `${command}. ${gate.semantics || APPROVE_SEMANTICS} behold never approves on its own.`;
  approve.addEventListener("click", () => actions.approve?.(gate.op, gate.gate));
  box.appendChild(approve);
  return box;
}
