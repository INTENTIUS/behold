/**
 * Whether the graph pane folds away (body.k-nograph hides it and gives its width to the runs).
 *
 * It folds for a tool whose pipeline has no graph to show, and for nothing else. It never folds:
 *   - before the page has read what it needs to know (the served project, the terragucci answer): a reload lands here
 *     for a second or two, and the pane is dark and in its place, not gone and then back;
 *   - in ask mode, where the graph is half of the story;
 *   - once the graph has been shown on this page: a read that fails or is stale for a moment (the reports being
 *     written at the apply) keeps the pane, and the last drawn scene with it.
 */
export function graphFolds({ vendor, ok, askOn, seen, pending }) {
  if (!vendor || ok) return false;
  return !(askOn || seen || pending);
}

/** Whether the page still has a read to wait for before it can say the graph is not coming. */
export function graphPending({ own, single, answer }) {
  return single === null || (!own && (answer === null || answer === undefined));
}

/**
 * Whether the frame may show what is in its svg. In ask mode the graph is the estate scene (web/kiosk-estate-scene.js)
 * and never the checkout's plain resource graph: the pane holds (dark, "Drawing the graph...") until the scene is up,
 * and a scene that is up stays when its reads go missing for a moment (a pin that fits no plan yet, a read in flight).
 *
 * - not in ask mode, or on the components view: always (Inspect and the rest are as they were);
 * - a scene is drawn: yes;
 * - the reports are in, hold no estate scene at all, and say so: yes, the repo's own graph is the scene (a repo
 *   that is not a composed run);
 * - anything else (no reads yet, a read that failed, a scene the pin hides for now): no.
 */
export function graphMayShow({ askOn, components = false, sceneUp, answerSettled, answerHasScene }) {
  if (!askOn || components) return true;
  if (sceneUp) return true;
  return !!answerSettled && !answerHasScene;
}

/**
 * Whether the frame may tell the kiosk it has drawn. In ask mode it waits until the graph may show, and, until the
 * kiosk has said whether ask mode is on (a load tells it right after), a short while at most: the kiosk swaps a
 * reloaded frame in on this word, and a frame swapped in too early shows the plain graph.
 */
export function mayTellDrawn({ askHeard, waitedMs, askOn, mayShow, graceMs = 3000 }) {
  if (!askHeard && waitedMs < graceMs) return false;
  return !askOn || mayShow;
}

/** Whether a scene that is up stays when the scene model is gone: in ask mode always, for the plain graph never paints. */
export function keepsSceneInAsk({ askOn, sceneUp }) {
  return !!askOn && !!sceneUp;
}

/**
 * Whether a kiosk frame draws its reports' scene on an empty svg in place of the graph's refusal (`refusal`, the
 * precondition body /api/graph answered): a composed run's scene comes from its reports alone, so a checkout the graph
 * refuses (a chant project the view never installed) is no reason to draw nothing. Only in a frame (`bare`), and only
 * once the reports hold a scene; without one the refusal's card stays.
 */
export function refusalHoldsScene({ refusal, bare, answer }) {
  if (!refusal || !bare || !answer || answer.error) return false;
  const scene = answer.estateScene;
  return !!(scene && Array.isArray(scene.roots) && scene.roots.some((r) => r && Array.isArray(r.resources) && r.resources.length));
}
