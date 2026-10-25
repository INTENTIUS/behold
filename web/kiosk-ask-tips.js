/**
 * The prompt demo's tip cards. The terminal (web/kiosk-ask.js) tells the story; a tip is a short aside that shows only
 * while the terminal has nothing new to say, and gives way the moment it does.
 *
 * The timing is a pure sequencer ({@link createTipSequencer}), tested with fake timers:
 * - a tip may show only while a busy line has been running at least {@link TIP_WAIT_MS} (an apply wait), with no
 *   typing and no reply, and not when the line is due to end (`until`: its reply, the next beat, the driver's
 *   `next.at`) before the tip could be read; the pane says when a busy line starts or ends (`behold:ask-busy`) and when any new line
 *   starts (`behold:ask-line`: a typed prompt, a reply, a busy line, the ready light);
 * - any such terminal event takes an open tip down at once, and no tip starts in the {@link TIP_QUIET_MS} after one;
 * - at most two tips per act (a scenario of a cycle), never at once: the step's own tips, else the act's built-in
 *   ones ({@link actTips}). The second needs its own qualifying wait, or what is left of the same wait once the first
 *   has held and a quiet gap has passed;
 * - a tip stays its reading time ({@link holdMs}) while the wait lasts, then goes; a tip with a link holds still while
 *   it is hovered or focused ({@link LINK_RESUME_MS} left at least on leaving).
 *
 * The card is compact and quiet, docked in a corner of the graph area that no lit box is in (the frame reports where
 * its lit cards are, `behold:lit-rects`), never over the prompt. When no corner is clear, or on a phone, no tip shows.
 */
import { modalStyle, openEventModal } from "./event-help-modal.js";

/** A tip waits for the busy line to have run this long. */
export const TIP_WAIT_MS = 6_000;
/** No tip starts this soon after a terminal event. */
export const TIP_QUIET_MS = 2_000;
/** A card stays at least this long while the wait lasts; a longer one stays its reading time ({@link holdMs}). */
export const TIP_MIN_MS = 8_000;
/** A card fades out in this long. */
export const TIP_FADE_MS = 150;
/** A card with a link, left after a hover or focus, has at least this long still to show. */
export const LINK_RESUME_MS = 3_000;

/**
 * A tip's link, or null: only an https URL on intentius.io (or a subdomain) or under github.com/INTENTIUS, with a
 * non-empty label (the default is "Read how"). Anything else is dropped.
 */
