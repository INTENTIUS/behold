// behold#631: the projected cycle track, a chant kiosk's bottom band.
//
// A viewer walking up to the loop between events saw breadcrumbs of what had
// happened and no idea of what was left. The track lays the whole cycle out
// from the first second, from the tool's last finished cycle
// (`cycles/<tool>/latest.json`, demo.cycle/v1): a segment per step, grouped
// into a chapter per pull request ("The change", "The fix"), as wide as that
// step took last time. Past segments are filled (a failure red, the end
// green), the current one fills as its time passes (never past 95% until the
// step really ends, with a sheen so a quiet stretch never looks frozen), and
// what is left stays outlined. Under it, the now line says what is happening
// and what is waited on, with the typical time.
//
// The same words make the "Waiting on…" modal (waitingSpec), the big version
// for someone just walking up, so the two always agree.
//
// Pure apart from drawTrack, which builds DOM from a model.

/** A segment's label, by the step it shows. A later pull request's open is the fix's. */
const LABELS = { "pull-request": "opened", planned: "planned", waiting: "review", approved: "review", merged: "merged", applying: "applying", resumed: "applying", failed: "failed", applied: "done", reset: "reset" };
/** The share of a step the fill reaches before the step really ends. */
export const FILL_CAP = 0.95;
/** A segment's least share of the track, so its label fits. */
export const MIN_SHARE = 0.045;
/** How long nothing must change before the "Waiting on…" modal shows. */
export const WAITING_AFTER_MS = 3_000;

const ms = (a, b) => Math.max(0, Date.parse(b) - Date.parse(a));
const secs = (n) => Math.max(1, Math.round(n / 1000));

/**
 * The track's frame from the last cycle: chapters, each with its segments, a
 * segment being one or more steps in a row with one label ("review" holds
 * waiting and approved). Each segment's `ms` is how long its steps took last
 * time. Null when the cycle has no steps.
 */
export function cycleTrack(cycle) {
  const steps = cycle && Array.isArray(cycle.steps) ? cycle.steps.filter((s) => s && typeof s.step === "string" && typeof s.at === "string") : [];
  if (!steps.length) return null;
  const end = typeof cycle.ended === "string" ? cycle.ended : null;
  const pulls = [];
  const chapters = [];
  steps.forEach((s, i) => {
    const next = steps[i + 1];
    const took = next ? ms(s.at, next.at) : end ? ms(s.at, end) : 3_000;
    // A step with no pull request of its own (the reset) closes the chapter it follows.
    let ci = Number.isInteger(s.pull) ? pulls.indexOf(s.pull) : chapters.length - 1;
    if (ci < 0) {
      pulls.push(s.pull);
      ci = pulls.length - 1;
      chapters.push({ index: ci, lastPull: s.pull, segments: [] });
    }
    if (ci < 0) return;
    const chapter = chapters[ci];
    const label = s.step === "pull-request" && ci > 0 ? "fix opened" : LABELS[s.step] || s.step;
    const last = chapter.segments[chapter.segments.length - 1];
    if (last && last.label === label) {
      last.steps.push(s.step);
      last.ms += took;
      return;
    }
    chapter.segments.push({ label, steps: [s.step], ms: took, labelText: s.label || "" });
  });
  const total = chapters.reduce((sum, c) => sum + c.segments.reduce((a, g) => a + g.ms, 0), 0) || 1;
  return { chapters, total, cycle: cycle.cycle };
}

/** "The change (PR #12)", "The fix (PR #13)": the current cycle's numbers once known, the chapter's role alone before. */
export function chapterTitle(index, pull) {
  const role = index === 0 ? "The change" : index === 1 ? "The fix" : `Pull request ${index + 1}`;
  return Number.isInteger(pull) ? `${role} (PR #${pull})` : role;
}

/**
 * The track as it stands now. `demo` is demo.json; `pulls` the pull requests
 * this cycle has opened, in order; `since` when the current segment began
 * (ms); `waves` the apply's waves as the paced graph shows them
 * ([{ wave, state }]), for the applying segment's ticks.
 */
