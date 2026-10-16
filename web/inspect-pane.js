// The inspect pane's opening state (#15, #476, behold#696), without the DOM:
// app.js reads the stored choice and the viewport and asks here.

/** A phone's width: under it the pane stacks under the graph (index.html) and starts folded. */
export const PHONE_QUERY = "(max-width: 600px)";

/**
 * Whether the pane starts folded: as the viewer last left it ("1" folded,
 * "0" open), else folded in a frame (#476) and on a phone, where an open
 * pane beside the graph left the graph a sliver (behold#696).
 */
export function inspectStartsFolded(saved, { embed = false, phone = false } = {}) {
  if (saved === "1") return true;
  if (saved === "0") return false;
  return !!(embed || phone);
}
