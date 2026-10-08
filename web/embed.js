// #476: behold framed in a host pane (arugula's workspace block). Pure logic,
// no DOM: app.js reads the embed parameters once, posts `behold:select` to the
// parent when a member or a card is picked, and takes `behold:view` from the
// parent to move the view.
//
//   ?embed=1            compact chrome: no Deploy tab, no theme picker, the
//                       panel and the inspect pane start folded
//   ?theme=<name>       a theme for this frame only (light, dark, or any theme
//                       name the picker lists); never saved
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
  return { embed, host, theme };
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
    if (k === "env") {
      if (v === null || v === "") want.env = null;
      else if (typeof v === "string") want.env = v;
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
