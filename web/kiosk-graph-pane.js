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
