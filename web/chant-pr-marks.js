// behold#631: the marks on a chant project's components view, for a repo
// whose CI runs chant's pull-request loop (`chant components pr-plan` on a
// pull request, `pr-apply` on its merge). What /api/chant/pr read (chant's
// pr-report, or the summary each stage prints in its run's log, and the
// gate's ledger) as the same marks a terragucci repo's components carry
// (web/terragucci-components-live.js), so app.js draws both one way:
//
// - `cards[component]`: its wave and state (planned, applied, unchanged,
//   failed, refused), the words on the card and the facts in its tooltip;
// - `waves[n]`: the wave's state (waiting while the gate waits on the plan's
//   digest), the run's job status while it runs, and the facts on its box.
//
// Live, when the stage uploaded its run events (chant#4007, the answer's
// `live`, folded by src/chant-pr-events.ts): each wave box says applying or
// done, and each card applying, applied, failed with a short reason, or
// blocked by the component that failed. Without events, only what the
// stage's summary says: while pr-apply runs it has printed nothing per wave
// or component yet, so the boxes say the job runs and the cards keep the
// plan they apply.

/** The issue that asks chant for progress per wave and component, and a report a reader can fetch. */
export const PROGRESS_ISSUE = "chant#4007";

/** A card's state in one or two words, when the full words don't fit. */
export const CHANT_SHORT = { "applied-earlier": "applied earlier", planned: "planned", queued: "waiting", applying: "applying", applied: "applied", "already-applied": "applied before", unchanged: "unchanged", failed: "failed", refused: "refused", blocked: "blocked", "not-started": "did not run" };

const TONE = { "applied-earlier": "ok", planned: "plan", queued: "plan", waiting: "wait", applying: "busy", applied: "ok", "already-applied": "ok", failed: "bad", refused: "bad", blocked: "wait" };
const toneOf = (state) => TONE[state] || "idle";

