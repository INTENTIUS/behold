/**
 * behold#936: the kiosk's prompt pane. While a demo step has an `ask` (or
 * `asks`), a big monospace pane at the bottom of the screen replaces the
 * header and the caption. It reads like a coding agent's terminal: every step
 * is a turn, and the whole scenario stays on screen as one session.
 *
 * A turn goes through these states, in order:
 *
 * 1. ready: the pane's top edge is lit with a soft glow and an empty `>` line
 *    shows a blinking block cursor. It shows whenever the pane waits for the
 *    next prompt (before the first one, between beats, after a reply), and
 *    goes dim when typing starts;
 * 2. typing: the person's prompt (or an action line, a check mark) is typed;
 * 3. busy: a line in the agent's colour, a spinner glyph, the label (the
 *    beat's or step's `status`, else the step's label), an animated ellipsis
 *    and a dim elapsed `(m:ss)`. A beat with a prompt and a reply shows it for
 *    at least {@link BUSY_MIN_MS} before the reply types. A step with only a
 *    status shows it for the whole step, under the turn it belongs to;
 * 4. replied: the busy line collapses into a dim "check label (m:ss)" line
 *    and the reply types below it.
 *
 * Only then does `behold:ask-done` fire, so the graph changes. Nothing
 * happens by magic: the graph holds still (`behold:ask-hold`, then
 * `behold:ask-start`) until the turn that asks for the change has replied. A
 * step that only carries a status releases it after its busy line has shown
 * for {@link BUSY_MIN_MS}, and a step that arrives while the one before is
 * still playing waits in a queue for it to finish.
 *
 * The timeline, the typing and the template filling are pure functions, so
 * they are tested without a page. {@link createAskPane} is the one part that
 * touches the document, and it tells the rest of the page through window
 * events (the shared interface with behold#937's lighting):
 *
 * - `behold:ask-hold` with `{ step, scenario }` when a step begins;
 * - `behold:ask-start` before a beat is typed, `behold:ask-done` when its
 *   reply has printed, each with detail `{ ask, step, scenario }`;
 * - `behold:ask-clear` on a step with no ask, once its busy line has shown;
 * - `behold:ask-status` with `{ status, step, scenario }` once a status
 *   line has shown for {@link BUSY_MIN_MS} (a step's `ask.status`, or its
 *   label's first sentence).
 *
 * `{dependents}` is not filled here: behold#937 sets
 * `window.beholdAskTokens = { dependents: <n> }` when it hears ask-start, and
 * the reply reads that object when it prints.
 */

/** Milliseconds per typed character of a prompt (a phone viewer has to be able to read it as it comes). */
export const TYPE_MS = 65;
/** The blinking cursor shows alone this long before a prompt starts to type. */
export const CURSOR_PAUSE_MS = 600;
/** Milliseconds per character of a reply, which types faster than the person. */
export const REPLY_TYPE_MS = 25;
/** The busy line shows at least this long before a reply types, and before a status-only step lets the graph go. */
export const BUSY_MIN_MS = 1200;
/** From a beat's end to the next beat's start. */
export const BEAT_GAP_MS = 1500;
/** Turns dimmed in steps above the newest one; older ones stay at the faintest. */
export const KEEP = 3;
/** Turns kept in the transcript. */
export const MAX_TURNS = 40;
/** Steps waiting for the one on screen to finish. */
export const MAX_QUEUE = 8;
/** The busy line's spinner glyphs, and how long each shows; the ellipsis steps every ELLIPSIS_MS. */
export const SPINNER = ["✻", "✶", "✳", "✢", "·"];
export const SPIN_MS = 140;
export const ELLIPSIS_MS = 400;
export const MARKS = { prompt: ">", action: "✓" };

/** A demo's beats in order: `asks` when it has some, else `ask`, else none. A beat is a prompt, an action, a reply or a status (a status alone is valid). */
export function askBeats(demo) {
  if (!demo) return [];
  const ok = (a) => a && (a.prompt || a.action || a.reply || a.status);
  if (Array.isArray(demo.asks) && demo.asks.length) return demo.asks.filter(ok);
  return ok(demo.ask) ? [demo.ask] : [];
}