export function trackModel(track, { demo, pulls = [], since = null, now = Date.now(), waves = null } = {}) {
  if (!track || !demo) return null;
  // Where the cycle is: the chapter of the current pull request (the reset, the last), the segment holding the step.
  const ci = demo.step === "reset" || !Number.isInteger(demo.pull) ? track.chapters.length - 1 : Math.max(0, pulls.indexOf(demo.pull));
  const chapter = track.chapters[Math.min(ci, track.chapters.length - 1)];
  const si = chapter ? chapter.segments.findIndex((g) => g.steps.includes(demo.step)) : -1;
  const at = { chapter: Math.min(ci, track.chapters.length - 1), segment: si };
  const elapsed = typeof since === "number" ? Math.max(0, now - since) : 0;
  const current = chapter && si >= 0 ? chapter.segments[si] : null;
  const expected = current ? current.ms : 0;
  const overrun = !!current && expected > 0 && elapsed > expected;
  const fill = current ? (expected > 0 ? Math.min(FILL_CAP, elapsed / expected) : FILL_CAP) : 0;
  const share = (g) => Math.max(MIN_SHARE, g.ms / track.total);
  const chapters = track.chapters.map((c, i) => ({
    title: chapterTitle(i, pulls[i]),
    state: i < at.chapter ? "done" : i === at.chapter ? "current" : "ahead",
    segments: c.segments.map((g, j) => {
      const state = i < at.chapter || (i === at.chapter && j < at.segment) ? "done" : i === at.chapter && j === at.segment ? "current" : "ahead";
      const tone = g.label === "failed" && state !== "ahead" ? "bad" : g.label === "done" && state !== "ahead" ? "ok" : state === "ahead" ? "ahead" : "past";
      return {
        label: g.label,
        share: share(g),
        state,
        tone,
        fill: state === "done" ? 1 : state === "current" ? fill : 0,
        ...(state === "current" && g.label === "applying" && Array.isArray(waves) && waves.length ? { ticks: waves.map((w) => ({ wave: w.wave, state: w.state })) } : {}),
      };
    }),
  }));
  const nowLine = nowWords({ demo, segment: current, expected, elapsed, overrun, waves, now, fix: at.chapter > 0 });
  return { chapters, at, elapsed, expected, overrun, now: nowLine };
}

const typical = (expected, overrun) => (overrun ? "taking longer than usual…" : expected > 0 ? `usually about ${secs(expected)} s` : null);
const countdown = (demo, now) => {
  const at = demo && demo.next && demo.next.at ? Date.parse(demo.next.at) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
};

/** What is happening now and what is waited on, in plain words: `{ text, waiting, why, expected, elapsed, overrun }`. */
export function nowWords({ demo, segment, expected = 0, elapsed = 0, overrun = false, waves = null, now = Date.now(), fix = false } = {}) {
  if (!demo || !segment) return null;
  const why = firstSentence(demo.label);
  const base = { why, expected, elapsed, overrun };
  const left = countdown(demo, now);
  const running = Array.isArray(waves) ? waves.filter((w) => w.state === "running").map((w) => w.wave) : [];
  const wavesSeen = Array.isArray(waves) && waves.some((w) => w.state && w.state !== "waiting");
  const say = (text, waiting = null, timed = true) => ({ ...base, text: timed && typical(expected, overrun) ? `${text} · ${typical(expected, overrun)}` : text, waiting });
  switch (segment.label) {
    case "opened":
    case "fix opened":
      return say("The pipeline is starting the plan job", "the pipeline to start the plan");
    case "planned":
      return say(fix ? "The fix is planned; a review is asked next" : "The plan is in; a review is asked next");
    case "review":
      return say("Waiting for the reviewer", "the reviewer to approve the plan");
    case "merged":
      return say("The pipeline is starting the apply job", "the pipeline to start the apply");
    case "applying":
      if (running.length) return say(`Wave ${running.join(" and ")} is applying`, null, false);
      if (wavesSeen) return say("The apply is under way", null, false);
      return say("The pipeline is starting the apply job", "the pipeline to start the apply");
    case "failed":
      return { ...base, text: left !== null && left > 0 ? `The fix opens in ${left} s` : "The fix opens next", waiting: "the fix to open" };
    case "done":
      return { ...base, text: left !== null && left > 0 ? `All done · reset in ${left} s` : "All done" };
    case "reset":
      return say("Resetting for the next cycle", null);
    default:
      return say(segment.label);
  }
}

/** A label's first sentence, when it reads as one line. */
function firstSentence(label) {
  if (typeof label !== "string" || !label.trim()) return null;
  const m = /^(.+?[.!?])(\s|$)/.exec(label.trim());
  const s = m ? m[1] : label.trim();
  return s.length <= 160 ? s : null;
}

/**
 * The "Waiting on…" modal, or null: only in a quiet stretch (nothing new for
 * {@link WAITING_AFTER_MS}), only for a step that waits on something (the
 * plan or apply job starting, the reviewer, the fix's countdown), never while
 * an apply is receiving events. `{ key, what, why, fraction, words }`.
 */
export function waitingSpec(model, { quietMs = 0, applyLive = false } = {}) {
  if (!model || !model.now || !model.now.waiting) return null;
  if (quietMs < WAITING_AFTER_MS) return null;
  if (applyLive) return null;
  const n = model.now;
  const fraction = n.expected > 0 ? Math.min(FILL_CAP, n.elapsed / n.expected) : null;
  return {
    key: `${model.at.chapter}|${model.at.segment}|${n.waiting}`,
    what: n.waiting,
    why: n.why,
    fraction,
    words: n.overrun ? "taking longer than usual" : n.expected > 0 ? `usually about ${secs(n.expected)} s` : null,
  };
}