export function safeLink(l) {
  if (!l || typeof l.url !== "string") return null;
  let u;
  try {
    u = new URL(l.url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const ok = host === "intentius.io" || host.endsWith(".intentius.io") || (host === "github.com" && (u.pathname === "/INTENTIUS" || u.pathname.startsWith("/INTENTIUS/")));
  if (!ok) return null;
  const label = typeof l.label === "string" && l.label.trim() ? l.label.trim() : "Read how";
  return { label, url: u.href };
}

/**
 * What a busy step with no tips of its own shows, in order: the viewer's takeaways, then where to look next. Minimal
 * and positive, and each linted clean on its own at strictness 3 with the sentences package's destink linter.
 */
export const DEFAULT_TIPS = [
  { title: "All at once", body: "Every estate plans together. The plan marks where the new subnet's id goes, and the same apply fills it in. With separate state runs, a downstream root sees that id only after its upstream applies.", link: { label: "How it plans across estates", url: "https://intentius.io/choudoufu/how-it-works/across-estates/" } },
  { title: "terragucci", body: "terragucci is CI pipelines for Terraform. Here it puts all three estates into one plan and one apply.", link: { label: "How a composed run works", url: "https://intentius.io/terragucci/concepts/waves-and-approvals/#composed-estates" } },
  { title: "choudoufu", body: "choudoufu is a fork of OpenTofu. A root that calls your estates as modules plans and applies them in one pass, and each estate keeps its own records. Resource-level locking at the cloud level.", link: { label: "How the locking works", url: "https://intentius.io/choudoufu/how-it-works/locking/" } },
  { title: "Free, nothing to host", body: "Both are free and open source. There is no server or database to host. Everything runs in CI pipelines.", link: { label: "choudoufu on GitHub", url: "https://github.com/INTENTIUS/choudoufu" } },
  { title: "Inspect", body: "Open Inspect to explore every resource and the plan behind it." },
];
/**
 * The free card for the Terragrunt and Atmos demos, which have no terragucci in them: it names choudoufu alone.
 * Linted alone at strictness 3.
 */
export const PLAIN_FREE_TIP = { title: "Free, nothing to host", body: "choudoufu is free and open source. There is no server or database to host. It runs in the CI pipeline you already have.", link: { label: "choudoufu on GitHub", url: "https://github.com/INTENTIUS/choudoufu" } };
/**
 * The Terragrunt and Atmos demos run their own tool's plain workflow with choudoufu as the binary: no terragucci in
 * them. Each has its own known-after-apply card, since the two apply differently: Terragrunt in one apply, Atmos one
 * component at a time. Each body was linted alone at strictness 3.
 */
export const TERRAGRUNT_TIP = { title: "Known after apply", body: "Terragrunt plans a unit whose upstream isn't applied yet with mock outputs. With choudoufu, the plan shows the real subnet id as known after apply. One apply fills it in.", link: { label: "Terragrunt's saved plans", url: "https://docs.terragrunt.com/features/stacks/run-queue/#saving-opentofuterraform-plan-output" } };
export const ATMOS_TIP = { title: "Known after apply", body: "Atmos plans each component against its upstream's last applied outputs, or a mock default. With choudoufu, one plan covers every component. The merge applies each one exactly as reviewed.", link: { label: "Atmos terraform.output", url: "https://atmos.tools/functions/yaml/terraform.output" } };

/**
 * The chant demo runs chant's own pull-request pipeline on three CloudFormation stacks: no terragucci and no choudoufu in
 * it. Each body was linted alone at strictness 3 and its claims checked against chant's guide (pull-request-ci,
 * apply-on-merge "A round the first approval covers").
 */
export const CHANT_TIPS = [
  { title: "One plan, one note", body: "chant plans every stack a pull request changes in one pass and posts one note with one digest. A reviewer approves that digest once.", link: { label: "Generated CI for pull requests", url: "https://intentius.io/chant/guide/pull-request-ci/" } },
  { title: "Known after apply", body: "A stack that reads a new subnet's id is planned with a stand-in for it. The note marks what the stand-in drives as known after apply, and no stand-in is shown as a value.", link: { label: "How CloudFormation stacks are planned", url: "https://intentius.io/chant/guide/pull-request-ci/#cloudformation-stacks" } },
  { title: "One approval", body: "When network has applied, chant plans the other two stacks again. The first approval covers that plan if it only fills in what the preview marked unknown.", link: { label: "How a round is covered", url: "https://intentius.io/chant/guide/apply-on-merge/#a-round-the-first-approval-covers" } },
  { title: "Parameters, not exports", body: "A stack reads another stack's output through a stackOutput input, which chant fills in as a CloudFormation parameter. No exports are involved." },
  { title: "Free, nothing to host", body: "chant is open source under Apache 2.0. The pull request pipeline is a workflow file chant generates for your forge, and it runs in the CI you already have.", link: { label: "chant on GitHub", url: "https://github.com/INTENTIUS/chant" } },
  DEFAULT_TIPS[4],
];

/** Whether a scenario belongs to the chant demo (chant-compose-edit, chant-compose-create). */
export const chantScenario = (scenario) => typeof scenario === "string" && /^chant-compose-/.test(scenario);

/** Whether a scenario belongs to a plain-workflow demo (Terragrunt or Atmos on choudoufu). */
export const plainScenario = (scenario) => typeof scenario === "string" && /^(terragrunt|atmos)-/.test(scenario);


/** Whether a scenario is a create act (a new resource whose id is known only after apply). */
export const createScenario = (scenario) => typeof scenario === "string" && /create/.test(scenario);

/**
 * The first built-in tip of an act. A create act gets the known-after-apply card (the Terragrunt and Atmos demos their
 * own); any other act gets the card that says what the tool is (choudoufu's, or chant's "One plan, one note"). The rest of the cards are not shown in the prompt demo: terragucci's, and chant's "One approval",
 * "Parameters, not exports" and "Free, nothing to host". See {@link actTips} for the second card.
 */
export function actTip(scenario) {
  const create = createScenario(scenario);
  if (chantScenario(scenario)) return create ? CHANT_TIPS[1] : CHANT_TIPS[0];
  if (create && /^terragrunt-/.test(scenario)) return TERRAGRUNT_TIP;
  if (create && /^atmos-/.test(scenario)) return ATMOS_TIP;
  return create ? DEFAULT_TIPS[0] : DEFAULT_TIPS[2];
}

/**
 * The built-in tips of an act, in order, at most two: {@link actTip}, then for an edit act "Free, nothing to host"
 * (choudoufu alone on the Terragrunt and Atmos demos), for a create act "Inspect". The chant demo has just its one.
 */
export function actTips(scenario) {
  const first = actTip(scenario);
  if (chantScenario(scenario)) return [first];
  if (createScenario(scenario)) return [first, DEFAULT_TIPS[4]];
  return [first, plainScenario(scenario) ? PLAIN_FREE_TIP : DEFAULT_TIPS[3]];
}

/** The act a busy line belongs to: one scenario of one cycle. */
export const actKey = (d) => (d ? `${d.cycle}|${d.scenario}` : null);

/** The phone layout's width (web/kiosk.html, ask mode): no tips there, the graph and the prompt have the screen. */
const PHONE = "(max-width: 700px)";

export const validTips = (v) =>
  Array.isArray(v)
    ? v
        .map((t) => (typeof t === "string" ? { body: t } : t))
        .filter((t) => t && typeof t.body === "string" && t.body.trim() && (t.title === undefined || t.title === null || typeof t.title === "string"))
        .map((t) => {
          const { link, title, ...rest } = t;
          const ok = safeLink(link);
          return { ...rest, ...(title ? { title } : {}), ...(ok ? { link: ok } : {}) };
        })
    : [];

/**
 * `show(tip)` puts a card up and returns false when there is no room for it (nothing shown; the act keeps its tip for
 * a later wait). `hide()` takes it down. `enabled()` is the Tips switch. `pick(detail)` is the act's built-in tips (a tip or a list of them).
 * `busy(detail)` takes a `behold:ask-busy` detail, `line()` a `behold:ask-line`; `dismiss()`: the viewer closed it.
 */
export function createTipSequencer({ show, hide, enabled = () => true, pick = (d) => actTips(d && d.scenario), waitMs = TIP_WAIT_MS, quietMs = TIP_QUIET_MS, minMs = TIP_MIN_MS, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  let id = null;
  let detail = null;
  let since = 0;
  let quietUntil = -Infinity;
  let timer = null;
  let up = false;
  let current = null;
  let due = 0;
  let paused = null;
  // How many tips each act has had.
  const shown = new Map();
  const MAX_PER_ACT = 2;
  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const down = () => {
    stop();
    if (up) hide();
    up = false;
    current = null;
    paused = null;
  };
  const arm = (ms, f) => {
    due = now() + ms;
    timer = setTimer(() => {
      timer = null;
      f();
    }, ms);
  };
  const eligible = () => id !== null && !up && enabled() && (shown.get(actKey(detail)) || 0) < MAX_PER_ACT;
  const fire = () => {
    if (!eligible() || now() < since + waitMs || now() < quietUntil) return schedule();
    const own = validTips(detail.tips);
    const list = own.length ? own : [].concat(pick(detail) || []);
    const tip = list[shown.get(actKey(detail)) || 0];
    // A wait due to end before the tip could be read shows none (the act keeps its tip): no flash of a card.
    const left = Number.isFinite(detail.until) ? detail.until - now() : Infinity;
    if (!tip || (left > 0 && left < holdMs(tip, minMs)) || show(tip) === false) return;
    up = true;
    current = tip;
    shown.set(actKey(detail), (shown.get(actKey(detail)) || 0) + 1);
    arm(holdMs(tip, minMs), expire);
  };
  // The card's hold is over while the wait goes on: it goes, and the act's next tip, if any, waits out a quiet gap.
  const expire = () => {
    quietUntil = now() + quietMs;
    down();
    schedule();
  };
  function schedule() {
    if (!eligible() || timer !== null) return;
    arm(Math.max(0, Math.max(since + waitMs, quietUntil) - now()), fire);
  }
  // A new terminal line: the tip gives way at once, and none starts for a while.
  const event = () => {
    quietUntil = now() + quietMs;
    down();
  };
  return {
    busy(d) {
      const step = d && d.busy && d.id ? d.id : null;
      if (step === id) return;
      id = step;
      detail = step === null ? null : d;
      event();
      if (id !== null) since = now();
      schedule();
    },
    line() {
      event();
      schedule();
    },
    /** The viewer hovers or focuses the card: a card with a link holds still. */
    pause() {
      if (!up || paused !== null || timer === null || !current || !current.link) return;
      paused = Math.max(0, due - now());
      stop();
    },
    /** The viewer moved away: the card goes on with at least {@link LINK_RESUME_MS} left. */
    resume() {
      if (paused === null) return;
      const left = Math.max(paused, LINK_RESUME_MS);
      paused = null;
      arm(left, expire);
    },
    /** The viewer closed the card. */
    dismiss() {
      if (id !== null) shown.set(actKey(detail), MAX_PER_ACT);
      stop();
      paused = null;
      up = false;
      current = null;
    },
    /** The Tips switch turned off: the card goes. */
    off() {
      down();
    },
    current: () => id,
  };
}

/** How long a card stays: long enough to read its title and body (about 3 words a second, plus 3 s), never under minMs. */
export function holdMs(tip, minMs = TIP_MIN_MS) {
  const words = `${tip.title || ""} ${tip.body}`.split(/\s+/).filter(Boolean).length;
  return Math.max(minMs, 3_000 + words * 330);
}

/** A press on `target` closes the card unless it is inside the card (or the target is unknown). */
export function shouldDismiss(target, host) {
  if (!target || !host) return false;
  return !(target.closest && target.closest("#k-ask-tips .eh-modal"));
}

/** Space kept around a lit box (its attribute lines hang under it), and between the card and the area's edges. */
export const LIT_PAD = 16;
export const LIT_FOOT = 56;
export const EDGE = 12;

const hits = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * Where the card docks in `area` ({ left, top, width, height }, the graph's room above the prompt) for a card of
 * `w` by `h`: the first corner (top right, top left, bottom right, bottom left) that touches no lit box (`lit`, page
 * rects, each padded by {@link LIT_PAD} and {@link LIT_FOOT} below). Null when none is clear or the card does not fit.
 */
export function dockCorner(area, w, h, lit = []) {
  if (!area || w + 2 * EDGE > area.width || h + 2 * EDGE > area.height) return null;
  const pads = lit.map((r) => ({ left: r.left - LIT_PAD, top: r.top - LIT_PAD, width: r.width + 2 * LIT_PAD, height: r.height + LIT_PAD + LIT_FOOT }));
  const xs = { r: area.left + area.width - EDGE - w, l: area.left + EDGE };
  const ys = { t: area.top + EDGE, b: area.top + area.height - EDGE - h };
  for (const [corner, x, y] of [["top-right", xs.r, ys.t], ["top-left", xs.l, ys.t], ["bottom-right", xs.r, ys.b], ["bottom-left", xs.l, ys.b]]) {
    const box = { left: x, top: y, width: w, height: h };
    if (!pads.some((p) => hits(box, p))) return { corner, left: x, top: y };
  }
  return null;
}

/**
 * The room a tip may dock in, in page pixels: the shown graph frame (`frame`), less what the prompt pane (`ask`) covers
 * under it and what the side pane (`side`: web/kiosk-side.js, open or folded to its tab) covers at its right. Either
 * may be null (not shown).
 */
export function tipArea(frame, ask = null, side = null) {
  const bottom = ask ? Math.min(frame.bottom, ask.top) : frame.bottom;
  const right = side && side.left < frame.right && side.right > frame.left && side.top < bottom && side.bottom > frame.top ? Math.max(frame.left, side.left) : frame.right;
  return { left: frame.left, top: frame.top, width: Math.max(0, right - frame.left), height: Math.max(0, bottom - frame.top) };
}

const STYLE_ID = "k-ask-tips-style";
const STYLE = `
#k-ask-tips { position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 50; pointer-events: none; overflow: hidden; }
#k-ask-tips .eh-modal-wrap { position: absolute; inset: 0; z-index: auto; display: block; background: transparent; pointer-events: auto; }
#k-ask-tips .eh-modal-wrap.k-tip-out { pointer-events: none; }
#k-ask-tips .eh-modal { position: absolute; pointer-events: auto; width: min(19em, calc(100% - 24px)); max-height: calc(100% - 24px); padding: 0.55em 2.4em 0.6em 0.8em; font-size: 0.8em; border: 1px solid var(--rule); border-radius: 8px; box-shadow: none;
  background: color-mix(in srgb, var(--surface-pane-b, var(--panel)) 92%, transparent); color: var(--muted); }
#k-ask-tips .eh-modal-tip { --bar: var(--rule); box-shadow: none; background: color-mix(in srgb, var(--surface-pane-b, var(--panel)) 92%, transparent); }
#k-ask-tips .eh-modal-mode { display: none; }
#k-ask-tips .eh-modal-title { font-size: 1.05em; margin: 0 0 0.2em; color: var(--fg); }
#k-ask-tips .eh-modal-line { color: var(--muted); line-height: 1.4; }
#k-ask-tips .eh-modal-close { min-width: 36px; min-height: 36px; top: 0; right: 0; font-size: 1.1em; }
#k-ask-tips .eh-modal-link { display: inline-block; margin-top: 0.3em; font-size: 0.95em; color: var(--muted); text-decoration: underline; }
@media (prefers-reduced-motion: no-preference) {
  #k-ask-tips .eh-modal-wrap { transition: opacity ${TIP_FADE_MS}ms linear; }
  #k-ask-tips .eh-modal-wrap.k-tip-out { opacity: 0; }
}
`;

/**
 * Wire the cards to the page: listens for `behold:ask-busy` and `behold:ask-line` on `win`, and for the frame's
 * `behold:lit-rects`. The card docks in the graph's room (the shown graph frame, above `askHost`, the prompt pane).
 * The Tips checkbox turns them off where it shows; where the bar is hidden (ask mode) they are on.
 */
export function mountAskTips({ win = window, doc = document, askHost, reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches }) {
  if (!askHost || !doc.body) return null;
  if (!doc.getElementById(STYLE_ID)) {
    const st = doc.createElement("style");
    st.id = STYLE_ID;
    st.textContent = STYLE;
    doc.head.appendChild(st);
  }
  modalStyle(doc);
  const host = doc.createElement("div");
  host.id = "k-ask-tips";
  host.setAttribute("aria-live", "polite");
  doc.body.appendChild(host);
  let card = null;
  let measure = null;
  // The lit boxes, in the frame's pixels, from the frame that sent them.
  let lit = { source: null, rects: [] };
  const phone = () => typeof win.matchMedia === "function" && win.matchMedia(PHONE).matches;
  // The graph frame on show is always #view (a frame loading out of sight takes the id when it swaps in).
  const shownFrame = () => {
    const f = doc.getElementById("view");
    return f && f.getClientRects().length > 0 ? f : null;
  };
  /** The graph's room above the prompt and left of the side pane, in page pixels. */
  const area = () => {
    const f = shownFrame();
    if (!f) return null;
    const side = [doc.getElementById("k-side"), doc.getElementById("k-side-tab")].find((n) => n && n.getClientRects().length > 0);
    const room = tipArea(f.getBoundingClientRect(), askHost.hidden ? null : askHost.getBoundingClientRect(), side ? side.getBoundingClientRect() : null);
    return { ...room, frame: f };
  };
  const litRects = (a) => {
    if (!a || !a.frame || lit.source !== a.frame.contentWindow) return [];
    return lit.rects.map(([x, y, w, h]) => ({ left: a.left + x, top: a.top + y, width: w, height: h }));
  };
  /** Dock the card; false when no corner is clear. */
  const place = () => {
    const box = card && host.querySelector(".eh-modal");
    const a = area();
    if (!box || !a) return false;
    host.style.left = `${Math.round(a.left)}px`;
    host.style.top = `${Math.round(a.top)}px`;
    host.style.width = `${Math.round(a.width)}px`;
    host.style.height = `${Math.round(a.height)}px`;
    const b = box.getBoundingClientRect();
    const spot = dockCorner(a, b.width, b.height, litRects(a));
    if (!spot) return false;
    box.style.left = `${Math.round(spot.left - a.left)}px`;
    box.style.top = `${Math.round(spot.top - a.top)}px`;
    box.dataset.corner = spot.corner;
    return true;
  };
  const enabled = () => {
    const box = doc.querySelector(".eh-switch input");
    const seen = box && box.getClientRects().length > 0;
    return !seen || box.checked;
  };
  const linkNode = (l) => {
    const a = doc.createElement("a");
    a.className = "eh-modal-link";
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = l.label;
    return a;
  };
  const fading = new Set();
  const stopMeasure = () => {
    if (measure !== null) win.clearInterval(measure);
    measure = null;
  };
  const kill = () => {
    for (const c of fading) c.api.close();
    fading.clear();
    if (card) {
      const c = card;
      card = null;
      c.api.close();
    }
    stopMeasure();
  };
  const hideCard = () => {
    const c = card;
    if (!c) return;
    const wrap = host.querySelector(".eh-modal-wrap");
    if (reduced() || !wrap) return kill();
    wrap.classList.add("k-tip-out");
    card = null;
    fading.add(c);
    stopMeasure();
    win.setTimeout(() => {
      fading.delete(c);
      c.api.close();
    }, TIP_FADE_MS);
  };
  // The boxes moved under the card: dock elsewhere, or go.
  const recheck = () => {
    if (card && !place()) hideCard();
  };
  const seq = createTipSequencer({
    enabled,
    show(tip) {
      kill();
      if (phone()) return false;
      const mine = { api: null };
      mine.api = openEventModal(host, {
        mode: "narrated",
        kind: "tip",
        data: { ...(tip.title ? { title: tip.title } : {}), lines: [{ text: tip.body }], ...(tip.link ? { panel: linkNode(tip.link) } : {}) },
        doc,
        reduced: reduced(),
        onClose: (s) => {
          if (card === mine) {
            card = null;
            stopMeasure();
            if (s.closedBy === "viewer") seq.dismiss();
          }
        },
      });
      card = mine;
      if (!place()) {
        kill();
        return false;
      }
      if (measure === null) measure = win.setInterval(recheck, 250);
      return true;
    },
    hide: hideCard,
  });
  // A card with a link holds still while it is hovered or has focus (the sequencer ignores a card without one).
  const onCard = (e) => e.target && e.target.closest && e.target.closest("#k-ask-tips .eh-modal");
  host.addEventListener("mouseover", (e) => onCard(e) && seq.pause());
  host.addEventListener("focusin", (e) => onCard(e) && seq.pause());
  host.addEventListener("mouseout", (e) => onCard(e) && !(e.relatedTarget && onCard({ target: e.relatedTarget })) && !host.querySelector(".eh-modal:focus-within") && seq.resume());
  host.addEventListener("focusout", (e) => onCard(e) && !(e.relatedTarget && onCard({ target: e.relatedTarget })) && !host.querySelector(".eh-modal:hover") && seq.resume());
  // A click or tap anywhere outside the card closes it, as the X does; one inside (its link) does not. Over the graph
  // (an iframe, which sends the page no events) the card's own sheet takes the press (the modal closes on a click on it);
  // anywhere else on the page, this listener does.
  doc.addEventListener("pointerdown", (e) => {
    if (!card || !shouldDismiss(e.target, host)) return;
    card.api.dismiss();
  }, true);
  win.addEventListener("behold:ask-busy", (e) => seq.busy(e.detail));
  win.addEventListener("behold:ask-line", () => seq.line());
  win.addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "behold:lit-rects" || !Array.isArray(e.data.rects)) return;
    const f = [...doc.querySelectorAll("iframe")].find((x) => x.contentWindow === e.source);
    if (!f) return;
    lit = { source: e.source, rects: e.data.rects.filter((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)) };
    recheck();
  });
  doc.addEventListener("change", (e) => {
    if (e.target && e.target.matches && e.target.matches(".eh-switch input") && !e.target.checked) seq.off();
  });
  return seq;
}