/** Whether a demo step carries a prompt-driven beat (`ask` or `asks`): the one thing that turns ask mode on for a view. */
export const hasAsk = (demo) => askBeats(demo).length > 0;

/**
 * behold#939: ask mode, while the pane shows in Watch. The story is the
 * prompts and the graph, so what contradicts or covers it is off: the approval
 * card and modal, the result card ("3 waves applied" against "one apply"), the
 * wave badges, the log drawer, Tips' bubbles and the "This cycle" strip. A step
 * without an ask is not in it, and looks as it always did.
 */
export const askMode = (s) => !!(s && s.askOn && s.watchMode);

/** event-help's read of the page, quieted for ask mode: no bubble, no modal, no strip, no waiting line, no result to defer to. */
export function askEventHelp(h, on) {
  return on && h ? { ...h, held: true, hideTrail: true, waiting: null, result: null } : h;
}

/** A step's shot in ask mode: the whole graph (the resources of every root), asked to fill the room. */
export function askShot(shot, on) {
  return on && shot ? { ...shot, kind: "whole", roots: [], waves: [], whole: true, ask: true } : shot;
}

/**
 * The pane's height only grows within a scenario: sized to its content (the
 * last entries and the current one), capped by the stylesheet, and never
 * shorter than the tallest it has been, so the graph's room does not breathe
 * as lines come and go.
 */
export function paneHeight(peak, now) {
  return Number.isFinite(now) && now > peak ? now : peak;
}

/** Fill `{token}`s from `values`. A token that is unknown, or has no value, is the empty string. */
export function fillReply(template, values = {}) {
  if (typeof template !== "string") return "";
  const v = values || {};
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const x = Object.prototype.hasOwnProperty.call(v, name) ? v[name] : null;
    return typeof x === "number" && Number.isFinite(x) ? String(x) : typeof x === "string" ? x : "";
  });
}

/**
 * The tokens a pull request's report gives (terragucci's `totals`,
 * `totals_roots`), and the failed root's error. A count absent from a report
 * that has totals is 0 (a report lists the kinds that are not zero).
 */
export function replyValues(pr, error = null, extra = {}) {
  const t = pr && pr.totals && typeof pr.totals === "object" ? pr.totals : null;
  const n = (k) => (t ? (Number.isInteger(t[k]) ? t[k] : 0) : null);
  const out = {
    roots: pr && Number.isInteger(pr.totals_roots) ? pr.totals_roots : null,
    creates: n("create"),
    updates: n("update"),
    deletes: n("delete"),
    error: typeof error === "string" && error ? error : null,
  };
  return { ...out, ...extra };
}

/** How many of `len` characters are typed `elapsedMs` after the line began. Reduced motion shows all at once. */
export function typedChars(len, elapsedMs, { reduced = false, msPerChar = TYPE_MS } = {}) {
  if (reduced || msPerChar <= 0) return len;
  return Math.max(0, Math.min(len, Math.floor(elapsedMs / msPerChar)));
}

// A note (the opening, the closing) is a line with no mark, shown at once and announced by no event.
// A reply with neither a prompt nor an action has no line of its own: the reply prints alone.
const lineOf = (beat) =>
  beat.note
    ? { mark: "", text: beat.note, typed: false }
    : beat.prompt
      ? { mark: MARKS.prompt, text: beat.prompt, typed: true }
      : beat.action
        ? { mark: MARKS.action, text: beat.action, typed: false }
        : { mark: "", text: "", typed: false };

/** The beat's reply, as the pane has it: the filled text once known, else the template (its length is a fair guess for timing). */
const replyOf = (beat, filled) => (typeof filled === "string" ? filled : typeof beat.reply === "string" ? beat.reply : "");


