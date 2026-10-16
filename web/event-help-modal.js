// behold#571: event-help's modal for a critical event: a wave held for an
// approval, a wave that failed, a cycle applied. One component for the full
// app and the kiosk, with the mode an explicit parameter:
//
// - `live` (the full app, any serve that isn't public or a preview): it opens
//   on the event and waits for the person. It closes when they dismiss it or
//   when the event resolves. It acts only through behold's existing approval
//   paths: an Op's gate through the route the app already calls
//   (`actions.approve`, which the app hands in), and a terragucci or chant
//   gate, which behold holds no identity to clear, by showing the signed
//   `chant approve` command to copy and watching the ledger (`actions.watch`,
//   a read) until the approval lands.
// - `narrated` (the live kiosk): the event is live and so is the data. The
//   button the driver is about to press counts down to the driver's real
//   action (demo.json's `next.at`): "Approve · 12". At zero it says
//   "Approving…", and it shows pressed and resolved only when the real record
//   or step arrives (`resolve`), never before. Every button is inert.
// - `replay` (a tool's page replaying a recorded cycle): the same, counting to
//   the recorded event's time, marked as a replay.
//
// Nothing here writes on its own: the only write is `actions.approve` in live
// mode, and only on a click.

/** The three modes. */
export const MODAL_MODES = ["live", "narrated", "replay"];

/** How long a narrated or replayed modal stays up once its event resolved, and how long a live one shows the outcome. */
export const MODAL_CLOSE_MS = 6_000;
export const LIVE_OUTCOME_MS = 2_500;
/** How often live mode reads the ledger for a signed approval. */
export const LEDGER_WATCH_MS = 4_000;

/** The verb each kind's button says, before, during and after. */
export const VERBS = {
  held: { verb: "Approve", ing: "Approving…", past: "Approved" },
  failed: { verb: "Run again", ing: "Running again…", past: "Running again" },
  applied: { verb: "Close", ing: "Close", past: "Close" },
};