/** The track's look, once per document. Motion only without prefers-reduced-motion. */
export const TRACK_STYLE = `
#k-track { display: flex; flex-direction: column; gap: 0.25em; padding: 0.35em 1.4em 0.4em; font: 600 0.8em var(--font-ui); color: var(--muted); background: var(--surface-pane-b); border-top: 1px solid color-mix(in srgb, var(--rule) 60%, transparent); border-radius: 8px 8px 0 0; }
body.k-watch #k-track { position: fixed; z-index: 7; left: 5px; right: 5px; }
#k-track .kt-row { display: flex; gap: 0.6em; align-items: stretch; min-width: 0; }
#k-track .kt-chapter { display: flex; flex-direction: column; gap: 0.15em; min-width: 0; }
#k-track .kt-chapter-title { font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg); }
#k-track .kt-chapter.kt-ahead .kt-chapter-title { color: var(--muted); }
#k-track .kt-segs { display: flex; gap: 3px; }
#k-track .kt-seg { position: relative; height: 1.7em; border-radius: 5px; border: 1.5px solid color-mix(in srgb, var(--muted) 60%, transparent); overflow: hidden; min-width: 0; }
#k-track .kt-seg .kt-fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--pending) 55%, transparent); }
#k-track .kt-seg.kt-past .kt-fill { background: color-mix(in srgb, var(--neutral, var(--muted)) 45%, transparent); }
#k-track .kt-seg.kt-ok { border-color: var(--frame-managed, var(--managed)); }
#k-track .kt-seg.kt-ok .kt-fill { background: color-mix(in srgb, var(--frame-managed, var(--managed)) 60%, transparent); }
#k-track .kt-seg.kt-bad { border-color: var(--frame-degraded, var(--degraded)); }
#k-track .kt-seg.kt-bad .kt-fill { background: color-mix(in srgb, var(--frame-degraded, var(--degraded)) 65%, transparent); }
#k-track .kt-seg.kt-current { border-color: var(--pending); }
#k-track .kt-seg .kt-label { position: relative; z-index: 1; display: block; padding: 0 0.4em; line-height: 1.7em; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: clip; color: var(--fg); text-align: center; }
#k-track .kt-seg.kt-ahead .kt-label { color: var(--muted); }
#k-track .kt-tick { position: absolute; top: 0; bottom: 0; width: 3px; background: color-mix(in srgb, var(--muted) 50%, transparent); }
#k-track .kt-tick.kt-tick-running { background: var(--frame-runtime, var(--runtime)); }
#k-track .kt-tick.kt-tick-applied { background: var(--frame-managed, var(--managed)); }
#k-track .kt-tick.kt-tick-failed { background: var(--frame-degraded, var(--degraded)); }
#k-track .kt-now { font-size: 1.05em; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (prefers-reduced-motion: no-preference) {
  #k-track .kt-seg.kt-current .kt-fill { transition: width 0.9s linear; }
  #k-track .kt-seg.kt-current .kt-fill::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, color-mix(in srgb, white 28%, transparent), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: kt-sheen 2.4s ease-in-out infinite; }
  @keyframes kt-sheen { from { background-position: -60% 0; } to { background-position: 160% 0; } }
}
@media (max-width: 600px) {
  body.k-watch #k-track { position: static; }
  #k-track .kt-segs .kt-label { display: none; }
  #k-track .kt-seg { height: 0.8em; }
}
`;

/** Draw the model into `host` (a fresh build each time: the track is a few dozen nodes). */
export function drawTrack(host, model, doc = typeof document !== "undefined" ? document : null) {
  if (!host || !doc) return;
  if (doc.head && !doc.getElementById("kt-style")) {
    const st = doc.createElement("style");
    st.id = "kt-style";
    st.textContent = TRACK_STYLE;
    doc.head.appendChild(st);
  }
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  host.replaceChildren();
  if (!model) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const row = el("div", "kt-row");
  const total = model.chapters.reduce((s, c) => s + c.segments.reduce((a, g) => a + g.share, 0), 0) || 1;
  for (const c of model.chapters) {
    const share = c.segments.reduce((a, g) => a + g.share, 0) / total;
    const ch = el("div", `kt-chapter kt-${c.state}`);
    ch.style.flex = `${share} 1 0`;
    ch.appendChild(el("div", "kt-chapter-title", c.title));
    const segs = el("div", "kt-segs");
    for (const g of c.segments) {
      const seg = el("div", `kt-seg kt-${g.state} kt-${g.tone}`);
      seg.style.flex = `${g.share} 1 0`;
      seg.title = g.label;
      const fill = el("div", "kt-fill");
      fill.style.width = `${Math.round(g.fill * 1000) / 10}%`;
      seg.appendChild(fill);
      if (g.ticks) {
        // The apply's waves, each a tick at its share of the segment, lit as the paced graph lights them.
        g.ticks.forEach((t, i) => {
          const tick = el("i", `kt-tick kt-tick-${t.state === "running" ? "running" : t.state === "applied" ? "applied" : t.state === "failed" ? "failed" : "waiting"}`);
          tick.style.left = `${Math.round(((i + 1) / (g.ticks.length + 1)) * 1000) / 10}%`;
          tick.title = `wave ${t.wave}`;
          seg.appendChild(tick);
        });
      }
      seg.appendChild(el("span", "kt-label", g.label));
      segs.appendChild(seg);
    }
    ch.appendChild(segs);
    row.appendChild(ch);
  }
  host.appendChild(row);
  if (model.now && model.now.text) host.appendChild(el("p", "kt-now", model.now.text));
}