/**
 * One beat's timing: the cursor's pause, how long its line takes to type, when
 * its busy line starts (`busyAt`, as soon as the line is done), when its reply
 * starts (after the busy line has shown for BUSY_MIN_MS, when the beat has a
 * line and a reply), how long the reply takes to type, and when the beat is
 * over. `reply` is the filled text when the pane has it.
 */
export function beatTiming(beat, { reduced = false, msPerChar = TYPE_MS, replyMs = REPLY_TYPE_MS, reply } = {}) {
  const line = lineOf(beat);
  const typed = line.typed && !reduced;
  const cursor = typed ? CURSOR_PAUSE_MS : 0;
  const typing = typed ? line.text.length * msPerChar : 0;
  const busyAt = cursor + typing;
  const busy = beat.reply && hasLine(beat) && !reduced ? BUSY_MIN_MS : 0;
  const replyAt = busyAt + busy;
  const replyType = beat.reply && !reduced ? replyOf(beat, reply).length * replyMs : 0;
  return { cursor, typing, busyAt, replyAt, replyType, end: replyAt + replyType };
}

/** Whether a beat has a prompt or an action line of its own (a note and a lone reply do not). */
const hasLine = (beat) => !beat.note && !!(beat.prompt || beat.action);

/**
 * Where a step's beats stand `elapsedMs` after the step began: for each beat
 * started, its line as typed so far, and its state. `ready` is a prompt whose
 * first character is not typed yet (the cursor's pause); `busy` is the busy
 * line showing (`busySince` is when it began, in ms from the step's start);
 * `sumSecs` is the length of a busy phase that has ended (a reply came, or the
 * next beat began), else null; then the reply's progress, and `over`.
 * `gap` is true while a later beat has not begun. `end` is when the last beat
 * is over. Beats play in order with {@link BEAT_GAP_MS} between.
 * `opts.replies[i]` is beat i's filled reply once the pane has it.
 */
export function playback(beats, elapsedMs, opts = {}) {
  const timings = [];
  const starts = [];
  let at = 0;
  beats.forEach((beat, i) => {
    const t = beatTiming(beat, { ...opts, reply: opts.replies ? opts.replies[i] : undefined });
    timings.push(t);
    starts.push(at);
    at += t.end + BEAT_GAP_MS;
  });
  const end = beats.length ? at - BEAT_GAP_MS : 0;
  const frames = [];
  let done = true;
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const t = timings[i];
    const local = elapsedMs - starts[i];
    if (local < 0) {
      done = false;
      break;
    }
    const line = lineOf(beat);
    const n = line.typed ? typedChars(line.text.length, local - t.cursor, opts) : line.text.length;
    const lined = hasLine(beat);
    const replied = !!beat.reply && local >= t.replyAt;
    const full = replyOf(beat, opts.replies ? opts.replies[i] : undefined);
    const replyChars = replied ? typedChars(full.length, local - t.replyAt, { reduced: opts.reduced, msPerChar: opts.replyMs ?? REPLY_TYPE_MS }) : 0;
    const nextStarted = i + 1 < beats.length && elapsedMs >= starts[i + 1];
    const over = local >= t.end;
    if (!over) done = false;
    const busy = lined && local >= t.busyAt && !replied && !nextStarted;
    let sumSecs = null;
    if (lined && replied) sumSecs = Math.round((t.replyAt - t.busyAt) / 1000);
    else if (lined && nextStarted) sumSecs = Math.round((starts[i + 1] - starts[i] - t.busyAt) / 1000);
    frames.push({
      index: i,
      mark: line.mark,
      text: line.text.slice(0, n),
      typing: n < line.text.length,
      ready: line.typed && n === 0,
      lined,
      busy,
      busySince: starts[i] + t.busyAt,
      sumSecs,
      replied,
      replyChars,
      replyTyping: replied && replyChars < full.length,
      over,
    });
  }
  return { frames, done, gap: frames.length < beats.length, end };
}

/** m:ss */
const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

