// behold#725: whether the kiosk is still hearing from behold. The kiosk redraws
// every second whether or not its reads come back, so a server that has gone
// away leaves a screen that looks live and isn't. Each read the kiosk relies
// on (the demo poll, the event stream) reports here; while any of them is
// failing, the status line says since when nothing has come in, and that the
// kiosk keeps trying. The first good read after that clears it.

/** A fresh record: no good read yet, nothing failing. */
export function linkState() {
  return { lastGood: null, failing: new Set() };
}

/** Note a read from `source` at `at` (a Date): it came back (`ok`) or it failed. */
export function noteRead(st, source, ok, at) {
  if (ok) {
    st.failing.delete(source);
    st.lastGood = at instanceof Date ? at : new Date(at);
  } else st.failing.add(source);
  return st;
}

/** Note that `source` reconnected, without counting it as a read. */
export function noteBack(st, source) {
  st.failing.delete(source);
  return st;
}

const two = (n) => String(n).padStart(2, "0");
/** HH:MM:SS in UTC, the kiosk's clock. */
export function clockUtc(d) {
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/** The status line's words while a read is failing; null while all is well. */
export function linkWords(st) {
  if (!st.failing.size) return null;
  return st.lastGood ? `Not updating since ${clockUtc(st.lastGood)} UTC, retrying` : "Not updating yet, retrying";
}

/**
 * Whether an answer from the kiosk's fetch means the read failed: behold
 * could not be reached, or answered with a server error (the fetch marks
 * both `unreachable`). An answer that carries its own `error` (a source that
 * isn't set up, say) is still a read.
 */
export function readFailed(answer) {
  return !!(answer && answer.unreachable === true);
}

// behold#725: the page's link, shared with the parts of the kiosk that say
// "live" (the tour's badge and its "last write N s ago"), so they don't claim
// it while the cue is up. kiosk.js shares its record after every read.
let shared = null;
const listeners = new Set();
/** Share `st` as the page's link and tell every listener. */
export function shareLink(st) {
  shared = st;
  for (const cb of listeners) cb();
}
/** Call `cb` whenever the page's link is shared again. Returns a function that stops it. */
export function onLinkChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
/** Whether the page's link is failing now, and its last good read (a Date, or null before one). */
export function pageStaleness() {
  return shared && shared.failing.size ? { stale: true, since: shared.lastGood } : { stale: false, since: null };
}
