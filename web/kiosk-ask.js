/**
 * behold#936: the kiosk's prompt pane. While a demo step has an `ask` (or
 * `asks`), a big monospace pane at the bottom of the screen replaces the
 * header and the caption: the person's prompt is typed after a `>`, an action
 * line (a check mark) is shown at once, and the agent's reply prints after
 * it. terragucci's demo.json writes the fields (src/terragucci-demo.ts has
 * the shapes); the replies are templates filled here from the step's report.
 *
 * The timeline, the typing and the template filling are pure functions, so
 * they are tested without a page. {@link createAskPane} is the one part that
 * touches the document, and it tells the rest of the page through window
 * events (the shared interface with behold#937's lighting):
 *
 * - `behold:ask-start` before a beat is typed, `behold:ask-done` when its
 *   reply has printed, each with detail `{ ask, step, scenario }`;
 * - `behold:ask-clear` on a new step with no ask;
 * - `behold:ask-status` with `{ status, step, scenario }` when a status line
 *   shows (a step's `ask.status`, or its label's first sentence).
 *
 * The pane never empties during a scenario: a step with no prompt keeps the
 * transcript and shows a status line under it (a spinner, the text and an
 * m:ss timer). A reply types after the prompt, and `ask-done` follows only
 * once it has finished typing, since the graph lights on it.
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
/** How long the pane's border flashes when a new prompt or action starts. */
export const FLASH_MS = 700;
/** From the end of a typed line to its reply. */
export const REPLY_PAUSE_MS = 500;
/** From a beat's end to the next beat's start. */
export const BEAT_GAP_MS = 1500;
/** Entries kept above the current one, faded. */
export const KEEP = 3;
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
 * its reply starts, how long the reply takes to type, and when the beat is over
 * (the reply has finished typing). `reply` is the filled text when the pane has it.
 */
export function beatTiming(beat, { reduced = false, msPerChar = TYPE_MS, replyMs = REPLY_TYPE_MS, reply } = {}) {
  const line = lineOf(beat);
  const typed = line.typed && !reduced;
  const cursor = typed ? CURSOR_PAUSE_MS : 0;
  const typing = typed ? line.text.length * msPerChar : 0;
  const replyAt = beat.reply ? cursor + typing + (reduced ? 0 : REPLY_PAUSE_MS) : cursor + typing;
  const replyType = beat.reply && !reduced ? replyOf(beat, reply).length * replyMs : 0;
  return { cursor, typing, replyAt, replyType, end: replyAt + replyType };
}

/**
 * Where a step's beats stand `elapsedMs` after the step began: for each beat
 * started, its line as typed so far, whether its reply has started and how
 * much of it is typed, and whether it is over; and whether all are over. Beats
 * play in order with {@link BEAT_GAP_MS} between. `opts.replies[i]` is beat i's
 * filled reply once the pane has it. A beat with only a status has no line.
 */
