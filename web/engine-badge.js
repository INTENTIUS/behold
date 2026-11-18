/**
 * behold#1182: when the LadybugDB badge beside the graph pane's Cypher heading moves.
 *
 * It moves while a query runs and for {@link LINGER_MS} after a fresh result
 * set arrives, then stops. The rules, as {@link createBadgeClock} keeps them:
 *
 * - `start()` a query began: the badge moves until it ends. Queries can
 *   overlap; the badge stops only once none runs and no linger is left.
 * - `result(fresh)` a query ended. A fresh result set (a 200 answer with
 *   rows) keeps the badge moving until LINGER_MS after it, or later if an
 *   earlier one asked for later. An empty or refused answer brings nothing
 *   new to look at, so it ends the linger at once (the badge still moves
 *   while another query runs).
 * - `reset()` forgets everything: a new loop on the ask demo.
 * - `active(now)` whether the badge moves at `now`; `nextChange(now)` the ms
 *   until it next stops by itself, or null when nothing is pending.
 *
 * Times are whatever clock the caller passes (the ask demo's runs faster
 * under `?pace`). The DOM half, {@link bindEngineBadge}, sets
 * `data-active` on the badge; the page's CSS draws the spin and pulse, or,
 * under reduced motion, a steady ring.
 */

/** How long the badge keeps moving after a fresh result set, ms. */
export const LINGER_MS = 3000;

export function createBadgeClock({ lingerMs = LINGER_MS } = {}) {
  let running = 0;
  let until = -Infinity;
  return {
    start() {
      running++;
    },
    result(fresh, now) {
      running = Math.max(0, running - 1);
      until = fresh ? Math.max(until, now + lingerMs) : -Infinity;
    },
    reset() {
      running = 0;
      until = -Infinity;
    },
    active(now) {
      return running > 0 || now < until;
    },
    nextChange(now) {
      return running === 0 && now < until ? until - now : null;
    },
  };
}

/** Whether a graph pane answer (`{ status, body }`) is a fresh result set: a 200 with rows. */
export function freshAnswer(answer) {
  return !!answer && answer.status === 200 && Array.isArray(answer.body?.rows) && answer.body.rows.length > 0;
}

/* c8 ignore start: the DOM half, driven by the page */
/**
 * The badge element `el` (may be null: the page has none) with its clock.
 * `now` is the page's clock. Returns `{ start, result, reset, run }`; `run(p)`
 * wraps a promise of an answer: start, then result when it settles.
 */
export function bindEngineBadge(el, { now = () => Date.now(), lingerMs = LINGER_MS, timers = globalThis } = {}) {
  const clock = createBadgeClock({ lingerMs });
  let timer = null;
  const sync = () => {
    const t = now();
    if (el) {
      if (clock.active(t)) el.dataset.active = "1";
      else delete el.dataset.active;
    }
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    const wait = clock.nextChange(t);
    // The page's clock may run faster than the timers' (the ask demo's `?pace`), so look again often rather than once.
    if (wait !== null) timer = timers.setTimeout(sync, Math.min(100, Math.max(0, wait) + 1));
  };
  const badge = {
    start() {
      clock.start();
      sync();
    },
    result(fresh) {
      clock.result(fresh, now());
      sync();
    },
    reset() {
      clock.reset();
      sync();
    },
    async run(promise) {
      badge.start();
      let answer;
      try {
        answer = await promise;
      } finally {
        badge.result(freshAnswer(answer));
      }
      return answer;
    },
  };
  return badge;
}
/* c8 ignore stop */