/** A label's first sentence, without its closing full stop. */
export function firstSentence(label) {
  if (typeof label !== "string") return "";
  const t = label.trim();
  const m = t.match(/^.*?[.!?](?=\s|$)/s);
  return (m ? m[0] : t).replace(/\.$/, "").trim();
}

/**
 * The text of the status line a step shows under the transcript: the last
 * `status` its beats carry, else, when the step has no ask at all, the step's
 * label cut to its first sentence. Null when the step is a prompt with nothing
 * to wait for.
 */
export function statusText(demo) {
  if (!demo) return null;
  const beats = askBeats(demo);
  for (let i = beats.length - 1; i >= 0; i--) if (typeof beats[i].status === "string" && beats[i].status.trim()) return beats[i].status.trim();
  if (beats.length || demo.opening || demo.closing) return null;
  return firstSentence(demo.label) || null;
}

/** The seconds since the step began: the driver's `started_at` when it has one, else `since` (ms). Never negative. */
export function elapsedSecs(demo, nowMs, since) {
  const from = demo && typeof demo.started_at === "string" ? Date.parse(demo.started_at) : NaN;
  return Math.max(0, Math.round((nowMs - (Number.isFinite(from) ? from : since)) / 1000));
}

export const elapsedClock = clock;

/** Whether a step is the first in which a scenario's opening line shows, and the one its closing shows in. */
export const OPENING_STEPS = ["pull-request", "planned"];
export const CLOSING_STEP = "applied";


const STYLE_ID = "k-ask-style";
/**
 * The pane's own look: the ready light on its top edge, the cursor, the busy
 * line and the dimmed turns. Layout (size, place) stays with kiosk.html.
 */
export const PANE_CSS = `
#k-ask { --ask-accent: var(--pending, #e0a030); --ask-agent: var(--ink2, var(--fg)); overflow-y: auto; overflow-x: hidden; justify-content: flex-start; scrollbar-width: none; border-top: 3px solid var(--rule); transition: border-color 0.3s ease, box-shadow 0.3s ease; }
#k-ask > :first-child { margin-top: auto; }
#k-ask::-webkit-scrollbar { display: none; }
#k-ask.ask-ready { border-top-color: var(--ask-accent); animation: ask-glow 1.8s ease-in-out infinite; }
#k-ask .ask-typing .ask-text::after, #k-ask .ask-reply-typing::after { content: "\\2588"; margin-left: 0.1em; }
#k-ask .ask-waiting .ask-text::after, #k-ask .ask-ready-line .ask-text::after { animation: ask-blink 1s steps(1) infinite; }
#k-ask .ask-ready-line .ask-text::after { content: "\\2588"; }
#k-ask .ask-ready-line .ask-mark { color: var(--ask-accent); }
#k-ask .ask-sum, #k-ask .ask-busy { display: flex; align-items: baseline; gap: 0.5em; padding-left: 0; font-size: 0.72em; font-weight: 500; }
#k-ask .ask-busy { font-size: 1em; padding-left: 1.6em; } /* the agent at work reads as large as its reply */
#k-ask .ask-sum { color: var(--muted); opacity: 0.8; }
#k-ask .ask-busy { color: var(--ask-agent); }
#k-ask .ask-spinner { flex: none; width: 1.2ch; text-align: center; }
#k-ask .ask-busy-text { min-width: 0; overflow-wrap: anywhere; }
#k-ask .ask-dots { flex: none; display: inline-block; min-width: 3ch; margin-left: -0.5em; }
#k-ask .ask-timer { flex: none; margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
@keyframes ask-blink { 50% { opacity: 0; } }
@keyframes ask-glow { 0%, 100% { box-shadow: 0 -2px 10px color-mix(in srgb, var(--ask-accent) 25%, transparent); } 50% { box-shadow: 0 -4px 22px color-mix(in srgb, var(--ask-accent) 70%, transparent); } }
@media (prefers-reduced-motion: reduce) {
  #k-ask { transition: none; }
  #k-ask.ask-ready { animation: none; box-shadow: 0 -3px 14px color-mix(in srgb, var(--ask-accent) 45%, transparent) !important; }
  #k-ask .ask-waiting .ask-text::after, #k-ask .ask-ready-line .ask-text::after { animation: none; }
}
`;