/** An error as a few words for a card: its first line, without a tool's prefix, cut at a word near `max`. */
export function shortReason(error, max = 60) {
  if (typeof error !== "string" || !error.trim()) return null;
  let t = error.split("\n").map((l) => l.trim()).find(Boolean) || "";
  t = t
    .replace(/^(error|Error|ERROR)[:\s]+/, "")
    .replace(/^\S+ failed:\s*/, "")
    // A tool's `<step> "<name>":` prefix names what the card already names.
    .replace(/^[\w.-]+ "[^"]+":\s*/, "")
    // The clause before a dash is the specific part; what follows is advice ("Inspect the stack events…").
    .replace(/\s+[—–]\s+.*$/, "")
    // CloudFormation's wrapper around a resource's own message.
    .replace(/^Resource handler returned message:\s*/i, "")
    .replace(/\s*\((?:Service|RequestToken|HandlerErrorCode|Status Code)\b[^)]*\)/g, "")
    .replace(/^"([^]*)"\s*$/, "$1")
    .replace(/[.\s]+$/, "");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "")}…`;
}

/**
 * The failed component `name`'s dependencies lead back to, from the graph's
 * `needs` (component -> what it depends on), or null: a failed dependency
 * itself, else a blocked one's blocker. `stateOf(c)` is `{ state, blockedBy }`.
 */
export function blockerOf(name, needs, stateOf) {
  if (!needs) return null;
  const seen = new Set();
  const walk = (n) => {
    for (const d of needs[n] || []) {
      if (seen.has(d)) continue;
      seen.add(d);
      const s = stateOf(d);
      if (s && s.state === "failed") return d;
      if (s && s.state === "blocked" && s.blockedBy) return s.blockedBy;
      const up = walk(d);
      if (up) return up;
    }
    return null;
  };
  return walk(name);
}

/** A live component state (src/chant-pr-events.ts) as a card's state. */
const LIVE_CARD = { waiting: "queued", planning: "queued", planned: "queued", running: "applying", applied: "applied", "already-applied": "already-applied", failed: "failed", blocked: "blocked", gated: "refused", "not-run": "not-started" };

/** A plan's changes as Terraform sums them up, "+1 ~2 -1" (create, update, delete; a replace is both), or null for none. */
export function countWords(counts) {
  if (!counts) return null;
  const add = (counts.create || 0) + (counts.replace || 0);
  const del = (counts.delete || 0) + (counts.replace || 0);
  const parts = [];
  if (add) parts.push(`+${add}`);
  if (counts.update) parts.push(`~${counts.update}`);
  if (del) parts.push(`-${del}`);
  return parts.length ? parts.join(" ") : null;
}

/** The same in words, for a tooltip: "1 to create, 2 to update". */
export function countSentence(counts) {
  if (!counts) return null;
  const parts = [];
  if (counts.create) parts.push(`${counts.create} to create`);
  if (counts.update) parts.push(`${counts.update} to update`);
  if (counts.replace) parts.push(`${counts.replace} to replace`);
  if (counts.delete) parts.push(`${counts.delete} to delete`);
  return parts.length ? parts.join(", ") : null;
}

/** A digest's hex part, without its `jcs1-sha256:` scheme. */
export const hexOf = (d) => (typeof d === "string" ? d.slice(d.lastIndexOf(":") + 1) : "");
/** A digest as a viewer reads it: its first 8 hex digits. */
export const short8 = (d) => hexOf(d).slice(0, 8);

/** The stage the marks follow: the apply once it reported, else the plan. */
const stageOf = (a) => (a && a.apply ? a.apply : a && a.plan ? a.plan : null);

/** A member's state in a stage. */
function memberState(m, stage) {
  if (!m) return "unchanged";
  if (m.status === "applied") return "applied";
  if (m.status === "failed" || m.status === "plan-failed") return "failed";
  if (m.status === "blocked") return "blocked";
  if (stage.stage === "apply" && stage.status === "refused") return "refused";
  return "planned";
}

/** The words on a card for its state; `x` carries the live facts (reason, blocker, wave). */
function cardWords(state, m, gate, x = {}) {
  if (state === "unchanged") return "unchanged";
  if (state === "failed") {
    const what = (m && m.status === "plan-failed") || x.failedIn === "plan" ? "plan failed" : "failed";
    return x.reason ? `${what}: ${x.reason}` : what === "failed" ? "apply failed" : what;
  }
  if (state === "blocked") return x.blockedBy ? `blocked by ${x.blockedBy}` : "blocked by an earlier failure";
  if (state === "not-started") return "did not run";
  if (state === "refused") return gate && gate.refusal ? `refused (${gate.refusal})` : "refused";
  if (state === "queued") return x.wave ? `waiting for wave ${x.wave}` : "waiting";
  if (state === "applying") return "applying";
  if (state === "already-applied") return "applied before";
  if (state === "applied-earlier") return "applied earlier";
  const c = countWords(m && m.counts);
  if (state === "applied") return c ? `applied ${c}` : "applied";
  return c ? `planned ${c}` : "planned, no changes";
}

/** The middle form, when the full words don't fit: the state with its blocker, or the failure's first words. */
function cardMid(state, x) {
  if (state === "failed" && x.reason) return `failed: ${shortReason(x.reason, 16)}`;
  if (state === "blocked" && x.blockedBy) return `blocked by ${x.blockedBy}`;
  return null;
}

/**
 * The marks for /api/chant/pr's answer and the components graph's
 * `meta.chantPr` facets. Empty (no cards, no waves) before the pull
 * request's first plan: a card with no state draws as the view's neutral.
 */
export function chantComponentMarks(answer, facets, opts = {}) {
  const cards = {};
  const waves = {};
  const empty = { stage: null, cards, waves, source: null };
  if (!answer || answer.error || !facets || !facets.waves) return empty;
  const stage = stageOf(answer);
  const gate = answer.gate || null;
  const running = answer.running || null;
  // The apply's run events, when it uploaded them; else the plan's while it plans.
  const liveRun = answer.live ? (answer.live.apply || (!answer.apply ? answer.live.plan : null)) : null;
  const live = liveRun && liveRun.stage === "apply" ? liveRun : null;
  const livePlan = liveRun && liveRun.stage === "plan" ? liveRun : null;
  const componentOf = (m) => m.component || (facets.members && facets.members[m.member]) || m.member;
  const earlier = new Set(answer.live && answer.live.earlier && Array.isArray(answer.live.earlier.applied) ? answer.live.earlier.applied : []);
  const waveNumbers = [...new Set(Object.values(facets.waves))].filter(Number.isInteger).sort((a, b) => a - b);
  // A fix just opened has no plan yet, and still its cards say what they were: applied earlier, or their last state.
  const carried = !!answer.lastStates || earlier.size > 0;
  if (!stage && !running && !liveRun && !carried) return empty;
  // Without the apply's events, its job running is all a box knows.
  const progressUnknown = !!(running && running.stage === "apply" && !live);
  // Events are coming (the stage uploads them) but none landed yet: the boxes say it is starting.
  const starting = progressUnknown && !!answer.eventsExpected;
  // The issue number is for Inspect: never on a kiosk, never while events are on their way.
  const issueNote = progressUnknown && !starting && !opts.kiosk;
  // The wave the apply starts with: the first one this change touches.
  const startingWave = starting ? waveNumbers.find((n) => Object.entries(facets.waves).some(([c, w]) => w === n && (!stage || memberState(stage.members.find((x) => componentOf(x) === c) || null, stage) !== "unchanged"))) ?? null : null;

  const facts = (state, m, x) => {
    const out = [];
    if (m && countSentence(m.counts)) out.push(countSentence(m.counts));
    if (stage && stage.digest) out.push(`plan ${short8(stage.digest)}`);
    if (x.error) out.push(x.error);
    else if (m && m.error) out.push(m.error);
    if (state === "blocked") out.push(x.blockedBy ? `did not run: ${x.blockedBy} failed, and this depends on it` : "did not run: something it depends on failed");
    if (m && m.inputsMoved && m.inputsMoved.length) out.push(`inputs from ${m.inputsMoved.join(", ")} moved; the next run plans it again`);
    if (state === "planned" && issueNote) out.push(`per-component progress: ${PROGRESS_ISSUE}`);
    return out;
  };
  const liveOf = (c) => (live && live.components ? live.components[c] : null);
  const memberOf = (c) => (stage ? stage.members.find((x) => componentOf(x) === c) || null : null);
  // A component's state first, then its blocker: a blocker is read from the others' states.
  const states = {};
  for (const [c, n] of Object.entries(facets.waves)) {
    const m = memberOf(c);
    const l = liveOf(c);
    const lp = livePlan && livePlan.components ? livePlan.components[c] : null;
    let state;
    // A run that never reached its component (a refusal at the gate) says so through its summary, once it is printed.
    if (l && l.state === "not-run" && m && stage && stage.stage === "apply") state = memberState(m, stage);
    else if (l) state = LIVE_CARD[l.state] || "queued";
    else if (lp && !stage) state = lp.state === "failed" ? "failed" : lp.state === "planned" ? "planned" : "queued";
    else if (live && !m) state = "unchanged";
    else if (!stage) state = "unchanged";
    else state = memberState(m, stage);
    // A finished apply's summary over a live read that has not caught up (the last upload is after the summary).
    if (l && m && answer.apply && (m.status === "applied" || m.status === "failed" || m.status === "blocked") && (state === "queued" || state === "applying")) state = memberState(m, stage);
    // Not in this run, and an earlier apply of the cycle applied it: it landed then.
    if (state === "unchanged" && earlier.has(c)) state = "applied-earlier";
    // A new pull request with no plan yet (the fix just opened): what it will touch keeps its last state.
    if ((state === "unchanged" || state === "queued") && answer.lastStates && answer.lastStates[c]) state = answer.lastStates[c];
    states[c] = { state, wave: n, m, l, blockedBy: l && l.blockedBy ? l.blockedBy : null };
  }
  const stateOf = (c) => states[c] || null;
  for (const [c, s] of Object.entries(states)) {
    if (s.state === "blocked" && !s.blockedBy) s.blockedBy = blockerOf(c, facets.needs, stateOf);
  }
  for (const [c, s] of Object.entries(states)) {
    if (!stage && !liveRun && !carried) continue;
    const error = (s.l && s.l.error) || (s.m && s.m.error) || (livePlan && livePlan.components && livePlan.components[c] && livePlan.components[c].error) || null;
    const x = { reason: shortReason(error), error, blockedBy: s.blockedBy, failedIn: s.l ? s.l.failedIn : null, wave: s.wave };
    const words = cardWords(s.state, s.m, gate, x);
    const mid = cardMid(s.state, x);
    cards[c] = { root: c, wave: s.wave, state: s.state, tone: toneOf(s.state), words, ...(mid && mid !== words ? { mid } : {}), short: CHANT_SHORT[s.state] || s.state, facts: facts(s.state, s.m, x), ...(s.blockedBy ? { blockedBy: s.blockedBy } : {}), ...(x.reason ? { reason: x.reason } : {}) };
  }
  for (const n of waveNumbers) {
    const members = Object.entries(facets.waves).filter(([, w]) => w === n).map(([c]) => cards[c]).filter(Boolean);
    const touched = members.filter((m) => m.state !== "unchanged");
    const earlierOnly = touched.length > 0 && touched.every((m) => m.state === "applied-earlier");
    // Live: the graph's wave by its components' names, since run-start's
    // wave numbers are re-layered on a resume and are not the boxes'.
    const inRun = live ? members.filter((m) => states[m.root] && states[m.root].l) : [];
    let state = null;
    let status = null;
    if (inRun.length) {
      const count = (...st) => inRun.filter((m) => st.includes(m.state)).length;
      const cnt = { applied: count("applied", "already-applied"), failed: count("failed"), blocked: count("blocked"), applying: count("applying"), queued: count("queued"), gated: count("refused"), notRun: count("not-started") };
      const blockedBy = [...new Set(inRun.filter((m) => m.state === "blocked" && m.blockedBy).map((m) => m.blockedBy))];
      const blockedWords = cnt.blocked ? `${cnt.blocked} blocked${blockedBy.length === 1 ? ` by ${blockedBy[0]}` : ""}` : null;
      // Settled in this run (a resume's already-applied did not run in it).
      const fresh = count("applied", "failed", "blocked");
      if (cnt.applying || (cnt.queued && fresh > 0 && !live.settled)) {
        state = "applying";
        status = { status: "running", words: "applying", tone: "busy" };
      } else if (cnt.queued === inRun.length || (cnt.queued && !live.settled)) {
        state = "planned";
        // "queued", not "waiting": a box's short form of waiting is "held", which reads as a failure word.
        status = { status: "queued", words: "waiting", tone: "idle" };
      } else if (cnt.failed) {
        state = "failed";
        status = { status: "failed", words: `${cnt.failed} failed${cnt.applied ? `, ${cnt.applied} applied` : ""}`, tone: "bad" };
      } else if (cnt.gated) {
        state = "waiting";
        status = { status: "waiting", words: "held at a gate", tone: "wait" };
      } else if (cnt.blocked === inRun.length) {
        state = "blocked";
        status = { status: "blocked", words: blockedBy.length === 1 ? `blocked by ${blockedBy[0]}` : "blocked", tone: "wait" };
      } else if (cnt.applied) {
        state = blockedWords ? "blocked" : "applied";
        status = { status: "done", words: blockedWords ? `${cnt.applied} applied, ${blockedWords}` : "done", tone: "ok" };
      } else {
        state = "not-started";
        status = { status: "not-run", words: "did not run", tone: "idle" };
      }
    } else if (touched.length) {
      if (touched.some((m) => m.state === "failed")) state = "failed";
      else if (touched.some((m) => m.state === "refused")) state = "refused";
      else if (touched.every((m) => m.state === "applied" || m.state === "already-applied" || m.state === "applied-earlier")) state = "applied";
      else if (touched.every((m) => m.state === "blocked" || m.state === "not-started")) state = "not-started";
      else if (touched.some((m) => m.state === "blocked")) state = "blocked";
      else state = gate && gate.state === "waiting" && !answer.apply ? "waiting" : "planned";
    }
    if (!status && earlierOnly) status = { status: "done", words: "applied earlier", tone: "ok" };
    // A kiosk says the plan job in words a passer-by reads ("planning", not "plan queued").
    const jobWords = opts.kiosk && running && running.stage === "plan" ? (running.status === "running" ? "planning" : "waiting to plan") : running ? `${running.job} ${running.status}` : null;
    if (!status && running && !(live && live.settled)) status = { status: running.status, words: jobWords, tone: running.status === "running" ? "busy" : "idle", run: running.run };
    if (status && running && status.run === undefined) status.run = running.run;
    const f = [];
    // A kiosk names the plan by its short id; Inspect keeps the whole digest.
    // The kiosk's approval card names the plan; its boxes don't repeat it. Inspect keeps the whole digest on them.
    if (state === "waiting" && gate && gate.digest && !inRun.length && !opts.kiosk) f.push(`approve plan ${hexOf(gate.digest)}`);
    // On a kiosk the approval card says who approved which plan; the boxes don't repeat it. Inspect keeps both.
    else if (state === "planned" && gate && gate.state === "approved" && !opts.kiosk) f.push(gate.by ? `approved by ${gate.by.replace(/^.*:/, "")}` : "approved");
    // A box whose cards all landed in an earlier apply did not apply this run's plan.
    if (state === "applied" && stage && stage.digest && !earlierOnly && !opts.kiosk) f.push(`applied plan ${short8(stage.digest)}`);
    if (state === "failed") for (const m of members.filter((x) => x.state === "failed")) f.push(m.reason ? `${m.root} failed: ${m.reason}` : `${m.root} failed`);
    // While pr-apply runs without events, chant has said nothing per wave yet: that first, with the issue that asks for it.
    if (issueNote && touched.length && state !== "applied") f.unshift(`per-wave progress: ${PROGRESS_ISSUE}`);
    // Only the wave the apply is starting says so; the ones after it wait their turn.
    if (starting && touched.length && state !== "applied") {
      status = n === startingWave ? { status: "running", words: "starting…", tone: "busy", ...(running ? { run: running.run } : {}) } : { status: "queued", words: "waiting", tone: "idle", ...(running ? { run: running.run } : {}) };
    }
    const job = running ? running.job : null;
    // A failed wave's first fact, shorter, for a narrow box: the reason cut, then the component alone.
    const firstFailed = state === "failed" ? members.find((x) => x.state === "failed") : null;
    const factShort = firstFailed && firstFailed.reason ? [`${firstFailed.root} failed: ${shortReason(firstFailed.reason, 36)}`, `${firstFailed.root} failed`] : [];
    waves[n] = { number: n, job, state, tone: state ? toneOf(state) : status ? status.tone : "idle", status, title: status ? `wave-${n} · ${status.words}` : `wave-${n}`, facts: f, ...(factShort.length ? { factShort } : {}) };
  }
  return { stage: live ? "apply" : stage ? stage.stage : livePlan ? "plan" : null, cards, waves, source: sourceWords(answer), ...(opts.kiosk ? { statusRight: true, cardFont: 15, waveFont: 18 } : {}) };
}

/** Where the marks came from, for each tooltip. */
export function sourceWords(answer) {
  const from = (s) => (s.from === "report" ? `chant's pr-${s.stage} report` : `chant pr-${s.stage}'s summary in run #${s.run}`);
  const parts = [answer.plan, answer.apply].filter(Boolean).map(from);
  for (const l of answer.live ? [answer.live.plan, answer.live.apply] : []) if (l) parts.push(`chant pr-${l.stage}'s run events`);
  if (answer.gate && answer.gate.from === "ledger") parts.push("the gate's ledger");
  return parts.length ? `(from ${parts.join(", ")})` : null;
}

