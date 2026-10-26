// behold#571: the kiosk frame's popover. In the kiosk the graph is framed
// bare (`?embed=1&bare=1`), with no Inspect pane, so a visitor pointing at a
// card sees what the plan does to it here instead: in the Resources view, the
// resource's planned change one attribute a line; in Components, the
// root's resources and which of them change. Pure logic: what the popover
// says, where it goes, and when it stays open. app.js draws it.
//
// The values come from the same terragucci read the Inspect pane's
// terragucci sections use (/api/terragucci: the marks on each card, which
// now carry each attribute's before and after, and what the newest applied
// wave wrote). Nothing here reads anything else.

import { PICK_HOLD_MS } from "./kiosk-runs.js";
import { clock } from "./terragucci.js";
import { placeFloat } from "./float-place.js";

/** How many attribute lines the popover shows before "and N more". */
export const MAX_LINES = 6;

/** How long a click keeps the popover open: as long as a click holds the view toggle. */
export const PIN_HOLD_MS = PICK_HOLD_MS;

/** The plan's action on a resource, in words for a viewer new to Terraform. */
export const ACTION_HEAD = {
  create: "The plan creates this resource.",
  update: "The plan changes this resource.",
  replace: "The plan destroys this resource and creates it again.",
  delete: "The plan destroys this resource.",
  forget: "The plan drops this resource from the state and leaves it running.",
  import: "The plan brings this resource into the state.",
};

export const WORDS = {
  same: "The plan leaves this resource as it is.",
  untouched: "This plan leaves its root as it is.",
  noPlan: "No plan yet for this resource.",
  unknown: "known after apply",
  long: "too long to show here",
  noneYet: "none yet",
  gone: "gone",
  leftIsApplied: "Left of each arrow is the value applied now.",
  pinHint: "Click to keep this open.",
  pinnedHint: "Click elsewhere or press Escape to close this.",
  tapPinnedHint: "Tap elsewhere to close this.",
  noResources: "No resources found for this root.",
  noRootChange: "No resource in this root changes.",
  changes: "changes",
  same2: "no change",
  unknown2: "known after apply",
};

/** A value as a line shows it: a string bare, anything else as JSON, cut to `max` characters. */
export function valueWords(v, max = 40) {
  let s;
  if (typeof v === "string") s = v === "" ? '""' : v;
  else if (v === null) s = "null";
  else s = JSON.stringify(v);
  if (s === undefined) s = String(v);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** The instance part of an address beyond its block (`[0]`, `["a"]`), or "". An address
 * under an expanded module call (`module.app[0].aws_eip.pool[1]`, chant#4486) gives "",
 * so the line shows the whole address: `[1]` alone would not say which module instance. */
function instanceKey(address) {
  if (/\]\./.test(address || "")) return "";
  const m = /(\[[^\]]*\])$/.exec(address || "");
  return m ? m[1] : "";
}

/** One attribute's line: `path: before -> after`, or the unknown and long cases. */
export function attributeLine(v, { prefix = "" } = {}) {
  const name = `${prefix}${v.path}`;
  if (v.unknown) return { text: `${name}: ${"before" in v ? `${valueWords(v.before)} -> ` : ""}${WORDS.unknown}`, tone: "unknown" };
  if (v.long) return { text: `${name}: ${WORDS.long}`, tone: null };
  const before = "before" in v ? valueWords(v.before) : WORDS.noneYet;
  const after = "after" in v ? valueWords(v.after) : WORDS.gone;
  return { text: `${name}: ${before} -> ${after}`, tone: null };
}

/** The mark the popover reads: a waiting wave's (the newest plan) before the pull request's plan. Drift marks are not a plan. */
export function planMark(marks) {
  const list = Array.isArray(marks) ? marks : [];
  return list.find((m) => m.verdict === "wave") || list.find((m) => m.verdict === "plan") || null;
}

/** The root entry of the terragucci read a card sits in: the longest `<member>/<name>/` prefix of its id. */
export function cardRoot(answer, nodeId) {
  if (!answer || !Array.isArray(answer.roots) || !nodeId) return null;
  let best = null;
  for (const r of answer.roots) {
    const prefix = `${r.member}/${r.name}/`;
    if (nodeId.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, root: r };
  }
  return best ? { ...best.root, block: nodeId.slice(best.prefix.length) } : null;
}