function injectStyle(doc) {
  if (!doc || !doc.head || (doc.getElementById && doc.getElementById(STYLE_ID))) return;
  const st = doc.createElement("style");
  st.id = STYLE_ID;
  st.textContent = PANE_CSS;
  doc.head.appendChild(st);
}

/** A busy line's label: the status or the label, without its closing full stop or ellipsis. */
export const busyLabel = (text) => (typeof text === "string" ? text.replace(/(\.{1,3}|…)\s*$/, "").trim() : "") || "Working";

/** The spinner glyph and the ellipsis at time `ms`; reduced motion keeps them still. */
export const spinnerAt = (ms, reduced = false) => (reduced ? SPINNER[0] : SPINNER[Math.floor(ms / SPIN_MS) % SPINNER.length]);
export const ellipsisAt = (ms, reduced = false) => (reduced ? "…" : ".".repeat((Math.floor(ms / ELLIPSIS_MS) % 3) + 1));

/**
 * The turns a transcript shows once a step's turns follow the earlier ones: a
 * turn with no line of its own (`cont`: a lone reply, or a status-only step's
 * busy line) continues the last turn.
 */
export function mergeTurns(done, more) {
  const out = done.map((t) => ({ ...t, parts: [...t.parts] }));
  for (const t of more) {
    if (t.cont && out.length) out[out.length - 1].parts.push(...t.parts);
    else out.push({ ...t, parts: [...t.parts] });
  }
  return out;
}

/** A turn whose busy line has ended becomes the dim summary line, `secs` long. */
export const settleTurns = (turns, nowMs) => turns.map((t) => ({ ...t, ready: false, typing: false, parts: t.parts.map((p) => (p.k === "busy" ? { k: "sum", label: p.label, secs: Math.max(0, Math.floor((nowMs - p.since) / 1000)) } : p)) }));

/**
 * The pane. `host` is its element; `fill()` gives the reply tokens from the
 * report as it stands; `now()` the time. `win` is where events go and
 * `reduced()` says whether motion is reduced. Once a scenario's step has put
 * something in the pane, the pane stays until a reset (no demo) or another
 * scenario. Steps that arrive while one is still playing wait their turn.
 * Returns:
 * - `setStep(demo)`: take a narration; returns whether the pane shows;
 * - `active()`: whether it shows now.
 */