/** Whole seconds until `at` (ms), never below 0; null without a time. */
export function secondsLeft(at, now) {
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * The button's state: `{ label, pressed, progress }`. Counting down to the
 * real action ("Approve · 12"), then "Approving…" at zero, and pressed only
 * once the real event resolved it. `progress` (0..1) fills a ring as the time
 * runs out; null under reduced motion, or without a time.
 */
export function buttonState(kind, { at = null, from = null, now = 0, resolved = false, reduced = false, verbs = null } = {}) {
  const v = verbs || VERBS[kind] || VERBS.held;
  if (resolved) return { label: v.past, pressed: true, progress: null };
  const left = secondsLeft(at, now);
  if (left === null) return { label: v.verb, pressed: false, progress: null };
  if (left === 0) return { label: v.ing, pressed: false, progress: reduced ? null : 1 };
  const span = Number.isFinite(from) && at > from ? at - from : null;
  return { label: `${v.verb} · ${left}`, pressed: false, progress: reduced || !span ? null : Math.min(1, Math.max(0, (now - from) / span)) };
}

/** "04:08", UTC. */
const utc = (ms) => new Date(ms).toISOString().slice(11, 16);

/**
 * The line that says which mode this is. Narrated says what the driver does
 * and when; replay says which run it replays; live says nothing extra.
 */
export function modeLine(mode, kind, { at = null, now = 0, resolved = false, outcome = null, replayAt = null, action = null } = {}) {
  if (mode === "replay") return `Replay of the run at ${utc(Number.isFinite(replayAt) ? replayAt : now)} UTC`;
  if (mode !== "narrated") return null;
  if (resolved) return outcome ? `Live · ${outcome}` : "Live";
  const left = secondsLeft(at, now);
  if (kind === "held") return left === null ? "Live · the driver plays the reviewer" : left > 0 ? `Live · the driver plays the reviewer and approves in ${left} s` : "Live · the driver plays the reviewer and approves now";
  if (kind === "failed") return left === null ? "Live · the driver fixes it and runs it again" : left > 0 ? `Live · the driver fixes it and runs it again in ${left} s` : "Live · the driver fixes it and runs it again now";
  return "Live";
}

/** Which gates live mode can clear through behold's own routes: an Op's run gate and a converge gate. */
export const ROUTED_GATES = ["run", "converge"];

/**
 * The route the app already calls to clear an Op's gate, as `{ method, path }`;
 * null for a gate behold holds no identity for (terragucci's, chant's).
 */
export function approveRoute(gate) {
  if (!gate) return null;
  const e = encodeURIComponent;
  if (gate.kind === "converge") return { method: "POST", path: (gate.approve && gate.approve.path) || `/api/operator/approve/${e(gate.op)}/${e(gate.gate)}` };
  if (gate.kind === "run") return { method: "POST", path: `/api/ops/${e(gate.op)}/signal/${e(gate.gate)}` };
  return null;
}

const ESC = "Escape";

/** The modal's look (and the Tips switch's), for the kiosk and the full app alike; the state colours are the bars' (theme.js barInks). */
export const MODAL_STYLE = `
.eh-switch { display: inline-flex; align-items: center; gap: 0.35em; color: var(--muted); cursor: pointer; user-select: none; }
.eh-switch input { margin: 0; accent-color: var(--pending); }
.eh-switch:hover { color: var(--fg); }
.eh-modal-wrap { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--bg) 35%, transparent); }
.eh-modal { position: relative; width: min(36em, calc(100vw - 32px)); max-height: calc(100vh - 48px); overflow-y: auto; padding: 1em 1.2em 1.1em; border-radius: 12px; background: var(--surface-pane-b, var(--panel)); color: var(--fg);
  border: 2px solid var(--bar, var(--focus)); box-shadow: 0 16px 48px color-mix(in srgb, var(--shadow) 80%, transparent); font-size: 1.05em; }
.eh-modal-held { --bar: var(--bar-foreign, var(--foreign)); } .eh-modal-failed { --bar: var(--bar-degraded, var(--degraded)); } .eh-modal-applied { --bar: var(--bar-managed, var(--managed)); }
.eh-modal-close { position: absolute; top: 0.4em; right: 0.5em; font-size: 1.3em; background: transparent; border: 0; color: var(--muted); cursor: pointer; }
.eh-modal-mode { margin: 0 2em 0.3em 0; font: 600 0.78em var(--font-mono); text-transform: uppercase; letter-spacing: 0.05em; color: var(--bar, var(--muted)); }
.eh-modal-title { margin: 0 0 0.5em; font-size: 1.35em; }
.eh-modal-line { margin: 0.2em 0; color: color-mix(in srgb, var(--fg) 82%, var(--muted)); }
.eh-modal-line.eh-lit { color: var(--fg); font-family: var(--font-mono); font-size: 0.9em; padding: 0.35em 0.6em; border-radius: 6px; background: color-mix(in srgb, var(--bar, var(--focus)) 14%, var(--well, transparent)); box-shadow: inset 3px 0 0 var(--bar, var(--focus)); }
.eh-modal-command { display: flex; gap: 0.5em; align-items: center; margin: 0.6em 0; }
.eh-modal-command code { flex: 1; padding: 0.45em 0.7em; background: var(--well); border-radius: 6px; font: 0.88em var(--font-mono); overflow-wrap: anywhere; }
.eh-modal-copy { font: inherit; padding: 0.3em 0.8em; border-radius: 6px; border: 1px solid var(--rule); background: transparent; color: var(--fg); cursor: pointer; }
.eh-modal-note, .eh-modal-outcome { margin: 0.4em 0; color: var(--muted); }
.eh-modal-outcome { color: var(--fg); font-weight: 600; }
.eh-modal-act { --eh-progress: 0; margin-top: 0.7em; font: 600 1.05em var(--font-ui); padding: 0.5em 1.4em; border-radius: 8px; border: 2px solid var(--bar, var(--pending)); color: var(--fg); cursor: default;
  background: linear-gradient(90deg, color-mix(in srgb, var(--bar, var(--pending)) 35%, transparent) calc(var(--eh-progress) * 100%), transparent 0); }
.eh-modal-act.eh-pressed { background: var(--bar, var(--pending)); color: var(--bg); transform: translateY(1px); }
.eh-mode-live .eh-modal-act:not(.eh-pressed) { cursor: pointer; }
.eh-modal .k-ap { margin-top: 0.4em; }
`;

/** Put the modal's style in `doc` once. */
export function modalStyle(doc) {
  if (!doc || !doc.head || !doc.getElementById || doc.getElementById("eh-modal-style")) return;
  const style = doc.createElement("style");
  style.id = "eh-modal-style";
  style.textContent = MODAL_STYLE;
  doc.head.appendChild(style);
}

/**
 * Open the modal in `host` (a document's body, or any element). Returns
 * `{ resolve(outcome), update(data), close(), state }`.
 *
 * `data`: `{ title, lines: [{ text, lit? }], panel?: Node, command?, at?, from?, action?, replayAt?, verbs?, gate?: { kind, op, gate, approve? } }`.
 * `actions` (live only): `approve()` the app's own approve call, and
 * `watch()` a read that answers an outcome once the ledger has the approval.
 */
export function openEventModal(host, { mode, kind, data = {}, actions = {}, doc = typeof document !== "undefined" ? document : null, now = () => Date.now(), reduced = false, onClose = () => {}, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  if (!MODAL_MODES.includes(mode)) throw new Error(`event-help modal: no mode ${JSON.stringify(mode)}`);
  modalStyle(doc);
  const st = { mode, kind, data, resolved: false, outcome: null, closed: false, hovered: false, closeAt: null, pressing: false };
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const wrap = el("div", "eh-modal-wrap");
  const box = el("div", `eh-modal eh-modal-${kind} eh-mode-${mode}`);
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "false");
  box.setAttribute("aria-label", data.title || kind);
  wrap.appendChild(box);
  host.appendChild(wrap);

  const close = () => {
    if (st.closed) return;
    st.closed = true;
    clearTimer(timer);
    if (watchTimer) clearTimer(watchTimer);
    if (doc.removeEventListener) doc.removeEventListener("keydown", onKey);
    if (wrap.remove) wrap.remove();
    else if (host.removeChild) host.removeChild(wrap);
    onClose(st);
  };
  const onKey = (e) => {
    if (e && e.key === ESC) close();
  };
  if (doc.addEventListener) doc.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => {
    if (e && e.target === wrap) close();
  });
  // Hovered, it holds: its time to close starts again when the pointer leaves.
  box.addEventListener("pointerenter", () => (st.hovered = true));
  box.addEventListener("pointerleave", () => {
    st.hovered = false;
    if (st.closeAt !== null) st.closeAt = Math.max(st.closeAt, now() + 2_000);
  });

  const render = () => {
    if (st.closed) return;
    const t = now();
    box.replaceChildren();
    const x = el("button", "eh-modal-close", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.addEventListener("click", close);
    box.appendChild(x);
    const line = modeLine(mode, kind, { at: data.at, now: t, resolved: st.resolved, outcome: st.outcome, replayAt: data.replayAt, action: data.action });
    if (line) box.appendChild(el("p", `eh-modal-mode eh-modal-${mode}`, line));
    box.appendChild(el("h2", "eh-modal-title", data.title || ""));
    for (const l of data.lines || []) box.appendChild(el("p", `eh-modal-line${l.lit ? " eh-lit" : ""}`, l.text));
    if (data.panel) box.appendChild(data.panel);
    const routed = mode === "live" && approveRoute(data.gate);
    // The panel, when there is one, already carries the command.
    if (data.command && !routed && !(data.panel && mode !== "live")) {
      const row = el("div", "eh-modal-command");
      row.appendChild(el("code", null, data.command));
      if (mode === "live") {
        // Copying is no write: it puts the command where the person can run it with their own key.
        const copy = el("button", "eh-modal-copy", "Copy");
        copy.type = "button";
        copy.addEventListener("click", () => {
          try {
            const c = typeof navigator !== "undefined" && navigator.clipboard;
            if (c) void c.writeText(data.command);
          } catch {
            /* no clipboard: the command stays on screen */
          }
        });
        row.appendChild(copy);
      }
      box.appendChild(row);
      if (mode === "live" && kind === "held" && !st.resolved) box.appendChild(el("p", "eh-modal-note", "Watching the ledger for the approval."));
    }
    if (st.resolved && st.outcome) box.appendChild(el("p", "eh-modal-outcome", st.outcome));
    if (kind === "applied" && !routed) return;
    if (mode === "live" && !routed) return; // a gate behold can't clear: the command is the action
    const b = buttonState(kind, { at: mode === "live" ? null : data.at, from: data.from, now: t, resolved: st.resolved || st.pressing, reduced, verbs: data.verbs || null });
    const btn = el("button", `eh-modal-act${b.pressed ? " eh-pressed" : ""}`, b.label);
    btn.type = "button";
    if (b.progress !== null && btn.style) btn.style.setProperty("--eh-progress", String(b.progress));
    if (mode === "live" && routed && !st.resolved && !st.pressing) {
      btn.addEventListener("click", () => {
        st.pressing = true;
        render();
        Promise.resolve(actions.approve ? actions.approve() : null).catch(() => {
          st.pressing = false;
          render();
        });
      });
    } else {
      // Narrated and replayed buttons show what the driver does; they do nothing.
      btn.setAttribute("aria-disabled", "true");
      btn.tabIndex = -1;
    }
    box.appendChild(btn);
  };

  // Live, a terragucci or chant gate: read the ledger until the approval lands.
  let watchTimer = null;
  if (mode === "live" && kind === "held" && !approveRoute(data.gate) && actions.watch) {
    const look = async () => {
      if (st.closed || st.resolved) return;
      const outcome = await actions.watch();
      if (outcome) api.resolve(outcome);
    };
    watchTimer = setTimer(() => void look(), LEDGER_WATCH_MS);
    void look();
  }
  const tick = () => {
    if (st.closed) return;
    if (st.closeAt !== null && !st.hovered && now() >= st.closeAt) return close();
    render();
  };
  const timer = setTimer(tick, 250);
  // The result needs no event to wait for: it closes on its own after its time.
  if (kind === "applied" && mode !== "live") st.closeAt = now() + MODAL_CLOSE_MS;
  render();

  const api = {
    state: st,
    /** The real event arrived: show it pressed and resolved, and close after a while (live: shortly after the outcome). */
    resolve(outcome = null) {
      if (st.closed || st.resolved) return;
      st.resolved = true;
      st.pressing = false;
      st.outcome = outcome;
      st.closeAt = now() + (mode === "live" ? LIVE_OUTCOME_MS : MODAL_CLOSE_MS);
      render();
    },
    update(next) {
      Object.assign(data, next);
      render();
    },
    close,
  };
  return api;
}
