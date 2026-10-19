// #476: behold framed in a host pane (arugula's workspace block). Pure logic,
// no DOM: app.js reads the embed parameters once, posts `behold:select` to the
// parent when a member or a card is picked, and takes `behold:view` from the
// parent to move the view.
//
//   ?embed=1            compact chrome: no Deploy tab, no theme picker, the
//                       panel and the inspect pane start folded
//   ?theme=<name>       a theme for this frame only (light, dark, or any theme
//                       name the picker lists); never saved
//   ?bare=1             with embed: the graph alone, no panel, inspect pane,
//                       buttons or now line (#569, the kiosk's frame)
//   ?host=<origin>      the parent's origin. Messages go only there, and only
//                       messages from there are taken. No host, no messages.
//
// Gates in a frame are the host's to approve (#477): behold draws them and
// says where to approve.

import { VIEW_KEYS } from "./view-url.js";

/** The light/dark words a host can pass, mapped to a theme the picker has. */
export const THEME_ALIASES = { light: "GitHub Light Default", dark: "GitHub Dark Default" };

/** The embed parameters of a query. `host` is an origin, or null when it is
 * missing or not one (a path, a bare word): a target origin has to be exact. */
export function readEmbed(search) {
  const q = new URLSearchParams(search || "");
  const embed = /^(1|true|on|yes)$/i.test(q.get("embed") || "");
  let host = null;
  const raw = (q.get("host") || "").trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "http:" || u.protocol === "https:") host = u.origin;
    } catch {
      host = null;
    }
  }
  const t = (q.get("theme") || "").trim();
  const theme = t ? THEME_ALIASES[t.toLowerCase()] || t : null;
  const bare = embed && /^(1|true|on|yes)$/i.test(q.get("bare") || "");
  return { embed, host, theme, bare };
}

/** The message a pick sends the parent. `node` is null when a member's box was
 * picked rather than a card. */
export function selectMessage(member, node) {
  return { type: "behold:select", member: member || null, node: node || null };
}

/**
 * A `behold:view` message from the parent, reduced to the view keys it
 * carries, or null when it isn't one or doesn't come from the host. The values
 * go through the same checks as the URL's (view-url.js settleView).
 */
export function viewFromMessage(event, host) {
  if (!host || !event || event.origin !== host) return null;
  const d = event.data;
  if (!d || typeof d !== "object" || d.type !== "behold:view") return null;
  const want = {};
  for (const k of VIEW_KEYS) {
    if (!(k in d)) continue;
    const v = d[k];
    if (k === "radial") {
      if (typeof v === "boolean") want.radial = v;
      continue;
    }
    if (k === "env" || k === "gates" || k === "focus" || k === "run" || k === "pull") {
      // env: null or "" is the source graph. gates: null or "" hands the
      // gate strip back to the graph's env. focus: null or "" brings nothing forward. run: null or "" draws the newest run again.
      if (v === null || v === "") want[k] = null;
      else if (typeof v === "string") want[k] = v;
      continue;
    }
    if (k === "member" && v === null) {
      want.member = null; // the whole estate
      continue;
    }
    if (typeof v === "string" && v) want[k] = v;
  }
  return want;
}

/**
 * behold#571: a card's line the kiosk's frame leaves out, for a viewer new to
 * Terraform: the kind line ("Component · chant", "terraform_data ·
 * terraform"), and the `archetype:`, `wave:` and `root:` meta lines (the wave
 * or the root is the box the card sits in). behold's own page keeps them.
 */
export function kioskQuietLine(text) {
  const t = typeof text === "string" ? text.trim() : "";
  return /^Component\b/.test(t) || /^[\w.-]+ · [\w.-]+$/.test(t) || /^archetype:\s*\S/.test(t) || /^wave:\s*\d+$/.test(t) || /^root:\s*\S+$/.test(t);
}

/** Hide the kioskQuietLine lines of every card in a drawn graph; marks them so a redraw of the marks leaves them hidden. */
export function quietCardLines(svg) {
  for (const t of svg.querySelectorAll("[data-node-id] text")) {
    if (!kioskQuietLine(t.textContent)) continue;
    t.setAttribute("visibility", "hidden");
    t.setAttribute("data-kiosk-quiet", "1");
  }
}

/**
 * Whether a plain wheel (no ctrl or meta key) zooms the graph: in the kiosk's
 * bare frame it does, since the graph is the whole stage and there is nothing
 * of the frame to scroll. A sideways-only scroll is left to the page.
 */
export function wheelZoomsBare(bare, e) {
  return !!bare && !!e && Math.abs(Number(e.deltaY) || 0) > 0;
}

/** A wheel event's vertical delta in px, whatever its unit: a line is 16 px, a page 800. */
export function wheelPx(e) {
  const d = Number(e && e.deltaY) || 0;
  const mode = e && e.deltaMode;
  return mode === 1 ? d * 16 : mode === 2 ? d * 800 : d;
}
