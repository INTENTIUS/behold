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
 * - `behold:ask-clear` on a new step with no ask.
 *
 * `{dependents}` is not filled here: behold#937 sets
 * `window.beholdAskTokens = { dependents: <n> }` when it hears ask-start, and
 * the reply reads that object when it prints.
 */

/** Milliseconds per typed character (the spec: 30 to 50). */
export const TYPE_MS = 40;
/** From the end of a typed line to its reply. */
export const REPLY_PAUSE_MS = 500;
/** From a beat's end to the next beat's start. */
export const BEAT_GAP_MS = 1500;
/** Entries kept above the current one, faded. */
export const KEEP = 3;
export const MARKS = { prompt: ">", action: "✓" };

/** A demo's beats in order: `asks` when it has some, else `ask`, else none. */
export function askBeats(demo) {
  if (!demo) return [];
  if (Array.isArray(demo.asks) && demo.asks.length) return demo.asks.filter((a) => a && (a.prompt || a.action));
  return demo.ask && (demo.ask.prompt || demo.ask.action) ? [demo.ask] : [];
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
const lineOf = (beat) => (beat.note ? { mark: "", text: beat.note, typed: false } : beat.prompt ? { mark: MARKS.prompt, text: beat.prompt, typed: true } : { mark: MARKS.action, text: beat.action || "", typed: false });

/** One beat's timing: how long its line takes to appear, when its reply prints, and when it is over. */
export function beatTiming(beat, { reduced = false, msPerChar = TYPE_MS } = {}) {
  const line = lineOf(beat);
  const typing = line.typed && !reduced ? line.text.length * msPerChar : 0;
  const replyAt = beat.reply ? typing + (reduced ? 0 : REPLY_PAUSE_MS) : typing;
  return { typing, replyAt, end: replyAt };
}

/**
 * Where a step's beats stand `elapsedMs` after the step began: for each beat
 * started, its line as typed so far and whether its reply has printed; and
 * whether all are over. Beats play in order with {@link BEAT_GAP_MS} between.
 */
export function playback(beats, elapsedMs, opts = {}) {
  const frames = [];
  let at = 0;
  let done = true;
  beats.forEach((beat, i) => {
    const t = beatTiming(beat, opts);
    const local = elapsedMs - at;
    at += t.end + BEAT_GAP_MS;
    if (local < 0) return void (done = false);
    const line = lineOf(beat);
    const n = line.typed ? typedChars(line.text.length, local, opts) : line.text.length;
    const replied = !!beat.reply && local >= t.replyAt;
    const over = local >= t.end;
    if (!over) done = false;
    frames.push({ index: i, mark: line.mark, text: line.text.slice(0, n), typing: n < line.text.length, replied, over });
  });
  return { frames, done };
}

/** m:ss */
const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

const JOB_WORDS = { "pull-request": "Planning the change", approved: "Applying the plan", merged: "Applying the plan", applying: "Applying the plan", resumed: "Applying the plan" };

/**
 * The status line under the current entry while a job runs: what is
 * happening, the elapsed time since the step began (`started_at`), and, when
 * the driver has named it, what it waits for next and how soon (`next`).
 * Null on a step with no job.
 */
export function statusLine(demo, now = new Date()) {
  if (!demo || !JOB_WORDS[demo.step]) return null;
  const from = Date.parse(demo.started_at);
  const parts = [JOB_WORDS[demo.step]];
  if (Number.isFinite(from)) parts.push(clock(Math.max(0, Math.round((now.getTime() - from) / 1000))));
  const next = demo.next;
  if (next && typeof next.action === "string" && next.action) {
    const at = typeof next.at === "string" ? Date.parse(next.at) : NaN;
    parts.push(Number.isFinite(at) ? `next: ${next.action} in ${Math.max(0, Math.round((at - now.getTime()) / 1000))} s` : `next: ${next.action}`);
  }
  return parts.join(" · ");
}

/** Whether a step is the first in which a scenario's opening line shows, and the one its closing shows in. */
export const OPENING_STEPS = ["pull-request", "planned"];
export const CLOSING_STEP = "applied";

/**
 * The pane. `host` is its element; `fill()` gives the reply tokens from the
 * report as it stands; `now()` the time. `win` is where events go and
 * `reduced()` says whether motion is reduced. Returns:
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
  let startedAt = 0;
  let started = -1;
  let finished = -1;
  let replies = [];
  let history = [];
  let timer = null;
  let shown = false;

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
  const entry = (cls, mark, text, reply) => {
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
    if (reply) e.appendChild(el("ask-reply", reply));
    return e;
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

  function draw() {
    const reducedNow = reduced();
    const pb = playback(beats, now().getTime() - startedAt, { reduced: reducedNow });
    for (const f of pb.frames) {
      const beat = beats[f.index];
      if (f.index > started) {
        started = f.index;
        if (!beat.note) emit("behold:ask-start", detailOf(beat));
      }
      if (f.replied && replies[f.index] === undefined) replies[f.index] = fillReply(beat.reply, fill());
      if (f.over && f.index > finished) {
        finished = f.index;
        if (!beat.note) emit("behold:ask-done", detailOf(beat));
      }
    }
    const rows = [];
    history.slice(-KEEP).forEach((h, i, all) => rows.push(entry(`ask-old ask-old-${all.length - i}`, h.mark, h.text, h.reply)));
    pb.frames.forEach((f, i) => {
      const cur = i === pb.frames.length - 1;
      const text = f.text;
      const e = entry(cur ? "ask-cur" : "ask-old ask-old-1", f.mark, text, f.replied ? replies[f.index] : "");
      if (cur && f.typing) e.classList.add("ask-typing");
      rows.push(e);
    });
    const status = statusLine(demo, now());
    const out = rows.slice(-(KEEP + 1));
    if (status) out.push(el("ask-status", status));
    host.replaceChildren(...out);
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
      cycleKey = sc;
      history = [];
    }
    demo = d;
    const asked = askBeats(d);
    beats = asked.slice();
    // The opening shows once, at the scenario's first step; the closing after the last step's own beats.
    if (d && d.opening && OPENING_STEPS.includes(d.step) && openedFor !== sc) {
      openedFor = sc;
      beats.unshift({ note: d.opening });
    }
    if (d && d.closing && d.step === CLOSING_STEP) beats.push({ note: d.closing });
    started = -1;
    finished = -1;
    replies = [];
    startedAt = now().getTime();
    if (d && !asked.length) emit("behold:ask-clear", { step: d.step, scenario: d.scenario });
    const on = beats.length > 0;
    shown = on;
    if (timer !== null) clearTimer(timer);
    timer = null;
    host.hidden = !on;
    if (on) {
      draw();
      timer = setTimer(draw, 40);
    } else host.replaceChildren();
    onActive(on);
    return on;
  }

  return { setStep, active: () => shown, draw };
}