/** Whether the read's plan holds a root: the pull request's plan, or any plan or wave report on it. */
function rootPlanned(answer, root) {
  if (answer.pull_request && Array.isArray(answer.pull_request.roots)) return answer.pull_request.roots.includes(root.path);
  return !!(root.plan || (root.apply && root.apply.approval === "waiting"));
}

/**
 * What the popover says about one resource card (the Resources view):
 * `{ address, root, head, lines, more, applied, note }`. `lines` is at most
 * MAX_LINES `{ text, tone }`, `more` how many it left out. `applied`, when the
 * root's newest applied wave wrote any of the attributes that change,
 * `{ when, lines }`; else `note` says the left of each arrow is what is
 * applied now. Null when the card is not one of the read's roots.
 */
export function resourcePopover(answer, nodeId, now = new Date()) {
  if (!answer || answer.error) return null;
  const at = cardRoot(answer, nodeId);
  if (!at) return null;
  const marks = answer.cards ? answer.cards[nodeId] : null;
  const mark = planMark(marks);
  const address = mark && mark.addresses && mark.addresses.length === 1 ? mark.addresses[0] : at.block.split("/").join(".");
  const out = { address, root: at.name, head: "", lines: [], more: 0, applied: null, note: null, change: false, unknown: false };
  if (!mark) {
    out.head = rootPlanned(answer, at) ? WORDS.same : answer.pull_request || at.plan ? WORDS.untouched : WORDS.noPlan;
    return out;
  }
  out.change = true;
  out.head = ACTION_HEAD[mark.action] || ACTION_HEAD.update;
  const values = Array.isArray(mark.values) ? mark.values : [];
  const several = (mark.addresses || []).length > 1;
  const lines = values.map((v) => attributeLine(v, { prefix: several ? `${instanceKey(v.address) || v.address} ` : "" }));
  out.unknown = values.some((v) => v.unknown);
  out.lines = lines.slice(0, MAX_LINES);
  out.more = Math.max(0, lines.length - MAX_LINES);
  // What the state holds now: the newest applied wave's values, when it wrote one of these attributes after this plan.
  const applied = answer.applied ? answer.applied[nodeId] : null;
  const paths = new Set(values.map((v) => v.path));
  const fresh = applied && applied.run && (!mark.run || !mark.run.finished || applied.run.finished >= mark.run.finished);
  const wrote = fresh ? applied.values.filter((v) => paths.has(v.path) && !v.unknown && "after" in v) : [];
  if (wrote.length) {
    out.applied = {
      when: `The applied state holds these values now, from wave ${applied.run.wave ?? "?"} at ${clock(applied.run.finished, now)}.`,
      lines: wrote.slice(0, MAX_LINES).map((v) => ({ text: `${v.path}: ${valueWords(v.after)}`, tone: null })),
    };
  } else if (values.some((v) => "before" in v)) out.note = WORDS.leftIsApplied;
  return out;
}

/** A card id for a resource of the components zoom's resources facet (`<root>/<block>`): `<member>/<root>/<block>`. */
export function resourceCardId(answer, root, resourceId) {
  const r = answer && Array.isArray(answer.roots) ? answer.roots.find((x) => x.name === root || x.path === root) : null;
  if (!r) return null;
  const rest = resourceId.startsWith(`${r.name}/`) ? resourceId.slice(r.name.length + 1) : resourceId;
  return `${r.member}/${r.name}/${rest}`;
}

/**
 * behold#796: the rows for a root's planned changes no card of the checkout
 * is (`answer.unmatched.changes`): a resource the change adds is in the plan
 * but not yet in the checkout's source, so the resources facet never lists
 * it. One row a block, instance keys dropped; drift is not a plan.
 */