/** The steps chant's gate shows its panel on: the plan waits, it is approved, the merge applied it. */
export const CHANT_PANEL_STEPS = ["waiting", "approved", "merged", "applying", "applied", "failed"];

/**
 * The apply's waves as its run events tell them, for the kiosk's tips: each
 * wave's state, what failed in it (with the reason) and what it left
 * blocked. Null without the apply's events.
 */
export function chantLiveWaves(answer) {
  const live = answer && answer.live && answer.live.apply;
  if (!live || !Array.isArray(live.waves)) return null;
  const comps = live.components || {};
  return graphWaves(live).map((w) => {
    const of = (st) => w.components.map((c) => comps[c]).filter((c) => c && c.state === st);
    const blocked = of("blocked");
    return {
      wave: w.wave,
      state: w.state,
      components: [...w.components],
      applied: of("applied").length + of("already-applied").length,
      appliedNames: [...of("applied"), ...of("already-applied")].map((c) => c.component),
      failed: of("failed").map((c) => ({
        component: c.component,
        reason: shortReason(c.error),
        ...(c.error ? { error: c.error } : {}),
        // What its failure blocked, wherever in the run: the cards a viewer must still see.
        blocks: Object.values(comps).filter((x) => x.state === "blocked" && x.blockedBy === c.component).map((x) => x.component),
      })),
      blocked: blocked.length,
      blockedBy: [...new Set(blocked.map((c) => c.blockedBy).filter(Boolean))],
    };
  });
}