export function playback(beats, elapsedMs, opts = {}) {
  const frames = [];
  let at = 0;
  let done = true;
  beats.forEach((beat, i) => {
    const filled = opts.replies ? opts.replies[i] : undefined;
    const t = beatTiming(beat, { ...opts, reply: filled });
    const local = elapsedMs - at;
    at += t.end + BEAT_GAP_MS;
    if (local < 0) return void (done = false);
    const line = lineOf(beat);
    const n = line.typed ? typedChars(line.text.length, local - t.cursor, opts) : line.text.length;
    const replied = !!beat.reply && local >= t.replyAt;
    const full = replyOf(beat, filled);
    const replyChars = replied ? typedChars(full.length, local - t.replyAt, { reduced: opts.reduced, msPerChar: opts.replyMs ?? REPLY_TYPE_MS }) : 0;
    const over = local >= t.end;
    if (!over) done = false;
    frames.push({ index: i, mark: line.mark, text: line.text.slice(0, n), typing: n < line.text.length, replied, replyChars, replyTyping: replied && replyChars < full.length, over });
  });
  return { frames, done };
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
/** The pane's own look: the status line, the cursor, the border flash. Layout (size, place) stays with kiosk.html. */
export const PANE_CSS = `
#k-ask { overflow-y: auto; overflow-x: hidden; justify-content: flex-start; scrollbar-width: none; }
#k-ask > :first-child { margin-top: auto; }
#k-ask::-webkit-scrollbar { display: none; }
#k-ask .ask-typing .ask-text::after, #k-ask .ask-reply-typing::after { content: "\\2588"; margin-left: 0.1em; }
#k-ask .ask-typing.ask-waiting .ask-text::after { animation: ask-blink 1s steps(1) infinite; }
#k-ask .ask-status { display: flex; align-items: center; gap: 0.6em; padding-left: 0; margin-top: 0.2em; font-size: 0.7em; font-weight: 500; color: var(--muted); }
#k-ask .ask-spinner { flex: none; width: 0.9em; height: 0.9em; box-sizing: border-box; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: ask-spin 0.9s linear infinite; }
#k-ask .ask-status-text { min-width: 0; overflow-wrap: anywhere; }
#k-ask .ask-timer { flex: none; margin-left: auto; font-variant-numeric: tabular-nums; }
#k-ask.ask-flash { animation: ask-flash ${FLASH_MS}ms ease-out 1; }
@keyframes ask-blink { 50% { opacity: 0; } }
@keyframes ask-spin { to { transform: rotate(360deg); } }
@keyframes ask-flash { 0% { box-shadow: inset 0 0 0 3px var(--pending, #e0a030), 0 0 18px var(--pending, #e0a030); } 100% { box-shadow: inset 0 0 0 3px transparent, 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { #k-ask .ask-spinner, #k-ask.ask-flash, #k-ask .ask-typing.ask-waiting .ask-text::after { animation: none; } }
`;

function injectStyle(doc) {
  if (!doc || !doc.head || (doc.getElementById && doc.getElementById(STYLE_ID))) return;
  const st = doc.createElement("style");
  st.id = STYLE_ID;
  st.textContent = PANE_CSS;
  doc.head.appendChild(st);
}

/**
 * The pane. `host` is its element; `fill()` gives the reply tokens from the
 * report as it stands; `now()` the time. `win` is where events go and
 * `reduced()` says whether motion is reduced. Once a scenario's step has put
 * something in the pane, the pane stays until a reset (no demo) or another
 * scenario: a step without a prompt shows a status line under the transcript.
 * Returns:
 * - `setStep(demo)`: take a narration; returns whether the pane shows;
 * - `active()`: whether it shows now.
 */
export function createAskPane({ host, win = typeof window !== "undefined" ? window : null, now = () => new Date(), fill = () => ({}), reduced = () => false, onActive = () => {}, setTimer = setInterval, clearTimer = clearInterval, later = (typeof setTimeout === "function" ? setTimeout : () => {}) }) {
  const doc = host.ownerDocument;
  let key = null;
  let cycleKey = null;
  let openedFor = null;
  let demo = null;
  let beats = [];
  let wanted = null;
  let startedAt = 0;
  let started = -1;
  let finished = -1;
  let replies = [];
  let history = [];
  let timer = null;
  let shown = false;
  let engaged = false;
  let peak = 0;
  let sig = "";
  let timerNode = null;
  let statusTold = null;

  const emit = (type, detail) => {
    if (win && typeof win.dispatchEvent === "function" && typeof CustomEvent === "function") win.dispatchEvent(new CustomEvent(type, { detail }));
  };
  const detailOf = (beat) => ({ ask: beat, step: demo.step, scenario: demo.scenario });
  const el = (cls, text) => {
    const n = doc.createElement("div");
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const entry = (cls, mark, text, reply, replyTyping) => {
    const e = el(`ask-entry ${cls}`);
    if (text !== "" || mark) {
      const line = el("ask-line");
      const m = doc.createElement("span");
      m.className = "ask-mark";
      m.textContent = mark;
      const t = doc.createElement("span");
      t.className = "ask-text";
      t.textContent = text;
      line.append(m, t);
      e.appendChild(line);
    }
    if (reply) e.appendChild(el(replyTyping ? "ask-reply ask-reply-typing" : "ask-reply", reply));
    return e;
  };
  const statusNode = (text, secs) => {
    const n = el("ask-status");
    const sp = doc.createElement("span");
    sp.className = "ask-spinner";
    const tx = doc.createElement("span");
    tx.className = "ask-status-text";
    tx.textContent = text;
    const tm = doc.createElement("span");
    tm.className = "ask-timer";
    tm.textContent = clock(secs);
    n.append(sp, tx, tm);
    timerNode = tm;
    return n;
  };
  const archive = () => {
    // What this step showed joins the faded entries above the next one.
    beats.forEach((beat, i) => {
      if (i > started) return;
      const l = lineOf(beat);
      history.push({ mark: l.mark, text: l.text, reply: replies[i] || "" });
    });
    history = history.slice(-KEEP);
  };
  // The border flashes once when a new prompt or action starts, to draw the eye down to it.
  const flash = () => {
    const c = host.classList;
    if (!c || typeof c.add !== "function") return;
    if (typeof c.remove === "function") c.remove("ask-flash");
    void host.offsetWidth; // restart the animation
    c.add("ask-flash");
    later(() => c.remove && c.remove("ask-flash"), FLASH_MS);
  };

  function draw() {
    const reducedNow = reduced();
    const t = now().getTime();
    const pb = playback(beats, t - startedAt, { reduced: reducedNow, replies });
    for (const f of pb.frames) {
      const beat = beats[f.index];
      if (f.index > started) {
        started = f.index;
        if (!beat.note) {
          emit("behold:ask-start", detailOf(beat));
          if (beat.prompt || beat.action) flash();
        }
      }
      if (f.replied && replies[f.index] === undefined) replies[f.index] = fillReply(beat.reply, fill());
      // The graph lights on this, so it waits for the reply to finish typing.
      if (f.over && f.index > finished) {
        finished = f.index;
        if (!beat.note) emit("behold:ask-done", detailOf(beat));
      }
    }
    // The status line shows once every beat is over; with no beats at all, at once.
    const status = pb.done ? wanted : null;
    if (status && statusTold !== status) {
      statusTold = status;
      emit("behold:ask-status", { status, step: demo.step, scenario: demo.scenario });
    }
    const secs = elapsedSecs(demo, t, startedAt);
    const frames = pb.frames.map((f) => ({ f, text: f.text, reply: f.replied ? (replies[f.index] || "").slice(0, f.replyChars) : "" }));
    const next = JSON.stringify([history.slice(-KEEP), frames.map((x) => [x.f.mark, x.text, x.reply, x.f.typing, x.f.replyTyping]), status]);
    if (next !== sig) {
      // Rebuilt only when something changed, so the spinner and the cursor keep turning.
      sig = next;
      timerNode = null;
      const rows = [];
      history.slice(-KEEP).forEach((h, i, all) => rows.push(entry(`ask-old ask-old-${all.length - i}`, h.mark, h.text, h.reply)));
      frames.forEach((x, i) => {
        const cur = i === frames.length - 1;
        const e = entry(cur ? "ask-cur" : "ask-old ask-old-1", x.f.mark, x.text, x.reply, x.f.replyTyping);
        if (cur && x.f.typing) {
          e.classList && e.classList.add && e.classList.add("ask-typing");
          if (x.text === "") e.classList && e.classList.add && e.classList.add("ask-waiting");
        }
        rows.push(e);
      });
      const out = rows.slice(-(KEEP + 1));
      if (status) out.push(statusNode(status, secs));
      host.replaceChildren(...out);
      // The newest line is always in view.
      if ("scrollTop" in host) host.scrollTop = host.scrollHeight;
      // Sized to its content, never shorter than the tallest this scenario has needed.
      if (host.style) {
        host.style.minHeight = "";
        peak = paneHeight(peak, host.offsetHeight || 0);
        if (peak > 0) host.style.minHeight = `${peak}px`;
      }
    } else if (timerNode) timerNode.textContent = clock(secs);
    if (pb.done && !status && timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function setStep(next) {
    const d = next && next.demo !== undefined ? next.demo : next;
    const nextKey = d ? `${d.cycle}|${d.scenario}|${d.step}` : null;
    if (nextKey === key) return shown;
    if (demo && beats.length) archive();
    key = nextKey;
    const sc = d ? `${d.cycle}|${d.scenario}` : null;
    if (sc !== cycleKey) {
      // A reset (no demo) or another scenario clears the pane.
      cycleKey = sc;
      history = [];
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
    started = -1;
    finished = -1;
    replies = [];
    sig = "";
    timerNode = null;
    statusTold = null;
    startedAt = now().getTime();
    if (d && !asked.length) emit("behold:ask-clear", { step: d.step, scenario: d.scenario });
    if (beats.length || asked.length) engaged = true;
    const on = !!d && engaged;
    shown = on;
    if (timer !== null) clearTimer(timer);
    timer = null;
    host.hidden = !on;
    if (on) {
      injectStyle(doc);
      draw();
      timer = setTimer(draw, 40);
    } else {
      host.replaceChildren();
      if (host.style) host.style.minHeight = "";
    }
    onActive(on);
    return on;
  }

  return { setStep, active: () => shown, draw };
}