export function createAskPane({ host, win = typeof window !== "undefined" ? window : null, now = () => new Date(), fill = () => ({}), reduced = () => false, onActive = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  const doc = host.ownerDocument;
  let key = null;
  let cycleKey = null;
  let openedFor = null;
  let demo = null;
  let beats = [];
  let wanted = null;
  // The status that is a busy line of its own: one that no beat with a line or a reply carries (that beat's busy line shows it).
  let tail = null;
  let tailTips;
  let busyId = null;
  let startedAt = 0;
  let started = -1;
  let finished = -1;
  let replies = [];
  let transcript = [];
  let queue = [];
  let timer = null;
  let shown = false;
  let engaged = false;
  let peak = 0;
  let sig = "";
  let live = [];
  let released = false;
  let lastView = { turns: [], ready: false, hostReady: false };

  const emit = (type, detail) => {
    if (win && typeof win.dispatchEvent === "function" && typeof CustomEvent === "function") win.dispatchEvent(new CustomEvent(type, { detail }));
  };
  /** `behold:ask-busy` whenever the busy line changes: `{ busy, id, tips, cycle, scenario, step }` (id null when none shows). */
  const setBusy = (id, part) => {
    if (id === busyId) return;
    busyId = id;
    emit("behold:ask-busy", { busy: id !== null, id, tips: part && part.tips ? part.tips : null, cycle: demo ? demo.cycle : null, scenario: demo ? demo.scenario : null, step: demo ? demo.step : null });
  };
  const detailOf = (beat) => ({ ask: beat, step: demo.step, scenario: demo.scenario });
  const el = (cls, text) => {
    const n = doc.createElement("div");
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const span = (cls, text) => {
    const n = doc.createElement("span");
    n.className = cls;
    n.textContent = text;
    return n;
  };
  const addClass = (n, c) => n.classList && n.classList.add && n.classList.add(c);
  const lineNode = (mark, text) => {
    const line = el("ask-line");
    line.append(span("ask-mark", mark), span("ask-text", text));
    return line;
  };
  const busyNode = (p, t) => {
    const n = el("ask-busy");
    const sp = span("ask-spinner", spinnerAt(t, reduced()));
    const tx = span("ask-busy-text", p.label);
    const dots = span("ask-dots", ellipsisAt(t, reduced()));
    const tm = span("ask-timer", "");
    // The glyph, the dots and the timer turn every tick; screen readers get the label once.
    for (const x of [sp, dots, tm]) x.setAttribute && x.setAttribute("aria-hidden", "true");
    n.append(sp, tx, dots, tm);
    live.push({ sp, dots, tm, since: p.since });
    return n;
  };
  const refresh = (t) => {
    const r = reduced();
    for (const l of live) {
      l.sp.textContent = spinnerAt(t, r);
      l.dots.textContent = ellipsisAt(t, r);
      l.tm.textContent = `(${clock(Math.max(0, Math.floor((t - l.since) / 1000)))})`;
    }
  };
  const turnNode = (tn, cls, t) => {
    const e = el(`ask-entry ${cls}`);
    if (tn.text !== "" || tn.mark) e.appendChild(lineNode(tn.mark, tn.text));
    if (tn.typing) addClass(e, "ask-typing");
    if (tn.ready) addClass(e, "ask-waiting");
    for (const p of tn.parts) {
      if (p.k === "busy") e.appendChild(busyNode(p, t));
      else if (p.k === "sum") e.appendChild(el("ask-sum", `✓ ${p.label} (${clock(p.secs)})`));
      else e.appendChild(el(p.typing ? "ask-reply ask-reply-typing" : "ask-reply", p.text));
    }
    return e;
  };

  /** What the current step shows now: its turns, whether the pane waits for a prompt, and when it lets the graph go. */
  function build(t) {
    const reducedNow = reduced();
    const elapsed = t - startedAt;
    const pb = playback(beats, elapsed, { reduced: reducedNow, replies });
    const label = (beat) => busyLabel((beat && beat.status) || wanted || firstSentence(demo && demo.label));
    const turns = [];
    for (const f of pb.frames) {
      const beat = beats[f.index];
      const tn = f.lined || beat.note ? { mark: f.mark, text: f.text, note: !!beat.note, typing: f.typing || f.ready, ready: f.ready, parts: [] } : { cont: true, mark: "", text: "", parts: [] };
      if (f.busy) tn.parts.push({ k: "busy", label: label(beat), since: startedAt + f.busySince, tips: beat.tips, bid: `b${f.index}` });
      else if (f.sumSecs !== null) tn.parts.push({ k: "sum", label: label(beat), secs: f.sumSecs });
      if (f.replied) tn.parts.push({ k: "reply", text: (replies[f.index] || "").slice(0, f.replyChars), typing: f.replyTyping });
      turns.push(tn);
    }
    const last = pb.frames[pb.frames.length - 1];
    let busyAt = last && last.busy ? last.busySince : null;
    // A status after the beats (or a step that is only a status) is a busy line under the turn it belongs to.
    if (pb.done && tail && !(last && last.busy)) {
      const since = beats.length ? startedAt + pb.end : Math.min(t, elapsedSince());
      busyAt = since - startedAt;
      const part = { k: "busy", label: busyLabel(tail), since, tips: tailTips, bid: "tail" };
      if (turns.length) turns[turns.length - 1].parts.push(part);
      else turns.push({ cont: true, mark: "", text: "", parts: [part] });
    }
    const busyNow = turns.some((x) => x.parts.some((p) => p.k === "busy"));
    const closing = !!(demo && demo.closing && demo.step === CLOSING_STEP);
    const typingNext = !!(last && last.ready);
    // Ready: waiting for the next prompt, between beats or once this step has said all it will.
    const ready = !typingNext && ((pb.gap && !busyNow) || (pb.done && !busyNow && !closing));
    return { pb, turns, ready, hostReady: ready || typingNext, busyAt: busyAt === null ? (pb.done ? pb.end : null) : busyAt };
  }
  const elapsedSince = () => {
    const from = demo && typeof demo.started_at === "string" ? Date.parse(demo.started_at) : NaN;
    return Number.isFinite(from) ? from : startedAt;
  };

  /** When, in ms from the step's start, a step lets the graph go (null: its beats' own events do). */
  function releaseAt(b) {
    const real = beats.some((x) => !x.note && (x.prompt || x.action || x.reply));
    if (real && !tail) return null;
    const from = b.pb.done ? Math.max(b.pb.end, b.busyAt === null ? 0 : b.busyAt) : null;
    return from === null ? null : from + BUSY_MIN_MS;
  }

  function draw() {
    const t = now().getTime();
    let b = build(t);
    let pb = b.pb;
    let filled = false;
    for (const f of pb.frames) {
      const beat = beats[f.index];
      if (f.index > started) {
        started = f.index;
        if (!beat.note) emit("behold:ask-start", detailOf(beat));
      }
      if (f.replied && replies[f.index] === undefined) {
        replies[f.index] = fillReply(beat.reply, fill());
        filled = true;
      }
    }
    if (filled) {
      b = build(t);
      pb = b.pb;
    }
    for (const f of pb.frames) {
      // The graph lights on this, so it waits for the reply to finish typing.
      if (f.over && f.index > finished) {
        finished = f.index;
        if (!beats[f.index].note) emit("behold:ask-done", detailOf(beats[f.index]));
      }
    }
    // A step with only a status (or no ask at all) lets the graph go once its busy line has shown for BUSY_MIN_MS.
    const due = releaseAt(b);
    const settled = pb.done && (due === null || t - startedAt >= due);
    if (!released && settled && due !== null) {
      released = true;
      if (tail) emit("behold:ask-status", { status: tail, step: demo.step, scenario: demo.scenario });
      else if (!beats.some((x) => !x.note && (x.prompt || x.action || x.reply))) emit("behold:ask-clear", { step: demo.step, scenario: demo.scenario });
    }
    // behold#tips: the busy line showing now (a status-only step's, or a turn's wait), for the tip cards (web/kiosk-ask-tips.js).
    const bp = b.turns.flatMap((x) => x.parts).find((p) => p.k === "busy");
    setBusy(bp ? `${key}|${bp.bid}` : null, bp);
    const view = { turns: mergeTurns(transcript, b.turns), ready: b.ready, hostReady: b.hostReady };
    lastView = view;
    const next = JSON.stringify([view.turns.slice(-(MAX_TURNS)).map((x) => [x.mark, x.text, x.typing, x.ready, x.parts.map((p) => [p.k, p.label, p.secs, p.text, p.typing])]), view.ready, view.hostReady]);
    if (next !== sig) {
      // Rebuilt only when something changed, so the cursor keeps blinking.
      sig = next;
      live = [];
      const rows = view.turns.slice(-MAX_TURNS).map((x, i, all) => turnNode(x, i === all.length - 1 ? "ask-cur" : `ask-old ask-old-${Math.min(KEEP, all.length - 1 - i)}`, t));
      if (view.ready) {
        const r = el("ask-entry ask-ready-line");
        r.appendChild(lineNode(MARKS.prompt, ""));
        rows.push(r);
      }
      host.replaceChildren(...rows);
      if (host.classList && host.classList.toggle) host.classList.toggle("ask-ready", view.hostReady);
      // The newest line is always in view.
      if ("scrollTop" in host) host.scrollTop = host.scrollHeight;
      // Sized to its content, never shorter than the tallest this scenario has needed.
      if (host.style) {
        host.style.minHeight = "";
        peak = paneHeight(peak, host.offsetHeight || 0);
        if (peak > 0) host.style.minHeight = `${peak}px`;
      }
    }
    refresh(t);
    if (settled && queue.length) {
      begin(queue.shift());
      return;
    }
    if (settled && !live.length && timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  /** What the step shown joins the transcript, its busy line collapsed into a summary. */
  function commit() {
    if (!demo) return;
    const t = now().getTime();
    const b = build(t);
    transcript = mergeTurns(transcript, settleTurns(b.turns, t)).slice(-MAX_TURNS);
  }

  function begin(d) {
    if (demo) commit();
    key = d ? `${d.cycle}|${d.scenario}|${d.step}` : null;
    const sc = d ? `${d.cycle}|${d.scenario}` : null;
    if (sc !== cycleKey) {
      // A reset (no demo) or another scenario clears the pane.
      cycleKey = sc;
      transcript = [];
      queue = [];
      peak = 0;
      engaged = false;
    }
    demo = d;
    const asked = askBeats(d);
    // A status alone has no line to play: it is the status line.
    beats = asked.filter((a) => a.prompt || a.action || a.reply);
    // The opening shows once, at the scenario's first step; the closing after the last step's own beats.
    if (d && d.opening && OPENING_STEPS.includes(d.step) && openedFor !== sc) {
      openedFor = sc;
      beats.unshift({ note: d.opening });
    }
    if (d && d.closing && d.step === CLOSING_STEP) beats.push({ note: d.closing });
    wanted = statusText(d);
    const lastStatus = asked.filter((a) => typeof a.status === "string" && a.status.trim()).pop();
    const withTips = asked.filter((a) => a.tips && a.tips.length).pop();
    tailTips = (lastStatus && lastStatus.tips) || (withTips && withTips.tips) || undefined;
    tail = wanted && !(lastStatus && (lastStatus.prompt || lastStatus.action || lastStatus.reply)) ? wanted : null;
    started = -1;
    finished = -1;
    replies = [];
    sig = "";
    live = [];
    released = false;
    startedAt = now().getTime();
    // The graph holds still from the first moment of a step until the turn that asks for a change has replied.
    if (d) emit("behold:ask-hold", { step: d.step, scenario: d.scenario });
    if (beats.length || asked.length) engaged = true;
    const on = !!d && engaged;
    shown = on;
    if (timer !== null) clearTimer(timer);
    timer = null;
    host.hidden = !on;
    if (on) {
      injectStyle(doc);
      draw();
      if (timer === null && demo === d) timer = setTimer(draw, 40);
    } else {
      setBusy(null, null);
      host.replaceChildren();
      if (host.classList && host.classList.remove) host.classList.remove("ask-ready");
      if (host.style) host.style.minHeight = "";
    }
    onActive(on);
  }

  function setStep(next) {
    const d = next && next.demo !== undefined ? next.demo : next;
    const nextKey = d ? `${d.cycle}|${d.scenario}|${d.step}` : null;
    const lastKey = queue.length ? `${queue[queue.length - 1].cycle}|${queue[queue.length - 1].scenario}|${queue[queue.length - 1].step}` : key;
    if (nextKey === lastKey) return shown;
    const sc = d ? `${d.cycle}|${d.scenario}` : null;
    if (sc === cycleKey && demo && shown) {
      // Same scenario: the step on screen plays out first.
      const b = build(now().getTime());
      const due = releaseAt(b);
      const settled = b.pb.done && (due === null || now().getTime() - startedAt >= due);
      if (!settled || queue.length) {
        queue = [...queue, d].slice(-MAX_QUEUE);
        return shown;
      }
    }
    queue = [];
    begin(d);
    return shown;
  }

  return { setStep, active: () => shown, draw, view: () => lastView };
}