/**
 * The apply's waves numbered as the components graph numbers them, when
 * every component carries its `graphWave`: a fix's or a resume's run-start
 * re-layers what is left (its wave 1 may be the graph's wave 2), and a
 * viewer reads the boxes' numbers. Else run-start's waves as they are.
 */
export function graphWaves(live) {
  const comps = live.components || {};
  const runWaves = Array.isArray(live.waves) ? live.waves : [];
  const names = runWaves.flatMap((w) => w.components);
  if (!names.length || !names.every((c) => comps[c] && Number.isInteger(comps[c].graphWave))) return runWaves;
  const by = new Map();
  for (const w of runWaves) {
    for (const c of w.components) {
      const g = comps[c].graphWave;
      if (!by.has(g)) by.set(g, { wave: g, components: [], states: [] });
      by.get(g).components.push(c);
      by.get(g).states.push(w.state);
    }
  }
  return [...by.values()]
    .sort((a, b) => a.wave - b.wave)
    .map((g) => {
      const counts = { applied: 0, failed: 0, blocked: 0, alreadyApplied: 0, running: 0, waiting: 0 };
      for (const c of g.components) {
        const s = comps[c].state;
        if (s === "applied") counts.applied++;
        else if (s === "failed") counts.failed++;
        else if (s === "blocked") counts.blocked++;
        else if (s === "already-applied") counts.alreadyApplied++;
        else if (s === "running") counts.running++;
        else if (s !== "gated" && s !== "not-run") counts.waiting++;
      }
      // One run wave maps to one graph wave in a fan-out; where they mix, the busiest state leads.
      const rank = ["running", "failed", "applied", "gated", "blocked", "not-run", "waiting"];
      const state = [...g.states].sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0] || "waiting";
      return { wave: g.wave, state: counts.running ? "running" : state, components: g.components, counts };
    });
}

