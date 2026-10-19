// behold#743: an apply made outside the pipeline, beside the pipeline's run
// of the same estate. terragucci#1163's fan-out-choudoufu has an operator run
// `choudoufu apply -target=aws_sqs_queue.alarms` on app-01's estate while the
// pipeline's wave 3 applies app-01. choudoufu keeps a record per resource and
// no state file to lock, so both land and neither waits. demo.json's
// `outside` says so at each step of that beat ({ who, estate, command, state,
// started_at, ended_at, resources, log }, null otherwise); the kiosk frame
// draws it as a mark on the estate's card, tagged "outside the pipeline".
//
// Pure: which card the estate is, and the mark's words and tone. app.js
// places and draws it.

/** The tag that sets the mark apart from the pipeline's own marks. */
export const OUTSIDE_TAG = "outside the pipeline";

/**
 * The card an outside apply's `estate` is: a card id or root name that is
 * the estate itself, else the one whose name the estate ends with after a
 * prefix ("fo-app-01" is app-01: choudoufu names a root's estate with the
 * scenario's prefix). Null when none is, or more than one could be.
 */
export function outsideCard(estate, ids) {
  if (typeof estate !== "string" || !estate) return null;
  const list = [...new Set((ids || []).filter((i) => typeof i === "string" && i))];
  if (list.includes(estate)) return estate;
  const tail = list.filter((i) => estate.length > i.length && estate.endsWith(i) && /[-_./:]/.test(estate[estate.length - i.length - 1]));
  if (tail.length === 1) return tail[0];
  // The longest wins when one name ends another ("app-1" and "x-app-1"): a tie is no answer.
  const longest = tail.sort((a, b) => b.length - a.length);
  return longest.length > 1 && longest[0].length > longest[1].length ? longest[0] : null;
}

/** The pipeline's states for a card that mean its own apply of the estate has landed. */
const LANDED = new Set(["applied", "applied-earlier", "already-applied"]);

/**
 * The mark's model. `outside` is demo.json's; `pipeline` the card's state as
 * the pipeline's run draws it now ("applying", "applied", "planned"...), or
 * null; `card` the card's name; `change` what the pipeline's plan changes on
 * it ("1 to change"), when the marks say; `wave` the wave that applies it.
 *
 * - `lines`: the mark's lines, top to bottom, each `{ text, kind }`: `who`
 *   (who ran it and its state), `command`, `resources`, `pipeline` (what the
 *   pipeline does to the same estate meanwhile), `landed` (once both ended:
 *   both changes are on the estate).
 * - `tone`: busy while it applies, ok once applied, bad when it failed (TG_TONE's keys).
 * - `pulse`: it applies now.
 * - `both`: it and the pipeline's apply of the card both landed, and neither waited.
 */
export function outsideModel(outside, { pipeline = null, card = null, change = null, wave = null } = {}) {
  if (!outside || typeof outside !== "object") return null;
  const who = outside.who || "someone";
  const name = card || outside.estate;
  const state = outside.state;
  const res = Array.isArray(outside.resources) ? outside.resources.filter((r) => typeof r === "string" && r) : [];
  const added = res.length ? `+ ${res.slice(0, 2).join(", ")}${res.length > 2 ? ` and ${res.length - 2} more` : ""}` : null;
  const command = { text: `$ ${outside.command || "an apply"}`, kind: "command" };
  const both = state === "applied" && LANDED.has(pipeline);
  const tone = state === "applying" ? "busy" : state === "failed" ? "bad" : "ok";
  if (both) {
    // Both changes on the estate, each said: the pipeline's, then the one made outside it.
    const lines = [
      { text: `both landed on ${name}, and neither waited`, kind: "landed" },
      { text: `${Number.isInteger(wave) ? `the pipeline's wave ${wave}` : "the pipeline"}: its planned change${change ? `, ${change}` : ""}`, kind: "pipeline" },
      { text: `${who}: ${added || "its apply"}`, kind: "resources" },
      command,
    ];
    return { tag: OUTSIDE_TAG, lines, tone, pulse: false, both, card: name };
  }
  const lines = [];
  if (state === "applying") lines.push({ text: `${who} is applying to ${name}`, kind: "who" });
  else if (state === "failed") lines.push({ text: `${who}'s apply to ${name} failed`, kind: "who" });
  else lines.push({ text: `${who}'s apply to ${name} landed`, kind: "who" });
  lines.push(command);
  if (added) lines.push({ text: added, kind: "resources" });
  const p = pipelineWords(pipeline, name, wave);
  if (p) lines.push({ text: p, kind: "pipeline" });
  return { tag: OUTSIDE_TAG, lines, tone, pulse: state === "applying", both, card: name };
}

/**
 * What the pipeline does to the same estate, said beside the outside apply. Its wave by number, which the wave box's
 * title and its job's status ("wave 3 · running") say too: the card's own words follow the run view, which may still
 * say queued while the wave's job applies it.
 */
function pipelineWords(pipeline, name, wave) {
  const its = Number.isInteger(wave) ? `the pipeline's wave ${wave}` : "the pipeline";
  if (LANDED.has(pipeline)) return `${its} applied ${name} too, and did not wait`;
  if (pipeline === "applying") return `${its} applies ${name} at the same time`;
  if (pipeline === "failed") return `${its} failed to apply ${name}`;
  if (pipeline === "blocked") return null;
  return `${its} applies ${name} too`;
}

/**
 * Where the mark goes around the card's box `card` ({ x, y, x2, y2 }), a
 * mark `w` by `h`: above, below, left or right of it, a few gaps out, slid
 * along the side. Each spot with its rect `r` and how far it sits from the
 * card (`far`); the caller scores them against what is drawn around.
 */
export function outsideSpots(card, w, h, { gaps = [12, 28, 48], slides = [0, -0.25, 0.25, -0.5, 0.5] } = {}) {
  const out = [];
  const cx = (card.x + card.x2) / 2;
  const cy = (card.y + card.y2) / 2;
  for (const side of ["top", "left", "bottom", "right"]) {
    for (const g of gaps) {
      for (const f of slides) {
        let x;
        let y;
        if (side === "top" || side === "bottom") {
          x = cx - w / 2 + f * w;
          y = side === "top" ? card.y - g - h : card.y2 + g;
        } else {
          x = side === "left" ? card.x - g - w : card.x2 + g;
          y = cy - h / 2 + f * h;
        }
        const r = { x, y, x2: x + w, y2: y + h };
        const far = Math.hypot(Math.max(r.x - card.x2, 0, card.x - r.x2), Math.max(r.y - card.y2, 0, card.y - r.y2));
        out.push({ r, side, gap: g, far });
      }
    }
  }
  return out;
}
