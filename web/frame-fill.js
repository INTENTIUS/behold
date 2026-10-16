// behold#571: the kiosk frame's card fill. In the frame a card's state is its
// outline, its bar and its words (web/app.js drawTgReads), never its fill, so
// every card there wears the theme's neutral card ground (pinTokensFor's
// `neutralFill`, the ground frameInks makes each state's words readable on).
// That holds for a card with no state yet, too: before a pull request's first
// plan, or when the reports name another checkout. Left to the category
// palette, such a card took the theme's hue for its kind, which in Sea Shells
// and others is a crimson that reads as "broken".
//
// Outside the frame, and on a graph that carries a live read (`_status`),
// the fill stays the category hue it always was.

/** Whether the cards take the neutral fill: in the kiosk's frame, on a graph with no live read. */
export function noStateFill({ frame = false, live = false } = {}) {
  return !!frame && !live;
}