/** "3 applied, 1 failed, 6 blocked" for a partial apply, from the events or the summary. */
function partialWords(answer) {
  const live = answer.live && answer.live.apply;
  const n = { applied: 0, failed: 0, blocked: 0 };
  if (live && live.components) {
    for (const c of Object.values(live.components)) {
      if (c.state === "applied" || c.state === "already-applied") n.applied++;
      else if (c.state === "failed") n.failed++;
      else if (c.state === "blocked") n.blocked++;
    }
  } else if (answer.apply) {
    for (const m of answer.apply.members) {
      if (m.status === "applied") n.applied++;
      else if (m.status === "failed") n.failed++;
      else if (m.status === "blocked") n.blocked++;
    }
  }
  return [n.applied ? `${n.applied} applied` : null, n.failed ? `${n.failed} failed` : null, n.blocked ? `${n.blocked} blocked` : null].filter(Boolean).join(", ");
}

/**
 * "How this hold ends" for chant's gate: one gate per pull request (op
 * `pr-<n>`, gate `pr-apply`) on the plan's digest, approved before the
 * merge. Three rows, each lit from a record: the plan asked for it (the
 * approve line pr-plan printed), the ledger's approval of that digest, and
 * pr-apply applying under it. Null when the answer has no gate.
 */
export function chantApprovalModel({ demo, answer, sealCheck = null, kiosk = false }) {
  if (!demo || !CHANT_PANEL_STEPS.includes(demo.step) || !answer || !answer.gate || !answer.plan) return null;
  // An answer read for another pull request of the cycle (the first, while the fix's is still to come) is not this one's.
  if (Number.isInteger(demo.pull) && Number.isInteger(answer.pull) && demo.pull !== answer.pull) return null;
  const g = answer.gate;
  const plan = answer.plan;
  const apply = answer.apply;
  const rows = [];
  rows.push({ id: "requested", label: "Requested", state: "lit", text: `Pull request #${answer.pull} asks a reviewer to approve its plan.`, runId: plan.run || null, ...(g.approveCommand && g.state === "waiting" && !kiosk ? { command: g.approveCommand } : {}) });
  if (g.state === "approved") {
    const signed = g.seal === "sealed";
    rows.push({
      id: "approved",
      label: "Approved",
      state: "lit",
      text: `${g.by || "A reviewer"} approved this exact digest.`,
      seal: signed ? (sealCheck && sealCheck.ok ? { ok: true, text: "signed; matches the repo's allowed signers" } : { ok: null, text: "signed" }) : { ok: null, text: g.from === "ledger" ? "not signed" : "from the report" },
      at: g.at || null,
      commit: g.ledgerCommit || null,
    });
  } else if (g.state === "changed" || g.state === "refused") {
    rows.push({ id: "approved", label: "Approved", state: "dim", text: g.state === "changed" ? "The plan moved after review and needs a fresh approval." : `The apply refused (${g.refusal || "no approval"}).` });
  } else rows.push({ id: "approved", label: "Approved", state: "dim", text: kiosk ? "A reviewer approves this exact plan." : "Next, a reviewer approves the digest." });
  const live = answer.live && answer.live.apply;
  const failedApply = (apply && apply.status === "failed") || (live && live.settled && live.status === "failed");
  if (apply && apply.status === "applied") rows.push({ id: "spent", label: "Applied", state: "lit", text: "The merge planned again and applied this digest.", runId: apply.run || null });
  else if (failedApply) {
    const words = partialWords(answer);
    rows.push({ id: "spent", label: "Applied", state: "dim", text: `The merge applied part of this digest${words ? `: ${words}` : ""}. The rest waits for a fix.`, runId: (apply && apply.run) || (answer.running && answer.running.run) || null });
  } else if (answer.running && answer.running.stage === "apply") {
    const gw = live ? graphWaves(live) : [];
    const at = gw.filter((w) => w.state === "running").map((w) => w.wave);
    const of = gw.length;
    rows.push({ id: "spent", label: "Applied", state: "going", text: at.length && of ? `chant is applying this digest on merge now: wave ${at.join(", ")}.` : "chant is applying this digest on merge now.", runId: answer.running.run });
  } else rows.push({ id: "spent", label: "Applied", state: "dim", text: kiosk ? "The merge applies it only if it still matches." : "On merge, chant applies the plan when it matches." });
  const run = apply ? apply.run : answer.running ? answer.running.run : plan.run;
  const chantWaves = chantLiveWaves(answer);
  // A kiosk names no run numbers: a passer-by can't place them. Inspect keeps them.
  if (kiosk) for (const r of rows) r.runId = null;
  return { wave: null, digest: g.digest, run: kiosk ? null : run || null, rows, ...(kiosk ? { kiosk: true } : {}), ...(chantWaves ? { chantWaves } : {}) };
}

