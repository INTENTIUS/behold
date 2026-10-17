// behold#725: the page's motion, in one place. Every looping animation in
// index.html and kiosk.html runs on the root's --beat (a spinner turns once a
// beat, a pulse takes two), so they keep time with each other. This module
// marks the root with data-motion="paused" while the tab is hidden, and the
// stylesheets hold every animation where it is under that mark, so a tab in
// the background spends nothing on frames nobody sees. Reduced motion is the
// stylesheets' own business (prefers-reduced-motion); `motionReduced` is here
// for script that animates.

/** The beat in milliseconds: the stylesheets' --beat, for script that wants to keep time with them. */
export const BEAT_MS = 1200;

/** The mark the root carries while the tab is hidden; null when it is shown. */
export function motionMark(doc) {
  return doc && doc.hidden ? "paused" : null;
}

/** True when the viewer asked for reduced motion. */
export function motionReduced(win = typeof window !== "undefined" ? window : null) {
  try {
    return !!(win && win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}

/**
 * Keep the root's data-motion in step with the tab's visibility. Returns a
 * function that stops listening.
 */
export function installMotion(doc = typeof document !== "undefined" ? document : null) {
  if (!doc || !doc.documentElement) return () => {};
  const root = doc.documentElement;
  const sync = () => {
    const mark = motionMark(doc);
    if (mark) root.setAttribute("data-motion", mark);
    else root.removeAttribute("data-motion");
  };
  doc.addEventListener("visibilitychange", sync);
  sync();
  return () => doc.removeEventListener("visibilitychange", sync);
}