function plannedOnly(answer, root, declared) {
  const changes = answer && !answer.error && answer.unmatched && Array.isArray(answer.unmatched.changes) ? answer.unmatched.changes : [];
  const r = Array.isArray(answer && answer.roots) ? answer.roots.find((x) => x.name === root || x.path === root) : null;
  const path = r ? r.path : root;
  const seen = new Set(declared.map((d) => d.address));
  const byBlock = new Map();
  for (const c of changes) {
    if (c.root !== path || c.verdict === "drift") continue;
    const address = c.address.replace(/\[(?:"(?:[^"\\]|\\.)*"|[^\]])*\]/g, "");
    if (seen.has(address)) continue;
    // A waiting wave's (the newest plan) before the pull request's plan, as planMark reads cards.
    const had = byBlock.get(address);
    if (!had || (c.verdict === "wave" && had.verdict !== "wave")) byBlock.set(address, c);
  }
  return [...byBlock].map(([address, c]) => ({ address, state: "change", words: PLANNED_WORDS[c.action] || WORDS.changes }));
}

/** behold#796: a row's words for a planned change the checkout has no card for. */
const PLANNED_WORDS = { create: "to create", delete: "to destroy", replace: "to replace" };

/**
 * What the popover says about one root's card (Components): its
 * resources, each "changes", "no change" or "known after apply", and how
 * many change. `resources` is the components zoom's resources facet for the
 * card (`[{ kind, id }]`).
 */
export function rootPopover(answer, root, resources) {
  const list = Array.isArray(resources) ? resources : [];
  const declared = list.map((res) => {
    const id = answer && !answer.error ? resourceCardId(answer, root, res.id) : null;
    const mark = id && answer.cards ? planMark(answer.cards[id]) : null;
    const address = res.id.startsWith(`${root}/`) ? res.id.slice(root.length + 1).split("/").join(".") : res.id;
    if (!mark) return { address, state: "same", words: WORDS.same2 };
    const unknown = (mark.values || []).some((v) => v.unknown);
    return { address, state: unknown ? "unknown" : "change", words: unknown ? WORDS.unknown2 : WORDS.changes };
  });
  // behold#796: first, so "and N more" never hides them.
  const rows = [...plannedOnly(answer, root, declared), ...declared];
  const changed = rows.filter((r) => r.state !== "same").length;
  const head = !rows.length ? WORDS.noResources : changed === 0 ? WORDS.noRootChange : `${changed} of ${rows.length} ${rows.length === 1 ? "resource changes" : "resources change"}.`;
  const shown = rows.slice(0, MAX_LINES + 2);
  return { root, head, rows: shown, more: rows.length - shown.length, changed };
}

// ---------------------------------------------------------------------------
// Open, pinned, closed. Nothing shows until someone points: a hover shows the
// card's popover while the pointer is on it; a click pins it, and it stays
// until a click elsewhere, Escape, or PIN_HOLD_MS after the pin.

/** The popover's state before anyone points: nothing shown. */
export function popState() {
  return { shown: null, pinned: false, at: 0 };
}

/**
 * The next state after an event: `{ type: "enter" | "leave" | "click", id }`,
 * `{ type: "outside" }` (a click anywhere but the shown card or the popover),
 * `{ type: "escape" }`, or `{ type: "tick" }`. `now` in ms.
 */
export function popReduce(s, ev, now) {
  switch (ev.type) {
    case "enter":
      return s.pinned ? s : { shown: ev.id, pinned: false, at: 0 };
    case "leave":
      return s.pinned || s.shown !== ev.id ? s : popState();
    case "click":
      return { shown: ev.id, pinned: true, at: now };
    case "outside":
    case "escape":
      return popState();
    case "tick":
      return s.pinned && now - s.at >= PIN_HOLD_MS ? popState() : s;
    default:
      return s;
  }
}

/**
 * Where the popover goes: beside the card, never over it, inside the frame.
 * Right of the card when it fits, else left, else below, else above; along
 * that side, as near the card's top (or left) as the frame allows. When no
 * side fits, the side with the most room, kept inside the frame. All boxes
 * are `{ left, top, width, height }` in the frame's pixels.
 * behold#764: the shared placement (web/float-place.js), so a card at the
 * frame's very top never puts it off the top, and a popover taller than the
 * frame gets `maxHeight` and scrolls.
 */
export function placePopover(card, pop, frame, { gap = 12, margin = 8 } = {}) {
  const view = { left: frame.left || 0, top: frame.top || 0, width: frame.width, height: frame.height };
  return placeFloat(card, pop, view, { gap, margin });
}