/**
 * behold#631: the result card at a chant repo's applied step, the one
 * terragucci's scenarios get (web/kiosk-watch.js resultModel), from the
 * apply's run events: what this run applied, what earlier applies of the
 * cycle did, and each wave's count. Null before the applied step or without
 * the apply's events.
 */
export function chantResultModel(demo, answer) {
  if (!demo || demo.step !== "applied") return null;
  const live = answer && answer.live && answer.live.apply;
  if (!live || !live.components) return null;
  const comps = Object.values(live.components);
  const now = comps.filter((c) => c.state === "applied").length;
  const earlierList = answer.live.earlier && Array.isArray(answer.live.earlier.applied) ? answer.live.earlier.applied : [];
  const before = new Set([...earlierList, ...comps.filter((c) => c.state === "already-applied").map((c) => c.component)]);
  for (const c of comps) if (c.state === "applied") before.delete(c.component);
  const waves = graphWaves(live);
  const counts = [`${now} applied this run`];
  if (before.size) counts.push(`${before.size} applied earlier`);
  // A later run of the cycle (the fix) ran only what was left: say so, or "2 waves" reads as a miscount of the three.
  const wavesWords = `${waves.length} ${waves.length === 1 ? "wave" : "waves"}`;
  counts.push(earlierList.length ? `the fix ran ${wavesWords}` : wavesWords);
  const failed = comps.filter((c) => c.state === "failed").length;
  const blocked = comps.filter((c) => c.state === "blocked").length;
  if (failed) counts.push(`${failed} failed`);
  if (blocked) counts.push(`${blocked} blocked`);
  return {
    head: "Applied",
    line: typeof demo.label === "string" ? demo.label : "",
    counts,
    waves: waves.map((w) => {
      const n = w.counts || {};
      const parts = [n.applied ? `${n.applied} applied` : null, n.alreadyApplied ? `${n.alreadyApplied} applied before` : null, n.failed ? `${n.failed} failed` : null, n.blocked ? `${n.blocked} blocked` : null].filter(Boolean);
      return { wave: w.wave, words: parts.length ? parts.join(", ") : null };
    }),
  };
}
